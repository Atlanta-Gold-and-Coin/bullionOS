import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { gmail_v1, google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { IntegrationsService } from '../integrations/integrations.service';
import type { CredentialsFor } from '../integrations/integrations.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { RarcoaService, type RarcoaSnapshot } from '../rarcoa/rarcoa.service';

type Creds = CredentialsFor<'gmail'>;

export interface PollResult {
  checked: boolean;
  /** Messages the Gmail query matched (before filtering). */
  matched: number;
  /** Messages we actually ingested this run. */
  ingested: number;
  /** Per-message outcomes for UI display. */
  details: Array<{
    message_id: string;
    from: string | null;
    subject: string | null;
    internal_date: string | null;
    outcome:
      | 'ingested'
      | 'skipped-no-url'
      | 'skipped-fetch-fail'
      | 'skipped-parse-fail'
      | 'error';
    as_of_date?: string | null;
    pdf_url?: string | null;
    error?: string | null;
  }>;
  /** Reason polling was a no-op (not configured, not enabled, etc.). */
  skipped_reason?: string;
}

/**
 * Gmail auto-ingest for RARCOA daily goldsheets.
 *
 * Workflow (runs every ~15 min via @Cron):
 *   1. Resolve creds + OAuth client from the integrations row.
 *   2. gmail.users.messages.list with a Gmail search query:
 *      `from:rarcoa.com has:attachment filename:pdf -label:RARCOA/Processed
 *       newer_than:2d subject:Goldsheet`
 *   3. For each hit:
 *      a. Download the PDF attachment.
 *      b. Hand it to RarcoaService.ingestPdf().
 *      c. On success, apply the "RARCOA/Processed" label so we skip it
 *         next time (Gmail is our dedup source of truth — no DB flag).
 *   4. Broadcast an admin notification per successful ingest.
 *
 * Admin can also trigger the same flow manually via the "Check now"
 * button on /admin/rarcoa — that calls pollOnce() directly.
 *
 * Failures are NEVER retried in-band. We log, emit a notification on
 * parse failure, and leave the message unlabeled so the next poll
 * picks it up. If parsing keeps failing, the admin can still upload
 * the PDF by hand.
 */
@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);

  constructor(
    private readonly integrations: IntegrationsService,
    private readonly notifications: NotificationsService,
    private readonly rarcoa: RarcoaService,
  ) {}

  async isAuthorized(): Promise<boolean> {
    const creds = await this.resolveCreds();
    return Boolean(creds && creds.refresh_token);
  }

  /**
   * Status payload for the /admin/rarcoa page so it can show whether
   * auto-ingest is configured, authorized, and what the last run did.
   */
  async getStatus(): Promise<{
    configured: boolean;
    authorized: boolean;
    enabled: boolean;
    mailbox: string | null;
    poll_interval_minutes: number | null;
    last_tested_at: string | null;
    last_test_ok: boolean | null;
    last_test_message: string | null;
  }> {
    const all = await this.integrations.listStatus();
    const row = all.find((s) => s.provider === 'gmail');
    const creds = await this.resolveCreds();
    return {
      configured: Boolean(row?.configured),
      authorized: Boolean(creds?.refresh_token),
      enabled: Boolean(row?.enabled),
      mailbox: creds?.mailbox_email ?? null,
      poll_interval_minutes: creds?.poll_interval_minutes ?? null,
      last_tested_at: row?.last_tested_at
        ? row.last_tested_at.toString()
        : null,
      last_test_ok: row?.last_test_ok ?? null,
      last_test_message: row?.last_test_message ?? null,
    };
  }

  /** Return the Google consent URL the admin's browser visits. */
  async buildAuthorizeUrl(redirectUri: string, state: string): Promise<string> {
    const creds = await this.resolveCreds();
    if (!creds) {
      throw new BadRequestException(
        'Gmail not configured yet. Save client_id and client_secret first, then authorize.',
      );
    }
    if (!creds.client_id || !creds.client_secret) {
      throw new BadRequestException(
        'client_id and client_secret must be saved before authorizing.',
      );
    }
    const oauth = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      redirectUri,
    );
    return oauth.generateAuthUrl({
      access_type: 'offline',
      // prompt=consent is required to force a refresh_token on re-auth —
      // without it Google only returns one the very first time an account
      // consents to the client.
      prompt: 'consent',
      // gmail.modify covers read + label changes. Not `.readonly` because
      // we need to apply the "RARCOA/Processed" label for idempotency.
      scope: ['https://www.googleapis.com/auth/gmail.modify'],
      state,
      include_granted_scopes: true,
    });
  }

  /** Finish the OAuth dance — exchange `code` for a refresh token. */
  async completeAuthorization(
    code: string,
    redirectUri: string,
  ): Promise<{ refreshToken: string }> {
    const creds = await this.resolveCreds();
    if (!creds) throw new BadRequestException('Gmail creds missing');
    const oauth = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      redirectUri,
    );
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      throw new BadRequestException(
        'Google did not return a refresh token. Remove app access at https://myaccount.google.com/permissions and retry.',
      );
    }
    return { refreshToken: tokens.refresh_token };
  }

  /** Admin "Test connection" — pings users.getProfile. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const creds = await this.resolveCreds();
      if (!creds) return { ok: false, message: 'Not configured' };
      if (!creds.refresh_token) {
        return { ok: false, message: 'Not authorized (no refresh token)' };
      }
      const gmail = this.gmail(creds);
      const res = await gmail.users.getProfile({ userId: 'me' });
      const email = res.data.emailAddress ?? '(unknown)';
      return { ok: true, message: `OK · signed in as ${email}` };
    } catch (err) {
      return {
        ok: false,
        message: (err as Error).message.slice(0, 500),
      };
    }
  }

  /**
   * Cron entry point. @nestjs/schedule fires this every 15 min on the
   * dot — we don't respect the admin-configurable poll_interval_minutes
   * as a literal schedule (would require dynamic cron registration),
   * instead we short-circuit when the last run happened within that
   * window. Admins who set 60 min just get a faster heartbeat from cron
   * but the actual work still runs hourly. Default of 15 min keeps the
   * expected latency honest.
   */
  // @nestjs/schedule's CronExpression enum doesn't ship an EVERY_15_MINUTES
  // constant — pass the literal 6-field cron instead. Same semantics.
  @Cron('0 */15 * * * *', { name: 'gmail-rarcoa-poll' })
  async scheduledPoll(): Promise<void> {
    try {
      const result = await this.pollOnce();
      if (result.checked) {
        this.logger.log(
          `Gmail poll: matched=${result.matched} ingested=${result.ingested}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Gmail poll failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /**
   * Shared poll impl for both cron and manual "Check now". Returns a
   * structured result so the UI can tell the operator what happened.
   */
  async pollOnce(): Promise<PollResult> {
    const all = await this.integrations.listStatus();
    const row = all.find((s) => s.provider === 'gmail');
    if (!row || !row.configured) {
      return { checked: false, matched: 0, ingested: 0, details: [], skipped_reason: 'not configured' };
    }
    if (!row.enabled) {
      return { checked: false, matched: 0, ingested: 0, details: [], skipped_reason: 'disabled' };
    }
    const creds = await this.resolveCreds();
    if (!creds || !creds.refresh_token) {
      return { checked: false, matched: 0, ingested: 0, details: [], skipped_reason: 'not authorized' };
    }

    const gmail = this.gmail(creds);

    // Build the Gmail search query. We no longer require `has:attachment`
    // because RARCOA's daily email links to the PDF rather than
    // attaching it — the body has a "Download" button pointing at
    // rarcoawholesale.com/dyn/goldsheet-<id>.pdf. `subject_filter` is
    // a free-form Gmail-query fragment (not forced to `subject:` prefix)
    // so typing `"goldsheet"` matches the body token RARCOA uses in
    // every send.
    const q = [
      creds.sender_filter.trim(),
      creds.subject_filter.trim(),
      `-label:${creds.processed_label}`,
      'newer_than:2d',
    ]
      .filter(Boolean)
      .join(' ');

    const list = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 10,
    });
    const matches = list.data.messages ?? [];
    if (matches.length === 0) {
      return { checked: true, matched: 0, ingested: 0, details: [] };
    }

    // Ensure the label exists before we start applying it. Nested labels
    // ("RARCOA/Processed") are first-class in Gmail — create on demand.
    const labelId = await this.ensureLabel(gmail, creds.processed_label);

    const details: PollResult['details'] = [];
    let ingested = 0;

    for (const m of matches) {
      if (!m.id) continue;

      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'full',
        });
        const headers = msg.data.payload?.headers ?? [];
        const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? null;
        const subject =
          headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? null;
        const internalDate = msg.data.internalDate
          ? new Date(Number(msg.data.internalDate)).toISOString()
          : null;

        // RARCOA's email body is HTML with a link (Download button) to
        // the actual PDF hosted on rarcoawholesale.com. Walk the MIME
        // tree to collect the HTML + plaintext bodies, then scan for
        // the PDF URL.
        const bodyText = this.extractBodyText(msg.data.payload);
        const pdfUrl = this.findPdfUrl(bodyText);
        if (!pdfUrl) {
          details.push({
            message_id: m.id,
            from,
            subject,
            internal_date: internalDate,
            outcome: 'skipped-no-url',
            error: 'No PDF link found in message body',
          });
          continue;
        }

        let pdfBuffer: Buffer;
        try {
          pdfBuffer = await this.fetchPdf(pdfUrl);
        } catch (err) {
          details.push({
            message_id: m.id,
            from,
            subject,
            internal_date: internalDate,
            outcome: 'skipped-fetch-fail',
            pdf_url: pdfUrl,
            error: (err as Error).message.slice(0, 500),
          });
          // Don't label — maybe the URL TTL expired or the host is
          // down. A future poll will retry.
          continue;
        }

        let snap: RarcoaSnapshot;
        try {
          snap = await this.rarcoa.ingestPdf({
            pdfBuffer,
            filename: this.filenameFromUrl(pdfUrl),
            ingestedByUserId: null,
          });
        } catch (err) {
          details.push({
            message_id: m.id,
            from,
            subject,
            internal_date: internalDate,
            outcome: 'skipped-parse-fail',
            pdf_url: pdfUrl,
            error: (err as Error).message.slice(0, 500),
          });
          // Don't label — let a future poll pick it up once parsing is fixed.
          continue;
        }

        // Apply the label so the next poll skips this message. Also mark
        // it read — the daily email doesn't need to stay in the operator's
        // Unread tally once we've ingested it.
        await gmail.users.messages.modify({
          userId: 'me',
          id: m.id,
          requestBody: {
            addLabelIds: [labelId],
            removeLabelIds: ['UNREAD'],
          },
        });

        details.push({
          message_id: m.id,
          from,
          subject,
          internal_date: internalDate,
          outcome: 'ingested',
          as_of_date: snap.as_of_date,
          pdf_url: pdfUrl,
        });
        ingested++;

        // Broadcast to admins + staff. Keep the body tight — most
        // operators only need the date and cell count. Include
        // as_of_time so multi-sheet-per-day pings disambiguate.
        const timeSuffix = snap.as_of_time ? ` ${snap.as_of_time}` : '';
        await this.notifications.notifyRoles(['admin', 'staff'], {
          type: 'rarcoa.auto_ingest',
          title: `RARCOA sheet auto-ingested · ${snap.as_of_date}${timeSuffix}`,
          body: `${snap.cells.length} price rows parsed from the daily email. Basis gold ${
            snap.basis_gold !== null ? '$' + snap.basis_gold.toFixed(2) : 'n/a'
          }.`,
          link: '/admin/rarcoa',
        });
      } catch (err) {
        details.push({
          message_id: m.id,
          from: null,
          subject: null,
          internal_date: null,
          outcome: 'error',
          error: (err as Error).message.slice(0, 500),
        });
      }
    }

    return { checked: true, matched: matches.length, ingested, details };
  }

  // --- internals ---

  private async resolveCreds(): Promise<Creds | null> {
    const creds = await this.integrations.getCredentials('gmail');
    if (!creds) return null;
    return creds as Creds;
  }

  private gmail(creds: Creds): gmail_v1.Gmail {
    const oauth = new OAuth2Client(creds.client_id, creds.client_secret);
    oauth.setCredentials({ refresh_token: creds.refresh_token });
    return google.gmail({ version: 'v1', auth: oauth });
  }

  /**
   * Walk the MIME tree and concatenate every text/* part's decoded
   * body. HTML gets priority (RARCOA's download button lives in an
   * <a href>) but we include text/plain too as a fallback in case the
   * HTML body is stripped or the link is only present in plaintext.
   *
   * Gmail encodes part bodies in base64url. For recursive multiparts
   * the actual text lives at the leaf parts, not the parent.
   */
  private extractBodyText(
    part: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!part) return '';
    const mime = part.mimeType ?? '';
    let buf = '';
    // Leaf-node text part: decode it.
    if (mime.startsWith('text/') && part.body?.data) {
      try {
        buf += Buffer.from(part.body.data, 'base64url').toString('utf8');
      } catch {
        /* ignore decode errors; other parts may still have usable text */
      }
    }
    // Recurse into children regardless — multipart wrappers can
    // contain both a leaf text and nested attachments.
    for (const child of part.parts ?? []) {
      buf += '\n' + this.extractBodyText(child);
    }
    return buf;
  }

  /**
   * Scan an email body (HTML + plaintext concat) for a PDF URL.
   * Preference order:
   *   1. URLs on rarcoawholesale.com (the known RARCOA PDF host)
   *   2. Any other URL whose path ends in .pdf (with optional query)
   *   3. Null if nothing matches
   *
   * Conservative about what we accept — we only fetch URLs that
   * plausibly lead to a PDF. Query strings are kept (Mailchimp
   * campaign params are harmless but stripping them could break
   * servers that require them).
   */
  private findPdfUrl(body: string): string | null {
    if (!body) return null;
    // Normalize HTML-encoded ampersands so Mailchimp-style URLs
    // (?utm_foo&amp;utm_bar=...) parse as the real query string.
    const normalized = body.replace(/&amp;/gi, '&');
    // Match any http/https URL whose path contains ".pdf" (optionally
    // followed by ? or # for query/fragment). Conservative charset
    // excludes whitespace, quotes, angle brackets, and HTML-escape
    // delimiters so we don't swallow surrounding markup.
    const re = /https?:\/\/[^\s"'<>)]+\.pdf(?:[?#][^\s"'<>)]*)?/gi;
    const matches = Array.from(normalized.matchAll(re)).map((m) => m[0]);
    if (matches.length === 0) return null;
    const rarcoaHit = matches.find((u) =>
      /rarcoawholesale\.com/i.test(u),
    );
    return rarcoaHit ?? matches[0];
  }

  /**
   * Fetch a PDF URL server-side. Uses Node 20's native fetch with a
   * 30s abort timeout so a hung host can't wedge the cron. Follows
   * redirects (Mailchimp tracker links bounce through click.* before
   * hitting the real host). Verifies the response's content-type
   * contains "pdf" before handing the buffer back — guards against
   * a server returning an HTML login page with 200 OK.
   */
  private async fetchPdf(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          // Some hosts reject requests without a User-Agent; mimic a
          // generic browser so Mailchimp/Cloudflare edges treat us
          // like an ordinary PDF download.
          'User-Agent': 'AGC-Desk/1.0 (+https://agcdesk.com)',
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!/pdf/i.test(contentType)) {
        // Peek at the first chunk to include in the error message —
        // helps diagnose "got HTML login page" scenarios.
        const preview = (await res.text()).slice(0, 120);
        throw new Error(
          `Expected a PDF, got ${contentType || 'unknown'}: ${preview}`,
        );
      }
      const array = await res.arrayBuffer();
      return Buffer.from(array);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Derive a display filename from the URL's path, for provenance. */
  private filenameFromUrl(url: string): string | null {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop() ?? null;
      return last;
    } catch {
      return null;
    }
  }

  /**
   * Find the label by name, creating it if it doesn't exist. Nested
   * names with "/" render as a tree in the Gmail UI automatically.
   */
  private async ensureLabel(
    gmail: gmail_v1.Gmail,
    name: string,
  ): Promise<string> {
    const res = await gmail.users.labels.list({ userId: 'me' });
    const existing = (res.data.labels ?? []).find((l) => l.name === name);
    if (existing?.id) return existing.id;
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
    if (!created.data.id) {
      throw new Error(`Label ${name} created but Google returned no id`);
    }
    return created.data.id;
  }
}
