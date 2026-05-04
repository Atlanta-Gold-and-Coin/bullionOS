import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Optional file attachments. Used by the "email invoice" flow to attach the PDF. */
  attachments?: MailAttachment[];
  /** Optional reply-to override — defaults to the configured SMTP_FROM. */
  replyTo?: string;
  /**
   * Optional From header override — defaults to the configured SMTP_FROM.
   * Note: Gmail SMTP only accepts From addresses that match the
   * authenticated user OR a configured "Send mail as" alias. Using a
   * non-aliased domain causes Gmail to silently rewrite the header back
   * to the SMTP_USER, so verify the alias is set up before relying on it.
   */
  from?: string;
}

/**
 * Email transport.
 *
 * When SMTP_HOST is configured, we use real SMTP.
 * Otherwise we fall back to a JSON transport that just logs — this lets dev
 * exercise every email-bearing code path without a live mail server.
 *
 * Never throws from `send()` — an outbound email failure should not roll
 * back the business action that triggered it. Failures are logged and we
 * keep the notification record (it's the source of truth).
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter!: Transporter;
  private from!: string;
  private mode: 'smtp' | 'dev' = 'dev';

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const host = this.config.get<string>('SMTP_HOST', '');
    this.from = this.config.get<string>(
      'SMTP_FROM',
      'BullionOS <noreply@example.com>',
    );

    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: this.config.get<number>('SMTP_PORT', 587),
        secure: this.config.get<number>('SMTP_PORT', 587) === 465,
        auth: this.config.get<string>('SMTP_USER')
          ? {
              user: this.config.getOrThrow<string>('SMTP_USER'),
              pass: this.config.getOrThrow<string>('SMTP_PASS'),
            }
          : undefined,
      });
      this.mode = 'smtp';
      this.logger.log(`Email transport: SMTP → ${host}`);
    } else {
      // JSON transport: verifies + logs messages without sending.
      this.transporter = nodemailer.createTransport({ jsonTransport: true });
      this.mode = 'dev';
      this.logger.warn('Email transport: DEV (logging only). Set SMTP_HOST to send real mail.');
    }
  }

  async send(input: SendMailInput): Promise<void> {
    // RFC 2606 reserves these TLDs explicitly so they never leak to real
    // DNS. Seed users (admin@agc.local) + any other placeholder accounts
    // that survive a migration end up triggering bounces to
    // sales@atlantagoldandcoin.com every time a notification fans out.
    // Short-circuit here so the bounce loop is impossible at the source.
    if (isUnroutableAddress(input.to)) {
      this.logger.warn(
        `skipped email to unroutable address ${input.to} (reserved TLD per RFC 2606)`,
      );
      return;
    }
    try {
      const info = await this.transporter.sendMail({
        from: input.from ?? this.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        replyTo: input.replyTo,
        attachments: input.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      if (this.mode === 'dev') {
        // In dev, log just enough to see it worked without dumping the whole payload.
        this.logger.log(
          `[dev email] → ${input.to} · ${input.subject}${
            input.attachments?.length ? ` · ${input.attachments.length} attachment(s)` : ''
          }`,
        );
      } else {
        this.logger.log(`sent → ${input.to} · ${input.subject} · id=${info.messageId}`);
      }
    } catch (err) {
      this.logger.error(`mail send failed to ${input.to}: ${(err as Error).message}`);
    }
  }
}

/**
 * RFC 2606 reserved TLDs + common placeholder domains. Returns true when
 * we can be confident the address will either not resolve in DNS or is
 * intentionally non-deliverable. Matches the literal suffixes only, to
 * avoid false positives on real domains like `.localhost.com`.
 */
function isUnroutableAddress(to: string | undefined | null): boolean {
  if (!to) return true;
  const lower = to.trim().toLowerCase();
  // Accept comma-separated lists (nodemailer allows them) — block if ANY
  // recipient is unroutable, since nodemailer fails the whole batch.
  const addrs = lower
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return addrs.some((a) => {
    const at = a.lastIndexOf('@');
    if (at < 0) return true; // not even a valid shape — drop
    const domain = a.slice(at + 1);
    return (
      domain === 'localhost' ||
      domain.endsWith('.local') ||
      domain.endsWith('.localhost') ||
      domain.endsWith('.test') ||
      domain.endsWith('.example') ||
      domain.endsWith('.invalid') ||
      domain === 'example.com' ||
      domain === 'example.org' ||
      domain === 'example.net'
    );
  });
}
