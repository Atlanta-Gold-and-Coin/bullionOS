import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, ShipmentStatus } from '../db/types';
import { IntegrationsService } from '../integrations/integrations.service';
import type { CredentialsFor } from '../integrations/integrations.registry';
import { toDbString } from '../common/money';
import { ShipmentsService } from '../shipments/shipments.service';
import { ShipmentIngestService } from '../integrations/shipment-ingest.service';

/**
 * IFS Clients (ifsclients.com) integration.
 *
 * Phase 1 scope (this file): mirror IFS's shipment dashboard inside
 * AGC Desk so operators can see today's labels without bouncing to
 * ifsclients.com. Read-only.
 *
 * Auth model: every request is a POST with form-data carrying
 * AppUserName, AppPassword, account_id. No bearer token, no refresh
 * — so we just attach the creds to every call. They live encrypted
 * in `integrations.credentials_encrypted` via IntegrationsService.
 *
 * Sync strategy: full reload. IFS's /ca_view_shipment_options.php
 * doesn't expose deltas, so we wipe + reinsert into ifs_shipments
 * inside a transaction on every sync. Per-customer shipment volume
 * is small (≤ a few thousand at most), so the cost is bounded.
 *
 * Cron cadence: 15 min, matching the Aurbitrage + Gmail patterns.
 * Operators can also force a refresh from the /admin/shipments IFS
 * tab via runSync().
 */

interface IfsApiResponse<T = unknown> {
  status?: 'success' | 'error' | string;
  message?: string;
  data?: T;
  // IFS sometimes returns the payload at the top level instead of
  // nested under `data`. We flatten both shapes.
  [key: string]: unknown;
}

export interface SyncResult {
  ok: boolean;
  message: string;
  count: number;
  synced_at: string;
}

export interface IfsShipmentRow {
  id: string;
  ifs_shipment_id: string;
  tracking_number: string | null;
  carrier: string | null;
  service_type: string | null;
  label_status: string | null;
  recipient_name: string | null;
  recipient_company: string | null;
  recipient_address: string | null;
  recipient_city: string | null;
  recipient_state: string | null;
  recipient_zip: string | null;
  recipient_country: string | null;
  declared_value: number | null;
  cost: number | null;
  ship_date: string | null;
  delivered_at: string | null;
  voided_at: string | null;
  label_url: string | null;
  tracking_url: string | null;
  reference: string | null;
  synced_at: string;
}

// ===== Phase 2: create-label wizard types =====
//
// One interface per IFS endpoint we surface to the FE. Keep the types
// "wizard-shaped" (booleans, numbers, normalized fields) rather than
// the raw IFS response shape — the service is the only place that
// knows IFS uses "Yes"/"No" strings, "1"/"0" flags, or top-level fields
// instead of a `data` envelope.

/** Output of #2 ca_basic_data.php — feeds dropdowns. */
export interface IfsBasicData {
  service_types: { id: string; text: string }[];
  packaging_types: { id: string; text: string }[];
  payment_types: { id: string; text: string }[];
  signature_types: { id: string; text: string }[];
  label_stock_types: { id: string; text: string }[];
}

/** One sender row from #3 ca_client_address_list.php. */
export interface IfsSenderListEntry {
  id: string;
  text: string;
  name: string;
  company_name: string;
  address1: string;
  is_residential: boolean;
  is_primary: boolean;
}

/** Hydrated sender from #4 ca_client_address_data.php. */
export interface IfsSenderData {
  company_name: string;
  name: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  fax: string;
  email: string;
  is_residential: boolean;
  is_primary: boolean;
  is_address_restricted: boolean;
  address_restricted_msg: string;
}

/** Recipient typeahead row from #5 ca_recipient_list.php. */
export interface IfsRecipientListEntry {
  id: string;
  name: string;
}

/** ZIP/service compatibility from #8 ca_change_zipcode_service.php. */
export interface IfsServiceRestrictionResult {
  is_restricted: boolean;
  message: string;
}

/** FedEx-corrected address from #9 ca_verify_recipient_address.php. */
export interface IfsAddressVerificationResult {
  corrected: {
    company_name: string;
    address1: string;
    address2: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  address_type: string;
  is_residential: boolean;
}

/** Zone from #13 ca_get_zone_id.php. Pass `zone_id` as-is to #20/#26. */
export interface IfsZoneInfo {
  zone_id: number;
  zone_name: string;
}

/** Service-by-packaging restrictions from #14. */
export interface IfsPackagingRestrictionResult {
  remove_service_type: string[];
  add_service_type: { id: string; text: string }[];
}

/** Weight check from #16. ok=false → render `message` as warning. */
export interface IfsWeightCheckResult {
  ok: boolean;
  message: string | null;
}

/**
 * Insurance value validation result from #17. The wizard renders the
 * popups (when present) as a decision tree: first → second → third.
 */
export interface IfsDeclareValueResult {
  is_error: boolean;
  needs_popup_chain: boolean;
  message: string;
  first_popup: { message: string[]; buttons: string[] } | null;
  second_popup: { message: string[]; buttons: string[] } | null;
  third_popup: { message: string[]; buttons: string[] } | null;
  multi_items_popup: { message: string[]; buttons: string[] } | null;
}

/** One Hold-at-Location result from #19. */
export interface IfsHalLocation {
  index: number;
  person_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  state_code: string;
  zip: string;
  country: string;
  location_in_property: string;
  distance: string;
  display_distance: string;
  map_url: string;
  location_id: string;
}

/** Cost preview from #20 ca_calculate_cost.php. */
export interface IfsCostPreview {
  final_amount: number;
  line_items: { title: string; value: string; severity: string | null }[];
  final_amount_2: number | null;
  line_items_2: { title: string; value: string; severity: string | null }[] | null;
}

/**
 * Wizard-side input for #26 ca_create_label.php. Domestic-only happy
 * path — international/multi-ship/pickup-scheduling are deferred (see
 * SESSION_HANDOFF_IFS_PHASE2.md). The DTO at the controller layer
 * mirrors this shape with class-validator decorators.
 */
export interface CreateLabelInput {
  // Sender
  ca_company_name: string;
  ca_name: string;
  ca_label_name: string;
  ca_email: string;
  ca_address1: string;
  ca_address2?: string;
  ca_city: string;
  ca_zip: string;
  ca_state: string;
  ca_state_id: string;
  ca_country: string;
  ca_phone: string;
  ca_fax?: string;
  // Recipient
  recipient_id?: string;
  client_label_name: string;
  client_company_name: string;
  client_name: string;
  client_address1: string;
  client_address2?: string;
  client_city: string;
  client_state: string;
  client_state_id: string;
  client_zip: string;
  client_country: string;
  client_phone: string;
  client_email?: string;
  client_is_address_verify: 0 | 1;
  residential: 0 | 1;
  // Package
  packaging_type: string;
  package_weight: number;
  packaging_dim_length?: number;
  packaging_dim_width?: number;
  packaging_dim_height?: number;
  // Service
  service_type: string;
  zone_id: number;
  signature_type1: string;
  saturday_delivery: 0 | 1;
  pickup_date: string; // MM-DD-YYYY
  declare_value: number;
  // Hold-at-Location (optional)
  hold_for_pu?: 0 | 1;
  hal_selected_value?: number;
  hal_company_name?: string;
  hal_address?: string;
  hal_city?: string;
  hal_state?: string;
  hal_state_id?: string;
  hal_zip?: string;
  hal_country?: string;
  hal_phone?: string;
  hal_contact_person?: string;
  hal_location_property?: string;
  hal_map_url?: string;
  hal_distance?: string;
  hal_email?: string;
  // Billing
  payment_type: 'SENDER' | 'RECIPIENT' | 'THIRD_PARTY';
  account_number?: string;
  cost?: number;
  // Reference / output
  reference?: string;
  reference_show_on_label?: 0 | 1;
  label_stock_type: string;
  gen_label_save: 0 | 1;
  display_receipt?: 0 | 1;
}

/** Output of createLabel — what the FE renders on the success screen. */
export interface IfsCreateLabelResult {
  shipment_id: string;
  tracking_no: string;
  view_label_link: string | null;
  view_return_label_link: string | null;
  view_receipt: string | null;
  message: string;
  /** UUID of the row written to local ifs_shipments. */
  ifs_shipments_row_id: string;
  /** UUID of the row written to local shipments (only when invoice_id provided). */
  shipments_row_id: string | null;
}

/** Output of #28 ca_view_shipment_details.php — selected fields the FE needs. */
export interface IfsShipmentDetails {
  shipment_id: string;
  tracking_no: string;
  fedex_status: string;
  service_type: string;
  pickup_date: string;
  declare_value: string;
  package_weight: string;
  cost_info: { text: string; value: string }[];
  delivered_to: string | null;
  delivered_date: string | null;
  delivered_signature: string | null;
  /** Full IFS payload for the FE to render whatever else it wants. */
  raw: unknown;
}

@Injectable()
export class IfsService {
  private readonly logger = new Logger(IfsService.name);

  // In-memory cache for #2 ca_basic_data.php. Enum values rarely change
  // and the wizard hits this on every mount; one-hour TTL keeps the FE
  // snappy without holding stale enums for too long.
  private cachedBasicData: IfsBasicData | null = null;
  private cachedBasicDataAt = 0;
  private static readonly BASIC_DATA_TTL_MS = 60 * 60 * 1000;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly integrations: IntegrationsService,
    private readonly shipments: ShipmentsService,
    private readonly shipmentIngest: ShipmentIngestService,
  ) {}

  async isAvailable(): Promise<boolean> {
    const creds = (await this.integrations.getCredentials(
      'ifs',
    )) as CredentialsFor<'ifs'> | null;
    return Boolean(creds?.app_user_name && creds?.app_password && creds?.account_id);
  }

  /**
   * Admin "Test connection" — calls the lightest endpoint (basic_data
   * #2) with the saved credentials. Returns ok/message in the same
   * shape every other provider's testConnection uses.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const creds = (await this.integrations.getCredentials(
      'ifs',
    )) as CredentialsFor<'ifs'> | null;
    if (!creds) return { ok: false, message: 'Not configured' };
    try {
      const res = await this.callIfs(creds, 'ca_basic_data.php');
      // IFS doesn't return a clean 'success' flag uniformly. Treat
      // a non-empty 200 response as success; surface the message
      // when one's present.
      if (res.status === 'error') {
        return { ok: false, message: res.message ?? 'IFS returned error' };
      }
      return {
        ok: true,
        message: `OK · acct ${creds.account_id}`,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message.slice(0, 500) };
    }
  }

  // ===== Phase 2: scheduled per-shipment status refresh =====
  //
  // Operators don't have direct FedEx API credentials — labels are
  // created through IFS Clients (a FedEx reseller) so AGC's only
  // tracking-status path is IFS's #28 ca_view_shipment_details.php.
  // We poll non-terminal ifs_shipments rows on a windowed cron (the
  // operator's working hours, ET) and pipe each update through
  // ShipmentIngestService.ingest() so any linked invoice-tied shipment
  // row advances and notifications fire — same machinery the FedEx
  // adapter would use if creds were present. Single source of truth.
  //
  // Cadence policy: 15-min ticks during business hours only. FedEx
  // tracking events don't move minute-to-minute and we want to be a
  // polite IFS reseller-API consumer. ~23 fires/business-day × ~10
  // open shipments = ~230 calls/day at peak.
  //
  // Three @Cron decorators because the afternoon window straddles
  // 5:30pm — that's not a clean cron-hour boundary, so the simplest
  // expression is to split.

  /** 8:00 → 11:45 ET, every 15 min, Mon-Fri. */
  @Cron('*/15 8-11 * * 1-5', {
    name: 'ifs-status-morning',
    timeZone: 'America/New_York',
  })
  async statusRefreshMorning(): Promise<void> {
    await this.runStatusRefreshSafe();
  }

  /** 16:00 → 16:45 ET, every 15 min, Mon-Fri. */
  @Cron('*/15 16 * * 1-5', {
    name: 'ifs-status-afternoon-1',
    timeZone: 'America/New_York',
  })
  async statusRefreshAfternoon1(): Promise<void> {
    await this.runStatusRefreshSafe();
  }

  /** 17:00, 17:15, 17:30 ET Mon-Fri (last poll at 5:30pm). */
  @Cron('0,15,30 17 * * 1-5', {
    name: 'ifs-status-afternoon-2',
    timeZone: 'America/New_York',
  })
  async statusRefreshAfternoon2(): Promise<void> {
    await this.runStatusRefreshSafe();
  }

  private async runStatusRefreshSafe(): Promise<void> {
    if (!(await this.isAvailable())) return;
    try {
      const r = await this.runStatusRefresh();
      this.logger.log(
        `IFS status refresh: scanned=${r.scanned} updated=${r.updated} failed=${r.failed}`,
      );
    } catch (err) {
      this.logger.error(
        `IFS status refresh failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /**
   * Walk every non-terminal ifs_shipments row and refresh its status
   * via #28. Updates the local cache + (when a linked shipments row
   * exists) pipes through ShipmentIngestService so the invoice-tied
   * row advances + the client gets notified. Idempotent — calling
   * twice in a row makes no extra changes once IFS has nothing new.
   */
  async runStatusRefresh(): Promise<{
    scanned: number;
    updated: number;
    failed: number;
  }> {
    const open = await this.db
      .selectFrom('ifs_shipments')
      .select([
        'id',
        'ifs_shipment_id',
        'tracking_number',
        'label_status',
        'delivered_at',
        'voided_at',
      ])
      .where('voided_at', 'is', null)
      .where('delivered_at', 'is', null)
      .execute();

    let updated = 0;
    let failed = 0;

    // Serial — be polite to the reseller API. Volume is bounded; even
    // at hundreds of open shipments this stays well under a minute.
    for (const row of open) {
      try {
        const details = await this.viewShipmentDetails({
          shipment_id: row.ifs_shipment_id,
        });
        const fedexStatusRaw = (details.fedex_status || '').trim();
        const mapped = this.mapFedexStatusToShipmentStatus(fedexStatusRaw);
        const isDelivered = mapped === 'delivered';
        const deliveredAt = isDelivered
          ? this.parseDeliveredAt(details.delivered_date) ?? new Date()
          : null;

        // Update the local IFS cache row when anything moved.
        const patch: Record<string, unknown> = {};
        if (fedexStatusRaw && fedexStatusRaw !== row.label_status) {
          patch.label_status = fedexStatusRaw;
        }
        if (deliveredAt) {
          patch.delivered_at = deliveredAt;
        }
        if (Object.keys(patch).length > 0) {
          await this.db
            .updateTable('ifs_shipments')
            .set(patch)
            .where('id', '=', row.id)
            .execute();
        }

        // Propagate to the linked shipments row (if any) so the
        // invoice detail page + /admin/shipments + client notification
        // all stay in sync. Skip if no tracking number (shouldn't
        // happen post-create) or no mappable status yet.
        if (row.tracking_number && mapped) {
          await this.shipmentIngest.ingest({
            carrier: 'fedex',
            tracking_number: row.tracking_number,
            status: mapped,
            description: fedexStatusRaw || null,
            occurred_at: deliveredAt ?? new Date(),
            // IFS doesn't expose an event id we can dedupe on, so we
            // skip carrier_event_id and accept that re-polling may
            // record duplicate event rows — ingest's status guard
            // ensures the shipment row only advances forward.
            carrier_event_id: null,
            raw_payload: details.raw,
            source: 'poll',
            eta: null,
          });
        }

        if (Object.keys(patch).length > 0) updated += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `IFS status refresh failed for ifs_shipment_id=${row.ifs_shipment_id}: ${(err as Error).message}`,
        );
      }
    }

    return { scanned: open.length, updated, failed };
  }

  /**
   * IFS's #28 surfaces FedEx's status string verbatim. We don't get a
   * formal enum from IFS, so this matches keyword + 2-letter-code
   * variants defensively. Returns null when the string doesn't look
   * like any known FedEx status (then the local cache still updates
   * but the shipments-row propagation is skipped — better than a
   * misclassification firing the wrong notification).
   */
  private mapFedexStatusToShipmentStatus(
    raw: string,
  ): ShipmentStatus | null {
    const t = raw.trim().toLowerCase();
    if (!t) return null;
    // Order matters — "out for delivery" must beat "delivery" / "delivered".
    if (t === 'rs' || t.includes('return')) return 'returned';
    if (t === 'od' || t.includes('out for')) return 'out_for_delivery';
    if (
      t === 'de' ||
      t === 'hd' ||
      t.includes('exception') ||
      t.includes('hold for') ||
      t.includes('address correction')
    ) {
      return 'exception';
    }
    if (t === 'dl' || t.includes('deliver')) return 'delivered';
    if (
      t === 'pu' ||
      t === 'it' ||
      t === 'ar' ||
      t === 'dp' ||
      t.includes('transit') ||
      t.includes('picked') ||
      t.includes('arrived') ||
      t.includes('departed') ||
      t.includes('shipment information')
    ) {
      return 'in_transit';
    }
    if (
      t === 'oc' ||
      t === 'ma' ||
      t.includes('label') ||
      t.includes('manifest') ||
      t.includes('created')
    ) {
      return 'label_created';
    }
    return null;
  }

  /** IFS returns delivered_date as a free-form string. Best-effort parse. */
  private parseDeliveredAt(s: string | null): Date | null {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /**
   * Pull the full shipment list from IFS, replace the local cache
   * inside a transaction, and update the singleton sync_state row.
   */
  async runSync(): Promise<SyncResult> {
    const creds = (await this.integrations.getCredentials(
      'ifs',
    )) as CredentialsFor<'ifs'> | null;
    if (!creds) {
      throw new BadRequestException('IFS not configured');
    }

    let payload: IfsApiResponse;
    try {
      // The view-shipment-options endpoint returns the operator's
      // shipment list. IFS hasn't documented filtering params in the
      // postman collection, so we pull the default window (most-
      // recent N) and rely on full reload.
      payload = await this.callIfs(creds, 'ca_view_shipment_options.php');
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await this.recordSyncState({ ok: false, message: msg, count: 0 });
      throw new BadRequestException(`IFS fetch failed: ${msg}`);
    }

    if (payload.status === 'error') {
      const msg = String(payload.message ?? 'IFS returned error');
      await this.recordSyncState({ ok: false, message: msg, count: 0 });
      throw new BadRequestException(`IFS returned error: ${msg}`);
    }

    // The exact field names depend on IFS's response shape. Walk a
    // few common locations to find the shipment array — IFS's
    // postman docs list the endpoints but not the response shapes.
    // We accept any of: payload.data (object with shipments),
    // payload.shipments, payload.data.shipments, top-level array.
    const rawList = this.extractShipmentArray(payload);
    if (!Array.isArray(rawList)) {
      const msg = 'Unexpected IFS response — no shipment array found';
      await this.recordSyncState({ ok: false, message: msg, count: 0 });
      throw new BadRequestException(msg);
    }

    const inserts = rawList
      .map((raw) => this.mapShipmentRow(raw))
      .filter((r): r is NonNullable<ReturnType<typeof this.mapShipmentRow>> => r !== null);

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('ifs_shipments').execute();
      // Postgres parameter cap: chunk at 1000 rows per insert (each
      // row has ~22 cols, so ~22k params per chunk — well under the
      // 65k ceiling).
      for (let i = 0; i < inserts.length; i += 1000) {
        await trx
          .insertInto('ifs_shipments')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .values(inserts.slice(i, i + 1000) as any)
          .execute();
      }
    });

    const result: SyncResult = {
      ok: true,
      message: `Synced ${inserts.length} shipments`,
      count: inserts.length,
      synced_at: new Date().toISOString(),
    };
    await this.recordSyncState({
      ok: true,
      message: result.message,
      count: inserts.length,
    });
    return result;
  }

  /** Browse the locally cached IFS shipments. */
  async listShipments(opts: { limit?: number; search?: string } = {}): Promise<IfsShipmentRow[]> {
    let q = this.db
      .selectFrom('ifs_shipments')
      .selectAll()
      .orderBy('ship_date', 'desc')
      .orderBy('synced_at', 'desc')
      .limit(opts.limit ?? 500);
    if (opts.search?.trim()) {
      const needle = `%${opts.search.trim().toLowerCase()}%`;
      q = q.where((eb) =>
        eb.or([
          sql<boolean>`lower(coalesce(tracking_number,'')) like ${needle}`,
          sql<boolean>`lower(coalesce(recipient_name,'')) like ${needle}`,
          sql<boolean>`lower(coalesce(recipient_company,'')) like ${needle}`,
          sql<boolean>`lower(coalesce(recipient_city,'')) like ${needle}`,
          sql<boolean>`lower(coalesce(reference,'')) like ${needle}`,
        ]),
      );
    }
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      ifs_shipment_id: r.ifs_shipment_id,
      tracking_number: r.tracking_number,
      carrier: r.carrier,
      service_type: r.service_type,
      label_status: r.label_status,
      recipient_name: r.recipient_name,
      recipient_company: r.recipient_company,
      recipient_address: r.recipient_address,
      recipient_city: r.recipient_city,
      recipient_state: r.recipient_state,
      recipient_zip: r.recipient_zip,
      recipient_country: r.recipient_country,
      declared_value:
        r.declared_value !== null ? Number(r.declared_value) : null,
      cost: r.cost !== null ? Number(r.cost) : null,
      ship_date: r.ship_date,
      delivered_at: r.delivered_at ? r.delivered_at.toString() : null,
      voided_at: r.voided_at ? r.voided_at.toString() : null,
      label_url: r.label_url,
      tracking_url: r.tracking_url,
      reference: r.reference,
      synced_at: r.synced_at.toString(),
    }));
  }

  async getSyncState(): Promise<{
    last_synced_at: string | null;
    last_sync_status: string | null;
    last_sync_message: string | null;
    last_sync_count: number | null;
    configured: boolean;
  }> {
    const row = await this.db
      .selectFrom('ifs_sync_state')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirst();
    return {
      last_synced_at: row?.last_synced_at ? row.last_synced_at.toString() : null,
      last_sync_status: row?.last_sync_status ?? null,
      last_sync_message: row?.last_sync_message ?? null,
      last_sync_count: row?.last_sync_count ?? null,
      configured: await this.isAvailable(),
    };
  }

  // ===== Phase 2: create-label wizard =====
  //
  // Each method here corresponds 1:1 with an IFS endpoint, taking
  // wizard-shaped input + returning wizard-shaped output. The transport
  // (auth, timeout, error parsing) is delegated to callIfs(). Status
  // checking is delegated to requireSuccess() so every method handles
  // IFS errors uniformly.

  /** #2 ca_basic_data.php — enum dropdowns. Cached in memory for 1h. */
  async getBasicData(): Promise<IfsBasicData> {
    const fresh =
      this.cachedBasicData &&
      Date.now() - this.cachedBasicDataAt < IfsService.BASIC_DATA_TTL_MS;
    if (fresh && this.cachedBasicData) return this.cachedBasicData;
    const creds = await this.requireCreds();
    const res = await this.callIfs(creds, 'ca_basic_data.php');
    this.requireSuccess(res, 'getBasicData');
    // The basic-data response format isn't in the Postman collection;
    // we walk the response defensively and pull whatever option arrays
    // we recognize. Empty arrays are acceptable — the FE just won't
    // populate that dropdown until IFS surfaces the values.
    const out: IfsBasicData = {
      service_types: this.toOptions(res, [
        'service_type_array',
        'service_types',
        'service_type',
      ]),
      packaging_types: this.toOptions(res, [
        'packaging_type_array',
        'packaging_types',
        'packaging_type',
      ]),
      payment_types: this.toOptions(res, [
        'payment_type_array',
        'payment_types',
        'payment_type',
      ]),
      signature_types: this.toOptions(res, [
        'signature_type_array',
        'signature_types',
        'signature_type1',
        'signature_type',
      ]),
      label_stock_types: this.toOptions(res, [
        'label_stock_type_array',
        'label_stock_types',
        'label_stock_type',
      ]),
    };
    this.cachedBasicData = out;
    this.cachedBasicDataAt = Date.now();
    return out;
  }

  /** #3 ca_client_address_list.php — sender dropdown. */
  async listSenders(): Promise<{
    senders: IfsSenderListEntry[];
    primary_id: string | null;
  }> {
    const creds = await this.requireCreds();
    const res = await this.callIfs(creds, 'ca_client_address_list.php');
    this.requireSuccess(res, 'listSenders');
    const list = Array.isArray(res.client_address)
      ? (res.client_address as Record<string, unknown>[])
      : [];
    const senders: IfsSenderListEntry[] = list.map((e) => ({
      id: String(e.id ?? ''),
      text: String(e.text ?? ''),
      name: String(e.name ?? ''),
      company_name: String(e.company_name ?? ''),
      address1: String(e.address1 ?? ''),
      is_residential: this.toBool(e.is_residential),
      is_primary: this.toBool(e.is_primaric),
    }));
    const primary =
      (res.primaric_client_address_id as string | undefined) ?? null;
    return { senders, primary_id: primary || null };
  }

  /** #4 ca_client_address_data.php — hydrate one sender. */
  async getSender(clientAddressId: string): Promise<IfsSenderData> {
    if (!clientAddressId) {
      throw new BadRequestException('client_address_id is required');
    }
    const creds = await this.requireCreds();
    const res = await this.callIfs(creds, 'ca_client_address_data.php', {
      client_address_id: clientAddressId,
    });
    this.requireSuccess(res, 'getSender');
    const d = (res.client_address_data as Record<string, unknown>) ?? {};
    return {
      company_name: String(d.company_name ?? ''),
      name: String(d.name ?? ''),
      address1: String(d.address1 ?? ''),
      address2: String(d.address2 ?? ''),
      city: String(d.city ?? ''),
      state: String(d.state ?? ''),
      zip: String(d.zip ?? ''),
      country: String(d.country ?? ''),
      phone: String(d.phone ?? ''),
      fax: String(d.fax ?? ''),
      email: String(d.email ?? ''),
      is_residential: this.toBool(d.is_residential),
      is_primary: this.toBool(d.is_primaric),
      is_address_restricted: String(d.IsAddressRestricted ?? '').toLowerCase() === 'yes',
      address_restricted_msg: String(d.AddressRestrictedMsg ?? ''),
    };
  }

  /** #5 ca_recipient_list.php — recipient typeahead. */
  async searchRecipients(term: string): Promise<IfsRecipientListEntry[]> {
    const creds = await this.requireCreds();
    const res = await this.callIfs(creds, 'ca_recipient_list.php', {
      term: term ?? '',
    });
    this.requireSuccess(res, 'searchRecipients');
    const list = Array.isArray(res.recipient_list)
      ? (res.recipient_list as Record<string, unknown>[])
      : [];
    return list.map((e) => ({
      id: String(e.id ?? ''),
      name: String(e.name ?? ''),
    }));
  }

  /** #8 ca_change_zipcode_service.php — ZIP/service compatibility. */
  async getServiceRestriction(args: {
    ca_country: string;
    client_country: string;
    service_type: string;
    client_zip: string;
  }): Promise<IfsServiceRestrictionResult> {
    const creds = await this.requireCreds();
    const res = await this.callIfs(creds, 'ca_change_zipcode_service.php', {
      ca_country: args.ca_country,
      client_country: args.client_country,
      service_type: args.service_type,
      client_zip: args.client_zip,
    });
    // This endpoint returns "Allow" in `message` even on success; status
    // === '1' is the actual signal. requireSuccess raises only on '0'.
    this.requireSuccess(res, 'getServiceRestriction');
    return {
      is_restricted: String(res.is_restricted ?? '').toLowerCase() === 'yes',
      message: String(res.message ?? ''),
    };
  }

  /** #9 ca_verify_recipient_address.php — FedEx address verify. */
  async verifyRecipientAddress(args: {
    client_address1: string;
    client_country: string;
    client_zip: string;
    recipient_id?: string;
    client_company_name?: string;
    client_address2?: string;
    client_city?: string;
    client_state?: string;
  }): Promise<IfsAddressVerificationResult> {
    const creds = await this.requireCreds();
    const res = await this.callIfs(
      creds,
      'ca_verify_recipient_address.php',
      this.compactStrings(args),
    );
    this.requireSuccess(res, 'verifyRecipientAddress');
    const d = (res.address_data as Record<string, unknown>) ?? {};
    return {
      corrected: {
        company_name: String(d.company_name ?? ''),
        address1: String(d.address ?? ''),
        address2: String(d.address2 ?? ''),
        city: String(d.city ?? ''),
        state: String(d.state ?? ''),
        zip: String(d.zip ?? ''),
        country: String(d.country ?? ''),
      },
      address_type: String(d.address_type ?? ''),
      is_residential: Number(d.residential_address_status ?? 0) === 1,
    };
  }

  /** #11 ca_update_recipient_address.php — accept FedEx-corrected address. */
  async acceptCorrectedAddress(args: {
    recipient_id: string;
    FAAddress: string;
    FACity: string;
    FAState: string;
    FAZip: string;
    FACountry: string;
    FACompanyName?: string;
    FAAddress2?: string;
    FAResidentialStatus?: number;
  }): Promise<{ ok: boolean; message: string }> {
    const creds = await this.requireCreds();
    const res = await this.callIfs(
      creds,
      'ca_update_recipient_address.php',
      this.compactStrings({
        ...args,
        FAResidentialStatus:
          args.FAResidentialStatus !== undefined
            ? String(args.FAResidentialStatus)
            : undefined,
      }),
    );
    this.requireSuccess(res, 'acceptCorrectedAddress');
    return { ok: true, message: String(res.message ?? '') };
  }

  /** #13 ca_get_zone_id.php — required for #20/#26. */
  async getZoneId(args: {
    recipient_zip: string;
    recipient_country: string;
    shipper_zip: string;
    shipper_country: string;
    service_type: string;
    recipient_address?: string;
    recipient_city?: string;
    recipient_state?: string;
    shipper_address?: string;
    shipper_city?: string;
    shipper_state?: string;
  }): Promise<IfsZoneInfo> {
    const creds = await this.requireCreds();
    const res = await this.callIfs(
      creds,
      'ca_get_zone_id.php',
      this.compactStrings(args),
    );
    this.requireSuccess(res, 'getZoneId');
    return {
      zone_id: Number(res.zone_id ?? 0),
      zone_name: String(res.zone_name ?? ''),
    };
  }

  /** #14 ca_restrict_service_type_from_package_type.php */
  async getServiceTypesForPackage(
    packagingType: string,
  ): Promise<IfsPackagingRestrictionResult> {
    const creds = await this.requireCreds();
    const res = await this.callIfs(
      creds,
      'ca_restrict_service_type_from_package_type.php',
      { packaging_type: packagingType },
    );
    this.requireSuccess(res, 'getServiceTypesForPackage');
    const removeRaw = Array.isArray(res.remove_service_type)
      ? (res.remove_service_type as unknown[])
      : [];
    const addRaw = Array.isArray(res.add_service_type)
      ? (res.add_service_type as Record<string, unknown>[])
      : [];
    return {
      remove_service_type: removeRaw.map((v) => String(v)),
      add_service_type: addRaw.map((e) => ({
        id: String(e.id ?? ''),
        text: String(e.text ?? ''),
      })),
    };
  }

  /** #16 ca_check_package_weight.php */
  async checkWeight(args: {
    packaging_type: string;
    service_type: string;
    package_weight: number;
    packaging_dim_length?: number;
    packaging_dim_width?: number;
    packaging_dim_height?: number;
  }): Promise<IfsWeightCheckResult> {
    const creds = await this.requireCreds();
    const extra: Record<string, string> = {
      packaging_type: args.packaging_type,
      service_type: args.service_type,
      package_weight: String(args.package_weight),
    };
    if (args.packaging_dim_length !== undefined)
      extra.packaging_dim_length = String(args.packaging_dim_length);
    if (args.packaging_dim_width !== undefined)
      extra.packaging_dim_width = String(args.packaging_dim_width);
    if (args.packaging_dim_height !== undefined)
      extra.packaging_dim_height = String(args.packaging_dim_height);
    const res = await this.callIfs(creds, 'ca_check_package_weight.php', extra);
    this.requireSuccess(res, 'checkWeight');
    const flagged =
      String(res.package_weight_notification ?? '').toLowerCase() === 'yes';
    return {
      ok: !flagged,
      message: flagged ? String(res.message ?? '') : null,
    };
  }

  /** #17 ca_check_declare_value.php — insurance popup decision tree. */
  async checkDeclareValue(args: {
    service_type: string;
    ca_country: string;
    client_country: string;
    declare_value?: number;
  }): Promise<IfsDeclareValueResult> {
    const creds = await this.requireCreds();
    const extra: Record<string, string> = {
      service_type: args.service_type,
      ca_country: args.ca_country,
      client_country: args.client_country,
    };
    if (args.declare_value !== undefined)
      extra.declare_value = String(args.declare_value);
    const res = await this.callIfs(creds, 'ca_check_declare_value.php', extra);
    // NOTE: this endpoint can return status='0' even when the response is
    // a valid popup chain (per the docs). Don't requireSuccess — the FE
    // needs the whole payload regardless.
    const popup = (key: string) => {
      const p = res[key] as Record<string, unknown> | undefined;
      if (!p || typeof p !== 'object') return null;
      const m = Array.isArray(p.message) ? (p.message as unknown[]) : [];
      const b = Array.isArray(p.button_lbl) ? (p.button_lbl as unknown[]) : [];
      return { message: m.map((x) => String(x)), buttons: b.map((x) => String(x)) };
    };
    return {
      is_error:
        String(res.display_declare_value_related_message_status ?? '').toLowerCase() ===
        'yes',
      needs_popup_chain:
        String(res.display_declare_value_related_popup_status ?? '').toLowerCase() ===
        'yes',
      message: String(res.message ?? ''),
      first_popup: popup('display_declare_value_related_first_popup'),
      second_popup: popup('display_declare_value_related_second_popup'),
      third_popup: popup('display_declare_value_related_third_popup'),
      multi_items_popup: popup('display_declare_value_related_multiitems_popup'),
    };
  }

  /** #19 ca_get_hold_for_pickup_location.php */
  async getHoldForPickupLocations(args: {
    shipping_zip: string;
    service_type: string;
    shipping_address?: string;
    shipping_city?: string;
    shipping_state?: string;
    shipping_country?: string;
  }): Promise<IfsHalLocation[]> {
    const creds = await this.requireCreds();
    const res = await this.callIfs(
      creds,
      'ca_get_hold_for_pickup_location.php',
      this.compactStrings(args),
    );
    this.requireSuccess(res, 'getHoldForPickupLocations');
    const list = Array.isArray(res.hold_for_location_array)
      ? (res.hold_for_location_array as Record<string, unknown>[])
      : [];
    return list.map((e, i) => ({
      index: i,
      person_name: String(e.PersonName ?? ''),
      email: String(e.Email ?? ''),
      phone: String(e.PhoneNumber ?? ''),
      address: String(e.Address ?? ''),
      city: String(e.City ?? ''),
      state: String(e.State ?? ''),
      state_code: String(e.StateOrProvinceCode ?? ''),
      zip: String(e.PostalCode ?? ''),
      country: String(e.CountryCode ?? ''),
      location_in_property: String(e.LocationInProperty ?? ''),
      distance: String(e.Distance ?? ''),
      display_distance: String(e.DisplayDistance ?? ''),
      map_url: String(e.MapUrl ?? ''),
      location_id: String(e.locationId ?? ''),
    }));
  }

  /** #20 ca_calculate_cost.php — cost preview. */
  async calculateCost(input: CreateLabelInput): Promise<IfsCostPreview> {
    const creds = await this.requireCreds();
    const form = this.buildLabelForm(input);
    const res = await this.callIfs(creds, 'ca_calculate_cost.php', form);
    this.requireSuccess(res, 'calculateCost');
    const items = Array.isArray(res.CostDisplayHtmlArray)
      ? (res.CostDisplayHtmlArray as Record<string, unknown>[])
      : [];
    const items2 = Array.isArray(res.CostDisplayHtmlArray2)
      ? (res.CostDisplayHtmlArray2 as Record<string, unknown>[])
      : null;
    return {
      final_amount: Number(res.final_amount ?? 0),
      line_items: items.map((i) => ({
        title: String(i.title ?? ''),
        value: String(i.display_value ?? ''),
        severity: i.message_type ? String(i.message_type) : null,
      })),
      final_amount_2:
        res.final_amount2 !== undefined && res.final_amount2 !== null
          ? Number(res.final_amount2)
          : null,
      line_items_2:
        items2 !== null
          ? items2.map((i) => ({
              title: String(i.title ?? ''),
              value: String(i.display_value ?? ''),
              severity: i.message_type ? String(i.message_type) : null,
            }))
          : null,
    };
  }

  /**
   * #26 ca_create_label.php — submit. On success persists to
   * ifs_shipments and (when invoiceId provided) to the local
   * `shipments` table via ShipmentsService.create() so the label
   * appears on /admin/invoices/[id] and /admin/shipments alongside
   * UPS/USPS labels.
   */
  async createLabel(
    input: CreateLabelInput,
    opts: { invoiceId?: string; actorUserId: string },
  ): Promise<IfsCreateLabelResult> {
    const creds = await this.requireCreds();
    const form = this.buildLabelForm(input);
    const res = await this.callIfs(creds, 'ca_create_label.php', form);
    this.requireSuccess(res, 'createLabel');

    const ifsShipmentId = String(res.shipment_id ?? '').trim();
    const trackingNo = String(res.tracking_no ?? '').trim();
    if (!ifsShipmentId || !trackingNo) {
      throw new BadRequestException(
        `IFS returned label without shipment_id or tracking_no: ${JSON.stringify(res).slice(0, 300)}`,
      );
    }
    const labelUrl = (res.view_label_link as string) || null;
    const returnLabelUrl = (res.view_return_label_link as string) || null;
    const receiptUrl = (res.view_receipt as string) || null;

    // Persist to ifs_shipments. We know all the addresses + cost from
    // the wizard input; the IFS response only adds shipment_id, tracking
    // and the PDF URLs.
    const ifsRow = await this.db
      .insertInto('ifs_shipments')
      .values({
        ifs_shipment_id: ifsShipmentId,
        tracking_number: trackingNo,
        carrier: 'FedEx',
        service_type: input.service_type,
        label_status: 'ACTIVE',
        sender_name: input.ca_label_name || input.ca_name,
        sender_company: input.ca_company_name,
        sender_address: this.joinAddr([input.ca_address1, input.ca_address2]),
        recipient_name: input.client_label_name,
        recipient_company: input.client_name,
        recipient_address: this.joinAddr([
          input.client_address1,
          input.client_address2,
        ]),
        recipient_city: input.client_city,
        recipient_state: input.client_state,
        recipient_zip: input.client_zip,
        recipient_country: input.client_country,
        declared_value: toDbString(input.declare_value),
        cost: input.cost !== undefined ? toDbString(input.cost) : null,
        ship_date: input.pickup_date,
        delivered_at: null,
        voided_at: null,
        label_url: labelUrl,
        tracking_url: null,
        reference: input.reference ?? null,
        raw_payload: sql`${JSON.stringify({ input, response: res })}::jsonb`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Optional: tie to invoice via the existing shipments table so the
    // label surfaces on /admin/invoices/[id] and /admin/shipments. The
    // ShipmentsService.create call also fires the client notification.
    let shipmentsRowId: string | null = null;
    if (opts.invoiceId) {
      try {
        const shipment = await this.shipments.create(
          {
            invoice_id: opts.invoiceId,
            carrier: 'fedex',
            tracking_number: trackingNo,
            weight_lbs: input.package_weight,
            insurance_amount: input.declare_value,
            notes: `Created via IFS · ${ifsShipmentId}`,
          },
          opts.actorUserId,
        );
        shipmentsRowId = shipment.id;
      } catch (err) {
        // Don't fail the whole flow if the local link breaks — the IFS
        // label still exists on ifsclients.com. Surface to logs so the
        // operator can manually link via the standard "Add shipment"
        // form on the invoice detail page.
        this.logger.error(
          `Failed to link IFS label ${ifsShipmentId} to invoice ${opts.invoiceId}: ${(err as Error).message}`,
        );
      }
    }

    return {
      shipment_id: ifsShipmentId,
      tracking_no: trackingNo,
      view_label_link: labelUrl,
      view_return_label_link: returnLabelUrl,
      view_receipt: receiptUrl,
      message: String(res.message ?? 'Label created'),
      ifs_shipments_row_id: ifsRow.id,
      shipments_row_id: shipmentsRowId,
    };
  }

  /** #28 ca_view_shipment_details.php — refresh a known shipment. */
  async viewShipmentDetails(
    args: { shipment_id?: string; tracking_no?: string },
  ): Promise<IfsShipmentDetails> {
    const id = args.shipment_id?.trim();
    const tn = args.tracking_no?.trim();
    if (!id && !tn) {
      throw new BadRequestException(
        'Either shipment_id or tracking_no is required',
      );
    }
    const creds = await this.requireCreds();
    const extra: Record<string, string> = {};
    if (id) extra.shipment_id = id;
    else if (tn) extra.tracking_no = tn;
    const res = await this.callIfs(creds, 'ca_view_shipment_details.php', extra);
    this.requireSuccess(res, 'viewShipmentDetails');
    const psi = (res.package_shipment_info as Record<string, unknown>) ?? {};
    const di = (res.delivery_information as Record<string, unknown>) ?? {};
    const ci = Array.isArray(res.cost_info)
      ? (res.cost_info as Record<string, unknown>[])
      : [];
    return {
      shipment_id: String(psi.confirmation_no ?? id ?? ''),
      tracking_no: String(psi.tracking_no ?? tn ?? ''),
      fedex_status: String(psi.fedex_status ?? ''),
      service_type: String(psi.service_type ?? ''),
      pickup_date: String(psi.pickup_date ?? ''),
      declare_value: String(psi.declare_value ?? ''),
      package_weight: String(psi.package_weight ?? ''),
      cost_info: ci.map((e) => ({
        text: String(e.text ?? ''),
        value: String(e.value ?? ''),
      })),
      delivered_to: di.delivered_to ? String(di.delivered_to) : null,
      delivered_date: di.delivered_date ? String(di.delivered_date) : null,
      delivered_signature: di.delivered_signature
        ? String(di.delivered_signature)
        : null,
      raw: res,
    };
  }

  /**
   * #31 ca_void_shipment.php — voids the IFS Inforsure side only. The
   * FedEx label remains usable; the caller MUST surface the warning
   * to the operator. Updates the local ifs_shipments row to mark
   * voided_at.
   */
  async voidShipment(
    shipmentId: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (!shipmentId) {
      throw new BadRequestException('shipment_id is required');
    }
    const creds = await this.requireCreds();
    const res = await this.callIfs(creds, 'ca_void_shipment.php', {
      shipment_id: shipmentId,
    });
    this.requireSuccess(res, 'voidShipment');
    await this.db
      .updateTable('ifs_shipments')
      .set({
        voided_at: new Date(),
        label_status: 'VOIDED',
      })
      .where('ifs_shipment_id', '=', shipmentId)
      .execute();
    return { ok: true, message: String(res.message ?? '') };
  }

  // --- internals ---

  /**
   * Call an IFS endpoint with form-data auth. IFS expects every
   * request to be POST with the credentials in the body, so this is
   * the single transport helper. 30s timeout matches our other
   * outbound integrations.
   */
  private async callIfs(
    creds: CredentialsFor<'ifs'>,
    endpoint: string,
    extra: Record<string, string> = {},
  ): Promise<IfsApiResponse> {
    const url = `${creds.url.replace(/\/$/, '')}/${endpoint}`;
    const form = new URLSearchParams();
    form.set('AppUserName', creds.app_user_name);
    form.set('AppPassword', creds.app_password);
    form.set('account_id', creds.account_id);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': 'BullionOS/1.0',
        },
        body: form.toString(),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
        );
      }
      // Parse — most endpoints return JSON, but if IFS ever returns
      // HTML on auth failure, surface the first chunk so the operator
      // can diagnose.
      try {
        return JSON.parse(text) as IfsApiResponse;
      } catch {
        throw new Error(
          `IFS returned non-JSON: ${text.slice(0, 200)}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * IFS's response shape isn't documented in the postman collection
   * — so we walk the tree looking for the first array of objects
   * that looks like shipments. Common locations checked:
   *   - payload.shipments
   *   - payload.data
   *   - payload.data.shipments
   *   - payload (top-level array)
   *   - any first-level array key
   */
  private extractShipmentArray(payload: IfsApiResponse): unknown[] | null {
    if (Array.isArray(payload)) return payload as unknown[];
    if (Array.isArray((payload as Record<string, unknown>).shipments))
      return (payload as { shipments: unknown[] }).shipments;
    const data = (payload as Record<string, unknown>).data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (Array.isArray(d.shipments)) return d.shipments;
      // First array value found inside data.
      for (const v of Object.values(d)) {
        if (Array.isArray(v)) return v;
      }
    }
    // Last resort: scan top-level keys for an array.
    for (const v of Object.values(payload)) {
      if (Array.isArray(v)) return v;
    }
    return null;
  }

  /**
   * Translate one raw IFS shipment object into the local-table row
   * shape. IFS uses snake_case in their forms but camelCase in some
   * response variants — we accept both via the field-fallback chain.
   * Skips rows that don't have at minimum an ifs_shipment_id /
   * tracking_no — those would violate the unique constraint.
   */
  private mapShipmentRow(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const get = (...keys: string[]): string | null => {
      for (const k of keys) {
        const v = r[k];
        if (v !== undefined && v !== null && v !== '') return String(v);
      }
      return null;
    };
    const num = (...keys: string[]): string | null => {
      const s = get(...keys);
      if (s === null) return null;
      const n = Number(s.toString().replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? toDbString(n) : null;
    };

    const ifsId =
      get('shipment_id', 'shipmentId', 'id') ??
      get('tracking_no', 'tracking_number', 'trackingNo');
    if (!ifsId) return null;

    return {
      ifs_shipment_id: ifsId,
      tracking_number: get('tracking_no', 'tracking_number', 'trackingNo'),
      carrier: get('service_type', 'carrier', 'courier'),
      service_type: get('service_type', 'serviceType', 'service'),
      label_status: get('status', 'label_status', 'labelStatus'),
      sender_name: get('ca_label_name', 'sender_name', 'senderName'),
      sender_company: get('ca_company_name', 'sender_company'),
      sender_address: get('ca_address1', 'sender_address'),
      recipient_name: get('client_label_name', 'recipient_name', 'recipientName'),
      recipient_company: get('client_name', 'recipient_company'),
      recipient_address: get('client_address1', 'recipient_address'),
      recipient_city: get('client_city', 'recipient_city'),
      recipient_state: get('client_state', 'recipient_state'),
      recipient_zip: get('client_zip', 'recipient_zip'),
      recipient_country: get('client_country', 'recipient_country'),
      declared_value: num('declare_value', 'declared_value', 'insurance'),
      cost: num('cost', 'shipment_cost', 'total_cost'),
      ship_date: get('pickup_date', 'ship_date', 'shipDate'),
      delivered_at: null, // IFS exposes this through #28 on a per-shipment basis; not in list view
      voided_at: get('voided_at')
        ? new Date(get('voided_at') as string)
        : null,
      label_url: get('label_url', 'pdf_url'),
      tracking_url: get('tracking_url'),
      reference: get('reference'),
      raw_payload: sql`${JSON.stringify(r)}::jsonb`,
    };
  }

  // ===== Phase 2 helpers =====

  /** Pull credentials or throw a 400. Used by every wizard method. */
  private async requireCreds(): Promise<CredentialsFor<'ifs'>> {
    const creds = (await this.integrations.getCredentials(
      'ifs',
    )) as CredentialsFor<'ifs'> | null;
    if (!creds) throw new BadRequestException('IFS not configured');
    return creds;
  }

  /**
   * IFS uses `status: "1"` for success and `status: "0"` (sometimes
   * `"error"`) for failure. We standardize on raising a
   * BadRequestException with the IFS message so the FE can show the
   * actual cause, not a generic 500.
   */
  private requireSuccess(res: IfsApiResponse, context: string): void {
    const s = String(res.status ?? '').toLowerCase();
    if (s === '1' || s === 'success') return;
    const msg = String(res.message ?? `IFS ${context} failed`).slice(0, 500);
    throw new BadRequestException(`${context}: ${msg}`);
  }

  /** Strip undefined/null values and stringify for the form-data layer. */
  private compactStrings(
    obj: Record<string, string | number | undefined | null>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      out[k] = String(v);
    }
    return out;
  }

  /** Coerce IFS-style "0"/"1"/"Yes"/"No" to a boolean. */
  private toBool(v: unknown): boolean {
    if (v === true || v === 1) return true;
    const s = String(v ?? '').toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  }

  /**
   * Pull an `[{id, text}, ...]` array out of a basic-data response,
   * trying multiple key names. Returns [] if none match — the wizard
   * can still operate with a free-text input until IFS surfaces enums.
   */
  private toOptions(
    res: IfsApiResponse,
    keys: string[],
  ): { id: string; text: string }[] {
    for (const k of keys) {
      const v = (res as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        return (v as Record<string, unknown>[])
          .filter((e) => e && typeof e === 'object')
          .map((e) => ({
            id: String(e.id ?? e.value ?? e.code ?? ''),
            text: String(e.text ?? e.label ?? e.name ?? e.id ?? ''),
          }))
          .filter((e) => e.id || e.text);
      }
    }
    return [];
  }

  /** Join address1 + address2, dropping empties. */
  private joinAddr(parts: (string | undefined | null)[]): string {
    return parts.filter((p) => p && String(p).trim()).join(', ');
  }

  /**
   * Translate the wizard-shaped CreateLabelInput into the snake_case
   * form-data shape #20 and #26 expect. Both endpoints take the same
   * field names; only the response differs. Optional fields with
   * empty values are dropped so IFS doesn't fail validation on
   * "expected number, got empty string".
   */
  private buildLabelForm(input: CreateLabelInput): Record<string, string> {
    const flat: Record<string, string | number | undefined | null> = {
      // Sender
      ca_company_name: input.ca_company_name,
      ca_name: input.ca_name,
      ca_label_name: input.ca_label_name,
      ca_email: input.ca_email,
      ca_address1: input.ca_address1,
      ca_address2: input.ca_address2,
      ca_city: input.ca_city,
      ca_zip: input.ca_zip,
      ca_state: input.ca_state,
      ca_state_id: input.ca_state_id,
      ca_country: input.ca_country,
      ca_phone: input.ca_phone,
      ca_fax: input.ca_fax,
      // Recipient
      recipient_id: input.recipient_id,
      client_label_name: input.client_label_name,
      client_company_name: input.client_company_name,
      client_name: input.client_name,
      client_address1: input.client_address1,
      client_address2: input.client_address2,
      client_city: input.client_city,
      client_state: input.client_state,
      client_state_id: input.client_state_id,
      client_zip: input.client_zip,
      client_country: input.client_country,
      client_phone: input.client_phone,
      client_email: input.client_email,
      client_is_address_verify: input.client_is_address_verify,
      residential: input.residential,
      // Package
      packaging_type: input.packaging_type,
      package_weight: input.package_weight,
      packaging_dim_length: input.packaging_dim_length,
      packaging_dim_width: input.packaging_dim_width,
      packaging_dim_height: input.packaging_dim_height,
      // Service
      service_type: input.service_type,
      zone_id: input.zone_id,
      signature_type1: input.signature_type1,
      saturday_delivery: input.saturday_delivery,
      pickup_date: input.pickup_date,
      declare_value: input.declare_value,
      // HAL
      hold_for_pu: input.hold_for_pu,
      hal_selected_value: input.hal_selected_value,
      hal_company_name: input.hal_company_name,
      hal_address: input.hal_address,
      hal_city: input.hal_city,
      hal_state: input.hal_state,
      hal_state_id: input.hal_state_id,
      hal_zip: input.hal_zip,
      hal_country: input.hal_country,
      hal_phone: input.hal_phone,
      hal_contact_person: input.hal_contact_person,
      hal_location_property: input.hal_location_property,
      hal_map_url: input.hal_map_url,
      hal_distance: input.hal_distance,
      hal_email: input.hal_email,
      // Billing
      payment_type: input.payment_type,
      account_number: input.account_number,
      cost: input.cost,
      // Reference / output
      reference: input.reference,
      reference_show_on_label: input.reference_show_on_label,
      label_stock_type: input.label_stock_type,
      gen_label_save: input.gen_label_save,
      display_receipt: input.display_receipt,
    };
    return this.compactStrings(flat);
  }

  private async recordSyncState(args: {
    ok: boolean;
    message: string;
    count: number;
  }): Promise<void> {
    await this.db
      .insertInto('ifs_sync_state')
      .values({
        id: 1,
        last_synced_at: new Date(),
        last_sync_status: args.ok ? 'ok' : 'error',
        last_sync_message: args.message.slice(0, 500),
        last_sync_count: args.count,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          last_synced_at: new Date(),
          last_sync_status: args.ok ? 'ok' : 'error',
          last_sync_message: args.message.slice(0, 500),
          last_sync_count: args.count,
        }),
      )
      .execute();
  }
}
