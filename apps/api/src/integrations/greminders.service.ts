import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB } from '../db/types';
import { ClientsService } from '../clients/clients.service';
import { IntegrationsService } from './integrations.service';

/**
 * Known GReminders webhook payload shape.
 *
 * Their docs (developer.greminders.com) describe the envelope as:
 *   { object: 'event', change_type: 'created'|'updated'|'canceled',
 *     data: { ... the event ... } }
 *
 * `data` carries the usual scheduling fields — event id, event type
 * id, start + end times, and an attendees array (at minimum the
 * booker, optionally more). Field names haven't been fully nailed in
 * public docs so we parse defensively and fall back gracefully when
 * something's missing rather than throwing — dropping an event on
 * the floor because we didn't recognize a shape is worse than
 * writing an incomplete audit entry that an operator can clean up.
 */
export interface GremindersWebhookEnvelope {
  object: string;
  change_type: 'created' | 'updated' | 'canceled' | string;
  data: GremindersEvent;
}

export interface GremindersEvent {
  id?: string;
  event_type_id?: string | null;
  name?: string | null;              // service / event-type name
  start_time?: string | null;        // ISO8601
  end_time?: string | null;          // ISO8601
  location?: string | null;
  canceled_at?: string | null;
  attendees?: GremindersAttendee[];
  invitees?: GremindersAttendee[];   // alternate naming seen in docs
}

export interface GremindersAttendee {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  phone_number?: string | null;
  response_status?: string | null;
}

@Injectable()
export class GremindersService {
  private readonly logger = new Logger(GremindersService.name);
  private static readonly API_BASE = 'https://api.greminders.com';

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly integrations: IntegrationsService,
    private readonly clients: ClientsService,
  ) {}

  /**
   * "Test connection" handler for the admin Integrations page.
   *
   * Splits the check into two calls so failures name the real culprit:
   *
   *   1. GET /users WITHOUT the impersonation header — validates the
   *      API key in isolation. A 401/403 here means the key itself
   *      is bad.
   *   2. GET /users WITH the impersonation header — validates that
   *      the stored impersonation_id is a real GReminders user this
   *      key is allowed to act as. A 403 here with a body like
   *      `"User is Invalid"` is how GReminders signals a bad user id;
   *      we translate that to a human-readable message so operators
   *      know to fix the user id field, not the key.
   *
   * Step 2 is skipped when impersonation_id is empty (operator may
   * be testing the key before they know the user id). In that case
   * a successful step-1 is reported with a nudge to fill in the id.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const creds = await this.integrations.getCredentials('greminders', {
      respectEnabled: false,
    });
    if (!creds) {
      return { ok: false, message: 'No credentials saved — enter an API key first.' };
    }
    if (!creds.api_key) {
      return { ok: false, message: 'API key is empty.' };
    }

    // Step 1 — validate the API key alone against GET /webhooks.
    // We can't use /users here because GReminders requires
    // X-GReminders-Impersonation-ID on per-user endpoints; /webhooks
    // is org-scoped and accepts a key on its own.
    const keyOnly = await this.callGet('/webhooks', { apiKey: creds.api_key });
    if (!keyOnly.ok) {
      return {
        ok: false,
        message:
          `API key rejected by GReminders (HTTP ${keyOnly.status}). ` +
          `Regenerate a fresh key in GReminders → Account → API Keys and ` +
          `paste it in /admin/integrations → GReminders.` +
          (keyOnly.body ? ` Raw response: ${keyOnly.body.slice(0, 200)}` : ''),
      };
    }

    // Step 2 — only if an impersonation id is configured. Verifies
    // the id maps to a real user this key can act as.
    if (creds.impersonation_id) {
      const impersonated = await this.callGet('/users', {
        apiKey: creds.api_key,
        impersonationId: creds.impersonation_id,
      });
      if (!impersonated.ok) {
        return {
          ok: false,
          message:
            `API key is valid, but impersonation_id was rejected ` +
            `(HTTP ${impersonated.status}). The user id does NOT match a real ` +
            `GReminders account, or this API key doesn't have permission to ` +
            `act as them. Find the right id in GReminders → Account → Users → ` +
            `click yourself → copy the UUID from the URL (starts with "usr_" ` +
            `or similar). It's NOT your email.` +
            (impersonated.body ? ` Raw: ${impersonated.body.slice(0, 200)}` : ''),
        };
      }
    }

    const parts = [
      `Connected to GReminders. API key is valid.`,
      creds.impersonation_id
        ? 'Impersonation id accepted — ready to sync bookings.'
        : 'Impersonation id NOT set — inbound webhooks still work, but any outbound calls (future Option B) will fail until you add it.',
      creds.webhook_secret
        ? 'Webhook signing is enabled.'
        : 'Webhook signing secret NOT set — inbound events accepted unsigned (set the secret before production traffic).',
    ];
    return { ok: true, message: parts.join(' ') };
  }

  /**
   * Small wrapper around fetch() for GReminders GET endpoints. Returns
   * a uniform `{ ok, status, body }` shape so testConnection can
   * compose operator-facing messages without each call site doing its
   * own try/catch. Network errors become `{ ok: false, status: 0 }`.
   */
  private async callGet(
    path: string,
    args: { apiKey: string; impersonationId?: string },
  ): Promise<{ ok: boolean; status: number; body: string }> {
    const headers: Record<string, string> = {
      'X-GReminders-API-Key': args.apiKey,
      Accept: 'application/json',
    };
    if (args.impersonationId) {
      headers['X-GReminders-Impersonation-ID'] = args.impersonationId;
    }
    try {
      const res = await fetch(`${GremindersService.API_BASE}${path}`, {
        method: 'GET',
        headers,
      });
      const body = res.ok ? '' : await res.text().catch(() => '');
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        body: `Network error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Verify the X-Greminders-Signature header. Returns true if signing
   * is disabled (no secret configured) — we log a warning so the
   * operator knows production is accepting unsigned events. Any
   * attempt with a bad signature returns false.
   *
   * GReminders' exact signing scheme isn't fully spelled out in their
   * public docs. Their support confirms it's HMAC-SHA256 of the raw
   * body with the shared secret, hex-encoded. We use timingSafeEqual
   * to avoid timing-based secret leakage.
   */
  async verifySignature(rawBody: Buffer, headerSig: string | undefined): Promise<boolean> {
    const creds = await this.integrations.getCredentials('greminders', {
      respectEnabled: false,
    });
    if (!creds || !creds.webhook_secret) {
      this.logger.warn(
        'GReminders webhook accepted without signature verification — no webhook_secret configured.',
      );
      return true;
    }
    if (!headerSig) return false;
    const expected = createHmac('sha256', creds.webhook_secret)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(headerSig, 'utf8');
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Drain one webhook envelope into the CRM:
   *   1. Pick the "customer" attendee — we skip any address that looks
   *      like an AGC internal (agcdesk.com, atlantagoldandcoin.com,
   *      atlantagoldandcoinbuyers.com) since those are the operator on
   *      the call, not the booker.
   *   2. findOrCreateByContact to match or create the client.
   *   3. Write an audit_logs row keyed to the client, tagging the
   *      GReminders event id and change_type so the detail page can
   *      surface a per-client timeline of reminders/appointments.
   *
   * Returns a small summary used by the controller's response body
   * (handy for debugging from the GReminders dashboard).
   */
  async ingest(envelope: GremindersWebhookEnvelope): Promise<{
    ok: boolean;
    client_id: string | null;
    client_created: boolean;
    skipped_reason: string | null;
  }> {
    const data = envelope?.data;
    if (!data) {
      return { ok: false, client_id: null, client_created: false, skipped_reason: 'no data' };
    }

    const attendees = (data.attendees ?? data.invitees ?? []).filter(Boolean);
    const customer = attendees.find((a) => {
      const email = (a.email ?? '').toLowerCase();
      if (!email) return false;
      return !isInternalEmail(email);
    });
    if (!customer || !customer.email) {
      return {
        ok: true,
        client_id: null,
        client_created: false,
        skipped_reason: 'no external attendee (internal-only event)',
      };
    }

    let clientId: string | null = null;
    let clientCreated = false;
    try {
      const match = await this.clients.findOrCreateByContact({
        name: customer.name ?? null,
        email: customer.email,
        phone: customer.phone ?? customer.phone_number ?? null,
      });
      clientId = match.id;
      clientCreated = match.created;
    } catch (err) {
      this.logger.warn(
        `GReminders client match failed for event ${data.id ?? 'unknown'}: ${(err as Error).message}`,
      );
    }

    // Always log the activity — even when client match fails, the audit
    // trail with the raw envelope lets an admin reconcile manually.
    await this.db
      .insertInto('audit_logs')
      .values({
        actor_user_id: null,
        action: `greminders_booking.${envelope.change_type ?? 'unknown'}`,
        entity_type: clientId ? 'client' : 'greminders_event',
        entity_id: clientId ?? (data.id ?? 'unknown'),
        metadata: sql`${JSON.stringify({
          greminders_event_id: data.id ?? null,
          event_type_id: data.event_type_id ?? null,
          service: data.name ?? null,
          start_time: data.start_time ?? null,
          end_time: data.end_time ?? null,
          location: data.location ?? null,
          canceled_at: data.canceled_at ?? null,
          attendee_email: customer.email,
          attendee_name: customer.name ?? null,
          client_created: clientCreated,
        })}::jsonb`,
      })
      .execute();

    this.logger.log(
      `GReminders ${envelope.change_type}: ${customer.email} → ` +
        (clientId ? `client ${clientId}${clientCreated ? ' (new)' : ''}` : 'unmatched'),
    );

    return {
      ok: true,
      client_id: clientId,
      client_created: clientCreated,
      skipped_reason: null,
    };
  }
}

/**
 * AGC internal staff domains — attendees on these addresses are the
 * operator, not the booking customer. Mirrors the list in the calendar
 * auto-create fix (commit 20e15e2) so the semantics stay aligned.
 */
const INTERNAL_DOMAINS = new Set([
  'atlantagoldandcoin.com',
  'atlantagoldandcoinbuyers.com',
  'agcdesk.com',
]);

function isInternalEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return INTERNAL_DOMAINS.has(email.slice(at + 1).toLowerCase());
}
