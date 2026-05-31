import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

// ===== Shared column helpers =====
// Timestamps are Date objects on the JS side. Kysely + node-postgres handle
// conversion. We use ColumnType inline on specific columns only if we need
// a different insert shape; nesting ColumnType inside Generated<> fails to
// unwrap on read, so keep Timestamp as the concrete Date type.
type Timestamp = Date;

// ===== Enums =====
export type UserRole = 'admin' | 'staff' | 'client';
export type AccountStatus = 'active' | 'restricted' | 'disabled';
export type Metal = 'gold' | 'silver' | 'platinum' | 'palladium';
export type ProductCategory = 'coin' | 'bar' | 'round' | 'numismatic' | 'jewelry' | 'other';
export type PremiumType = 'percent' | 'flat';
export type PricingRuleScope = 'metal' | 'product';
export type InvoiceType = 'buy' | 'sell';
export type InvoiceStatus = 'draft' | 'finalized' | 'paid' | 'shipped' | 'canceled';
export type PaymentMethod =
  | 'wire'
  | 'check'
  | 'ach'
  | 'cash'
  | 'crypto'
  | 'card'
  | 'zelle'
  | 'venmo';

/** Discriminates retail walk-ins from wholesale partners for list/filtering. */
export type ClientType = 'retail' | 'wholesaler';

/** One leg of a split-payment invoice. Stored as JSONB in invoices.payment_methods. */
export interface PaymentEntry {
  method: PaymentMethod;
  /** Free-form reference (check #, Zelle memo, last-4 of card, …). */
  reference?: string | null;
  /** Decimal amount as string (money-safe). */
  amount: string;
}
export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded';
export type InventoryMovementReason =
  | 'purchase'
  | 'sale'
  | 'adjustment'
  | 'return'
  | 'damage'
  | 'manual'
  | 'reservation'
  | 'reservation_release';
export type DealRequestStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'converted';
export type ShipmentCarrier = 'ups' | 'fedex' | 'usps' | 'other';
export type ShipmentStatus =
  | 'label_created'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'returned';

// Postgres NUMERIC is returned as string by node-postgres to preserve precision.
// We keep it as string across the Kysely boundary and convert at service level.
type Numeric = ColumnType<string, string | number, string | number>;

// ===== Tables =====

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  role: UserRole;
  status: ColumnType<AccountStatus, AccountStatus | undefined, AccountStatus>;
  is_2fa_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  totp_secret: string | null;
  email_notifications: ColumnType<boolean, boolean | undefined, boolean>;
  phone_e164: string | null;
  phone_verified_at: Timestamp | null;
  sms_notifications: ColumnType<boolean, boolean | undefined, boolean>;
  last_login_at: Timestamp | null;
  failed_login_count: ColumnType<number, number | undefined, number>;
  locked_until: Timestamp | null;
  /**
   * Gate for creating/editing/deleting Daily Updates on the admin
   * dashboard (migration 026). Independent of role so delegation is a
   * per-user flip, not a code change.
   */
  can_post_daily_update: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Allowlist for viewing owner-private invoices/clients (migration
   * 038). Hunter + Tim get true; everyone else stays false. Default
   * false so any newly-created admin/staff user has to be explicitly
   * promoted to see the privacy-fenced records.
   */
  can_view_owner_private: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type BackupStatus = 'pending' | 'succeeded' | 'failed';
export type BackupTrigger = 'cron' | 'manual';

export interface BackupRunsTable {
  id: Generated<string>;
  status: ColumnType<BackupStatus, BackupStatus | undefined, BackupStatus>;
  trigger: ColumnType<BackupTrigger, BackupTrigger | undefined, BackupTrigger>;
  started_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
  size_bytes: string | null;
  dump_bytes: Buffer | null;
  error: string | null;
  created_by_user_id: string | null;
}

export interface BrandingAssetsTable {
  slug: string;
  mime: string;
  /** pg returns Buffer for bytea; we insert a Buffer too. */
  bytes: Buffer;
  updated_at: Generated<Timestamp>;
  updated_by_user_id: string | null;
}

export interface ClientsTable {
  id: Generated<string>;
  // Optional link: a client can exist without a login (walk-in).
  user_id: string | null;
  // Nullable as of migration 020: wholesale-company records may lack a
  // personal name. CHECK constraint `clients_has_identity` still requires
  // *one* of first_name / last_name / company to be non-empty.
  first_name: string | null;
  last_name: string | null;
  /** Company/organization name (migration 020). Primary identity for wholesale. */
  company: string | null;
  email: string | null;
  /** Additional email addresses on file (migration 020). */
  secondary_emails: ColumnType<string[], string[] | undefined, string[]>;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  is_portal_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  notes: string | null;
  /** Free-form marketing source (migration 014). */
  heard_from: string | null;
  client_type: ColumnType<ClientType, ClientType | undefined, ClientType>;
  /** Migration 030: when true, this client's invoices are omitted from
   *  aggregate views (Invoices list, KPI rollups, Wholesale AR). Used
   *  for owner/test clients whose activity shouldn't skew revenue. */
  exclude_from_reports: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Migration 038: when true, this client is fully invisible to any
   * admin/staff user without `users.can_view_owner_private = true`.
   * Used for owner/accounting personal accounts whose individual
   * transactions shouldn't be visible to the rest of the team — the
   * dollar totals still flow into KPI/EOD/dashboards (privacy is
   * detail-level only). Different from exclude_from_reports, which
   * omits the dollars from totals entirely.
   */
  is_owner_private: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Migration 039: per-tenant custom field values. Free-form JSONB
   * object keyed by the field defs in app_settings `custom_fields_schema`.
   * Defaults to `{}` so existing rows are unaffected; values are stored
   * as-is (passthrough, no server-side schema validation).
   */
  custom_fields: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  // Postgres GENERATED column (migration 006, rebuilt in 020 to include
  // company). Read-only from the app side.
  search_text: ColumnType<string, never, never>;
}

export type Client = Selectable<ClientsTable>;
export type NewClient = Insertable<ClientsTable>;
export type ClientUpdate = Updateable<ClientsTable>;

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  // We store only the SHA-256 hash of the token, never the token itself.
  token_hash: string;
  user_agent: string | null;
  ip_address: string | null;
  issued_at: Generated<Timestamp>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  // For rotation: the id of the token that replaced this one.
  replaced_by: string | null;
}

export type RefreshToken = Selectable<RefreshTokensTable>;
export type NewRefreshToken = Insertable<RefreshTokensTable>;
export type RefreshTokenUpdate = Updateable<RefreshTokensTable>;

export interface AuditLogsTable {
  id: Generated<string>;
  actor_user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: unknown; // jsonb
  ip_address: string | null;
  user_agent: string | null;
  created_at: Generated<Timestamp>;
}

export type AuditLog = Selectable<AuditLogsTable>;
export type NewAuditLog = Insertable<AuditLogsTable>;

// ===== Products =====

export interface ProductsTable {
  id: Generated<string>;
  sku: string;
  name: string;
  metal: Metal;
  category: ProductCategory;
  weight_troy_oz: Numeric;
  purity: Numeric;
  metal_content_troy_oz: Numeric;
  description: string | null;
  image_url: string | null;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  show_on_website: ColumnType<boolean, boolean | undefined, boolean>;
  sort_order: ColumnType<number, number | undefined, number>;
  /**
   * Optional slug that overrides the frontend heuristic for which
   * display category this product appears under (builtin or admin-added).
   * Null = fall back to deriveDisplayCategory(name, metal, category).
   */
  display_category_override: string | null;
  /**
   * Migration 039: per-tenant custom field values. Free-form JSONB
   * object keyed by the field defs in app_settings `custom_fields_schema`.
   * Defaults to `{}` so existing rows are unaffected; values are stored
   * as-is (passthrough, no server-side schema validation).
   */
  custom_fields: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  // Postgres GENERATED column (migration 006) — read-only.
  search_text: ColumnType<string, never, never>;
}

export type Product = Selectable<ProductsTable>;
export type NewProduct = Insertable<ProductsTable>;
export type ProductUpdate = Updateable<ProductsTable>;

// ===== Pricing rules =====

export interface PricingRulesTable {
  id: Generated<string>;
  scope: PricingRuleScope;
  metal: Metal | null;
  product_id: string | null;
  buy_premium_type: PremiumType;
  buy_premium_value: Numeric;
  sell_premium_type: PremiumType;
  sell_premium_value: Numeric;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  effective_from: Generated<Timestamp>;
  effective_until: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export type PricingRule = Selectable<PricingRulesTable>;
export type NewPricingRule = Insertable<PricingRulesTable>;
export type PricingRuleUpdate = Updateable<PricingRulesTable>;

// ===== Inventory =====

export interface InventoryTable {
  id: Generated<string>;
  product_id: string;
  quantity_on_hand: ColumnType<number, number | undefined, number>;
  quantity_reserved: ColumnType<number, number | undefined, number>;
  location: ColumnType<string, string | undefined, string>;
  weighted_avg_cost: ColumnType<string, string | number | undefined, string | number>;
  last_purchase_price: Numeric | null;
  updated_at: Generated<Timestamp>;
}

export interface InventoryMovementsTable {
  id: Generated<string>;
  // Nullable as of migration 010: a product deletion sets this to NULL so
  // the movement history row survives.
  product_id: string | null;
  /** Signed change to inventory.quantity_on_hand. */
  delta: number;
  /** Signed change to inventory.quantity_reserved (migration 011). */
  reserved_delta: ColumnType<number, number | undefined, number>;
  reason: InventoryMovementReason;
  invoice_id: string | null;
  unit_cost: Numeric | null;
  notes: string | null;
  actor_user_id: string | null;
  created_at: Generated<Timestamp>;
}

// ===== Invoices =====

export interface InvoicesTable {
  id: Generated<string>;
  invoice_number: string;
  client_id: string;
  type: InvoiceType;
  status: ColumnType<InvoiceStatus, InvoiceStatus | undefined, InvoiceStatus>;
  subtotal: ColumnType<string, string | number | undefined, string | number>;
  tax: ColumnType<string, string | number | undefined, string | number>;
  shipping: ColumnType<string, string | number | undefined, string | number>;
  total: ColumnType<string, string | number | undefined, string | number>;
  payment_method: PaymentMethod | null;
  payment_methods: ColumnType<PaymentEntry[], PaymentEntry[] | undefined, PaymentEntry[]>;
  payment_status: ColumnType<PaymentStatus, PaymentStatus | undefined, PaymentStatus>;
  notes: string | null;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  finalized_at: Timestamp | null;
  paid_at: Timestamp | null;
  /** User who marked the invoice paid (migration 022). Wholesale audit. */
  paid_by_user_id: string | null;
}

export type Invoice = Selectable<InvoicesTable>;
export type NewInvoice = Insertable<InvoicesTable>;
export type InvoiceUpdate = Updateable<InvoicesTable>;

export interface InvoiceLineItemsTable {
  id: Generated<string>;
  invoice_id: string;
  // Nullable as of migration 010: the invoice line survives a product
  // deletion. Readers must rely on the snapshot columns below, which are
  // already the source of truth for historical accuracy.
  product_id: string | null;
  position: number;
  quantity: number;
  product_name_snapshot: string;
  gross_weight_troy_oz: Numeric;
  purity: Numeric;
  metal_content_troy_oz: Numeric;
  spot_price_per_oz: Numeric;
  premium_type: PremiumType;
  premium_value: Numeric;
  unit_price: Numeric;
  line_total: Numeric;
  is_overridden: ColumnType<boolean, boolean | undefined, boolean>;
  override_reason: string | null;
  override_by_user_id: string | null;
  created_at: Generated<Timestamp>;
}

export type InvoiceLineItem = Selectable<InvoiceLineItemsTable>;
export type NewInvoiceLineItem = Insertable<InvoiceLineItemsTable>;

// ===== Daily updates (migration 026) =====

export interface DailyUpdatesTable {
  id: Generated<string>;
  body: string;
  author_user_id: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export type DailyUpdate = Selectable<DailyUpdatesTable>;
export type NewDailyUpdate = Insertable<DailyUpdatesTable>;

export interface DailyUpdateCommentsTable {
  id: Generated<string>;
  daily_update_id: string;
  author_user_id: string;
  body: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export type DailyUpdateComment = Selectable<DailyUpdateCommentsTable>;
export type NewDailyUpdateComment = Insertable<DailyUpdateCommentsTable>;

export interface DailyUpdateAttachmentsTable {
  id: Generated<string>;
  daily_update_id: string;
  filename: string;
  mime: string;
  bytes: Buffer;
  created_at: Generated<Timestamp>;
}
export type DailyUpdateAttachment = Selectable<DailyUpdateAttachmentsTable>;
export type NewDailyUpdateAttachment = Insertable<DailyUpdateAttachmentsTable>;

// ===== Client attachments (migration 028) =====

export type ClientAttachmentOcrStatus = 'pending' | 'succeeded' | 'failed';

export interface ClientAttachmentsTable {
  id: Generated<string>;
  client_id: string;
  /** Free-text tag — 'drivers_license', 'passport', 'other', etc. */
  kind: ColumnType<string, string | undefined, string>;
  filename: string;
  mime: string;
  bytes: Buffer;
  size_bytes: number;
  uploaded_by_user_id: string | null;
  ocr_status: ClientAttachmentOcrStatus | null;
  ocr_text: string | null;
  ocr_fields: unknown;
  created_at: Generated<Timestamp>;
}
export type ClientAttachment = Selectable<ClientAttachmentsTable>;
export type NewClientAttachment = Insertable<ClientAttachmentsTable>;

// ===== KPI manual entries (migration 027) =====

export type KpiManualCategory = 'sales' | 'purchases' | 'wholesale';

export interface KpiManualEntriesTable {
  id: Generated<string>;
  /** First day of the month this entry is booked against (YYYY-MM-01). */
  bucket_month: ColumnType<Date, Date | string, Date | string>;
  category: KpiManualCategory;
  /** Required in practice for wholesale, optional at the DB layer. */
  client_id: string | null;
  amount: Numeric;
  notes: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export type KpiManualEntry = Selectable<KpiManualEntriesTable>;
export type NewKpiManualEntry = Insertable<KpiManualEntriesTable>;
export type KpiManualEntryUpdate = Updateable<KpiManualEntriesTable>;

// ===== Restock subscriptions (migration 029) =====

export interface RestockSubscriptionsTable {
  id: Generated<string>;
  product_id: string;
  email: string;
  token: string;
  ip: string | null;
  created_at: Generated<Timestamp>;
  notified_at: Timestamp | null;
}
export type RestockSubscription = Selectable<RestockSubscriptionsTable>;
export type NewRestockSubscription = Insertable<RestockSubscriptionsTable>;

// ===== Historical invoices (migration 031) =====

export interface HistoricalInvoicesTable {
  id: Generated<string>;
  /** Date the original past-system invoice was written (YYYY-MM-DD). */
  date: ColumnType<Date, Date | string, Date | string>;
  type: 'buy' | 'sell';
  amount: Numeric;
  is_wholesale: ColumnType<boolean, boolean | undefined, boolean>;
  client_id: string | null;
  client_name: string | null;
  reference: string | null;
  notes: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  created_by_user_id: string | null;
}
export type HistoricalInvoice = Selectable<HistoricalInvoicesTable>;
export type NewHistoricalInvoice = Insertable<HistoricalInvoicesTable>;
export type HistoricalInvoiceUpdate = Updateable<HistoricalInvoicesTable>;

// ===== Supplier prices (migration 032) — RARCOA + future vendors =====

/**
 * One ingested RARCOA (or other supplier) daily sheet. Header-level
 * metadata: basis spot, provenance, ingester. Cascades to
 * supplier_prices rows.
 */
export interface SupplierPriceSheetsTable {
  id: Generated<string>;
  supplier: string;
  as_of_date: ColumnType<Date, Date | string, Date | string>;
  as_of_time: string | null;
  basis_gold: Numeric | null;
  source_ref: string | null;
  source_filename: string | null;
  raw_text: string | null;
  ingested_by_user_id: string | null;
  ingested_at: Generated<Timestamp>;
}
export type SupplierPriceSheet = Selectable<SupplierPriceSheetsTable>;
export type NewSupplierPriceSheet = Insertable<SupplierPriceSheetsTable>;

/**
 * Per-row price grid cell on a supplier sheet. One row per
 * (product, grade) pair per day.
 */
export interface SupplierPricesTable {
  id: Generated<string>;
  sheet_id: string;
  supplier: string;
  section: string;
  product: string;
  grade: string;
  raw_bid: Numeric | null;
  raw_ask: Numeric | null;
  ngc_only: ColumnType<boolean, boolean | undefined, boolean>;
  as_of_date: ColumnType<Date, Date | string, Date | string>;
  ingested_at: Generated<Timestamp>;
}
export type SupplierPrice = Selectable<SupplierPricesTable>;
export type NewSupplierPrice = Insertable<SupplierPricesTable>;

// ===== Database root =====
export interface DB {
  users: UsersTable;
  backup_runs: BackupRunsTable;
  branding_assets: BrandingAssetsTable;
  clients: ClientsTable;
  refresh_tokens: RefreshTokensTable;
  audit_logs: AuditLogsTable;
  products: ProductsTable;
  pricing_rules: PricingRulesTable;
  inventory: InventoryTable;
  inventory_movements: InventoryMovementsTable;
  invoices: InvoicesTable;
  invoice_line_items: InvoiceLineItemsTable;
  app_settings: AppSettingsTable;
  deal_requests: DealRequestsTable;
  shipments: ShipmentsTable;
  notifications: NotificationsTable;
  price_quotes: PriceQuotesTable;
  deal_request_photos: DealRequestPhotosTable;
  totp_recovery_codes: TotpRecoveryCodesTable;
  messages: MessagesTable;
  integrations: IntegrationsTable;
  shipment_tracking_events: ShipmentTrackingEventsTable;
  calendar_bookings: CalendarBookingsTable;
  daily_updates: DailyUpdatesTable;
  daily_update_comments: DailyUpdateCommentsTable;
  daily_update_attachments: DailyUpdateAttachmentsTable;
  kpi_manual_entries: KpiManualEntriesTable;
  client_attachments: ClientAttachmentsTable;
  restock_subscriptions: RestockSubscriptionsTable;
  historical_invoices: HistoricalInvoicesTable;
  supplier_price_sheets: SupplierPriceSheetsTable;
  supplier_prices: SupplierPricesTable;
  aurbitrage_quotes: AurbitrageQuotesTable;
  aurbitrage_sync_state: AurbitrageSyncStateTable;
  ifs_shipments: IfsShipmentsTable;
  ifs_sync_state: IfsSyncStateTable;
  invoice_attachments: InvoiceAttachmentsTable;
}

// ===== Invoice attachments (migration 037) =====

/**
 * Per-invoice photo / file attachments. Operator-only (PDF gen and
 * client portal both ignore this table). Used by the scrap-invoice
 * flow to record the customer's ID, a photo of the customer, and
 * photo(s) of the items at the time of intake — Georgia precious-
 * metal-dealer compliance + general fraud-prevention audit trail.
 */
export interface InvoiceAttachmentsTable {
  id: Generated<string>;
  invoice_id: string;
  /** 'id' | 'client_photo' | 'item' | 'other' — text, no DB enum. */
  kind: ColumnType<string, string | undefined, string>;
  filename: string;
  mime: string;
  bytes: Buffer;
  size_bytes: number;
  uploaded_by_user_id: string | null;
  created_at: Generated<Timestamp>;
}
export type InvoiceAttachment = Selectable<InvoiceAttachmentsTable>;
export type NewInvoiceAttachment = Insertable<InvoiceAttachmentsTable>;

// ===== IFS shipments (migration 036) =====

/**
 * Cached snapshot of one shipment from ifsclients.com. Sync runs wipe
 * + reinsert the table; we keep the raw_payload around for reparsing
 * without re-hitting the IFS API.
 */
export interface IfsShipmentsTable {
  id: Generated<string>;
  ifs_shipment_id: string;
  tracking_number: string | null;
  carrier: string | null;
  service_type: string | null;
  label_status: string | null;
  sender_name: string | null;
  sender_company: string | null;
  sender_address: string | null;
  recipient_name: string | null;
  recipient_company: string | null;
  recipient_address: string | null;
  recipient_city: string | null;
  recipient_state: string | null;
  recipient_zip: string | null;
  recipient_country: string | null;
  declared_value: Numeric | null;
  cost: Numeric | null;
  ship_date: string | null;
  delivered_at: Timestamp | null;
  voided_at: Timestamp | null;
  label_url: string | null;
  tracking_url: string | null;
  reference: string | null;
  raw_payload: ColumnType<unknown, unknown, unknown> | null;
  synced_at: Generated<Timestamp>;
}
export type IfsShipment = Selectable<IfsShipmentsTable>;
export type NewIfsShipment = Insertable<IfsShipmentsTable>;

export interface IfsSyncStateTable {
  id: Generated<number>;
  last_synced_at: Timestamp | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  last_sync_count: number | null;
}
export type IfsSyncState = Selectable<IfsSyncStateTable>;

// ===== Aurbitrage quotes (migration 035) =====

/**
 * One row per (aurbitrage_sku_id, side, dealer) tuple from
 * Aurbitrage's `/api/v1/pricing/favorites` endpoint. Sync runs wipe
 * + reinsert the whole table in a transaction (the API returns the
 * full favorites payload each call).
 */
export interface AurbitrageQuotesTable {
  id: Generated<string>;
  aurbitrage_sku_id: number;
  product_name: string;
  category: string | null;
  sub_category: string | null;
  product_type: string | null;
  metal: string | null;
  equivalent_oz: Numeric | null;
  side: 'bid' | 'ask';
  dealer: string;
  dealer_id: number | null;
  price: Numeric;
  price_format: string | null;
  format: string | null;
  price_sign: string | null;
  data_source: string | null;
  notes: string | null;
  shipping_note: string | null;
  quote_date: Timestamp | null;
  ingested_at: Generated<Timestamp>;
}
export type AurbitrageQuote = Selectable<AurbitrageQuotesTable>;
export type NewAurbitrageQuote = Insertable<AurbitrageQuotesTable>;

/**
 * Singleton row tracking the most recent sync attempt — used by the
 * /admin/aurbitrage page to render "synced 3m ago" + error toasts
 * when a poll fails.
 */
export interface AurbitrageSyncStateTable {
  id: Generated<number>;
  last_synced_at: Timestamp | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  last_sync_quote_count: number | null;
}
export type AurbitrageSyncState = Selectable<AurbitrageSyncStateTable>;

// ===== Calendar bookings (migration 023) =====

export type CalendarBookingStatus = 'confirmed' | 'canceled' | 'completed';
export type CalendarBookingSource = 'public_booking' | 'admin_created' | 'google_import';

export interface CalendarBookingsTable {
  id: Generated<string>;
  /** Google Calendar event id. Unique — dedupes webhook / import re-ingest. */
  google_event_id: string;
  /** Link to the CRM client record. NULL = unmatched / awaiting review. */
  client_id: string | null;
  service: string | null;
  starts_at: Timestamp;
  ends_at: Timestamp;
  name: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: ColumnType<CalendarBookingStatus, CalendarBookingStatus | undefined, CalendarBookingStatus>;
  source: ColumnType<CalendarBookingSource, CalendarBookingSource | undefined, CalendarBookingSource>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export type CalendarBooking = Selectable<CalendarBookingsTable>;
export type NewCalendarBooking = Insertable<CalendarBookingsTable>;
export type CalendarBookingUpdate = Updateable<CalendarBookingsTable>;

export type TrackingEventSource = 'webhook' | 'poll' | 'manual';

export interface ShipmentTrackingEventsTable {
  id: Generated<string>;
  shipment_id: string;
  carrier: ShipmentCarrier;
  tracking_number: string | null;
  status: ShipmentStatus;
  description: string | null;
  occurred_at: Timestamp;
  carrier_event_id: string | null;
  raw_payload: unknown;
  source: TrackingEventSource;
  inserted_at: Generated<Timestamp>;
}

export type ShipmentTrackingEvent = Selectable<ShipmentTrackingEventsTable>;
export type NewShipmentTrackingEvent = Insertable<ShipmentTrackingEventsTable>;

export interface IntegrationsTable {
  provider: string;
  // AES-256-GCM output (nonce + ciphertext + tag). node-postgres returns Buffer.
  credentials_encrypted: Buffer;
  display_hint: string | null;
  is_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  last_tested_at: Timestamp | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  updated_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export type Integration = Selectable<IntegrationsTable>;

export type MessageAuthorRole = 'admin' | 'staff' | 'client';

export interface MessagesTable {
  id: Generated<string>;
  deal_request_id: string;
  author_user_id: string;
  author_role: MessageAuthorRole;
  body: string;
  read_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export type Message = Selectable<MessagesTable>;
export type NewMessage = Insertable<MessagesTable>;

export interface AppSettingsTable {
  key: string;
  value: unknown;
  updated_at: Generated<Timestamp>;
  updated_by_user_id: string | null;
}

// ===== Deal requests =====

export interface DealRequestsTable {
  id: Generated<string>;
  client_id: string;
  type: InvoiceType;
  product_id: string | null;
  product_description: string | null;
  quantity: number | null;
  estimated_weight_troy_oz: Numeric | null;
  metal: Metal | null;
  notes: string | null;
  status: ColumnType<DealRequestStatus, DealRequestStatus | undefined, DealRequestStatus>;
  responded_by_user_id: string | null;
  responded_at: Timestamp | null;
  response_message: string | null;
  converted_invoice_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export type DealRequest = Selectable<DealRequestsTable>;
export type NewDealRequest = Insertable<DealRequestsTable>;
export type DealRequestUpdate = Updateable<DealRequestsTable>;

// ===== Shipments =====

export interface ShipmentsTable {
  id: Generated<string>;
  invoice_id: string;
  carrier: ShipmentCarrier;
  tracking_number: string | null;
  status: ColumnType<ShipmentStatus, ShipmentStatus | undefined, ShipmentStatus>;
  /**
   * Carrier-specific service level (migration 021). Free-form TEXT, but
   * validated against a carrier↔speed whitelist in the shipments service.
   * NULL for legacy rows created before the column existed.
   */
  delivery_speed: string | null;
  shipped_at: Timestamp | null;
  delivered_at: Timestamp | null;
  weight_lbs: Numeric | null;
  insurance_amount: Numeric | null;
  notes: string | null;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export type Shipment = Selectable<ShipmentsTable>;
export type NewShipment = Insertable<ShipmentsTable>;
export type ShipmentUpdate = Updateable<ShipmentsTable>;

// ===== Notifications =====

export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  metadata: unknown;
  read_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export type Notification = Selectable<NotificationsTable>;
export type NewNotification = Insertable<NotificationsTable>;

// ===== Price quotes =====

export interface PriceQuotesTable {
  id: Generated<string>;
  client_id: string;
  product_id: string;
  side: InvoiceType;
  quantity: number;
  spot_price_per_oz: Numeric;
  unit_price: Numeric;
  line_total: Numeric;
  premium_type: PremiumType;
  premium_value: Numeric;
  expires_at: Timestamp;
  converted_invoice_id: string | null;
  created_at: Generated<Timestamp>;
}

export type PriceQuote = Selectable<PriceQuotesTable>;
export type NewPriceQuote = Insertable<PriceQuotesTable>;

// ===== Deal request photos =====

export interface DealRequestPhotosTable {
  id: Generated<string>;
  deal_request_id: string;
  disk_path: string;
  mime_type: string;
  byte_size: number;
  position: ColumnType<number, number | undefined, number>;
  uploaded_by_user_id: string | null;
  created_at: Generated<Timestamp>;
}

export type DealRequestPhoto = Selectable<DealRequestPhotosTable>;
export type NewDealRequestPhoto = Insertable<DealRequestPhotosTable>;

// ===== TOTP recovery codes =====

export interface TotpRecoveryCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  used_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export type TotpRecoveryCode = Selectable<TotpRecoveryCodesTable>;
export type NewTotpRecoveryCode = Insertable<TotpRecoveryCodesTable>;
