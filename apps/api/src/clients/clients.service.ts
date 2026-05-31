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
import { canViewOwnerPrivate } from '../common/owner-privacy.helper';
import type { Client, ClientType, DB } from '../db/types';
import type { CreateClientDto, UpdateClientDto } from './dto/upsert-client.dto';

export interface ClientSearchResult extends Client {
  score?: number;
  invoice_count?: number;
  last_invoice_at: Date | null;
}

export type ClientExportHistoryFilter =
  | 'all'
  | 'bought_from_us'
  | 'sold_to_us'
  | 'bought_or_sold'
  | 'bought_and_sold'
  | 'no_history';

type ClientInvoiceStats = {
  bought_from_us_count: number;
  bought_from_us_total: string;
  bought_from_us_last_at: Date | null;
  sold_to_us_count: number;
  sold_to_us_total: string;
  sold_to_us_last_at: Date | null;
  invoice_count: number;
};

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
  async list(
    search?: string,
    opts: { client_type?: ClientType; actorUserId?: string } = {},
  ): Promise<ClientSearchResult[]> {
    let clients: Array<Client & { score?: number }>;
    const allowOwnerPrivate = opts.actorUserId
      ? await canViewOwnerPrivate(this.db, opts.actorUserId)
      : true;

    if (!search || !search.trim()) {
      let q = this.db.selectFrom('clients').selectAll();
      if (opts.client_type) q = q.where('client_type', '=', opts.client_type);
      if (!allowOwnerPrivate) q = q.where('is_owner_private', '=', false);
      // Limit raised 500 → 2000. The invoice wizard's client combobox
      // is a client-side fuzzy picker over this full payload; when AGC
      // grew past 500 clients alphabetically, names past "V..." fell
      // off the list and became invisible in the picker. 2000 gives
      // years of headroom at typical growth (~540 → ~2000 would be
      // roughly a 3–4× scale). When we outgrow 2000 we should switch
      // the combobox to call the server on keystroke (the endpoint's
      // ?q= path already exists and uses proper trigram ranking).
      clients = (await q
        .orderBy('last_name')
        .orderBy('first_name')
        .limit(2000)
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

        let q = trx
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
          );
        if (opts.client_type) q = q.where('c.client_type', '=', opts.client_type);
        if (!allowOwnerPrivate) q = q.where('c.is_owner_private', '=', false);
        return q
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

  async getById(id: string, opts: { actorUserId?: string } = {}): Promise<Client> {
    const row = await this.db
      .selectFrom('clients')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Client not found');
    // Owner-privacy gate — 404 (not 403) for non-allowlisted callers
    // hitting an is_owner_private record. The 404 keeps the existence
    // of the client itself confidential.
    if (
      row.is_owner_private &&
      opts.actorUserId &&
      !(await canViewOwnerPrivate(this.db, opts.actorUserId))
    ) {
      throw new NotFoundException('Client not found');
    }
    return row;
  }

  create(dto: CreateClientDto): Promise<Client> {
    // DB CHECK constraint `clients_has_identity` guarantees at least one of
    // first/last/company is non-empty, but reject in app code too so the
    // error is human-readable instead of a raw Postgres constraint message.
    const first = dto.first_name?.trim();
    const last = dto.last_name?.trim();
    const company = dto.company?.trim();
    if (!first && !last && !company) {
      throw new BadRequestException(
        'Provide a first name, last name, or company.',
      );
    }
    return this.db
      .insertInto('clients')
      .values({
        first_name: first || null,
        last_name: last || null,
        company: company || null,
        email: dto.email?.trim().toLowerCase() ?? null,
        // Dedupe + lowercase the secondary list. JSONB array; Kysely serializes.
        secondary_emails: normalizeEmails(dto.secondary_emails, dto.email),
        phone: dto.phone?.trim() ?? null,
        address_line1: dto.address_line1 ?? null,
        address_line2: dto.address_line2 ?? null,
        city: dto.city ?? null,
        region: dto.region ?? null,
        postal_code: dto.postal_code ?? null,
        country: dto.country ?? null,
        notes: dto.notes ?? null,
        heard_from: dto.heard_from?.trim() ?? null,
        client_type: dto.client_type ?? 'retail',
        is_portal_enabled: dto.is_portal_enabled ?? false,
        // Migration 039: per-tenant custom field values. Passthrough —
        // stored as-is, defaults to {} when the form sends nothing.
        // JSONB needs an explicit ::jsonb cast (pg drops parameterized
        // objects to text otherwise) — same pattern as audit_logs.metadata.
        ...(dto.custom_fields !== undefined && {
          custom_fields: sql`${JSON.stringify(dto.custom_fields)}::jsonb`,
        }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, dto: UpdateClientDto): Promise<Client> {
    const patch: Record<string, unknown> = {};
    const cols: (keyof UpdateClientDto)[] = [
      'first_name',
      'last_name',
      'company',
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
      'client_type',
      'is_portal_enabled',
    ];
    for (const k of cols) {
      if (dto[k] !== undefined) {
        if (k === 'email') {
          patch.email = (dto.email as string).trim().toLowerCase();
        } else if (k === 'first_name' || k === 'last_name' || k === 'company') {
          // Collapse empty strings to NULL so the CHECK constraint and the
          // search_text GENERATED column both treat the field uniformly.
          const v = (dto[k] as string | undefined)?.trim();
          patch[k] = v && v.length > 0 ? v : null;
        } else {
          patch[k] = dto[k] as string | boolean;
        }
      }
    }
    if (dto.secondary_emails !== undefined) {
      // Exclude primary (if set in same patch or already on row) from the
      // secondary list so we don't duplicate-mention the same address.
      const primaryNow =
        typeof patch.email === 'string'
          ? (patch.email as string)
          : (await this.getById(id)).email;
      patch.secondary_emails = normalizeEmails(dto.secondary_emails, primaryNow);
    }
    // Migration 039: per-tenant custom field values. Passthrough — the
    // form sends the full object, we store it as-is (replace semantics).
    // JSONB needs an explicit ::jsonb cast (see create()).
    if (dto.custom_fields !== undefined) {
      patch.custom_fields = sql`${JSON.stringify(dto.custom_fields)}::jsonb`;
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

  /**
   * Locate (or create) a client for an inbound calendar booking.
   *
   * Matching order is deliberately conservative — a duplicate client is
   * cheap to merge later, but a wrong auto-link silently pollutes the
   * history of a real customer. Priorities:
   *
   *   1. Exact case-insensitive match on the primary email column.
   *   2. Exact match on the secondary_emails JSONB array.
   *   3. Exact match on phone after stripping non-digits (US numbers get
   *      compared as 10-digit strings so "(404) 555-1212" and
   *      "404-555-1212" collide).
   *
   * If none match we *create* a retail client using whatever personal
   * info the booking provided. Fuzzy trigram matching is NOT used here —
   * see CAL-001 risk notes — we'd rather admins merge two "Jane Smith"s
   * than auto-link the wrong one.
   *
   * Returns the resolved client id + whether it's newly created so the
   * caller can surface "created client" vs "linked existing" in the UI.
   */
  /**
   * Read-only twin of findOrCreateByContact — returns the matching
   * client id or null without creating anything. Used by the calendar
   * UI to show "linked to X" badges without side effects on page load.
   * Same matching order: primary email → secondary_emails → phone
   * last-10-digits.
   */
  async findByContact(input: {
    email?: string | null;
    phone?: string | null;
  }): Promise<{ id: string } | null> {
    const email = input.email?.trim().toLowerCase() ?? null;
    const phone = input.phone?.trim() ?? null;
    const digits = phone?.replace(/\D/g, '') ?? null;
    const last10 = digits && digits.length >= 10 ? digits.slice(-10) : digits;

    if (email) {
      const hit = await this.db
        .selectFrom('clients')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();
      if (hit) return { id: hit.id };
      const sec = await this.db
        .selectFrom('clients')
        .select('id')
        .where(sql<boolean>`secondary_emails @> ${JSON.stringify([email])}::jsonb`)
        .executeTakeFirst();
      if (sec) return { id: sec.id };
    }
    if (last10 && last10.length >= 10) {
      const hit = await this.db
        .selectFrom('clients')
        .select('id')
        .where(
          sql<boolean>`right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${last10}`,
        )
        .executeTakeFirst();
      if (hit) return { id: hit.id };
    }
    return null;
  }

  async findOrCreateByContact(input: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    actorUserId?: string | null;
  }): Promise<{ id: string; created: boolean }> {
    const email = input.email?.trim().toLowerCase() ?? null;
    const phone = input.phone?.trim() ?? null;
    const digits = phone?.replace(/\D/g, '') ?? null;
    const last10 = digits && digits.length >= 10 ? digits.slice(-10) : digits;

    // 1. primary email
    if (email) {
      const hit = await this.db
        .selectFrom('clients')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();
      if (hit) return { id: hit.id, created: false };

      // 2. secondary emails array
      const sec = await this.db
        .selectFrom('clients')
        .select('id')
        .where(sql<boolean>`secondary_emails @> ${JSON.stringify([email])}::jsonb`)
        .executeTakeFirst();
      if (sec) return { id: sec.id, created: false };
    }

    // 3. phone (last 10 digits)
    if (last10 && last10.length >= 10) {
      const hit = await this.db
        .selectFrom('clients')
        .select('id')
        // regexp_replace strips non-digits from the stored phone; endsWith by
        // taking the right(..., 10). Avoids indexing but the phone list is
        // small (~600 rows) so a seq scan is fine.
        .where(
          sql<boolean>`right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${last10}`,
        )
        .executeTakeFirst();
      if (hit) return { id: hit.id, created: false };
    }

    // No match — create a new retail record. Best-effort name split.
    const { first, last } = splitName(input.name ?? '');
    const created = await this.create({
      first_name: first,
      last_name: last,
      email: email ?? undefined,
      phone: phone ?? undefined,
      client_type: 'retail',
    });

    if (input.actorUserId) {
      await this.db
        .insertInto('audit_logs')
        .values({
          actor_user_id: input.actorUserId,
          action: 'client.auto_created.calendar',
          entity_type: 'client',
          entity_id: created.id,
          metadata: sql`${JSON.stringify({ source: 'calendar_booking' })}::jsonb`,
        })
        .execute();
    }

    return { id: created.id, created: true };
  }

  /**
   * Upgrade a walk-in client to a portal user, OR re-activate a
   * previously-disabled portal account. Returns a fresh one-time
   * initial password in both cases — operators always get a clean
   * credential to share.
   *
   * Re-enable path (Apr 2026 fix): when disablePortal runs, it sets
   * users.status='disabled' but keeps clients.user_id. The original
   * enablePortal guard rejected re-enables because user_id was still
   * set. Now we detect that state, reset the password + flip
   * users.status back to 'active' instead of refusing.
   */
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

    const tempPassword = this.generateTempPassword();
    const hash = await bcrypt.hash(tempPassword, this.bcryptCost);
    const email = client.email.toLowerCase();

    // RE-ENABLE path: client.user_id already set + is_portal_enabled
    // is false. Reactivate the existing user row, reset its password,
    // flip the flag, and revoke any stale refresh tokens.
    if (client.user_id && !client.is_portal_enabled) {
      const linked = await this.db
        .selectFrom('users')
        .select(['id', 'status'])
        .where('id', '=', client.user_id)
        .executeTakeFirst();
      if (!linked) {
        throw new BadRequestException(
          'Client links to a user_id that no longer exists. Clear the user_id and re-enable.',
        );
      }
      const userId = await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('users')
          .set({ password_hash: hash, status: 'active' })
          .where('id', '=', client.user_id as string)
          .execute();
        await trx
          .updateTable('clients')
          .set({ is_portal_enabled: true })
          .where('id', '=', clientId)
          .execute();
        // Belt-and-suspenders — disable() already revokes, but if
        // any token slipped in between, kill it now too.
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
            action: 'client.portal.reenable',
            entity_type: 'client',
            entity_id: clientId,
            metadata: sql`${JSON.stringify({ user_id: client.user_id })}::jsonb`,
          })
          .execute();
        return client.user_id as string;
      });
      return { temp_password: tempPassword, user_id: userId };
    }

    // Already-active path: nothing to do, surface a clear error.
    if (client.user_id && client.is_portal_enabled) {
      throw new BadRequestException('Client already has portal access');
    }

    // FRESH path: no user_id yet — create one.
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

  /**
   * Latest GReminders events linked to this client via the webhook
   * ingest path (integrations/greminders-webhook.controller). Each row
   * is one audit_logs entry with action like `greminders_booking.*`
   * (created / updated / canceled / confirmed / declined — whatever
   * change_type GReminders emits). Metadata JSON carries the event id,
   * service name, and start/end times for display.
   *
   * Returns the entries sorted newest-first. Empty array when nothing
   * has been recorded yet.
   */
  async getGremindersActivity(clientId: string, limit: number) {
    // Validate the client exists (404 if not) — keeps error handling
    // consistent with getTimeline().
    await this.getById(clientId);

    const rows = await this.db
      .selectFrom('audit_logs')
      .select([
        'id',
        'action',
        'metadata',
        sql<Date>`created_at`.as('created_at'),
      ])
      .where('entity_type', '=', 'client')
      .where('entity_id', '=', clientId)
      .where(sql<boolean>`action LIKE 'greminders_booking.%'`)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map((r) => {
      const md = (r.metadata as Record<string, unknown> | null) ?? {};
      // `action` is 'greminders_booking.<change_type>' — strip the
      // prefix for a concise display value.
      const changeType = String(r.action).replace(/^greminders_booking\./, '');
      return {
        id: r.id,
        change_type: changeType,
        at: r.created_at,
        greminders_event_id: (md.greminders_event_id as string | null) ?? null,
        service: (md.service as string | null) ?? null,
        start_time: (md.start_time as string | null) ?? null,
        end_time: (md.end_time as string | null) ?? null,
        location: (md.location as string | null) ?? null,
        attendee_email: (md.attendee_email as string | null) ?? null,
      };
    });
  }

  /**
   * Read the full history timeline for the client-detail page.
   *
   * 2026-onward policy (Apr 2026): historical_invoices entries dated
   * 2026-01-01 or later are treated as operationally live — they show
   * up in client timelines AND wholesale AP the same way a real
   * invoices row would. Pre-2026 historical entries stay archive-only
   * (KPI rollup feed, not surfaced to client/AP pages). The
   * rationale: operators were booking fresh 2026 vendor POs via the
   * historical-invoices form (no line items / inventory side-effects
   * needed) and then losing visibility in downstream views.
   */
  async getTimeline(clientId: string, opts: { actorUserId?: string } = {}) {
    // getById applies the owner-privacy gate; non-allowlisted callers
    // get a 404 here so timeline detail can't leak around the client
    // detail block.
    await this.getById(clientId, opts);

    const [liveInvoices, histInvoices, quotes, requests, shipments] = await Promise.all([
      this.db
        .selectFrom('invoices')
        .select([
          'id',
          'invoice_number',
          'type',
          'status',
          'payment_status',
          'total',
          'created_at',
        ])
        .where('client_id', '=', clientId)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute(),
      // 2026+ historical invoices for this client, mapped into the
      // same shape the timeline UI already renders. `status` is
      // synthesized as 'finalized' because historical rows don't
      // carry a lifecycle column; `invoice_number` uses reference
      // when available, otherwise a short synthetic tag so the row
      // still looks like an invoice in the list.
      this.db
        .selectFrom('historical_invoices')
        .select((eb) => [
          'id',
          eb.fn.coalesce(
            'reference',
            sql<string>`'HIST-' || substring(id::text, 1, 8)`,
          ).as('invoice_number'),
          'type',
          sql<string>`'finalized'`.as('status'),
          // Auto-paid rule: any historical invoice with a date 30+ days
          // in the past is assumed settled. Captures the operator's
          // mental model — "if it's been on the books a month, it's
          // been paid." Anything within the last 30 days stays
          // 'unpaid' so it shows up as outstanding in client + AP
          // views until the operator deletes the row (or the 30-day
          // window naturally expires).
          sql<string>`case when date <= current_date - interval '30 days' then 'paid' else 'unpaid' end`.as(
            'payment_status',
          ),
          sql<string>`amount::text`.as('total'),
          sql<Date>`date::timestamptz`.as('created_at'),
        ])
        .where('client_id', '=', clientId)
        .where(sql<boolean>`date >= '2026-01-01'::date`)
        .orderBy('date', 'desc')
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

    // Merge live + 2026+ historical invoices into one list, newest
    // first. The UI doesn't care which table each row came from —
    // both render the same way.
    const invoices = [...liveInvoices, ...histInvoices].sort((a, b) => {
      const ad = new Date(a.created_at as unknown as string | Date).getTime();
      const bd = new Date(b.created_at as unknown as string | Date).getTime();
      return bd - ad;
    });

    return { invoices, quotes, requests, shipments };
  }

  /**
   * Export selected client-file fields plus invoice history rollups.
   *
   * Invoice type mapping follows AGC Desk semantics:
   *   - type='sell' means the client bought from AGC.
   *   - type='buy' means the client sold to AGC.
   *
   * Canceled invoices are ignored so a dead draft/canceled sale does not
   * accidentally put a client into a marketing/export bucket.
   */
  async exportSelected(
    ids: string[],
    opts: {
      actorUserId: string;
      historyFilter: ClientExportHistoryFilter;
    },
  ): Promise<{ filename: string; csv: string; rowCount: number }> {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) {
      return {
        filename: this.clientExportFilename(opts.historyFilter),
        csv: toCsv([]),
        rowCount: 0,
      };
    }

    const allowOwnerPrivate = await canViewOwnerPrivate(this.db, opts.actorUserId);
    let q = this.db
      .selectFrom('clients')
      .selectAll()
      .where('id', 'in', uniqueIds);
    if (!allowOwnerPrivate) q = q.where('is_owner_private', '=', false);

    const clients = await q
      .orderBy('last_name')
      .orderBy('first_name')
      .orderBy('company')
      .execute();

    if (clients.length === 0) {
      return {
        filename: this.clientExportFilename(opts.historyFilter),
        csv: toCsv([]),
        rowCount: 0,
      };
    }

    const visibleIds = clients.map((c) => c.id);
    const invoiceStats = await this.db
      .selectFrom('invoices')
      .select([
        'client_id',
        sql<string>`count(*) filter (where status <> 'canceled')`.as('invoice_count'),
        sql<string>`count(*) filter (where type = 'sell' and status <> 'canceled')`.as(
          'bought_from_us_count',
        ),
        sql<string>`coalesce(sum(total) filter (where type = 'sell' and status <> 'canceled'), 0)::text`.as(
          'bought_from_us_total',
        ),
        sql<Date | null>`max(created_at) filter (where type = 'sell' and status <> 'canceled')`.as(
          'bought_from_us_last_at',
        ),
        sql<string>`count(*) filter (where type = 'buy' and status <> 'canceled')`.as(
          'sold_to_us_count',
        ),
        sql<string>`coalesce(sum(total) filter (where type = 'buy' and status <> 'canceled'), 0)::text`.as(
          'sold_to_us_total',
        ),
        sql<Date | null>`max(created_at) filter (where type = 'buy' and status <> 'canceled')`.as(
          'sold_to_us_last_at',
        ),
      ])
      .where('client_id', 'in', visibleIds)
      .groupBy('client_id')
      .execute();

    const statsByClient = new Map<string, ClientInvoiceStats>();
    for (const s of invoiceStats) {
      statsByClient.set(s.client_id, {
        invoice_count: Number(s.invoice_count),
        bought_from_us_count: Number(s.bought_from_us_count),
        bought_from_us_total: s.bought_from_us_total,
        bought_from_us_last_at: s.bought_from_us_last_at,
        sold_to_us_count: Number(s.sold_to_us_count),
        sold_to_us_total: s.sold_to_us_total,
        sold_to_us_last_at: s.sold_to_us_last_at,
      });
    }

    const rows = clients
      .map((client) => {
        const stats =
          statsByClient.get(client.id) ??
          ({
            invoice_count: 0,
            bought_from_us_count: 0,
            bought_from_us_total: '0',
            bought_from_us_last_at: null,
            sold_to_us_count: 0,
            sold_to_us_total: '0',
            sold_to_us_last_at: null,
          } satisfies ClientInvoiceStats);
        return { client, stats };
      })
      .filter(({ stats }) => matchesHistoryFilter(stats, opts.historyFilter))
      .map(({ client, stats }) => ({
        client_id: client.id,
        client_type: client.client_type,
        first_name: client.first_name ?? '',
        last_name: client.last_name ?? '',
        company: client.company ?? '',
        email: client.email ?? '',
        secondary_emails: (client.secondary_emails ?? []).join('; '),
        phone: client.phone ?? '',
        address_line1: client.address_line1 ?? '',
        address_line2: client.address_line2 ?? '',
        city: client.city ?? '',
        region: client.region ?? '',
        postal_code: client.postal_code ?? '',
        country: client.country ?? '',
        heard_from: client.heard_from ?? '',
        notes: client.notes ?? '',
        portal_enabled: client.is_portal_enabled ? 'yes' : 'no',
        has_portal_user: client.user_id ? 'yes' : 'no',
        exclude_from_reports: client.exclude_from_reports ? 'yes' : 'no',
        is_owner_private: client.is_owner_private ? 'yes' : 'no',
        invoice_count: String(stats.invoice_count),
        bought_from_us_count: String(stats.bought_from_us_count),
        bought_from_us_total: stats.bought_from_us_total,
        bought_from_us_last_at: formatExportDate(stats.bought_from_us_last_at),
        sold_to_us_count: String(stats.sold_to_us_count),
        sold_to_us_total: stats.sold_to_us_total,
        sold_to_us_last_at: formatExportDate(stats.sold_to_us_last_at),
        created_at: formatExportDate(client.created_at),
        updated_at: formatExportDate(client.updated_at),
      }));

    return {
      filename: this.clientExportFilename(opts.historyFilter),
      csv: toCsv(rows),
      rowCount: rows.length,
    };
  }

  /**
   * Hard-delete a single client. Blocks if there are any invoices attached
   * — historical totals + audit depends on the client row existing. Staff
   * must archive by disabling the portal + clearing PII instead.
   */
  async delete(clientId: string, actorUserId: string): Promise<void> {
    const client = await this.getById(clientId);
    const invoiceCount = await this.db
      .selectFrom('invoices')
      .select(this.db.fn.count<string>('id').as('n'))
      .where('client_id', '=', clientId)
      .executeTakeFirstOrThrow();
    if (Number(invoiceCount.n) > 0) {
      throw new BadRequestException(
        `Cannot delete — ${invoiceCount.n} invoice(s) reference this client. Delete invoices first or archive instead.`,
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('clients').where('id', '=', clientId).execute();
      // Disable any linked login user so a stale portal session can't outlive
      // the client row. We intentionally keep the users row for audit history.
      if (client.user_id) {
        await trx
          .updateTable('users')
          .set({ status: 'disabled' })
          .where('id', '=', client.user_id)
          .execute();
      }
      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: actorUserId,
          action: 'client.delete',
          entity_type: 'client',
          entity_id: clientId,
          metadata: sql`${JSON.stringify({
            first_name: client.first_name,
            last_name: client.last_name,
            email: client.email,
          })}::jsonb`,
        })
        .execute();
    });
  }

  /**
   * Delete many clients, skipping any that still have invoices attached.
   * Returns a summary so the UI can render "X deleted, Y skipped (reason)".
   */
  async bulkDelete(
    ids: string[],
    actorUserId: string,
  ): Promise<{ deleted: number; skipped: Array<{ id: string; reason: string }> }> {
    if (ids.length === 0) return { deleted: 0, skipped: [] };

    // Find which ids still have invoices — those are the ones to skip.
    const blocked = await this.db
      .selectFrom('invoices')
      .select(['client_id', this.db.fn.count<string>('id').as('n')])
      .where('client_id', 'in', ids)
      .groupBy('client_id')
      .execute();
    const blockedByClient = new Map(blocked.map((r) => [r.client_id, Number(r.n)]));

    const deletable = ids.filter((id) => !blockedByClient.has(id));
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      if (blockedByClient.has(id)) {
        skipped.push({
          id,
          reason: `Has ${blockedByClient.get(id)} invoice(s)`,
        });
      }
    }
    if (deletable.length === 0) {
      return { deleted: 0, skipped };
    }

    // Capture the rows we're about to delete so the audit log has something
    // to point at. One roundtrip, no-op if any IDs are missing.
    const victims = await this.db
      .selectFrom('clients')
      .select(['id', 'first_name', 'last_name', 'email', 'user_id'])
      .where('id', 'in', deletable)
      .execute();

    const deleted = await this.db.transaction().execute(async (trx) => {
      const out = await trx
        .deleteFrom('clients')
        .where('id', 'in', deletable)
        .executeTakeFirst();
      const userIds = victims.map((v) => v.user_id).filter((x): x is string => !!x);
      if (userIds.length) {
        await trx
          .updateTable('users')
          .set({ status: 'disabled' })
          .where('id', 'in', userIds)
          .execute();
      }
      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: actorUserId,
          action: 'client.bulk_delete',
          entity_type: 'client',
          entity_id: null,
          metadata: sql`${JSON.stringify({
            deleted: victims.length,
            ids: victims.map((v) => v.id),
          })}::jsonb`,
        })
        .execute();
      return Number(out.numDeletedRows ?? 0);
    });
    return { deleted, skipped };
  }

  /**
   * Merge one or more duplicate client rows into a canonical keeper.
   *
   * Steps, all inside one transaction:
   *   1. Verify keeper + losers exist and are distinct.
   *   2. Re-point foreign keys from each loser to the keeper:
   *        invoices, price_quotes, deal_requests, audit_logs (entity_id).
   *        Shipments are linked via invoice_id, so they ride along for free.
   *   3. Backfill any null field on the keeper from the losers in order
   *      (first non-null wins). Keeps useful data that might only live on
   *      a duplicate — email, phone, address, notes, heard_from.
   *   4. Delete the loser rows. If any loser had a linked portal user, we
   *      disable it so the stale login can't outlive the row.
   *   5. Emit one client.merge audit event with { keeper, losers }.
   *
   * Returns the merged count.
   */
  async merge(
    keeperId: string,
    loserIds: string[],
    actorUserId: string,
  ): Promise<{ merged: number; keeper_id: string }> {
    const uniqLosers = Array.from(new Set(loserIds)).filter((id) => id !== keeperId);
    if (uniqLosers.length === 0) return { merged: 0, keeper_id: keeperId };

    return this.db.transaction().execute(async (trx) => {
      const keeper = await trx
        .selectFrom('clients')
        .selectAll()
        .where('id', '=', keeperId)
        .executeTakeFirst();
      if (!keeper) throw new NotFoundException('Keeper client not found');

      const losers = await trx
        .selectFrom('clients')
        .selectAll()
        .where('id', 'in', uniqLosers)
        .execute();
      if (losers.length !== uniqLosers.length) {
        throw new BadRequestException('One or more losers not found');
      }

      // 2. Re-point FKs. Kysely's update with IN is a single roundtrip per
      //    table, which is fine for the handful of tables that reference
      //    client_id.
      await trx
        .updateTable('invoices')
        .set({ client_id: keeperId })
        .where('client_id', 'in', uniqLosers)
        .execute();
      await trx
        .updateTable('price_quotes')
        .set({ client_id: keeperId })
        .where('client_id', 'in', uniqLosers)
        .execute();
      await trx
        .updateTable('deal_requests')
        .set({ client_id: keeperId })
        .where('client_id', 'in', uniqLosers)
        .execute();
      // Audit logs point at the entity id string; rewrite those too so the
      // client detail timeline shows the combined history.
      await trx
        .updateTable('audit_logs')
        .set({ entity_id: keeperId })
        .where('entity_type', '=', 'client')
        .where('entity_id', 'in', uniqLosers)
        .execute();

      // 3. Backfill keeper nulls from the first loser that has a value.
      //    We do this in TS so the "first non-null wins" semantics are
      //    crystal clear rather than hiding in COALESCE SQL.
      const fillable: Array<keyof typeof keeper> = [
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
      ];
      const patch: Record<string, unknown> = {};
      for (const k of fillable) {
        if (keeper[k] == null) {
          for (const l of losers) {
            if (l[k] != null) {
              patch[k as string] = l[k];
              break;
            }
          }
        }
      }
      if (Object.keys(patch).length > 0) {
        await trx.updateTable('clients').set(patch).where('id', '=', keeperId).execute();
      }

      // 4. Disable any portal logins tied to the losers, then delete rows.
      const loserUserIds = losers.map((l) => l.user_id).filter((x): x is string => !!x);
      if (loserUserIds.length) {
        await trx
          .updateTable('users')
          .set({ status: 'disabled' })
          .where('id', 'in', loserUserIds)
          .execute();
      }
      await trx.deleteFrom('clients').where('id', 'in', uniqLosers).execute();

      // 5. Audit.
      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: actorUserId,
          action: 'client.merge',
          entity_type: 'client',
          entity_id: keeperId,
          metadata: sql`${JSON.stringify({
            keeper_id: keeperId,
            loser_ids: uniqLosers,
            backfilled_fields: Object.keys(patch),
          })}::jsonb`,
        })
        .execute();

      return { merged: uniqLosers.length, keeper_id: keeperId };
    });
  }

  private generateTempPassword(): string {
    // 14 chars, base64 → strip ambiguous chars. Guaranteed to meet the 12-char
    // + letter + digit minimum from the auth validator.
    const raw = randomBytes(12).toString('base64').replace(/[+/=]/g, '');
    // Ensure at least one digit + one letter by construction.
    return `${raw.slice(0, 10)}${Math.floor(Math.random() * 10)}A`;
  }

  private clientExportFilename(filter: ClientExportHistoryFilter): string {
    const stamp = new Date().toISOString().slice(0, 10);
    return `agc-clients-${filter}-${stamp}.csv`;
  }
}

function matchesHistoryFilter(
  stats: ClientInvoiceStats,
  filter: ClientExportHistoryFilter,
): boolean {
  const bought = stats.bought_from_us_count > 0;
  const sold = stats.sold_to_us_count > 0;
  switch (filter) {
    case 'bought_from_us':
      return bought;
    case 'sold_to_us':
      return sold;
    case 'bought_or_sold':
      return bought || sold;
    case 'bought_and_sold':
      return bought && sold;
    case 'no_history':
      return !bought && !sold;
    case 'all':
    default:
      return true;
  }
}

function formatExportDate(value: Date | string | null): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function toCsv(rows: Array<Record<string, string>>): string {
  const headers = rows[0] ? Object.keys(rows[0]) : [
    'client_id',
    'client_type',
    'first_name',
    'last_name',
    'company',
    'email',
    'secondary_emails',
    'phone',
    'address_line1',
    'address_line2',
    'city',
    'region',
    'postal_code',
    'country',
    'heard_from',
    'notes',
    'portal_enabled',
    'has_portal_user',
    'exclude_from_reports',
    'is_owner_private',
    'invoice_count',
    'bought_from_us_count',
    'bought_from_us_total',
    'bought_from_us_last_at',
    'sold_to_us_count',
    'sold_to_us_total',
    'sold_to_us_last_at',
    'created_at',
    'updated_at',
  ];
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header] ?? '')).join(',')),
  ];
  return `\uFEFF${lines.join('\n')}\n`;
}

function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Lowercase, trim, dedupe, drop blanks, and remove `primary` (if set) from
 * the secondary-email array. Returns a stable sorted array so equality
 * checks on the JSONB value don't ping the column when nothing actually
 * changed.
 */
function normalizeEmails(
  raw: string[] | undefined,
  primary: string | null | undefined,
): string[] {
  if (!raw) return [];
  const primaryLower = primary?.trim().toLowerCase() ?? null;
  const seen = new Set<string>();
  for (const e of raw) {
    if (typeof e !== 'string') continue;
    const v = e.trim().toLowerCase();
    if (!v) continue;
    if (v === primaryLower) continue;
    seen.add(v);
  }
  return Array.from(seen).sort();
}

/**
 * Best-effort split of "First Last" (or "First Middle Last") into first +
 * last. Used only when we auto-create a client from a calendar booking —
 * operators can edit afterwards. If the input has only one token we put it
 * in first_name and leave last_name blank (the DB accepts a null there as
 * of migration 020).
 */
function splitName(raw: string): { first?: string; last?: string } {
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (!cleaned) return {};
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}
