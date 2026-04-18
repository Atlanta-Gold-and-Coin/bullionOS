import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, Invoice, InvoiceLineItem, InvoiceStatus, InvoiceType, UserRole } from '../db/types';
import { d, toDbString, Decimal } from '../common/money';
import { PricingService } from '../pricing/pricing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InventoryService } from '../inventory/inventory.service';
import type { CreateInvoiceDto } from './dto/create-invoice.dto';

export interface InvoiceWithLines extends Invoice {
  client_name: string;
  client_email: string | null;
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
    return row;
  }

  async list(
    opts: {
      clientId?: string;
      status?: InvoiceStatus;
      type?: InvoiceType;
      /** 'wholesaler' or 'retail' — joins clients to filter by segment. */
      client_type?: 'retail' | 'wholesaler';
    } = {},
  ): Promise<Array<Invoice & { client_name: string; client_type: string }>> {
    // Include client name + type with the invoice so the tab'd list view
    // can render rows without a second roundtrip.
    let q = this.db
      .selectFrom('invoices as i')
      .innerJoin('clients as c', 'c.id', 'i.client_id')
      .selectAll('i')
      .select([
        sql<string>`c.first_name || ' ' || c.last_name`.as('client_name'),
        'c.client_type as client_type',
      ])
      .orderBy('i.created_at', 'desc')
      .limit(500);
    if (opts.clientId) q = q.where('i.client_id', '=', opts.clientId);
    if (opts.status) q = q.where('i.status', '=', opts.status);
    if (opts.type) q = q.where('i.type', '=', opts.type);
    if (opts.client_type) q = q.where('c.client_type', '=', opts.client_type);
    return q.execute() as unknown as Promise<
      Array<Invoice & { client_name: string; client_type: string }>
    >;
  }

  async getById(id: string): Promise<InvoiceWithLines> {
    const invoice = await this.db
      .selectFrom('invoices as i')
      .innerJoin('clients as c', 'c.id', 'i.client_id')
      .selectAll('i')
      .select([
        sql<string>`c.first_name || ' ' || c.last_name`.as('client_name'),
        'c.email as client_email',
      ])
      .where('i.id', '=', id)
      .executeTakeFirst();

    if (!invoice) throw new NotFoundException('Invoice not found');

    const lines = await this.db
      .selectFrom('invoice_line_items')
      .selectAll()
      .where('invoice_id', '=', id)
      .orderBy('position')
      .execute();

    return { ...(invoice as Invoice & { client_name: string; client_email: string | null }), line_items: lines };
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

    // Pre-compute quotes outside the transaction (reads from Redis + Postgres).
    const quotes = await Promise.all(
      dto.line_items.map(async (li) => {
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
        product_id: string;
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
        const useOverride = li.override_unit_price !== undefined;
        const unitPrice = useOverride
          ? d(li.override_unit_price!)
          : dto.type === 'sell'
            ? d(quote.sell_unit_price)
            : d(quote.buy_unit_price);
        const lineTotal = unitPrice.times(li.quantity);
        subtotal = subtotal.plus(lineTotal);

        const premiumType =
          dto.type === 'sell' ? quote.sell_premium_type : quote.buy_premium_type;
        const premiumValue =
          dto.type === 'sell' ? quote.sell_premium_value : quote.buy_premium_value;

        lineInserts.push({
          invoice_id: invoice.id,
          product_id: li.product_id,
          position: idx + 1,
          quantity: li.quantity,
          product_name_snapshot:
            li.custom_name && li.custom_name.trim().length > 0
              ? li.custom_name.trim()
              : quote.product_name,
          // Snapshot all three product physical attributes INDEPENDENTLY so an
          // audit of this invoice years later can reproduce the math without
          // re-reading a potentially-mutated product record.
          //   weight  — gross troy oz per unit (e.g. 1.0909 for a Gold Eagle)
          //   purity  — fineness fraction      (e.g. 0.9167)
          //   content — weight * purity        (e.g. ~1.0000)
          gross_weight_troy_oz: quote.product_weight_troy_oz,
          purity: quote.product_purity,
          metal_content_troy_oz: quote.metal_content_per_unit,
          spot_price_per_oz: quote.spot_per_oz,
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
        sql<string>`c.first_name || ' ' || c.last_name`.as('client_name'),
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

    return { ...(inv as Invoice & { client_name: string; client_email: string | null }), line_items: lines };
  }

  async updateStatus(id: string, status: InvoiceStatus, actor: Actor): Promise<Invoice> {
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

    const patch: Partial<{
      status: InvoiceStatus;
      finalized_at: Date;
      paid_at: Date;
      payment_status: 'paid';
    }> = { status };
    if (status === 'finalized') patch.finalized_at = new Date();
    if (status === 'paid') {
      patch.paid_at = new Date();
      patch.payment_status = 'paid';
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
      | null = this.classifyInventoryAction(current.type, current.status, status);

    const updated = await this.db.transaction().execute(async (trx) => {
      const updatedRow = await trx
        .updateTable('invoices')
        .set(patch)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      if (inventoryAction) {
        const lines = await trx
          .selectFrom('invoice_line_items')
          .select(['product_id', 'quantity', 'unit_price'])
          .where('invoice_id', '=', id)
          .execute();

        for (const line of lines) {
          if (!line.product_id) continue; // product was deleted; nothing to move
          switch (inventoryAction.kind) {
            case 'purchase':
              await this.inventory.applyMovement(trx, {
                product_id: line.product_id,
                delta: line.quantity,
                reason: 'purchase',
                unit_cost: line.unit_price,
                invoice_id: id,
                actor_user_id: actor.id,
              });
              break;
            case 'reserve':
              await this.inventory.reserveFor(trx, {
                product_id: line.product_id,
                qty: line.quantity,
                invoice_id: id,
                actor_user_id: actor.id,
              });
              break;
            case 'consume':
              await this.inventory.consumeReservationFor(trx, {
                product_id: line.product_id,
                qty: line.quantity,
                invoice_id: id,
                actor_user_id: actor.id,
              });
              break;
            case 'release':
              await this.inventory.releaseReservationFor(trx, {
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
              await this.inventory.applyMovement(trx, {
                product_id: line.product_id,
                delta: line.quantity,
                reserved_delta: 0,
                reason: 'return',
                invoice_id: id,
                actor_user_id: actor.id,
              });
              break;
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
          })}::jsonb`,
        })
        .execute();

      return updatedRow;
    });

    return updated;
  }

  /**
   * Map an invoice status transition to the inventory side-effect it must
   * trigger (or `null` if none). Pure function — fed to the transaction
   * handler in `updateStatus`.
   *
   * Sell lifecycle (most transactions are in-person — deduct at paid, not ship):
   *   draft ─reserve→ finalized ─consume→ paid ─no-op→ shipped
   *                          ╲            ╲reverse-consume→ canceled
   *                           ╲release→ canceled
   *                   finalized ─consume→ shipped (skip-paid path)
   *
   * Buy lifecycle: draft ─no-op→ finalized ─purchase→ paid ─no-op→ shipped
   *
   * The 'paid' state is treated as the real inventory event for sells because
   * the shop's majority volume is walk-in. Shipped status is retained for
   * mail-order completeness but no longer carries inventory weight on
   * paid→shipped (already consumed at paid).
   */
  private classifyInventoryAction(
    type: InvoiceType,
    from: InvoiceStatus,
    to: InvoiceStatus,
  ): { kind: 'purchase' | 'reserve' | 'consume' | 'release' | 'reverse_consume' } | null {
    if (type === 'buy') {
      if (to === 'paid' && from !== 'paid') return { kind: 'purchase' };
      return null;
    }
    // type === 'sell'
    if (to === 'finalized' && from === 'draft') return { kind: 'reserve' };
    // Consume at paid OR at shipped (if skipping paid). Only consume once —
    // paid→shipped is a no-op because the deduction already happened.
    if (to === 'paid' && from !== 'paid') return { kind: 'consume' };
    if (to === 'shipped' && from === 'finalized') return { kind: 'consume' };
    // Cancel paths. Paid→canceled means we already deducted, so we must
    // restore stock (return flow). Finalized→canceled releases the reservation
    // without any stock movement.
    if (to === 'canceled' && from === 'finalized') return { kind: 'release' };
    if (to === 'canceled' && from === 'paid') return { kind: 'reverse_consume' };
    return null;
  }

  private canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
    if (from === to) return true;
    const allowed: Record<InvoiceStatus, InvoiceStatus[]> = {
      draft: ['finalized', 'canceled'],
      finalized: ['paid', 'shipped', 'canceled'],
      paid: ['shipped', 'canceled'], // canceling a paid sell releases reservation
      shipped: [],
      canceled: [],
    };
    return allowed[from].includes(to);
  }
}

// Re-export Decimal so other modules can keep one import style.
export { Decimal };
