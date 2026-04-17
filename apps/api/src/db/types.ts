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
  first_name: string;
  last_name: string;
  email: string | null;
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
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  // Postgres GENERATED column (migration 006) — read-only from the app side.
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
}

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
