import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type {
  DB,
  Invoice,
  InvoiceLineItem,
  InvoiceStatus,
  InvoiceType,
  PaymentMethod,
  UserRole,
} from '../db/types';
import { d, toDbString, Decimal } from '../common/money';
import { canViewOwnerPrivate } from '../common/owner-privacy.helper';
import { PricingService } from '../pricing/pricing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InventoryService } from '../inventory/inventory.service';
import { EmailService } from '../email/email.service';
import { SettingsService } from '../settings/settings.service';
import { RestockService } from '../restock/restock.service';
import { InvoicePdfService } from './invoice-pdf.service';
import type { CreateInvoiceDto } from './dto/create-invoice.dto';

export interface InvoiceWithLines extends Invoice {
  client_name: string;
  /** Separate first-name field so email templates can greet "Hi John" instead of "Hi John Smith". */
  client_first_name: string | null;
  client_last_name: string | null;
  client_email: string | null;
  /** Whether the backing client is wholesale — drives the "Mark Paid" button + WH reports. */
  client_type?: 'retail' | 'wholesaler';
  client_company?: string | null;
  /** Display name of the staff/admin who created this invoice. */
  created_by_name?: string | null;
  /** Email of the creator — fallback identifier on the detail page. */
  created_by_email?: string | null;
  line_items: InvoiceLineItem[];
}

interface Actor {
  id: string;
  role: UserRole;
}

@Injectable()
export class InvoicesService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly pricing: PricingService,
    private readonly notifications: NotificationsService,
    private readonly inventory: InventoryService,
    private readonly email: EmailService,
    private readonly pdf: InvoicePdfService,
    private readonly settings: SettingsService,
    private readonly restock: RestockService,
  ) {}

  /** Resolve the client record owned by the given user. Throws if none. */
  async resolveClientIdForUser(userId: string): Promise<string> {
    const row = await this.db
      .selectFrom('clients')
      .select('id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw new ForbiddenException('No client profile linked to this account');
    return row.id;
  }

  listForClientUser(userId: string): Promise<Invoice[]> {
    return this.resolveClientIdForUser(userId).then((clientId) =>
      this.list({ clientId }),
    );
  }

  async getByIdForClientUser(userId: string, invoiceId: string): Promise<InvoiceWithLines> {
    const clientId = await this.resolveClientIdForUser(userId);
    const row = await this.getById(invoiceId);
    if (row.client_id !== clientId) {
      throw new ForbiddenException('Not your invoice');
    }
    // Strip premium_type + premium_value from line items — these snapshot
    // our buy/sell formula at invoice-create time and must never hit the
    // client (they'd reveal our margin math per product). Clients see the
    // final unit_price + line_total; the derivation stays server-side.
    return {
      ...row,
      line_items: row.line_items.map((l) => {
        // Intentional rebuild without the two sensitive keys. Keeping
        // it as a mapper (vs delete-on-object) avoids mutating the
        // admin-cached copy if the service ever gets a request cache.
        const {
          premium_type: _pt,
          premium_value: _pv,
          ...rest
        } = l;
        void _pt;
        void _pv;
        return rest as typeof l;
      }),
    };
  }

  async list(
    opts: {
      clientId?: string;
      status?: InvoiceStatus;
      type?: InvoiceType;
      /** 'wholesaler' or 'retail' — joins clients to filter by segment. */
      client_type?: 'retail' | 'wholesaler';
      /** Include clients flagged exclude_from_reports. Default false
       *  (filter them out). Set true only when drilling into a specific
       *  client — e.g. the client detail page — where hiding invoices
       *  from the client they belong to would be confusing. */
      includeExcluded?: boolean;
      /**
       * Caller's user id, used to enforce the owner-privacy allowlist
       * (migration 038). When set, non-allowlisted users have
       * is_owner_private clients' invoices filtered out entirely. When
       * undefined (e.g. internal callers like the EOD service that
       * shouldn't apply privacy), the filter is skipped.
       */
      actorUserId?: string;
    } = {},
  ): Promise<Array<Invoice & { client_name: string; client_type: string }>> {
    // Owner-privacy filter: hide is_owner_private clients' invoices
    // from any caller not on users.can_view_owner_private. Bypass
    // when no actor is supplied (internal aggregation callers).
    const allowOwnerPrivate = opts.actorUserId
      ? await canViewOwnerPrivate(this.db, opts.actorUserId)
      : true;
    // Include client name + type with the invoice so the tab'd list view
    // can render rows without a second roundtrip.
    let q = this.db
      .selectFrom('invoices as i')
      .innerJoin('clients as c', 'c.id', 'i.client_id')
      .selectAll('i')
      .select([
        sql<string>`coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.company, '(unnamed)')`.as(
          'client_name',
        ),
        'c.client_type as client_type',
      ])
      .orderBy('i.created_at', 'desc')
      .limit(500);
    if (opts.clientId) q = q.where('i.client_id', '=', opts.clientId);
    if (opts.status) q = q.where('i.status', '=', opts.status);
    if (opts.type) q = q.where('i.type', '=', opts.type);
    if (opts.client_type) q = q.where('c.client_type', '=', opts.client_type);
    // Global list views hide "excluded" clients' invoices by default —
    // owner/test clients stay out of revenue + AR surfaces. Passing
    // includeExcluded=true or clientId bypasses the filter.
    if (!opts.includeExcluded && !opts.clientId) {
      q = q.where('c.exclude_from_reports', '=', false);
    }
    if (!allowOwnerPrivate) {
      // Hide rows whose client is owner-private — applies to both the
      // global list and any clientId-filtered query (a non-allowlisted
      // user reaching the URL with a private client_id should still
      // see nothing, same as the empty list).
      q = q.where('c.is_owner_private', '=', false);
    }
    return q.execute() as unknown as Promise<
      Array<Invoice & { client_name: string; client_type: string }>
    >;
  }

  async getById(
    id: string,
    opts: { actorUserId?: string } = {},
  ): Promise<InvoiceWithLines> {
    const invoice = await this.db
      .selectFrom('invoices as i')
      .innerJoin('clients as c', 'c.id', 'i.client_id')
      // Left-join the creator's user record so we can show
      // "Created by Hunter Rhodes" on the detail page + PDF without
      // a second roundtrip. Left-join (not inner) because
      // created_by_user_id is nullable for legacy / imported rows.
      .leftJoin('users as u', 'u.id', 'i.created_by_user_id')
      .selectAll('i')
      .select([
        sql<string>`coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.company, '(unnamed)')`.as(
          'client_name',
        ),
        'c.first_name as client_first_name',
        'c.last_name as client_last_name',
        'c.email as client_email',
        'c.client_type as client_type',
        'c.company as client_company',
        'c.is_owner_private as client_is_owner_private',
        // Creator display name: derived from the email's local-part
        // (everything before the @) and capitalized via initcap.
        // Users table only stores email — first/last names live on
        // the clients table for end-customers, not on staff rows.
        // For legacy invoices with no created_by_user_id, the
        // left-join produces NULL email and the entire expression
        // evaluates NULL — UI side just hides the line.
        sql<string | null>`initcap(split_part(u.email, '@', 1))`.as(
          'created_by_name',
        ),
        'u.email as created_by_email',
      ])
      .where('i.id', '=', id)
      .executeTakeFirst();

    if (!invoice) throw new NotFoundException('Invoice not found');

    // Owner-privacy gate: 404 (not 403) if the invoice belongs to an
    // is_owner_private client and the caller isn't on the allowlist.
    // 404 keeps the existence of the record itself confidential —
    // the caller can't distinguish "blocked" from "doesn't exist."
    if (
      (invoice as { client_is_owner_private?: boolean }).client_is_owner_private &&
      opts.actorUserId &&
      !(await canViewOwnerPrivate(this.db, opts.actorUserId))
    ) {
      throw new NotFoundException('Invoice not found');
    }

    const lines = await this.db
      .selectFrom('invoice_line_items')
      .selectAll()
      .where('invoice_id', '=', id)
      .orderBy('position')
      .execute();

    return {
      ...(invoice as Invoice & {
        client_name: string;
        client_first_name: string | null;
        client_last_name: string | null;
        client_email: string | null;
        client_type: 'retail' | 'wholesaler';
        client_company: string | null;
        created_by_name: string | null;
        created_by_email: string | null;
      }),
      line_items: lines,
    };
  }

  /**
   * Create an invoice atomically:
   *   - validate client exists
   *   - for each line: call pricing engine (product override > metal default)
   *   - snapshot unit_price, metal content, spot, premium into line items
   *   - sum to invoice.subtotal/total
   *   - allocate invoice_number from the Postgres sequence
   */
  async create(dto: CreateInvoiceDto, actor: Actor): Promise<InvoiceWithLines> {
    // Reject overrides from non-admins early with a clean error.
    const hasOverride = dto.line_items.some((li) => li.override_unit_price !== undefined);
    if (hasOverride && actor.role !== 'admin') {
      throw new ForbiddenException('Only admins can override unit prices');
    }

    // Payment method is required — either a legacy single method or at
    // least one entry in the multi-payment array. Normalize so the row
    // always has *both* columns populated for back-compat and reporting.
    const multi = dto.payment_methods ?? [];
    const primary = dto.payment_method ?? multi[0]?.method;
    if (!primary) {
      throw new BadRequestException(
        'Payment method is required. Provide payment_method or at least one payment_methods entry.',
      );
    }

    // Validate ad-hoc lines up front so we throw ONE clean error
    // instead of a cryptic pricing.quote failure. An ad-hoc line
    // (no product_id) must carry a custom_name AND an
    // override_unit_price — pricing is operator-entered.
    for (const li of dto.line_items) {
      if (!li.product_id) {
        if (!li.custom_name || li.custom_name.trim().length === 0) {
          throw new BadRequestException(
            'Ad-hoc line items require a custom_name',
          );
        }
        if (li.override_unit_price === undefined) {
          throw new BadRequestException(
            `Ad-hoc line "${li.custom_name}" requires a unit price`,
          );
        }
      }
    }

    // Pre-compute quotes outside the transaction (reads from Redis + Postgres).
    // Ad-hoc lines skip pricing.quote and carry null quote — the insert
    // path below branches on product_id presence.
    const quotes = await Promise.all(
      dto.line_items.map(async (li) => {
        if (!li.product_id) return { li, quote: null };
        const quote = await this.pricing.quote(li.product_id, li.quantity);
        return { li, quote };
      }),
    );

    const result = await this.db.transaction().execute(async (trx) => {
      const client = await trx
        .selectFrom('clients')
        .select(['id'])
        .where('id', '=', dto.client_id)
        .executeTakeFirst();
      if (!client) throw new NotFoundException('Client not found');

      // Allocate invoice_number: YYYY-000123
      const { nextval } = await sql<{
        nextval: string;
      }>`select nextval('invoice_number_seq')`
        .execute(trx)
        .then((r) => r.rows[0]);
      const year = new Date().getUTCFullYear();
      const invoiceNumber = `${year}-${String(nextval).padStart(6, '0')}`;

      let subtotal = d(0);
      const lineInserts: Array<{
        invoice_id: string;
        product_id: string | null;
        position: number;
        quantity: number;
        product_name_snapshot: string;
        gross_weight_troy_oz: string;
        purity: string;
        metal_content_troy_oz: string;
        spot_price_per_oz: string;
        premium_type: 'percent' | 'flat';
        premium_value: string;
        unit_price: string;
        line_total: string;
        is_overridden: boolean;
        override_reason: string | null;
        override_by_user_id: string | null;
      }> = [];

      const invoice = await trx
        .insertInto('invoices')
        .values({
          invoice_number: invoiceNumber,
          client_id: dto.client_id,
          type: dto.type,
          status: 'draft',
          subtotal: '0',
          tax: toDbString(dto.tax ?? 0),
          shipping: toDbString(dto.shipping ?? 0),
          total: '0',
          payment_method: primary,
          // JSONB columns need an explicit cast — pg's type inference on
          // parameterized values drops to text otherwise. Pattern mirrors
          // what audit_logs.metadata uses elsewhere in this service.
          payment_methods: sql`${JSON.stringify(
            multi.map((m) => ({
              method: m.method,
              reference: m.reference ?? null,
              amount: toDbString(m.amount),
            })),
          )}::jsonb`,
          notes: dto.notes ?? null,
          // Manual timestamp override for backdated tickets (walk-in from
          // yesterday written up today). Omitted → DB default NOW(). We
          // deliberately write created_at — the updated_at column keeps
          // tracking real insert time via its own default so the audit
          // trail stays honest.
          created_at: dto.transacted_at ? new Date(dto.transacted_at) : undefined,
          created_by_user_id: actor.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      quotes.forEach(({ li, quote }, idx) => {
        const isAdHoc = !li.product_id;
        const useOverride = li.override_unit_price !== undefined;
        // Ad-hoc lines are always operator-priced (validated above).
        // Catalog lines take the override when set, else the live quote.
        const unitPrice = isAdHoc
          ? d(li.override_unit_price!)
          : useOverride
            ? d(li.override_unit_price!)
            : dto.type === 'sell'
              ? d(quote!.sell_unit_price)
              : d(quote!.buy_unit_price);
        const lineTotal = unitPrice.times(li.quantity);
        subtotal = subtotal.plus(lineTotal);

        // Premium fields exist on every line_item row (NOT NULL on
        // migration 005 — invoice history snapshot). For ad-hoc lines
        // we zero-fill with premium_type='flat', premium_value='0' —
        // the operator-entered unit price IS the premium, no formula.
        const premiumType: 'percent' | 'flat' = isAdHoc
          ? 'flat'
          : dto.type === 'sell'
            ? quote!.sell_premium_type
            : quote!.buy_premium_type;
        const premiumValue = isAdHoc
          ? '0'
          : dto.type === 'sell'
            ? quote!.sell_premium_value
            : quote!.buy_premium_value;

        lineInserts.push({
          invoice_id: invoice.id,
          product_id: li.product_id ?? null,
          position: idx + 1,
          quantity: li.quantity,
          product_name_snapshot:
            li.custom_name && li.custom_name.trim().length > 0
              ? li.custom_name.trim()
              : quote!.product_name,
          // Snapshot all three product physical attributes INDEPENDENTLY so an
          // audit of this invoice years later can reproduce the math without
          // re-reading a potentially-mutated product record.
          //   weight  — gross troy oz per unit (e.g. 1.0909 for a Gold Eagle)
          //   purity  — fineness fraction      (e.g. 0.9167)
          //   content — weight * purity        (e.g. ~1.0000)
          // Ad-hoc lines have no product to snapshot; zero-fill so
          // the NOT NULL columns take a value. The PDF + detail view
          // render the custom_name, so the numeric zeros aren't
          // surfaced — they only exist for schema compliance.
          gross_weight_troy_oz: isAdHoc ? '0' : quote!.product_weight_troy_oz,
          purity: isAdHoc ? '0' : quote!.product_purity,
          metal_content_troy_oz: isAdHoc ? '0' : quote!.metal_content_per_unit,
          spot_price_per_oz: isAdHoc ? '0' : quote!.spot_per_oz,
          premium_type: premiumType,
          premium_value: premiumValue,
          unit_price: toDbString(unitPrice),
          line_total: toDbString(lineTotal),
          is_overridden: useOverride,
          override_reason: useOverride ? li.override_reason ?? null : null,
          override_by_user_id: useOverride ? actor.id : null,
        });
      });

      await trx.insertInto('invoice_line_items').values(lineInserts).execute();

      const total = subtotal.plus(d(dto.tax ?? 0)).plus(d(dto.shipping ?? 0));
      const updated = await trx
        .updateTable('invoices')
        .set({
          subtotal: toDbString(subtotal),
          total: toDbString(total),
        })
        .where('id', '=', invoice.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: actor.id,
          action: 'invoice.create',
          entity_type: 'invoice',
          entity_id: invoice.id,
          metadata: sql`${JSON.stringify({ invoice_number: invoiceNumber, total: toDbString(total) })}::jsonb`,
        })
        .execute();

      return this.assembleInvoice(trx, updated.id);
    });

    // Notify the client (outside the tx so notification failures don't roll back the invoice).
    await this.notifications.notifyClient(result.client_id, {
      type: 'invoice.created',
      title: `New ${result.type === 'sell' ? 'invoice' : 'buy ticket'}: ${result.invoice_number}`,
      body: `Total $${Number(result.total).toFixed(2)}`,
      link: `/dashboard/transactions/${result.id}`,
      metadata: { invoice_id: result.id, invoice_number: result.invoice_number },
    });

    return result;
  }

  private async assembleInvoice(trx: Kysely<DB>, id: string): Promise<InvoiceWithLines> {
    const inv = await trx
      .selectFrom('invoices as i')
      .innerJoin('clients as c', 'c.id', 'i.client_id')
      .selectAll('i')
      .select([
        sql<string>`coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.company, '(unnamed)')`.as(
          'client_name',
        ),
        'c.first_name as client_first_name',
        'c.last_name as client_last_name',
        'c.email as client_email',
      ])
      .where('i.id', '=', id)
      .executeTakeFirstOrThrow();

    const lines = await trx
      .selectFrom('invoice_line_items')
      .selectAll()
      .where('invoice_id', '=', id)
      .orderBy('position')
      .execute();

    return {
      ...(inv as Invoice & {
        client_name: string;
        client_first_name: string | null;
        client_last_name: string | null;
        client_email: string | null;
      }),
      line_items: lines,
    };
  }

  /**
   * Header-level edit. Accepts any subset of the metadata columns and
   * rewrites them on the existing invoice row. Totals are recomputed
   * when tax or shipping changes (subtotal comes from line_items, which
   * this endpoint intentionally doesn't touch — line edits belong in a
   * dedicated flow that can also reason about inventory movements).
   *
   * Allowed on any status, including closed invoices, because its main
   * use-case is clerical cleanup on yesterday's walk-in ticket.
   */
  async updateHeader(
    id: string,
    dto: {
      notes?: string | null;
      tax?: number;
      shipping?: number;
      payment_method?: PaymentMethod;
      payment_methods?: Array<{ method: PaymentMethod; reference?: string; amount: number }>;
      transacted_at?: string;
    },
    actor: Actor,
  ): Promise<Invoice> {
    const existing = await this.db
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw new NotFoundException('Invoice not found');

    const patch: Record<string, unknown> = {};
    if (dto.notes !== undefined) patch.notes = dto.notes ?? null;
    if (dto.tax !== undefined) patch.tax = toDbString(dto.tax);
    if (dto.shipping !== undefined) patch.shipping = toDbString(dto.shipping);
    if (dto.payment_method !== undefined) patch.payment_method = dto.payment_method;
    if (dto.payment_methods !== undefined) {
      patch.payment_methods = sql`${JSON.stringify(
        dto.payment_methods.map((m) => ({
          method: m.method,
          reference: m.reference ?? null,
          amount: toDbString(m.amount),
        })),
      )}::jsonb`;
      // Keep the legacy single-method column in sync so the PDF header
      // continues to render the primary method without back-references.
      if (dto.payment_methods.length > 0 && dto.payment_method === undefined) {
        patch.payment_method = dto.payment_methods[0].method;
      }
    }
    if (dto.transacted_at) {
      const newDate = new Date(dto.transacted_at);
      patch.created_at = newDate;
      // KPI buckets, EOD reports, and wholesale-AR aging all key off
      // COALESCE(finalized_at, created_at). Once an invoice exits draft,
      // finalized_at is non-null so created_at alone has no effect on
      // those reports — the operator's date edit appears to do nothing.
      // Realign finalized_at + paid_at to keep the invoice's date
      // representation consistent across every consumer.
      // (Audit log below records previous_finalized_at + previous_paid_at
      // so the original timestamps stay recoverable.)
      if (existing.finalized_at) patch.finalized_at = newDate;
      if (existing.paid_at) patch.paid_at = newDate;
    }

    // Recompute total when tax/shipping moves. Subtotal stays as-is
    // because line items are unchanged.
    const newTax =
      dto.tax !== undefined ? d(dto.tax) : d(existing.tax as unknown as string);
    const newShipping =
      dto.shipping !== undefined ? d(dto.shipping) : d(existing.shipping as unknown as string);
    if (dto.tax !== undefined || dto.shipping !== undefined) {
      const subtotal = d(existing.subtotal as unknown as string);
      patch.total = toDbString(subtotal.plus(newTax).plus(newShipping));
    }

    if (Object.keys(patch).length === 0) {
      return existing as Invoice;
    }

    const updated = await this.db
      .updateTable('invoices')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.db
      .insertInto('audit_logs')
      .values({
        actor_user_id: actor.id,
        action: 'invoice.edit_header',
        entity_type: 'invoice',
        entity_id: id,
        metadata: sql`${JSON.stringify({
          changed_fields: Object.keys(patch),
          previous_status: existing.status,
          // Capture the prior timestamps when transacted_at moves any of
          // them so the original values are recoverable from the audit
          // log if a date correction needs to be undone.
          ...(dto.transacted_at
            ? {
                previous_created_at: existing.created_at,
                previous_finalized_at: existing.finalized_at,
                previous_paid_at: existing.paid_at,
              }
            : {}),
        })}::jsonb`,
      })
      .execute();

    return updated as Invoice;
  }

  async updateStatus(
    id: string,
    status: InvoiceStatus,
    actor: Actor,
    opts: { forceOversell?: boolean } = {},
  ): Promise<Invoice> {
    const current = await this.db
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw new NotFoundException('Invoice not found');

    if (!this.canTransition(current.status, status)) {
      throw new BadRequestException(`Cannot transition ${current.status} → ${status}`);
    }
    if (status === 'canceled' && actor.role !== 'admin') {
      throw new ForbiddenException('Only admins can cancel invoices');
    }
    // Oversell override is admin-only. Silently drop the flag for staff
    // so a mis-checked UI checkbox on a non-admin session can't bypass
    // the guard; the explicit ForbiddenException path is reserved for
    // deliberate attempts (caller would have had to craft the request
    // directly).
    const forceOversell = opts.forceOversell === true && actor.role === 'admin';

    const patch: Partial<{
      status: InvoiceStatus;
      finalized_at: Date;
      paid_at: Date;
      paid_by_user_id: string | null;
      payment_status: 'paid';
    }> = { status };
    if (status === 'finalized') patch.finalized_at = new Date();
    if (status === 'paid') {
      patch.paid_at = new Date();
      // Record who marked it paid — the audit trail for wholesale AR.
      // Cheap to record on every paid-transition; migration 022 added
      // the column. See WH-002.
      patch.paid_by_user_id = actor.id;
      patch.payment_status = 'paid';
      // Walk-in shortcut: draft → paid skips the finalized state
      // entirely. Backfill finalized_at so the timeline still reads
      // "finalized before paid" on the rare report that reads that
      // column. Use the same `now()` as paid_at so the two are
      // co-incident, signaling "both happened in the same click."
      if (!current.finalized_at) {
        patch.finalized_at = patch.paid_at;
      }
    }

    // Inventory policy (driven entirely by status transition):
    //   BUY  invoice:  paid         → +on_hand         (purchase)
    //   SELL invoice:  finalized    → +reserved        (reservation)
    //                  shipped      → -on_hand -reserved (consume)
    //                  canceled*    → -reserved        (release, if held)
    //
    //   * canceled from 'shipped' is a no-op — consumption is irreversible
    //     until we build an explicit return flow.
    //
    // The line-items SELECT inside this block does NOT require product_id to
    // be non-null (see migration 010): a deleted product has product_id=null
    // and is silently skipped here — no inventory to move, history row will
    // still reflect the original sale.
    //
    // Everything below runs inside a single transaction. applyMovement takes
    // a SELECT ... FOR UPDATE on the inventory row, so concurrent finalize
    // attempts for the same product serialize and oversell is impossible.
    const inventoryAction:
      | { kind: 'purchase' }
      | { kind: 'reserve' }
      | { kind: 'consume' }
      | { kind: 'release' }
      | { kind: 'reverse_consume' }
      | { kind: 'direct_sale' }
      | null = this.classifyInventoryAction(current.type, current.status, status);

    const { updatedRow: updated, restockProductIds } = await this.db
      .transaction()
      .execute(async (trx) => {
        const updatedRow = await trx
          .updateTable('invoices')
          .set(patch)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        // Products whose available-on-shelf transitioned from ≤ 0
        // to > 0 during this status change. Collected inside the trx
        // and drained after commit so the back-in-stock notifier
        // reads committed state (never dirty, never racing).
        const restockProductIds: string[] = [];

        if (inventoryAction) {
          const lines = await trx
            .selectFrom('invoice_line_items')
            .select(['product_id', 'quantity', 'unit_price'])
            .where('invoice_id', '=', id)
            .execute();

          for (const line of lines) {
            if (!line.product_id) continue; // product was deleted; nothing to move
            let result: { became_available: boolean } = { became_available: false };
            switch (inventoryAction.kind) {
              case 'purchase':
                result = await this.inventory.applyMovement(trx, {
                  product_id: line.product_id,
                  delta: line.quantity,
                  reason: 'purchase',
                  unit_cost: line.unit_price,
                  invoice_id: id,
                  actor_user_id: actor.id,
                });
                break;
              case 'reserve':
                result = await this.inventory.reserveFor(trx, {
                  product_id: line.product_id,
                  qty: line.quantity,
                  invoice_id: id,
                  actor_user_id: actor.id,
                  force: forceOversell,
                });
                break;
              case 'consume':
                result = await this.inventory.consumeReservationFor(trx, {
                  product_id: line.product_id,
                  qty: line.quantity,
                  invoice_id: id,
                  actor_user_id: actor.id,
                  force: forceOversell,
                });
                break;
              case 'release':
                result = await this.inventory.releaseReservationFor(trx, {
                  product_id: line.product_id,
                  qty: line.quantity,
                  invoice_id: id,
                  actor_user_id: actor.id,
                });
                break;
              case 'reverse_consume':
                // Undo a prior paid-time deduction (return flow on a walk-in
                // sale that was already consumed). reserved_delta stays 0 —
                // the reservation was cleared at the same time we deducted.
                result = await this.inventory.applyMovement(trx, {
                  product_id: line.product_id,
                  delta: line.quantity,
                  reserved_delta: 0,
                  reason: 'return',
                  invoice_id: id,
                  actor_user_id: actor.id,
                });
                break;
              case 'direct_sale':
                // Walk-in retail: draft → paid in one click, no prior
                // reservation. Pull straight off the shelf (delta=-qty,
                // reserved_delta=0). Mirrors the end-state of a normal
                // draft → finalized → paid chain with one fewer
                // movement row. Oversell-guarded same as reserve —
                // admin can force through with the Override box on
                // the wizard or detail page.
                result = await this.inventory.applyMovement(trx, {
                  product_id: line.product_id,
                  delta: -line.quantity,
                  reserved_delta: 0,
                  reason: 'sale',
                  invoice_id: id,
                  actor_user_id: actor.id,
                  force: forceOversell,
                });
                break;
            }
            if (result.became_available) {
              restockProductIds.push(line.product_id);
            }
          }
        }

        await trx
          .insertInto('audit_logs')
          .values({
            actor_user_id: actor.id,
            action: `invoice.status.${status}`,
            entity_type: 'invoice',
            entity_id: id,
            metadata: sql`${JSON.stringify({
              from: current.status,
              to: status,
              inventory_action: inventoryAction?.kind ?? null,
              force_oversell: forceOversell || undefined,
            })}::jsonb`,
          })
          .execute();

        return { updatedRow, restockProductIds };
      });

    // Post-commit: fire back-in-stock notifications for any products
    // this status change brought off the out-of-stock list. Failures
    // are swallowed by RestockService so a flaky SMTP run doesn't
    // propagate back to the invoice finalize endpoint.
    if (restockProductIds.length > 0) {
      await this.restock.dispatchForProducts(restockProductIds);
    }

    // Oversell-override notification (operator request Apr 2026).
    // When an admin force-overrides the stock guard on a transition,
    // broadcast an in-app notification to every admin so someone
    // remembers to reconcile inventory later. Keeps the audit trail
    // (audit_logs already records force_oversell in metadata), adds
    // a nudge to the bell icon so it doesn't get lost. Silent on the
    // normal happy path.
    if (forceOversell) {
      try {
        await this.broadcastOversellOverride({
          invoiceId: id,
          invoiceNumber: updated.invoice_number,
          fromStatus: current.status,
          toStatus: status,
          actorUserId: actor.id,
          actorName: actor.role,
        });
      } catch (err) {
        // Non-fatal — the inventory move already committed. Log and move on.
        // eslint-disable-next-line no-console
        console.warn(
          `oversell-override notify failed for invoice ${id}: ${(err as Error).message}`,
        );
      }
    }

    return updated;
  }

  /**
   * Fan out an oversell-override notification to every admin user.
   * Each gets a row in their notifications feed tagged
   * `inventory.override_used` so the bell icon surfaces it.
   * Lands AFTER the trx commits so a notification row write failure
   * can't roll back a successful status move.
   */
  private async broadcastOversellOverride(args: {
    invoiceId: string;
    invoiceNumber: string;
    fromStatus: InvoiceStatus;
    toStatus: InvoiceStatus;
    actorUserId: string;
    actorName: string;
  }): Promise<void> {
    const admins = await this.db
      .selectFrom('users')
      .select(['id', 'email'])
      .where('role', '=', 'admin')
      .where('status', '=', 'active')
      .execute();
    if (admins.length === 0) return;

    const link = `/admin/invoices/${args.invoiceId}`;
    const title = `Stock override used on ${args.invoiceNumber}`;
    const body =
      `An admin force-overrode the inventory guard when moving ` +
      `${args.invoiceNumber} from ${args.fromStatus} → ${args.toStatus}. ` +
      `Inventory may now be negative on one or more line items — reconcile ` +
      `stock counts when convenient.`;

    await Promise.all(
      admins.map((u) =>
        this.notifications.create({
          user_id: u.id,
          type: 'inventory.override_used',
          title,
          body,
          link,
          metadata: {
            invoice_id: args.invoiceId,
            invoice_number: args.invoiceNumber,
            from_status: args.fromStatus,
            to_status: args.toStatus,
            actor_user_id: args.actorUserId,
          },
        }),
      ),
    );
  }

  /**
   * Hard-delete a draft OR canceled invoice and its line items.
   *
   *   - draft: anyone in admin/staff can delete (no reserved
   *     inventory, no audit impact on closed invoices).
   *   - canceled: admin-only. Canceled invoices are already
   *     tombstoned in the history; deletion is a cleanup operation
   *     reserved for scrubbing junk / test records. Inventory was
   *     already released at cancel time (see classifyInventoryAction),
   *     so no further stock movement happens here.
   *
   * Any other status rejects with 400 — operators must cancel first.
   *
   * Emits an audit event distinguishing the two paths
   * (`invoice.draft.delete` or `invoice.canceled.delete`) so the
   * action log stays precise.
   */
  async deleteDraft(id: string, actor: Actor): Promise<{ invoice_number: string }> {
    const current = await this.db
      .selectFrom('invoices')
      .select(['id', 'status', 'invoice_number', 'client_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw new NotFoundException('Invoice not found');
    if (current.status !== 'draft' && current.status !== 'canceled') {
      throw new BadRequestException(
        `Only draft or canceled invoices can be deleted. This invoice is ${current.status}; cancel it first.`,
      );
    }
    if (current.status === 'canceled' && actor.role !== 'admin') {
      throw new ForbiddenException(
        'Only admins can delete canceled invoices',
      );
    }

    const auditAction =
      current.status === 'canceled'
        ? 'invoice.canceled.delete'
        : 'invoice.draft.delete';

    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('invoice_line_items')
        .where('invoice_id', '=', id)
        .execute();
      await trx.deleteFrom('invoices').where('id', '=', id).execute();
      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: actor.id,
          action: auditAction,
          entity_type: 'invoice',
          entity_id: id,
          metadata: sql`${JSON.stringify({
            invoice_number: current.invoice_number,
            client_id: current.client_id,
            prior_status: current.status,
          })}::jsonb`,
        })
        .execute();
    });

    return { invoice_number: current.invoice_number };
  }

  /**
   * PIN-gated escape hatch to hard-delete an invoice in ANY status,
   * bypassing the draft/canceled rule in deleteDraft(). Intended for
   * mopping up obvious mistakes (double-finalized ticket, test data
   * that slipped through) where the normal Cancel → Delete flow would
   * be needlessly ceremonial.
   *
   * Caller is expected to have already validated the PIN at the
   * controller layer. We still refuse on `shipped` status because
   * physical goods have already moved — reversing that needs an
   * explicit return flow, not a DELETE.
   *
   * Emits `invoice.force.delete` so the audit log captures the prior
   * status (any stock-reversal review can start from this event).
   */
  async deleteForce(id: string, actor: Actor): Promise<{ invoice_number: string; prior_status: string }> {
    const current = await this.db
      .selectFrom('invoices')
      .select(['id', 'status', 'invoice_number', 'client_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw new NotFoundException('Invoice not found');
    if (current.status === 'shipped') {
      throw new BadRequestException(
        'Shipped invoices cannot be force-deleted — goods are physically out. Use a return flow.',
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('invoice_line_items').where('invoice_id', '=', id).execute();
      await trx.deleteFrom('invoices').where('id', '=', id).execute();
      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: actor.id,
          action: 'invoice.force.delete',
          entity_type: 'invoice',
          entity_id: id,
          metadata: sql`${JSON.stringify({
            invoice_number: current.invoice_number,
            client_id: current.client_id,
            prior_status: current.status,
          })}::jsonb`,
        })
        .execute();
    });
    return { invoice_number: current.invoice_number, prior_status: current.status };
  }

  /**
   * Render the invoice as PDF and email it to the given address. Does not
   * mutate invoice state — works on drafts too (INV-006, INV-007).
   *
   * If `saveToClient=true` and the target address is not already the
   * primary email, append it to the client's `secondary_emails` JSONB.
   * Dedupe is handled at the column level by `normalizeEmails` in
   * ClientsService but we also skip the write entirely when the address
   * already exists on the client record.
   *
   * Body text is kept short and factual; the PDF carries the detail. The
   * SMTP transport is dev-logged when SMTP_HOST is not configured.
   */
  async emailInvoice(
    id: string,
    opts: { to: string; saveToClient?: boolean },
    actor: Actor,
  ): Promise<{ sent_to: string; saved_to_client: boolean }> {
    // getById gates on owner-privacy — non-allowlisted operators
    // emailing an is_owner_private invoice get a 404 here, so the
    // PDF never renders and no email leaves the box.
    const invoice = await this.getById(id, { actorUserId: actor.id });
    const to = opts.to.trim().toLowerCase();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new BadRequestException('Invalid email address');
    }

    // Render the PDF to a Buffer so we can attach it.
    const pdfStream = await this.pdf.render(invoice);
    const chunks: Buffer[] = [];
    for await (const chunk of pdfStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const pdfBuffer = Buffer.concat(chunks);

    const human = invoice.invoice_number;
    const docLabel = invoice.type === 'sell' ? 'invoice' : 'buy ticket';
    const branding = await this.settings.getBranding();
    // Pull the operator-editable template; fall back to the built-in
    // defaults when they haven't customized one.
    const tpl = await this.settings.getEmailTemplate('invoice');
    const defaultSubject =
      invoice.type === 'sell'
        ? `Your invoice from {{company_name}} — {{invoice_number}}`
        : `Buy ticket from {{company_name}} — {{invoice_number}}`;
    const defaultBody =
      `Hi {{client_first_name}},\n\n` +
      `Your {{doc_label}} {{invoice_number}} is attached as a PDF.\n` +
      `Total: \${{total}}\n` +
      `Status: {{status}}\n\n` +
      `If you have questions, just reply to this email.\n\n` +
      `— {{company_name}}`;
    const vars = {
      client_name: invoice.client_name,
      // Fall back to the full client_name if first_name is empty (wholesalers
      // frequently have company but no personal name). Same for last_name.
      // This keeps greetings like "Hi {{client_first_name}}" from rendering
      // as "Hi" on company-only rows.
      client_first_name: invoice.client_first_name?.trim() || invoice.client_name,
      client_last_name: invoice.client_last_name?.trim() || '',
      invoice_number: human,
      doc_label: docLabel,
      type: invoice.type,
      total: Number(invoice.total).toFixed(2),
      status: invoice.status,
      company_name: branding.company_name,
    };
    const subject = this.settings.renderEmailTemplate(
      tpl.subject ?? defaultSubject,
      vars,
    );
    const body = this.settings.renderEmailTemplate(
      tpl.body ?? defaultBody,
      vars,
    );

    await this.email.send({
      to,
      subject,
      text: body,
      attachments: [
        {
          filename: `invoice-${human}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    let savedToClient = false;
    if (opts.saveToClient) {
      const client = await this.db
        .selectFrom('clients')
        .select(['email', 'secondary_emails'])
        .where('id', '=', invoice.client_id)
        .executeTakeFirst();
      if (client) {
        const primary = client.email?.trim().toLowerCase() ?? null;
        const existing = (client.secondary_emails as string[] | null) ?? [];
        const existingLower = new Set(existing.map((e) => e.trim().toLowerCase()));
        if (primary !== to && !existingLower.has(to)) {
          const next = Array.from(new Set([...existing, to])).sort();
          await this.db
            .updateTable('clients')
            .set({
              secondary_emails: sql`${JSON.stringify(next)}::jsonb` as never,
            })
            .where('id', '=', invoice.client_id)
            .execute();
          savedToClient = true;
        }
      }
    }

    await this.db
      .insertInto('audit_logs')
      .values({
        actor_user_id: actor.id,
        action: 'invoice.email',
        entity_type: 'invoice',
        entity_id: id,
        metadata: sql`${JSON.stringify({
          invoice_number: human,
          to,
          saved_to_client: savedToClient,
        })}::jsonb`,
      })
      .execute();

    return { sent_to: to, saved_to_client: savedToClient };
  }

  /**
   * Wholesale reconciliation — every finalized (not-yet-paid) wholesale
   * invoice, grouped by client, with a per-client running balance.
   *
   * Powers:
   *   - /admin/wholesale/reconciliation (ticket WH-001)
   *   - KPI card "Total Owed by All Wholesalers" (WH-003)
   *
   * Uses the partial index `invoices_outstanding_by_client_idx` (migration
   * 022) for the finalized+wholesale filter.
   */
  async listOutstandingWholesale(opts: { actorUserId?: string } = {}): Promise<{
    total_owed: string;
    by_client: Array<{
      client_id: string;
      client_name: string;
      client_email: string | null;
      invoice_count: number;
      owed: string;
      invoices: Array<{
        id: string;
        invoice_number: string;
        total: string;
        created_at: Date;
        type: InvoiceType;
      }>;
    }>;
  }> {
    const allowOwnerPrivate = opts.actorUserId
      ? await canViewOwnerPrivate(this.db, opts.actorUserId)
      : true;
    let rowsQ = this.db
      .selectFrom('invoices as i')
      .innerJoin('clients as c', 'c.id', 'i.client_id')
      .select([
        'i.id',
        'i.invoice_number',
        'i.total',
        'i.created_at',
        'i.type',
        'i.client_id',
        'c.email as client_email',
        sql<string>`coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.company, '(unnamed)')`.as(
          'client_name',
        ),
      ])
      .where('c.client_type', '=', 'wholesaler')
      // Skip invoices against clients flagged exclude_from_reports —
      // same gate as the Invoices list + KPI rollup. Keeps owner/test
      // transactions out of AR.
      .where('c.exclude_from_reports', '=', false);
    if (!allowOwnerPrivate) {
      rowsQ = rowsQ.where('c.is_owner_private', '=', false);
    }
    const rows = await rowsQ
      // Outstanding = finalized OR shipped, but not yet paid. Wholesale
      // routinely ships before payment lands, so 'shipped' must stay on
      // the receivables list until Mark Paid fires. Guarded by
      // paid_at IS NULL so an invoice that was paid then shipped
      // (rare retail mail-order path) doesn't reappear.
      .where('i.status', 'in', ['finalized', 'shipped'])
      .where('i.paid_at', 'is', null)
      .orderBy('c.last_name')
      .orderBy('i.created_at', 'asc')
      .execute();

    // 2026-onward policy: historical_invoices rows dated 2026+ with a
    // wholesale flag and a linked client are treated as outstanding
    // AP alongside real invoices. Operators started using the
    // historical-invoices form to book fresh 2026 vendor POs
    // (Dillon Gage etc.) and expected those to surface on this page.
    // Pre-2026 historicals stay archive-only. No paid_at on the
    // historical_invoices table yet, so deleting the historical row
    // is how an operator clears it from this list for now.
    let histQ = this.db
      .selectFrom('historical_invoices as h')
      .innerJoin('clients as c', 'c.id', 'h.client_id')
      .select((eb) => [
        'h.id',
        eb.fn
          .coalesce(
            'h.reference',
            sql<string>`'HIST-' || substring(h.id::text, 1, 8)`,
          )
          .as('invoice_number'),
        sql<string>`h.amount::text`.as('total'),
        sql<Date>`h.date::timestamptz`.as('created_at'),
        'h.type',
        'h.client_id',
        'c.email as client_email',
        sql<string>`coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.company, '(unnamed)')`.as(
          'client_name',
        ),
      ])
      .where('c.client_type', '=', 'wholesaler')
      .where('c.exclude_from_reports', '=', false)
      .where('h.is_wholesale', '=', true)
      .where(sql<boolean>`h.date >= '2026-01-01'::date`)
      // Auto-paid rule: anything 30+ days old is presumed settled and
      // drops off the outstanding AP list. Aligns the wholesale-AP
      // view with the same heuristic the client timeline uses for
      // historical entries — past 30 days = paid in operator's mental
      // model.
      .where(sql<boolean>`h.date > current_date - interval '30 days'`);
    if (!allowOwnerPrivate) {
      histQ = histQ.where('c.is_owner_private', '=', false);
    }
    const histRows = await histQ
      .orderBy('c.last_name')
      .orderBy('h.date', 'asc')
      .execute();

    // Normalize both result sets to a shared shape. `client_id` comes
    // back nullable from historical_invoices even though the innerJoin
    // guarantees non-null in practice — filter + cast keeps TS happy.
    const combined: Array<{
      id: string;
      invoice_number: string;
      total: string;
      created_at: Date;
      type: InvoiceType;
      client_id: string;
      client_email: string | null;
      client_name: string;
    }> = [
      ...rows.map((r) => ({
        id: r.id,
        invoice_number: r.invoice_number,
        total: r.total as unknown as string,
        created_at: r.created_at as Date,
        type: r.type as InvoiceType,
        client_id: r.client_id,
        client_email: r.client_email,
        client_name: r.client_name,
      })),
      ...histRows
        .filter((r) => r.client_id !== null)
        .map((r) => ({
          id: r.id,
          invoice_number: r.invoice_number as string,
          total: r.total,
          created_at: r.created_at,
          type: r.type as InvoiceType,
          client_id: r.client_id as string,
          client_email: r.client_email,
          client_name: r.client_name,
        })),
    ];

    const grouped = new Map<
      string,
      {
        client_id: string;
        client_name: string;
        client_email: string | null;
        invoice_count: number;
        owed: Decimal;
        invoices: Array<{
          id: string;
          invoice_number: string;
          total: string;
          created_at: Date;
          type: InvoiceType;
        }>;
      }
    >();

    let total = d(0);
    for (const r of combined) {
      const existing = grouped.get(r.client_id) ?? {
        client_id: r.client_id,
        client_name: r.client_name,
        client_email: r.client_email,
        invoice_count: 0,
        owed: d(0),
        invoices: [],
      };
      const amt = d(r.total as unknown as string);
      existing.owed = existing.owed.plus(amt);
      existing.invoice_count += 1;
      existing.invoices.push({
        id: r.id,
        invoice_number: r.invoice_number,
        total: r.total as unknown as string,
        created_at: r.created_at as Date,
        type: r.type,
      });
      grouped.set(r.client_id, existing);
      total = total.plus(amt);
    }

    return {
      total_owed: toDbString(total),
      by_client: Array.from(grouped.values()).map((g) => ({
        ...g,
        owed: toDbString(g.owed),
      })),
    };
  }

  /**
   * Map an invoice status transition to the inventory side-effect it must
   * trigger (or `null` if none). Pure function — fed to the transaction
   * handler in `updateStatus`.
   *
   * Sell lifecycle has two valid shapes depending on who's buying:
   *
   *   Retail walk-in (consume at paid):
   *     draft ─reserve→ finalized ─consume→ paid ─no-op→ shipped
   *
   *   Retail mail-order (consume at ship, already paid):
   *     draft ─reserve→ finalized ─consume→ paid ─no-op→ shipped
   *     (same path; paid happens first, ship is bookkeeping)
   *
   *   Wholesale ship-first-pay-later (consume at ship, paid later):
   *     draft ─reserve→ finalized ─consume→ shipped ─no-op→ paid
   *     Goods physically leave when we mark shipped; AR stays open
   *     until the wholesaler remits and Mark Paid fires. See
   *     listOutstandingWholesale — it includes shipped invoices so
   *     the receivable doesn't disappear at ship time.
   *
   *   Cancel:
   *     finalized → canceled  release (reservation only, no stock moved)
   *     paid      → canceled  reverse_consume (return flow — stock back)
   *     shipped   → canceled  NOT allowed (goods physically gone; use
   *                           an admin adjustment instead)
   *
   * Buy lifecycle: draft ─no-op→ finalized ─purchase→ paid ─no-op→ shipped.
   *
   * Consume is strictly idempotent — once it happens (at paid OR at
   * shipped, whichever comes first after finalized), the other
   * transition is a no-op. That's why both `finalized→shipped` and
   * `finalized→paid` classify as consume, but `paid→shipped` and
   * `shipped→paid` do not.
   */
  private classifyInventoryAction(
    type: InvoiceType,
    from: InvoiceStatus,
    to: InvoiceStatus,
  ):
    | { kind: 'purchase' | 'reserve' | 'consume' | 'release' | 'reverse_consume' | 'direct_sale' }
    | null {
    if (type === 'buy') {
      if (to === 'paid' && from !== 'paid') return { kind: 'purchase' };
      return null;
    }
    // type === 'sell'
    if (to === 'finalized' && from === 'draft') return { kind: 'reserve' };
    // Consume only from finalized — either to paid (retail walk-in) or
    // to shipped (wholesale ship-first). Any other to='paid'/'shipped'
    // transition is between already-consumed states, so no-op.
    if (from === 'finalized' && (to === 'paid' || to === 'shipped')) {
      return { kind: 'consume' };
    }
    // Walk-in retail shortcut: draft → paid in one click. No reservation
    // was ever created, so we can't "consume" one — we apply a direct
    // sale movement (delta=-qty, reserved_delta=0). Same net inventory
    // effect as draft → finalized → paid, one fewer round trip.
    // Introduced Apr 2026 when the operator asked to remove the explicit
    // Finalize button for client invoices. Wholesale typically still
    // goes through finalized (AR stays open until payment lands), but
    // the backend allows the shortcut for either type.
    if (from === 'draft' && to === 'paid') return { kind: 'direct_sale' };
    // Cancel paths. Paid→canceled means we already deducted, so we must
    // restore stock (return flow). Finalized→canceled releases the reservation
    // without any stock movement. Shipped→canceled is disallowed at the
    // transition layer; no entry here.
    if (to === 'canceled' && from === 'finalized') return { kind: 'release' };
    if (to === 'canceled' && from === 'paid') return { kind: 'reverse_consume' };
    return null;
  }

  private canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
    if (from === to) return true;
    const allowed: Record<InvoiceStatus, InvoiceStatus[]> = {
      // `paid` in this list lets retail walk-ins skip Finalize — the
      // UI hides the Finalize button for retail clients and sends
      // status=paid directly. Wholesale still goes draft → finalized
      // → paid via the detail-page dropdown to preserve open-AR
      // semantics.
      draft: ['finalized', 'paid', 'canceled'],
      finalized: ['paid', 'shipped', 'canceled'],
      paid: ['shipped', 'canceled'], // canceling a paid sell releases reservation
      // shipped → paid enables the wholesale "ship first, get paid days
      // later" workflow. Goods have physically left; the invoice stays
      // on wholesale AR until this transition fires. shipped is
      // otherwise terminal — no back-to-canceled, because reversing a
      // physical shipment needs an explicit return flow we haven't built.
      shipped: ['paid'],
      canceled: [],
    };
    return allowed[from].includes(to);
  }
}

// Re-export Decimal so other modules can keep one import style.
export { Decimal };
