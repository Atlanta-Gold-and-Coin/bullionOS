import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql, type Transaction } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, InventoryMovementReason } from '../db/types';
import { d, toDbString } from '../common/money';

export interface InventoryRow {
  product_id: string;
  sku: string;
  name: string;
  metal: string;
  category: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  available: number;
  /**
   * Physical storage label — 'main' by default, configurable to 'safe',
   * 'vault-2', etc. via PATCH /admin/inventory/:productId/location
   * (PROD-002). Always present at the API boundary because the list
   * query COALESCEs to 'main' for products with no inventory row yet.
   */
  location: string;
  weighted_avg_cost: string;
  last_purchase_price: string | null;
  updated_at: Date;
  show_on_website: boolean;
}

@Injectable()
export class InventoryService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /** Full inventory rollup for admins. */
  list(): Promise<InventoryRow[]> {
    return this.db
      .selectFrom('products as p')
      .leftJoin('inventory as inv', 'inv.product_id', 'p.id')
      .select([
        'p.id as product_id',
        'p.sku',
        'p.name',
        'p.metal',
        'p.category',
        'p.show_on_website',
        sql<number>`coalesce(inv.quantity_on_hand, 0)`.as('quantity_on_hand'),
        sql<number>`coalesce(inv.quantity_reserved, 0)`.as('quantity_reserved'),
        sql<number>`coalesce(inv.quantity_on_hand, 0) - coalesce(inv.quantity_reserved, 0)`.as('available'),
        sql<string>`coalesce(inv.location, 'main')`.as('location'),
        sql<string>`coalesce(inv.weighted_avg_cost, '0')::text`.as('weighted_avg_cost'),
        sql<string | null>`inv.last_purchase_price::text`.as('last_purchase_price'),
        sql<Date>`coalesce(inv.updated_at, p.updated_at)`.as('updated_at'),
      ])
      .where('p.is_active', '=', true)
      .orderBy('p.name')
      .execute() as unknown as Promise<InventoryRow[]>;
  }

  /**
   * In-stock feed. Two audiences:
   *
   *   - Public (WP plugin, atlantagoldandcoin.com)
   *     → opts.onlyWebsite=true: obeys `show_on_website` so the shop can
   *       hide items from the public site without deactivating them.
   *
   *   - Client portal (logged-in retail/wholesale clients)
   *     → opts.onlyWebsite=false: the client is already authenticated and
   *       expects to see everything we have in stock; `show_on_website`
   *       is a display-only toggle for the WP plugin and shouldn't gate
   *       the portal. Prior to this split, the filter was always on,
   *       which made the client portal look empty when no items were
   *       flagged for the public site.
   *
   * Always filters on `is_active=true` and `available > 0` regardless
   * of audience.
   */
  inStock(opts: { onlyWebsite?: boolean } = {}): Promise<
    Array<
      Pick<
        InventoryRow,
        'product_id' | 'sku' | 'name' | 'metal' | 'category' | 'available'
      > & { weight_troy_oz: string }
    >
  > {
    const onlyWebsite = opts.onlyWebsite === true;
    let q = this.db
      .selectFrom('products as p')
      .innerJoin('inventory as inv', 'inv.product_id', 'p.id')
      .select([
        'p.id as product_id',
        'p.sku',
        'p.name',
        'p.metal',
        'p.category',
        'p.weight_troy_oz',
        sql<number>`(inv.quantity_on_hand - inv.quantity_reserved)`.as('available'),
      ])
      .where('p.is_active', '=', true)
      .where(sql<boolean>`(inv.quantity_on_hand - inv.quantity_reserved) > 0`)
      .orderBy('p.name');
    if (onlyWebsite) q = q.where('p.show_on_website', '=', true);
    return q.execute() as never;
  }

  // ─── Primitives ─────────────────────────────────────────────────────────
  //
  // All mutating ops go through `applyMovement`, which:
  //   - locks the inventory row with SELECT ... FOR UPDATE inside the caller's
  //     transaction (prevents concurrent oversell / double-reserve)
  //   - upserts the inventory row if this is the first movement
  //   - enforces non-negative counters at the app layer; the DB CHECK
  //     constraints provide the belt-and-suspenders
  //   - writes exactly one audit row per call
  //
  // Reservation primitives (`reserveFor`, `releaseReservationFor`,
  // `consumeReservationFor`) wrap `applyMovement` with the invoice context
  // and the correct delta signs, so the invoice state machine doesn't need
  // to know about movement internals.

  /**
   * Apply an arbitrary inventory movement. Callers must provide their own
   * Kysely transaction — every mutation happens inside one atomic block so
   * the row lock stays held across the read/write pair.
   */
  async applyMovement(
    trx: Transaction<DB>,
    params: {
      product_id: string;
      delta: number;
      /** Change to quantity_reserved. Optional; defaults to 0. */
      reserved_delta?: number;
      reason: InventoryMovementReason;
      unit_cost?: string | number | null;
      invoice_id?: string | null;
      actor_user_id?: string | null;
      notes?: string | null;
      /**
       * Admin override that bypasses the on-hand guard. Lets inventory
       * go negative and lets reservations exceed on-hand when the
       * operator explicitly chose to oversell (rare — e.g. an agreed
       * pre-sale against incoming stock). Still enforces the
       * reservation-underflow guard because negative reserved values
       * are never a valid state.
       */
      force?: boolean;
    },
  ): Promise<void> {
    const delta = params.delta;
    const reservedDelta = params.reserved_delta ?? 0;
    const force = params.force === true;
    if (delta === 0 && reservedDelta === 0) return;

    // Lock the row (or the product's would-be row) for the remainder of the tx.
    // SELECT FOR UPDATE against the existing row; if none exists we fall through
    // to an insert path. Concurrent callers will serialize on the FOR UPDATE.
    const existing = await trx
      .selectFrom('inventory')
      .select([
        'quantity_on_hand',
        'quantity_reserved',
        'weighted_avg_cost',
      ])
      .where('product_id', '=', params.product_id)
      .forUpdate()
      .executeTakeFirst();

    const currentOnHand = existing?.quantity_on_hand ?? 0;
    const currentReserved = existing?.quantity_reserved ?? 0;
    const nextOnHand = currentOnHand + delta;
    const nextReserved = currentReserved + reservedDelta;

    // Implicit-force on the consume path.
    //
    // When an invoice transitions finalized → paid/shipped, we call
    // consumeReservationFor which sets delta === reserved_delta (both
    // negative, same magnitude). That operation is strictly a 1:1
    // conversion of an already-committed reservation into a real
    // deduction — it cannot create new oversell exposure that wasn't
    // already booked at reserve time. So if the reservation was
    // created with force_oversell at finalize (currentReserved was
    // allowed to exceed currentOnHand back then), the corresponding
    // consume MUST also be allowed through — otherwise the invoice
    // gets stuck between finalized and paid. Blocking it wouldn't
    // prevent any oversell: the commitment was made the moment we
    // reserved.
    //
    // The operator still has to explicitly opt-in at reserve time
    // (via the admin-only force_oversell checkbox). This just prevents
    // the guard from re-tripping on the follow-on paid transition.
    const isConsumingReservation =
      delta < 0 &&
      reservedDelta < 0 &&
      delta === reservedDelta &&
      currentReserved >= -reservedDelta;
    const effectiveForce = force || isConsumingReservation;

    if (!effectiveForce && nextOnHand < 0) {
      throw new BadRequestException(
        `Insufficient on-hand stock for product ${params.product_id}: have ${currentOnHand}, needed ${-delta}`,
      );
    }
    // Reservation-underflow is never legitimate (a release can't subtract
    // more than was reserved), so we keep this check even under force.
    if (nextReserved < 0) {
      throw new BadRequestException(
        `Reservation underflow for product ${params.product_id}: reserved ${currentReserved}, releasing ${-reservedDelta}`,
      );
    }
    if (!effectiveForce && nextReserved > nextOnHand) {
      throw new BadRequestException(
        `Cannot reserve more than is on hand for product ${params.product_id}: on_hand=${nextOnHand}, reserved=${nextReserved}`,
      );
    }

    // Weighted-average cost updates only on positive on-hand deltas with a cost.
    let newWac: string | null = null;
    if (delta > 0 && params.unit_cost !== undefined && params.unit_cost !== null) {
      const prevWac = d(existing?.weighted_avg_cost ?? 0);
      const prevTotal = prevWac.times(currentOnHand);
      const newTotal = prevTotal.plus(d(params.unit_cost).times(delta));
      newWac = toDbString(nextOnHand > 0 ? newTotal.div(nextOnHand) : 0);
    }

    if (existing) {
      await trx
        .updateTable('inventory')
        .set({
          quantity_on_hand: nextOnHand,
          quantity_reserved: nextReserved,
          ...(newWac !== null && { weighted_avg_cost: newWac }),
          ...(delta > 0 &&
            params.unit_cost !== undefined &&
            params.unit_cost !== null && {
              last_purchase_price: toDbString(params.unit_cost),
            }),
        })
        .where('product_id', '=', params.product_id)
        .execute();
    } else {
      await trx
        .insertInto('inventory')
        .values({
          product_id: params.product_id,
          quantity_on_hand: nextOnHand,
          quantity_reserved: nextReserved,
          weighted_avg_cost:
            params.unit_cost !== undefined && params.unit_cost !== null
              ? toDbString(params.unit_cost)
              : '0',
          last_purchase_price:
            params.unit_cost !== undefined && params.unit_cost !== null
              ? toDbString(params.unit_cost)
              : null,
        })
        .execute();
    }

    await trx
      .insertInto('inventory_movements')
      .values({
        product_id: params.product_id,
        delta,
        reserved_delta: reservedDelta,
        reason: params.reason,
        invoice_id: params.invoice_id ?? null,
        unit_cost:
          params.unit_cost !== undefined && params.unit_cost !== null
            ? toDbString(params.unit_cost)
            : null,
        notes: params.notes ?? null,
        actor_user_id: params.actor_user_id ?? null,
      })
      .execute();
  }

  // ─── Reservation wrappers ─────────────────────────────────────────────

  /**
   * Reserve `qty` units for a sell-side invoice. Fails atomically on
   * insufficient stock. Writes a movement row keyed to invoice_id for audit.
   */
  async reserveFor(
    trx: Transaction<DB>,
    params: {
      product_id: string;
      qty: number;
      invoice_id: string;
      actor_user_id: string;
      /** Admin override — bypass the on-hand ≥ reserved guard. */
      force?: boolean;
    },
  ): Promise<void> {
    if (params.qty <= 0) throw new BadRequestException('qty must be positive');
    await this.applyMovement(trx, {
      product_id: params.product_id,
      delta: 0,
      reserved_delta: params.qty,
      reason: 'reservation',
      invoice_id: params.invoice_id,
      actor_user_id: params.actor_user_id,
      force: params.force,
    });
  }

  /** Inverse of reserveFor. Used on invoice cancellation before shipment. */
  async releaseReservationFor(
    trx: Transaction<DB>,
    params: { product_id: string; qty: number; invoice_id: string; actor_user_id: string },
  ): Promise<void> {
    if (params.qty <= 0) throw new BadRequestException('qty must be positive');
    await this.applyMovement(trx, {
      product_id: params.product_id,
      delta: 0,
      reserved_delta: -params.qty,
      reason: 'reservation_release',
      invoice_id: params.invoice_id,
      actor_user_id: params.actor_user_id,
    });
  }

  /**
   * Ship-time consumption: convert a reservation into a real deduction.
   * Both counters drop by qty; `quantity_reserved` hits zero for this line,
   * `quantity_on_hand` finally decreases.
   */
  async consumeReservationFor(
    trx: Transaction<DB>,
    params: {
      product_id: string;
      qty: number;
      invoice_id: string;
      actor_user_id: string;
      /**
       * Admin override — must be set if this invoice was originally
       * reserved under force (i.e. the reservation exceeds on-hand).
       * Without it, the final deduction would trip the on-hand guard
       * on a movement the operator already committed to.
       */
      force?: boolean;
    },
  ): Promise<void> {
    if (params.qty <= 0) throw new BadRequestException('qty must be positive');
    await this.applyMovement(trx, {
      product_id: params.product_id,
      delta: -params.qty,
      reserved_delta: -params.qty,
      reason: 'sale',
      invoice_id: params.invoice_id,
      actor_user_id: params.actor_user_id,
      force: params.force,
    });
  }

  /**
   * PROD-002: edit the storage location for a product's inventory row.
   * Creates the row if this is the first time we've touched inventory
   * for the product (same upsert pattern as applyMovement).
   *
   * Location is an operator-visible label — 'main', 'safe', 'vault-2',
   * etc. — used to organize physical placement in the shop. Short,
   * uppercase, trimmed; empty collapses to 'main'.
   */
  async setLocation(
    productId: string,
    rawLocation: string,
    actorUserId: string,
  ): Promise<InventoryRow> {
    const location = rawLocation.trim().slice(0, 64) || 'main';
    const product = await this.db
      .selectFrom('products')
      .select('id')
      .where('id', '=', productId)
      .executeTakeFirst();
    if (!product) throw new NotFoundException('Product not found');

    await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('inventory')
        .select(['location'])
        .where('product_id', '=', productId)
        .executeTakeFirst();
      if (existing) {
        if (existing.location === location) return;
        await trx
          .updateTable('inventory')
          .set({ location })
          .where('product_id', '=', productId)
          .execute();
      } else {
        await trx
          .insertInto('inventory')
          .values({
            product_id: productId,
            quantity_on_hand: 0,
            quantity_reserved: 0,
            location,
            weighted_avg_cost: '0',
          })
          .execute();
      }
      // Movement row so the change is auditable alongside stock edits.
      // delta=0 + reserved_delta=0 means no-op on counters — the movement
      // exists purely for its metadata (actor + note).
      await trx
        .insertInto('inventory_movements')
        .values({
          product_id: productId,
          delta: 0,
          reserved_delta: 0,
          reason: 'adjustment',
          actor_user_id: actorUserId,
          notes: `Location → ${location}`,
        })
        .execute();
    });

    const rows = await this.list();
    const row = rows.find((r) => r.product_id === productId);
    if (!row) throw new NotFoundException();
    return row;
  }

  // ─── Admin-initiated adjustment (unrelated to invoices) ───────────────

  async adjust(
    productId: string,
    delta: number,
    actorUserId: string,
    notes?: string,
  ): Promise<InventoryRow> {
    const product = await this.db
      .selectFrom('products')
      .select('id')
      .where('id', '=', productId)
      .executeTakeFirst();
    if (!product) throw new NotFoundException('Product not found');

    await this.db.transaction().execute((trx) =>
      this.applyMovement(trx, {
        product_id: productId,
        delta,
        reason: 'adjustment',
        actor_user_id: actorUserId,
        notes,
      }),
    );

    const rows = await this.list();
    const row = rows.find((r) => r.product_id === productId);
    if (!row) throw new NotFoundException();
    return row;
  }
}
