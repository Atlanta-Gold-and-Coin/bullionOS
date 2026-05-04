import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB } from '../db/types';

/**
 * Configure otplib once. SHA-1 + 30s window is the TOTP standard and matches
 * every authenticator app (Google Authenticator, 1Password, Authy, etc).
 */
authenticator.options = { window: 1, digits: 6, step: 30 };

interface EnrollResult {
  /** otpauth:// URI; scan with an authenticator app. */
  otpauth_url: string;
  /** Data-URL PNG of the above URI for display in-browser. */
  qr_data_url: string;
  /** Raw plain-text recovery codes — shown ONCE. */
  recovery_codes: string[];
}

@Injectable()
export class TwoFactorService {
  private readonly issuer: string;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    config: ConfigService,
  ) {
    // TOTP issuer string — appears in the user's authenticator app.
    // Per-tenant override via TOTP_ISSUER env var so each operator's
    // entry shows their company name (e.g. "Acme Coin"). Falls back
    // to the meta-product name when unset.
    this.issuer = config.get<string>('TOTP_ISSUER') ?? 'BullionOS';
  }

  /**
   * Begin enrollment: generate a secret, persist it, issue 10 recovery codes.
   * The secret is NOT yet "enabled" — the user must verify a code first.
   */
  async enroll(userId: string): Promise<EnrollResult> {
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'is_2fa_enabled'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new NotFoundException();
    if (user.is_2fa_enabled) {
      throw new BadRequestException('2FA already enabled. Disable first to re-enroll.');
    }

    const secret = authenticator.generateSecret();
    const otpauth_url = authenticator.keyuri(user.email, this.issuer, secret);
    const qr_data_url = await QRCode.toDataURL(otpauth_url);

    // Generate 10 recovery codes. Format xxxx-xxxx-xxxx for readability.
    const rawCodes = Array.from({ length: 10 }, () => this.randomCode());

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ totp_secret: secret })
        .where('id', '=', userId)
        .execute();

      // Purge any old codes from a previous enrollment attempt.
      await trx.deleteFrom('totp_recovery_codes').where('user_id', '=', userId).execute();

      await trx
        .insertInto('totp_recovery_codes')
        .values(rawCodes.map((code) => ({ user_id: userId, code_hash: this.sha256(code) })))
        .execute();
    });

    return { otpauth_url, qr_data_url, recovery_codes: rawCodes };
  }

  /** Finalize enrollment: verify the user can produce a valid code from their secret. */
  async activate(userId: string, code: string): Promise<void> {
    const user = await this.db
      .selectFrom('users')
      .select(['totp_secret', 'is_2fa_enabled'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || !user.totp_secret) {
      throw new BadRequestException('No enrollment in progress');
    }
    if (user.is_2fa_enabled) {
      throw new BadRequestException('2FA already enabled');
    }
    if (!authenticator.check(code, user.totp_secret)) {
      throw new UnauthorizedException('Invalid code');
    }

    await this.db
      .updateTable('users')
      .set({ is_2fa_enabled: true })
      .where('id', '=', userId)
      .execute();
  }

  /** Remove 2FA completely — secret, recovery codes, flag. */
  async disable(userId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ is_2fa_enabled: false, totp_secret: null })
        .where('id', '=', userId)
        .execute();
      await trx.deleteFrom('totp_recovery_codes').where('user_id', '=', userId).execute();
    });
  }

  /**
   * Verify a user-submitted TOTP or recovery code during login.
   * Recovery codes are single-use: marking used_at prevents replay.
   */
  async verify(userId: string, rawCode: string): Promise<boolean> {
    const user = await this.db
      .selectFrom('users')
      .select(['totp_secret', 'is_2fa_enabled'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || !user.is_2fa_enabled || !user.totp_secret) return false;

    const normalized = rawCode.replace(/\s+/g, '').replace(/-/g, '');

    // 6-digit TOTP
    if (/^\d{6}$/.test(normalized)) {
      return authenticator.check(normalized, user.totp_secret);
    }

    // Recovery code (treat anything else that matches our code format)
    if (/^[A-Z0-9]{12}$/i.test(normalized)) {
      const pretty = this.formatCode(normalized.toLowerCase());
      const hash = this.sha256(pretty);
      const row = await this.db
        .selectFrom('totp_recovery_codes')
        .select(['id', 'used_at'])
        .where('user_id', '=', userId)
        .where('code_hash', '=', hash)
        .executeTakeFirst();
      if (!row || row.used_at) return false;
      await this.db
        .updateTable('totp_recovery_codes')
        .set({ used_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      return true;
    }

    return false;
  }

  /** Format a raw hex string into xxxx-xxxx-xxxx. */
  private formatCode(raw: string): string {
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  }

  private randomCode(): string {
    // 6 bytes → 12 hex chars, grouped for readability.
    const raw = randomBytes(6).toString('hex');
    return this.formatCode(raw);
  }

  private sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }
}
