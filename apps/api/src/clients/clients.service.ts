import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { Client, DB } from '../db/types';
import type { CreateClientDto, UpdateClientDto } from './dto/upsert-client.dto';

export interface ClientSearchResult extends Client {
  score?: number;
  invoice_count?: number;
  last_invoice_at: Date | null;
}

@Injectable()
export class ClientsService {
  private readonly bcryptCost: number;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    config: ConfigService,
  ) {
    this.bcryptCost = config.get<number>('BCRYPT_COST', 12);
  }

  /**
   * Fuzzy-search clients using pg_trgm similarity + ILIKE fallback.
   *
   * Strategy:
   *  - Normalize the query to lowercase.
   *  - Match rows where search_text % :q (trigram similarity above threshold)
   *    OR search_text ILIKE '%q%' (substring).
   *  - Rank by similarity desc, then by surname.
   *  - Counts are fetched in a single follow-up query and merged in app code —
   *    mixing aggregates with selectAll + groupBy made for brittle runtime shapes.
   */
  async list(search?: string): Promise<ClientSearchResult[]> {
    let clients: Array<Client & { score?: number }>;

    if (!search || !search.trim()) {
      clients = (await this.db
        .selectFrom('clients')
        .selectAll()
        .orderBy('last_name')
        .orderBy('first_name')
        .limit(500)
        .execute()) as typeof clients;
    } else {
      const term = search.trim().toLowerCase();
      const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
      const likePattern = `%${escaped}%`;

      // Run the threshold setters + query inside a single transaction so they
      // share a connection. SET LOCAL / set_limit are connection-scoped; the
      // pool hands out a fresh connection per query otherwise.
      clients = (await this.db.transaction().execute(async (trx) => {
        await sql`SELECT set_limit(0.10)`.execute(trx);
        await sql`SET LOCAL pg_trgm.word_similarity_threshold = 0.40`.execute(trx);

        return trx
          .selectFrom('clients as c')
          .selectAll('c')
          .select(
            sql<number>`greatest(similarity(c.search_text, ${term}), word_similarity(${term}, c.search_text))`.as(
              'score',
            ),
          )
          .where((eb) =>
            eb.or([
              sql<boolean>`c.search_text % ${term}`,
              sql<boolean>`${term} <% c.search_text`,
              eb('c.search_text', 'like', likePattern),
            ]),
          )
          .orderBy(
            sql`greatest(similarity(c.search_text, ${term}), word_similarity(${term}, c.search_text))`,
            'desc',
          )
          .orderBy('c.last_name')
          .limit(200)
          .execute();
      })) as unknown as typeof clients;
    }

    if (clients.length === 0) return [];

    const ids = clients.map((c) => c.id);
    const counts = await this.db
      .selectFrom('invoices')
      .select(({ fn }) => [
        'client_id',
        fn.count<string>('id').as('n'),
        // Cast the MAX(timestamptz) through sql<Date> — Kysely's fn.max generic
        // insists on string|number|bigint, but the pg driver returns Date here.
        sql<Date | null>`max(created_at)`.as('last_at'),
      ])
      .where('client_id', 'in', ids)
      .groupBy('client_id')
      .execute();
    const byId = new Map(
      counts.map((r) => [r.client_id, { n: Number(r.n), last_at: r.last_at }]),
    );

    return clients.map((c) => ({
      ...c,
      invoice_count: byId.get(c.id)?.n ?? 0,
      last_invoice_at: byId.get(c.id)?.last_at ?? null,
    }));
  }

  async getById(id: string): Promise<Client> {
    const row = await this.db
      .selectFrom('clients')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Client not found');
    return row;
  }

  create(dto: CreateClientDto): Promise<Client> {
    return this.db
      .insertInto('clients')
      .values({
        first_name: dto.first_name.trim(),
        last_name: dto.last_name.trim(),
        email: dto.email?.trim().toLowerCase() ?? null,
        phone: dto.phone?.trim() ?? null,
        address_line1: dto.address_line1 ?? null,
        address_line2: dto.address_line2 ?? null,
        city: dto.city ?? null,
        region: dto.region ?? null,
        postal_code: dto.postal_code ?? null,
        country: dto.country ?? null,
        notes: dto.notes ?? null,
        heard_from: dto.heard_from?.trim() ?? null,
        is_portal_enabled: dto.is_portal_enabled ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, dto: UpdateClientDto): Promise<Client> {
    const patch: Record<string, unknown> = {};
    const cols: (keyof UpdateClientDto)[] = [
      'first_name',
      'last_name',
      'email',
      'phone',
      'address_line1',
      'address_line2',
      'city',
      'region',
      'postal_code',
      'country',
      'notes',
      'heard_from',
      'is_portal_enabled',
    ];
    for (const k of cols) {
      if (dto[k] !== undefined) {
        patch[k] =
          k === 'email'
            ? (dto.email as string).trim().toLowerCase()
            : (dto[k] as string | boolean);
      }
    }
    if (Object.keys(patch).length === 0) return this.getById(id);

    const row = await this.db
      .updateTable('clients')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Client not found');
    return row;
  }

  /** Upgrade a walk-in client to a portal user. Returns the one-time initial password. */
  async enablePortal(
    clientId: string,
    actorUserId: string,
  ): Promise<{ temp_password: string; user_id: string }> {
    const client = await this.getById(clientId);
    if (!client.email) {
      throw new BadRequestException(
        'Client has no email address. Set one before enabling portal access.',
      );
    }
    if (client.user_id) {
      throw new BadRequestException('Client already has portal access');
    }

    const tempPassword = this.generateTempPassword();
    const hash = await bcrypt.hash(tempPassword, this.bcryptCost);
    const email = client.email.toLowerCase();

    // Check the email isn't already used by another user.
    const existing = await this.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    if (existing) {
      throw new BadRequestException(
        'A user with this email already exists. Link manually or change the email.',
      );
    }

    const userId = await this.db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto('users')
        .values({
          email,
          password_hash: hash,
          role: 'client',
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .updateTable('clients')
        .set({ user_id: user.id, is_portal_enabled: true })
        .where('id', '=', clientId)
        .execute();

      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: actorUserId,
          action: 'client.portal.enable',
          entity_type: 'client',
          entity_id: clientId,
          metadata: sql`${JSON.stringify({ user_id: user.id })}::jsonb`,
        })
        .execute();

      return user.id;
    });

    return { temp_password: tempPassword, user_id: userId };
  }

  /** Disable portal access: flip the flag, revoke all refresh tokens. Keeps the user row for audit. */
  async disablePortal(clientId: string, actorUserId: string): Promise<void> {
    const client = await this.getById(clientId);
    if (!client.user_id) return;

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('clients')
        .set({ is_portal_enabled: false })
        .where('id', '=', clientId)
        .execute();
      await trx
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '=', client.user_id as string)
        .execute();
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', client.user_id as string)
        .where('revoked_at', 'is', null)
        .execute();
      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: actorUserId,
          action: 'client.portal.disable',
          entity_type: 'client',
          entity_id: clientId,
          metadata: sql`'{}'::jsonb`,
        })
        .execute();
    });
  }

  /** Generate a new temp password, hash it, revoke existing sessions. */
  async resetPassword(
    clientId: string,
    actorUserId: string,
  ): Promise<{ temp_password: string }> {
    const client = await this.getById(clientId);
    if (!client.user_id) {
      throw new BadRequestException('Client has no portal account');
    }
    const temp = this.generateTempPassword();
    const hash = await bcrypt.hash(temp, this.bcryptCost);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ password_hash: hash, failed_login_count: 0, locked_until: null })
        .where('id', '=', client.user_id as string)
        .execute();
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', client.user_id as string)
        .where('revoked_at', 'is', null)
        .execute();
      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: actorUserId,
          action: 'client.password.reset',
          entity_type: 'client',
          entity_id: clientId,
          metadata: sql`'{}'::jsonb`,
        })
        .execute();
    });
    return { temp_password: temp };
  }

  /** Read the full history timeline for the client-detail page. */
  async getTimeline(clientId: string) {
    await this.getById(clientId); // 404 if missing

    const [invoices, quotes, requests, shipments] = await Promise.all([
      this.db
        .selectFrom('invoices')
        .select([
          'id',
          'invoice_number',
          'type',
          'status',
          'total',
          'created_at',
        ])
        .where('client_id', '=', clientId)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute(),
      this.db
        .selectFrom('price_quotes as q')
        .innerJoin('products as p', 'p.id', 'q.product_id')
        .select([
          'q.id',
          'q.side',
          'q.quantity',
          'q.unit_price',
          'q.line_total',
          'q.expires_at',
          'q.converted_invoice_id',
          'q.created_at',
          'p.name as product_name',
        ])
        .where('q.client_id', '=', clientId)
        .orderBy('q.created_at', 'desc')
        .limit(100)
        .execute(),
      this.db
        .selectFrom('deal_requests')
        .selectAll()
        .where('client_id', '=', clientId)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute(),
      this.db
        .selectFrom('shipments as s')
        .innerJoin('invoices as i', 'i.id', 's.invoice_id')
        .select([
          's.id',
          's.carrier',
          's.tracking_number',
          's.status',
          's.shipped_at',
          's.delivered_at',
          's.created_at',
          'i.invoice_number',
        ])
        .where('i.client_id', '=', clientId)
        .orderBy('s.created_at', 'desc')
        .limit(100)
        .execute(),
    ]);

    return { invoices, quotes, requests, shipments };
  }

  private generateTempPassword(): string {
    // 14 chars, base64 → strip ambiguous chars. Guaranteed to meet the 12-char
    // + letter + digit minimum from the auth validator.
    const raw = randomBytes(12).toString('base64').replace(/[+/=]/g, '');
    // Ensure at least one digit + one letter by construction.
    return `${raw.slice(0, 10)}${Math.floor(Math.random() * 10)}A`;
  }
}
