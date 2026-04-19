import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, Shipment, ShipmentStatus } from '../db/types';
import { toDbString } from '../common/money';
import { NotificationsService } from '../notifications/notifications.service';
import type { CreateShipmentDto } from './dto/create-shipment.dto';
import type { UpdateShipmentDto } from './dto/update-shipment.dto';
import { validateDeliverySpeed } from './delivery-speeds';

/**
 * SQL expression for rendering a client's display name. Prefers the
 * "first last" composite; falls back to company when both personal names
 * are blank; lands on "(unnamed)" if nothing matches. Kept in one place
 * so the shipments list + detail + notifications all format the same.
 */
const CLIENT_NAME_SQL = sql<string>`coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.company, '(unnamed)')`;

/** Public carrier tracking URLs for UI "track" links. */
const CARRIER_URLS: Record<string, (n: string) => string> = {
  ups: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  fedex: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  usps: (n) =>
    `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  other: () => '',
};

export function trackingUrlFor(carrier: string, trackingNumber: string | null): string | null {
  if (!trackingNumber) return null;
  const fn = CARRIER_URLS[carrier];
  return fn ? fn(trackingNumber) : null;
}

@Injectable()
export class ShipmentsService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly notifications: NotificationsService,
  ) {}

  async create(dto: CreateShipmentDto, actorUserId: string): Promise<Shipment> {
    const invoice = await this.db
      .selectFrom('invoices')
      .select(['id', 'client_id', 'status', 'invoice_number'])
      .where('id', '=', dto.invoice_id)
      .executeTakeFirst();
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === 'canceled') {
      throw new BadRequestException('Cannot create shipment for a canceled invoice');
    }

    const existing = await this.db
      .selectFrom('shipments')
      .select('id')
      .where('invoice_id', '=', dto.invoice_id)
      .executeTakeFirst();
    if (existing) {
      throw new BadRequestException('Shipment already exists for this invoice');
    }

    // Validate delivery_speed against the carrier whitelist (SHIP-001).
    // The helper throws a plain Error with a message listing the valid
    // options; wrap it in Nest's BadRequestException for proper 400.
    let deliverySpeed: string | null;
    try {
      deliverySpeed = validateDeliverySpeed(dto.carrier, dto.delivery_speed);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const created = await this.db
      .insertInto('shipments')
      .values({
        invoice_id: dto.invoice_id,
        carrier: dto.carrier,
        tracking_number: dto.tracking_number ?? null,
        delivery_speed: deliverySpeed,
        status: 'label_created',
        weight_lbs: dto.weight_lbs !== undefined ? toDbString(dto.weight_lbs) : null,
        insurance_amount:
          dto.insurance_amount !== undefined ? toDbString(dto.insurance_amount) : null,
        notes: dto.notes ?? null,
        created_by_user_id: actorUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.notifications.notifyClient(invoice.client_id, {
      type: 'shipment.created',
      title: `Shipment created for ${invoice.invoice_number}`,
      body: dto.tracking_number
        ? `${dto.carrier.toUpperCase()} · ${dto.tracking_number}`
        : `${dto.carrier.toUpperCase()} · tracking pending`,
      link: `/dashboard/shipments`,
      metadata: { shipment_id: created.id, invoice_id: invoice.id },
    });

    return created;
  }

  async update(id: string, dto: UpdateShipmentDto): Promise<Shipment> {
    const current = await this.db
      .selectFrom('shipments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw new NotFoundException('Shipment not found');

    if (dto.status && !this.canTransition(current.status, dto.status)) {
      throw new BadRequestException(`Cannot transition ${current.status} → ${dto.status}`);
    }

    const patch: Partial<{
      tracking_number: string | null;
      delivery_speed: string | null;
      status: ShipmentStatus;
      notes: string | null;
      shipped_at: Date;
      delivered_at: Date;
    }> = {};
    if (dto.tracking_number !== undefined) patch.tracking_number = dto.tracking_number || null;
    if (dto.notes !== undefined) patch.notes = dto.notes || null;
    if (dto.delivery_speed !== undefined) {
      try {
        patch.delivery_speed = validateDeliverySpeed(current.carrier, dto.delivery_speed);
      } catch (err) {
        throw new BadRequestException((err as Error).message);
      }
    }
    if (dto.status) {
      patch.status = dto.status;
      if (dto.status === 'in_transit' && !current.shipped_at) patch.shipped_at = new Date();
      if (dto.status === 'delivered' && !current.delivered_at) patch.delivered_at = new Date();
    }

    const updated = await this.db
      .updateTable('shipments')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    // Notify client on status change.
    if (dto.status && dto.status !== current.status) {
      const invoice = await this.db
        .selectFrom('invoices')
        .select(['client_id', 'invoice_number'])
        .where('id', '=', updated.invoice_id)
        .executeTakeFirstOrThrow();
      await this.notifications.notifyClient(invoice.client_id, {
        type: 'shipment.status',
        title: `Shipment ${dto.status.replace('_', ' ')}`,
        body: `Invoice ${invoice.invoice_number}`,
        link: `/dashboard/shipments`,
        metadata: { shipment_id: id, status: dto.status },
      });
    }

    return updated;
  }

  private canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
    if (from === to) return true;
    const allowed: Record<ShipmentStatus, ShipmentStatus[]> = {
      label_created: ['in_transit', 'exception', 'returned'],
      in_transit: ['out_for_delivery', 'delivered', 'exception', 'returned'],
      out_for_delivery: ['delivered', 'exception', 'returned'],
      delivered: [],
      exception: ['in_transit', 'returned'],
      returned: [],
    };
    return allowed[from].includes(to);
  }

  listAll() {
    return this.db
      .selectFrom('shipments as s')
      .innerJoin('invoices as i', 'i.id', 's.invoice_id')
      .innerJoin('clients as c', 'c.id', 'i.client_id')
      .selectAll('s')
      .select([
        'i.invoice_number as invoice_number',
        CLIENT_NAME_SQL.as('client_name'),
      ])
      .orderBy('s.created_at', 'desc')
      .limit(500)
      .execute();
  }

  async getById(id: string) {
    const row = await this.db
      .selectFrom('shipments as s')
      .innerJoin('invoices as i', 'i.id', 's.invoice_id')
      .innerJoin('clients as c', 'c.id', 'i.client_id')
      .selectAll('s')
      .select([
        'i.invoice_number as invoice_number',
        CLIENT_NAME_SQL.as('client_name'),
        'c.user_id as client_user_id',
      ])
      .where('s.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Shipment not found');
    return row;
  }

  async listForClientUser(userId: string) {
    const client = await this.db
      .selectFrom('clients')
      .select('id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!client) throw new ForbiddenException('No client profile');

    return this.db
      .selectFrom('shipments as s')
      .innerJoin('invoices as i', 'i.id', 's.invoice_id')
      .selectAll('s')
      .select(['i.invoice_number as invoice_number'])
      .where('i.client_id', '=', client.id)
      .orderBy('s.created_at', 'desc')
      .execute();
  }
}
