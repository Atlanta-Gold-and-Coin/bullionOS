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
      'AGC CRM <noreply@example.com>',
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
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
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
