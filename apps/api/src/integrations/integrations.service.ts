import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB } from '../db/types';
import { CryptoService } from '../crypto/crypto.service';
import {
  PROVIDERS,
  type CredentialsFor,
  type ProviderName,
  isProvider,
  redact,
} from './integrations.registry';

export interface IntegrationStatus {
  provider: ProviderName;
  label: string;
  configured: boolean;
  enabled: boolean;
  display_hint: string | null;
  last_tested_at: Date | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  updated_at: Date | null;
  // Masked credentials (no secret values). Empty when not configured.
  redacted_credentials: Record<string, unknown> | null;
}

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly crypto: CryptoService,
  ) {}

  /** One status row per provider in the registry (configured or not). */
  async listStatus(): Promise<IntegrationStatus[]> {
    const rows = await this.db.selectFrom('integrations').selectAll().execute();
    const byProvider = new Map(rows.map((r) => [r.provider, r]));

    return (Object.keys(PROVIDERS) as ProviderName[]).map((p) => {
      const row = byProvider.get(p);
      if (!row) {
        return {
          provider: p,
          label: PROVIDERS[p].label,
          configured: false,
          enabled: false,
          display_hint: null,
          last_tested_at: null,
          last_test_ok: null,
          last_test_message: null,
          updated_at: null,
          redacted_credentials: null,
        };
      }

      let redacted: Record<string, unknown> | null = null;
      try {
        const creds = this.crypto.decryptJson<CredentialsFor<typeof p>>(
          row.credentials_encrypted,
        );
        redacted = redact(p, creds);
      } catch {
        // Ciphertext is present but we can't decrypt (rotated key?). Surface
        // that clearly rather than pretending the integration is healthy.
        redacted = { error: 'Decryption failed. Re-enter credentials.' };
      }

      return {
        provider: p,
        label: PROVIDERS[p].label,
        configured: true,
        enabled: row.is_enabled,
        display_hint: row.display_hint,
        last_tested_at: row.last_tested_at,
        last_test_ok: row.last_test_ok,
        last_test_message: row.last_test_message,
        updated_at: row.updated_at,
        redacted_credentials: redacted,
      };
    });
  }

  /** Load + decrypt credentials for a provider. Null if not configured/enabled. */
  async getCredentials<P extends ProviderName>(
    provider: P,
    opts: { respectEnabled?: boolean } = { respectEnabled: true },
  ): Promise<CredentialsFor<P> | null> {
    if (!isProvider(provider)) throw new BadRequestException('Unknown provider');
    const row = await this.db
      .selectFrom('integrations')
      .selectAll()
      .where('provider', '=', provider)
      .executeTakeFirst();
    if (!row) return null;
    if (opts.respectEnabled && !row.is_enabled) return null;
    try {
      return this.crypto.decryptJson<CredentialsFor<P>>(row.credentials_encrypted);
    } catch {
      return null;
    }
  }

  async isAvailable(provider: ProviderName): Promise<boolean> {
    const creds = await this.getCredentials(provider);
    return creds !== null;
  }

  /** Upsert credentials. Validates shape, encrypts, stores + masked hint. */
  async set<P extends ProviderName>(
    provider: P,
    payload: unknown,
    actorUserId: string,
  ): Promise<IntegrationStatus> {
    if (!isProvider(provider)) throw new BadRequestException('Unknown provider');

    // Preserve the OAuth refresh_token on google_calendar edits: the token
    // is populated by the consent callback, not the admin form. Without
    // this merge, a Save of the hours/services would wipe auth and force
    // a re-authorize. Only applies when the incoming payload has empty
    // or missing refresh_token AND we already have one on file.
    let incoming: Record<string, unknown> = (payload as Record<string, unknown>) ?? {};
    if (provider === 'google_calendar') {
      const tok = incoming['refresh_token'];
      if (!tok || typeof tok !== 'string' || tok.trim() === '') {
        const existing = await this.getCredentials(provider);
        if (existing && typeof (existing as Record<string, unknown>).refresh_token === 'string') {
          incoming = {
            ...incoming,
            refresh_token: (existing as Record<string, unknown>).refresh_token,
          };
        }
      }
    }

    const schema = PROVIDERS[provider].schema;
    const parsed = schema.safeParse(incoming);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const creds = parsed.data as CredentialsFor<P>;

    const encrypted = this.crypto.encryptJson(creds);
    const hint = PROVIDERS[provider].hint(creds as never);

    await this.db
      .insertInto('integrations')
      .values({
        provider,
        credentials_encrypted: encrypted,
        display_hint: hint,
        is_enabled: true,
        updated_by_user_id: actorUserId,
        last_tested_at: null,
        last_test_ok: null,
        last_test_message: null,
      })
      .onConflict((oc) =>
        oc.column('provider').doUpdateSet({
          credentials_encrypted: encrypted,
          display_hint: hint,
          is_enabled: true,
          updated_by_user_id: actorUserId,
          updated_at: new Date(),
          // Force re-test after any credential change.
          last_tested_at: null,
          last_test_ok: null,
          last_test_message: null,
        }),
      )
      .execute();

    await this.writeAudit(actorUserId, 'integration.set', provider);
    const all = await this.listStatus();
    return all.find((s) => s.provider === provider)!;
  }

  async setEnabled(
    provider: ProviderName,
    enabled: boolean,
    actorUserId: string,
  ): Promise<void> {
    if (!isProvider(provider)) throw new BadRequestException('Unknown provider');
    const r = await this.db
      .updateTable('integrations')
      .set({ is_enabled: enabled, updated_by_user_id: actorUserId })
      .where('provider', '=', provider)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) {
      throw new NotFoundException('Provider not configured');
    }
    await this.writeAudit(actorUserId, enabled ? 'integration.enable' : 'integration.disable', provider);
  }

  async remove(provider: ProviderName, actorUserId: string): Promise<void> {
    if (!isProvider(provider)) throw new BadRequestException('Unknown provider');
    await this.db.deleteFrom('integrations').where('provider', '=', provider).execute();
    await this.writeAudit(actorUserId, 'integration.remove', provider);
  }

  async recordTestResult(
    provider: ProviderName,
    ok: boolean,
    message: string,
  ): Promise<void> {
    await this.db
      .updateTable('integrations')
      .set({
        last_tested_at: new Date(),
        last_test_ok: ok,
        last_test_message: message.slice(0, 500),
      })
      .where('provider', '=', provider)
      .execute();
  }

  private async writeAudit(
    actorUserId: string,
    action: string,
    provider: string,
  ): Promise<void> {
    await this.db
      .insertInto('audit_logs')
      .values({
        actor_user_id: actorUserId,
        action,
        entity_type: 'integration',
        entity_id: provider,
        metadata: sql`'{}'::jsonb`,
      })
      .execute();
  }
}
