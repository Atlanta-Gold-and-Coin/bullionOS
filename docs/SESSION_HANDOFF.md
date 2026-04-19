# AGC Desk — Session Handoff

> **Purpose:** If you're a new Claude instance (or a human) with zero context on
> this project, read this document end-to-end once and you'll have what you
> need to make changes safely.
>
> **Last updated:** 2026-04-19
> **Latest commit at time of writing:** (see §25 below — this session's
> commit lands Phases 1–4 of the big production release)
>
> Read the **Changelog Addenda** (bottom of this file) first if you already
> read the main doc — §24 covers the prior session, §25 covers this one.

---

## 0. TL;DR

- **What it is:** AGC Desk — a private CRM + trading + client portal + booking
  system for **Atlanta Gold and Coin** (https://atlantagoldandcoin.com).
- **Who uses it:** 6 seeded admin employees; walk-in and wholesale clients.
- **Where it runs:**
  - Web: **https://agc-crm-web.vercel.app** (Vercel)
  - API: **https://agc-api-production.up.railway.app** (Railway)
  - Repo: **https://github.com/AGCstore/agc-crm** (branch: `main`)
- **Stack:** pnpm-workspace monorepo. Backend NestJS 10 + Kysely + Postgres 16 +
  Redis 7. Frontend Next.js 15 App Router + React 19 + Tailwind 3. Shared types
  via `packages/shared`. No ORM — raw Kysely on the backend, React Query on the
  frontend.
- **Invariant to remember:** migrations are **additive only**. Never
  rename/drop columns without an explicit migration numbered N+1.

---

## 1. Table of Contents

1. [Repository Layout](#2-repository-layout)
2. [Database Schema & Migration History](#3-database-schema--migration-history)
3. [Domain Model](#4-domain-model)
4. [Pricing Engine (CRITICAL)](#5-pricing-engine-critical)
5. [Display Categories & Family Sort](#6-display-categories--family-sort)
6. [Authentication, Authorization, Roles](#7-authentication-authorization-roles)
7. [Admin Surfaces (every page)](#8-admin-surfaces-every-page)
8. [Client Portal Surfaces](#9-client-portal-surfaces)
9. [Public Surfaces](#10-public-surfaces)
10. [Integrations](#11-integrations)
11. [Backups](#12-backups)
12. [Branding Assets (logo + favicon)](#13-branding-assets-logo--favicon)
13. [WordPress Plugin](#14-wordpress-plugin)
14. [Deployment](#15-deployment)
15. [Data Loaded to Production](#16-data-loaded-to-production)
16. [Known Pending Items](#17-known-pending-items)
17. [How to Rebuild From Scratch](#18-how-to-rebuild-from-scratch)
18. [Common Operations Cookbook](#19-common-operations-cookbook)
19. [Commit Timeline](#20-commit-timeline)
20. [File Reference](#21-file-reference)
21. [Glossary](#22-glossary)

---

## 2. Repository Layout

```
agc-crm/
├── apps/
│   ├── api/                      NestJS API
│   │   ├── src/
│   │   │   ├── auth/             JWT + 2FA + refresh tokens
│   │   │   ├── backups/          Daily pg_dump cron + endpoints
│   │   │   ├── calendar/         Google Calendar booking + admin events
│   │   │   ├── client-portal/    /client/* endpoints (role=client only)
│   │   │   ├── clients/          CRUD, search, merge, bulk-delete, import
│   │   │   ├── common/           Guards, decorators, filters, money utils
│   │   │   ├── crypto/           AES-256-GCM for integrations creds
│   │   │   ├── db/               Kysely types, migrations, one-off scripts
│   │   │   ├── deal-requests/    Client-initiated quote requests
│   │   │   ├── email/            SMTP abstraction
│   │   │   ├── health/           /health endpoint
│   │   │   ├── integrations/     Encrypted third-party creds store
│   │   │   ├── inventory/        Stock levels, adjustments, reservations
│   │   │   ├── invoices/         Invoice state machine + PDF
│   │   │   ├── kpi/              Rollup endpoint for the KPI dashboard
│   │   │   ├── messages/         Thread messaging on deal requests
│   │   │   ├── metals/           metals.dev client + SSE stream
│   │   │   ├── notifications/    In-app notification store
│   │   │   ├── price-quotes/     Client-lockable quotes
│   │   │   ├── pricing/          Pricing rule engine (THE formula)
│   │   │   ├── products/         Catalog CRUD + sort + CSV import
│   │   │   ├── public/           Unauthenticated endpoints
│   │   │   ├── redis/            ioredis module
│   │   │   ├── settings/         Branding settings + asset blob store
│   │   │   ├── shipments/        Carrier tracking
│   │   │   └── sms/              Twilio abstraction
│   │   ├── test/
│   │   │   └── integration/      invoices-inventory.test.ts (9 tests)
│   │   ├── Dockerfile            Multi-stage build, installs postgresql16-client
│   │   ├── nest-cli.json
│   │   ├── package.json
│   │   └── vitest.config.ts
│   └── web/                      Next.js 15 App Router
│       ├── src/
│       │   ├── app/
│       │   │   ├── admin/        Admin surfaces (role=admin|staff)
│       │   │   ├── dashboard/    Client portal (any logged-in user)
│       │   │   ├── book/         Public booking page
│       │   │   ├── login/
│       │   │   ├── register/
│       │   │   ├── layout.tsx    Root layout (favicon wiring)
│       │   │   ├── providers.tsx React Query + auth providers
│       │   │   └── globals.css
│       │   ├── components/       Shared React components
│       │   └── lib/              api-client, product-category, etc.
│       ├── next.config.js
│       ├── package.json
│       ├── tailwind.config.ts    ink + gold + buy + sell palettes
│       └── vercel.json           Rewrites /api/* → Railway
├── packages/
│   └── shared/                   Common TS types shared between api + web
├── wordpress-plugin/
│   └── agc-inventory/            Drop-in WP plugin for atlantagoldandcoin.com
├── docs/
│   └── SESSION_HANDOFF.md        (this file)
├── package.json                  Root (pnpm workspaces)
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── railway.json                  Deployment config
```

---

## 3. Database Schema & Migration History

Migrations live in `apps/api/src/db/migrations/` and are applied by
`apps/api/src/db/migrator.ts`. Naming: `NNN_description.ts`. Kysely's
`FileMigrationProvider` picks them up by directory scan.

| # | File | What it does |
|---|------|-------------|
| 001 | `001_init.ts` | Core tables: users, refresh_tokens, clients, products, inventory, inventory_movements, audit_logs, app_settings |
| 002 | `002_trading.ts` | Pricing rules, invoices, invoice_line_items, price_quotes. CHECK constraint `products.category IN ('coin','bar','round','numismatic','jewelry','other')` lives here. |
| 003 | `003_settings.ts` | app_settings JSONB keyed by slug (branding.company_name, etc.) |
| 004 | `004_portal.ts` | deal_requests table with CHECK `product_id IS NOT NULL OR product_description IS NOT NULL` |
| 005 | `005_phase3.ts` | Notifications, messages, shipments |
| 006 | `006_fuzzy_search.ts` | pg_trgm + GIN indexes on clients.search_text for typo-tolerant search |
| 007 | `007_phase4.ts` | Additional shipment tracking, 2FA fields on users |
| 008 | `008_integrations.ts` | Encrypted integrations credentials store |
| 009 | `009_invoice_line_snapshot_rename.ts` | Renamed: `unit_weight_troy_oz → gross_weight_troy_oz`, `unit_purity → purity`, `unit_metal_content_troy_oz → metal_content_troy_oz` |
| 010 | `010_invoice_history_independence.ts` | `invoice_line_items.product_id` + `inventory_movements.product_id` → **ON DELETE SET NULL** (invoices survive product deletion) |
| 011 | `011_inventory_reservations.ts` | `inventory_movements.reserved_delta` column; reasons include `reservation` and `reservation_release` |
| 012 | `012_inventory_product_fk.ts` | inventory FK → CASCADE; deal_requests FK → SET NULL |
| 013 | `013_shipment_tracking_events.ts` | Full tracking event history, `carrier_event_id` for idempotency |
| 014 | `014_client_referral_source.ts` | `clients.heard_from TEXT` ("How they heard about us") |
| 015 | `015_client_type_and_payments.ts` | `clients.client_type ∈ {retail, wholesaler}`, expanded `payment_method` CHECK to include `zelle` + `venmo`, `invoices.payment_methods JSONB` (split payments array) |
| 016 | `016_branding_asset_blob.ts` | `branding_assets(slug PK, mime, bytes, updated_at, updated_by_user_id)` — logo + favicon in Postgres (survive Railway deploys, unlike `/app/uploads`) |
| 017 | `017_backups.ts` | `backup_runs(id, status, trigger, started_at, completed_at, size_bytes, dump_bytes, error, created_by_user_id)` |
| 018 | `018_product_sort_order.ts` | `products.sort_order INT NOT NULL DEFAULT 0`, seeded from created_at × 10 |

### Key enums / CHECK constraints

- `InvoiceStatus = 'draft' | 'finalized' | 'paid' | 'shipped' | 'canceled'`
- `InvoiceType = 'buy' | 'sell'`
- `PaymentMethod = 'wire' | 'check' | 'ach' | 'cash' | 'crypto' | 'card' | 'zelle' | 'venmo'`
- `ClientType = 'retail' | 'wholesaler'`
- `Metal = 'gold' | 'silver' | 'platinum' | 'palladium'`
- `ProductCategory = 'coin' | 'bar' | 'round' | 'numismatic' | 'jewelry' | 'other'`
  (display categories are derived client-side; see section 6)
- `PremiumType = 'percent' | 'flat'`
- `PricingRuleScope = 'metal' | 'product'`

### How to run migrations

```bash
# Dev (uses .env)
cd apps/api
pnpm exec tsx src/db/migrator.ts up

# Prod (via Railway public proxy)
DATABASE_URL='postgresql://...@nozomi.proxy.rlwy.net:42130/railway' \
  pnpm exec tsx src/db/migrator.ts up
```

Idempotent; running twice is a no-op.

---

## 4. Domain Model

### Clients

- **retail** = walk-in / individual consumer
- **wholesaler** = company; shows "Wholesale" badge; appears in its own tab
- Can have a linked `users.id` for portal access (optional)
- Fields: first_name, last_name, email, phone, address_*, city, region,
  postal_code, country, notes, heard_from, client_type, is_portal_enabled

Fuzzy search via pg_trgm on a materialized `search_text` column. Typos and
partial matches work.

### Products

- `sku`, `name`, `metal`, `category`, `weight_troy_oz`, `purity`,
  `metal_content_troy_oz`, `is_active`, `show_on_website`, `sort_order`
- **`metal_content_troy_oz`** is the field the pricing engine uses. For coins
  this is AGW (actual gold weight) or ASW (actual silver weight). For a Gold
  Eagle that's `1.0000` (even though gross weight is `1.0909` at 91.67% pure).
- `sort_order` is the hand-curated order (drag-and-drop on /admin/products).
  Ties break on `name`.

### Invoices

State machine:

```
         ┌───────── reserve ─────────┐
draft ──▶ finalized ── consume ─── paid ── (no-op) ──▶ shipped
          │                          │                    ▲
          │                          │                    │
          └───── release ────────▶ canceled ◀─ reverse ───┘
                                                consume
```

- `draft → finalized`: reserves inventory (SELECT FOR UPDATE to prevent
  oversell)
- `finalized → paid`: consumes inventory (walk-in sale = money changes hands,
  product leaves)
- `paid → shipped`: no-op (already consumed)
- `finalized → canceled`: releases reservation
- `paid → canceled`: `reverse_consume` — stock is returned
- `finalized → shipped` (skip paid): also consumes

**This was changed in commit `cdff580`** — originally `shipped` was when
inventory was consumed, but most AGC sales are walk-in, so `paid` became the
consumption event. See `apps/api/src/invoices/invoices.service.ts`,
`classifyInventoryAction()`.

Line items are **snapshot-based**. At creation time the line captures:
- `product_name_snapshot` (or `custom_name` for ad-hoc)
- `gross_weight_troy_oz`
- `purity`
- `metal_content_troy_oz`
- `spot_price_per_oz`
- `premium_type`, `premium_value`
- `unit_price`, `line_total`

If the product is later deleted, the line keeps all this. FK is ON DELETE SET NULL.

### Pricing Rules

Two scopes:
- **metal** scope: default rule per metal (e.g. "all gold: buy at 96%, sell at 105%")
- **product** scope: per-product override. Takes precedence over metal default.

Rule fields: `buy_premium_type`, `buy_premium_value`, `sell_premium_type`,
`sell_premium_value`, `is_active`, `scope`, `product_id` (nullable), `metal`
(nullable).

Resolution order in `pricing.service.ts → resolveRule()`:
1. Active product override
2. Active metal default
3. Hard fallback: 0% (returns melt value)

### Inventory

- `inventory(product_id, quantity_on_hand, quantity_reserved)`
- `available = quantity_on_hand - quantity_reserved`
- Every change goes through `inventory.service.ts → applyMovement()` which:
  - `SELECT ... FOR UPDATE` inside the caller's transaction
  - Writes an `inventory_movements` row (audit)
  - Updates the `inventory` row

### Deal Requests

Client-initiated quote requests. Client can reference a product by id or
free-text `product_description`. CHECK constraint enforces one of them is
non-null (migration 004).

When a product is deleted, the deal_requests.product_id is SET NULL. The
import script in `apps/api/src/db/reset-and-import-products.ts` backfills
`product_description` from the product name before the cascade to satisfy
the CHECK.

### Shipments

Carrier-aware (UPS, FedEx, USPS, EasyPost via `apps/api/src/integrations/adapters/`).
Status lattice: `label_created < in_transit < out_for_delivery < delivered`.
Webhook ingest at `/webhooks/carriers/:carrier` — idempotent via
`carrier_event_id`.

---

## 5. Pricing Engine (CRITICAL)

**The formula** (as of commit `e48d4c1`):

```
melt_per_unit  = spot_per_oz × metal_content_per_unit

if premium_type = 'percent':
    unit_price = melt_per_unit × (premium_value / 100)

if premium_type = 'flat':
    unit_price = melt_per_unit + (premium_value × metal_content_per_unit)
               = (spot_per_oz + premium_value) × metal_content_per_unit
```

### Percent semantics (IMPORTANT)

`percent` is **"X% of spot × weight"**, NOT "+X% markup above melt".

- `buy_premium_value = 96` → we pay **96% of melt**
- `sell_premium_value = 105` → we sell at **105% of melt**
- `sell_premium_value = 103` → 3% above spot

**This was changed in commit `e48d4c1`**. Prior to that, `percent` meant
`melt × (1 + value/100)` — "markup above melt". The catalog reset + import
rekeyed all product pricing rules under the new meaning. **Any metal-default
rules that existed pre-`e48d4c1` still need to be re-examined** — the
import script wipes product-scoped rules, but metal defaults survive.

### Flat semantics

`flat` is **dollars-per-troy-oz-of-metal-content**. A flat premium of $5/oz
on a 1oz Gold Eagle adds $5; on a 10oz bar, $50. Works on both sides.

### Example calculations

Spot gold = $2,500.00

| Product | weight_troy_oz | buy_premium_value | buy_unit_price |
|---------|----------------|-------------------|----------------|
| 1 oz American Gold Eagle | 1.0000 | 96 | 2500 × 1.0 × 0.96 = **$2,400** |
| 1/2 oz American Gold Eagle | 0.5000 | 96.5 | 2500 × 0.5 × 0.965 = **$1,206.25** |
| $20 Saint-Gaudens | 0.9675 | 93 | 2500 × 0.9675 × 0.93 = **$2,249.44** |
| 10 oz PAMP bar | 10.0000 | 94.75 | 2500 × 10 × 0.9475 = **$23,687.50** |

### Where the engine lives

`apps/api/src/pricing/pricing.service.ts`

- `quote(productId, qty)` → single-product quote
- `quoteMany(items[])` → batched (5 queries regardless of N products)
- `applyPremium(melt, content, type, value)` → the formula
- `resolveRule(product)` → product override > metal default > zero fallback

---

## 6. Display Categories & Family Sort

**DB category** is coarse (`coin | bar | round | numismatic | jewelry | other`).
**Display category** is finer (12 buckets), derived client-side from the
product's metal + category + name. Lives at
`apps/web/src/lib/product-category.ts`.

### The 12 display categories

| ID | Label | Metal group |
|----|-------|------------|
| `gold_coins` | Gold Coins | gold |
| `gold_bars` | Gold Bars | gold |
| `pre_1933_gold` | Pre-1933 U.S. Gold Coins | gold |
| `silver_coins` | Silver Coins | silver |
| `silver_junk` | Junk Silver (90%) | silver |
| `silver_generic` | Silver Rounds / Bars (Generic) | silver |
| `silver_mint_sets` | Silver U.S. Mint Sets | silver |
| `platinum_coins` | Platinum Coins | platinum |
| `platinum_bars` | Platinum Bars | platinum |
| `palladium_coins` | Palladium Coins | palladium |
| `palladium_bars` | Palladium Bars | palladium |
| `other` | Other | other |

### Heuristics

Routing happens in `deriveDisplayCategory()`:
- **Pre-1933 gold:** gold + name matches `Pre-1933|Saint-Gaudens|Indian Head|Liberty Head|18\d{2}|19[0-2]\d|193[0-2]`
- **Junk silver:** silver + name matches `Morgan|Peace|US Dollar|Silver Dollar|US Half|US Quarter|US Dime|Half Dollar|90%`
- **Silver mint sets:** silver + name matches `Prestige|Premier|Proof Set|Uncirculated Mint Set`
- **Silver generic:** silver + (DB category bar/round OR name matches `generic|round|bar`)
- **Silver coins:** fallback for silver
- Bars / coins split by DB category for the other three metals

### Family sort

`compareByFamily()` groups by name prefix and sub-sorts by size (largest
first within a family). So 1 oz / 1/2 oz / 1/4 oz / 1/10 oz Gold Eagles
cluster and sort 1 → 1/10.

### Metal group rendering

`groupSectionsByMetal()` partitions sections into contiguous metal runs.
Every product-listing page renders:

```
GOLD (amber banner)
  Gold Coins
    [family-sorted items]
  Gold Bars
  Pre-1933 U.S. Gold Coins

SILVER (slate banner)
  Silver Coins
  Junk Silver (90%)
  Silver Rounds / Bars (Generic)
  Silver U.S. Mint Sets

PLATINUM (sky banner)
  Platinum Coins
  Platinum Bars

PALLADIUM (violet banner)
  Palladium Coins
  Palladium Bars
```

Sticky horizontal jump-nav at the top of each page.

---

## 7. Authentication, Authorization, Roles

### Auth flow

- Login returns an **access token** (JWT, HS256, 15 min lifetime) and sets a
  **refresh token** as an httpOnly cookie (`agc_refresh`, 30 days, Path
  scoped to `/api/v1/auth`).
- Access token goes in `Authorization: Bearer <jwt>` header (React Query
  wraps `apiFetch()` which sets it automatically from `getAccessToken()`).
- Refresh happens on 401 via `POST /auth/refresh` (cookie-based).
- Logout revokes the refresh token in the DB and clears the cookie.

### Roles

| Role | Scope |
|------|-------|
| `admin` | Everything |
| `staff` | Read everything, mutate everything EXCEPT: creating/deleting integrations creds, portal enable/disable, password reset, client delete, client merge |
| `client` | `/client/*` endpoints only, own records only |

### 2FA

TOTP (otplib). User enrolls at `/dashboard/security` → enters code once →
activates. Subsequent logins require the 6-digit code.

Recovery: a one-off disable script lives at
`apps/api/src/db/disable-2fa.ts` — used to unblock the initial admin login
when 2FA was mis-set.

### Encryption at rest

- `password_hash`: bcrypt (cost 12)
- Integrations credentials (`integrations_credentials.encrypted_secret`):
  AES-256-GCM (`apps/api/src/crypto/`). Key comes from env
  `CREDENTIALS_ENCRYPTION_KEY` (32-byte base64). Rotating the key requires
  decrypting with the old key and re-encrypting — not currently automated.

### Required env vars

```
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_ACCESS_SECRET=<random 64 chars>
JWT_REFRESH_SECRET=<random 64 chars>
CREDENTIALS_ENCRYPTION_KEY=<base64 of 32 bytes>
WEB_ORIGIN=https://agc-crm-web.vercel.app
BCRYPT_COST=12
METALS_API_KEY=<optional; admin integration preferred>
```

---

## 8. Admin Surfaces (every page)

All under `/admin/*`. Access gate: `@Roles('admin', 'staff')` on the
controller side, `<admin layout>` redirect on the web side.

| URL | What it does |
|-----|--------------|
| `/admin` | Dashboard (simple landing) |
| `/admin/kpi` | Daily / Weekly / Monthly / Quarterly / Yearly rollup — Sales × Purchases × Wholesale. Vanilla-SVG bar chart (no chart dep). |
| `/admin/calendar` | Sales Google Calendar agenda + "New event" form (any title, duration, attendees, notify toggle) |
| `/admin/invoices` | Tabs: Drafts / Sales / Purchase / Wholesale / All |
| `/admin/invoices/new` | Invoice wizard: fuzzy product picker, ad-hoc "New item", manual unit price, auto-add line, required multi-payment (up to 3 legs incl. Zelle/Venmo), transaction date+time override, notes |
| `/admin/invoices/[id]` | Detail — PDF download, shipment attach, status transitions, full timestamp |
| `/admin/clients` | Tabs: All / Clients / Wholesale. Bulk-delete checkboxes. Duplicate detector with one-click merge. |
| `/admin/clients/new` | Create form (heard_from datalist, client_type toggle) |
| `/admin/clients/[id]` | Detail + timeline (invoices, quotes, requests, shipments) |
| `/admin/clients/[id]/edit` | Edit |
| `/admin/requests` | Deal request inbox |
| `/admin/shipments` | Carrier tracking feed |
| `/admin/quotes` | Price-quote history |
| `/admin/inventory` | **Labeled "Products" in sidebar.** 12 metal-grouped sections, jump-nav, family sort, in-stock & out-of-stock buckets per section, inline adjust |
| `/admin/in-stock-sheet` | Printable in-stock view with inline premium editor |
| `/admin/buy-sheet` | Printable "What we pay" view with inline premium editor |
| `/admin/products` | **Labeled "Catalog" in sidebar.** Per-section drag-and-drop reorder via @dnd-kit. Inline show_on_website toggle. |
| `/admin/products/new` | Create product form |
| `/admin/products/import` | CSV import with two-phase preview+commit |
| `/admin/products/[id]` | Detail + live buy/sell preview + pricing override editor |
| `/admin/integrations` | UPS / FedEx / USPS / DocuSign / metals.dev / Google Calendar creds (AES-encrypted at rest) |
| `/admin/backups` | Last 30 runs + Run Now + Download `.dump.gz` |
| `/admin/settings` | Company name, tagline, address, phone, website, logo upload, favicon upload |

### Sidebar layout (admin)

```
Dashboard
KPI
Calendar
Invoices
New invoice
Clients
Requests
Shipments
Quotes
Products            ← /admin/inventory
In stock sheet
What we pay         ← /admin/buy-sheet
Catalog             ← /admin/products
Integrations
Backups
Settings
─────────
[user@email]
Client portal view →
Sign out
```

---

## 9. Client Portal Surfaces

All under `/dashboard/*`. Role: any authenticated user (admin, staff, or
client). Client role is scoped to their own records.

| URL | What it does |
|-----|--------------|
| `/dashboard` | Landing |
| `/dashboard/pricing` | "What we pay" consumer view — spot cards with session change ▲/▼, product rows, "Lock in" button for 15-min quotes |
| `/dashboard/in-stock` | Browse what's available |
| `/dashboard/quotes` | Client's locked-in quotes |
| `/dashboard/requests` | Submit / track deal requests |
| `/dashboard/transactions` | Client's invoices |
| `/dashboard/transactions/[id]` | Invoice detail (own only) |
| `/dashboard/shipments` | Track own shipments |
| `/dashboard/security` | Change password + 2FA enrollment |

Sidebar has a `Admin console` link that shows only for role `admin` or `staff`.

---

## 10. Public Surfaces

No auth. Exposed for the booking page and the WordPress plugin.

| URL | Returns |
|-----|---------|
| `/api/v1/public/spot` | Current gold/silver/platinum/palladium spot + session-change baseline |
| `/api/v1/public/products` | Active, show_on_website products |
| `/api/v1/public/in-stock` | In-stock items (`available > 0`) with sku, name, metal, category, weight_troy_oz, available |
| `/api/v1/public/what-we-pay` | Buy prices for every website-visible product |
| `/api/v1/public/branding/logo` | Logo bytes (ETag-cached) |
| `/api/v1/public/branding/favicon` | Favicon bytes |
| `/api/v1/public/calendar/config` | Booking services + hours for the /book page |
| `/api/v1/public/calendar/slots?date=YYYY-MM-DD` | Free 30-min slots (FreeBusy minus hours) |
| `/api/v1/public/calendar/book` | POST — create the Google Calendar event |
| `/api/v1/sse/prices` | SSE stream of spot updates (every 15s) |

Web pages:

| URL | What |
|-----|------|
| `/login` | Login (uses `<img>` logo fallback) |
| `/register` | Self-service signup (role=client) |
| `/book` | Public booking page (service + date + slot + form) |

---

## 11. Integrations

Provider configs live in `apps/api/src/integrations/integrations.registry.ts`.
Each provider has a Zod schema, a list of secret fields (masked in
responses), and a hint function for display.

Credentials are encrypted with AES-256-GCM (`CREDENTIALS_ENCRYPTION_KEY`
env) and stored as a single bytes blob per provider. Admin-rotatable — no
redeploy required when rotating a key.

### Metals (`metals.dev`)

- Schema: `{ api_key, url }`
- Env fallback: `METALS_API_KEY`, `METALS_API_URL`
- Redis cache: 30s TTL at `metals:spot:v1`
- Session change: baseline stored at `metals:baseline:<YYYY-MM-DD>` (US/Eastern),
  computed on every `getSpot()` call. Exposed as `{delta, percent, baseline}`
  per metal.
- Test connection button actually hits metals.dev with current creds.

### Shipping (UPS / FedEx / USPS / EasyPost)

- Each has its own adapter at `apps/api/src/integrations/adapters/<carrier>.adapter.ts`
- Shared contract: `ShipmentAdapter` interface (label purchase, tracking pull,
  webhook event parse)
- Webhook endpoint: `POST /webhooks/carriers/:carrier` — idempotent via
  `carrier_event_id`

### DocuSign

- JWT Bearer Grant with RSA keypair
- Schema: `integration_key`, `account_id`, `user_id`, `base_path`,
  `private_key_pem`, `webhook_secret`, `template_buy_contract`,
  `template_sell_contract`
- **Not fully wired** as of this handoff: creds store + test connection work,
  but the service doesn't yet send envelopes on invoice finalize. That's the
  next feature to complete here.
- Setup: see section 17 below.

### Google Calendar

- OAuth2 with offline access (refresh_token)
- Schema includes hours, services list, slot duration, timezone
- Setup flow:
  1. Admin creates OAuth client in Google Cloud Console
  2. Adds redirect URI: `https://agc-api-production.up.railway.app/api/v1/admin/integrations/google_calendar/callback`
  3. Scopes: `calendar.events` + `calendar.readonly`
  4. Pastes `client_id` + `client_secret` into `/admin/integrations`
  5. Clicks **Authorize with Google** → signs in as sales@atlantagoldandcoinbuyers.com → grants consent → refresh_token written
  6. Test connection passes → `/book` goes live
- Public booking + admin-initiated events both use the same credentials.

---

## 12. Backups

- Daily at **20:00 America/New_York** via `@Cron('0 20 * * *', { timeZone })`
- Mechanism: spawn `pg_dump --format=custom --no-owner --no-acl` against
  `DATABASE_URL` → capture stdout → gzip → store as `backup_runs.dump_bytes`
  (bytea)
- Retention: 30 days, enforced after each successful run
- Dockerfile runtime stage installs `postgresql16-client` so `pg_dump` exists
- Admin UI at `/admin/backups`: list, Run Now, Download `.dump.gz`
- Restore: `gunzip file.dump.gz && pg_restore -d $URL file.dump`

### Off-site backup (future)

Currently backups live inside the same Postgres they're backing up — which
is fine if Railway's managed backups are also enabled (they are, by default).
For belt-and-suspenders off-site, add an S3 uploader that reads the same
bytes. Schema doesn't need to change.

---

## 13. Branding Assets (logo + favicon)

**Stored as bytea in the `branding_assets` table** (migration 016) with
`slug PK` ∈ `{'logo', 'favicon'}`. This replaced the earlier
`/app/uploads/<filename>` disk approach that was wiped on every Railway
deploy.

- Upload: `POST /admin/settings/logo` or `.../favicon`, multipart
- Serving: `GET /public/branding/logo` (and `/favicon`)
- **Cache headers:** `ETag: W/"<slug>-<updated_at_ms>"` + `Cache-Control:
  public, max-age=0, must-revalidate`. Browsers revalidate on every request
  but 304s keep it cheap. Guarantees fresh uploads show up instantly.
- PDF embed: `invoice-pdf.service.ts` reads the logo blob from the DB and
  passes the Buffer directly to pdfkit — no disk round-trip.
- Next.js root layout wires the favicon via `metadata.icons`.

---

## 14. WordPress Plugin

Lives at `wordpress-plugin/agc-inventory/`. **This is not deployed to
anything** — it's a standalone drop-in plugin for atlantagoldandcoin.com.

### What it is

```
wordpress-plugin/agc-inventory/
├── agc-inventory.php                            main plugin
├── README.md
├── assets/
│   ├── agc-inventory.css
│   └── agc-inventory.js
└── includes/
    ├── class-agc-live-inventory-widget.php
    └── class-agc-what-we-pay-widget.php
```

### Features

- Two Elementor widgets (category: "AGC Desk"):
  - **AGC Live Inventory** — in-stock items, qty, grouped by metal
  - **AGC What We Pay** — every catalog item with buy price
- Shortcode fallback: `[agc_live_inventory metal="gold"]`,
  `[agc_what_we_pay metal="silver"]`
- Metal filter control on each widget
- 1-minute browser poll via `admin-ajax.php` (between 08:00–18:00 US/Eastern)
- 60-second WP transient cache in front of the AGC Desk public endpoints
- No build step, no dependencies beyond core WP

### How to install

1. Zip the `agc-inventory` directory (top-level entry = the folder)
2. WP admin → Plugins → Add New → Upload Plugin → Activate
3. Settings → AGC Inventory → confirm API base (defaults to Railway URL)
4. Drop widgets on Elementor pages OR use shortcodes on classic pages

### Refresh behavior

- Only refreshes between 8 AM and 6 PM US/Eastern (inventory only changes
  during business hours; no point polling overnight)
- Outside window: page renders, interval idles; first load after 8 AM picks
  up fresh data

---

## 15. Deployment

### GitHub

- Org: **AGCstore**
- Repo: **agc-crm**
- Branch = deployment environment: `main` → production

### Railway (API)

- Project: **lovely-dream** (original name; don't rename — downstream refs
  depend on it)
- Services:
  - `agc-api` — the NestJS API
  - `agc-postgres` — managed Postgres 16
  - `agc-redis` — managed Redis 7
- Build: Dockerfile (`apps/api/Dockerfile`), multi-stage, pnpm install +
  `nest build` in stage 1, prod-only deps in stage 2, minimal runtime in
  stage 3 (installs `postgresql16-client` for `pg_dump`).
- **Dockerfile gotchas** (learned the hard way during initial deploy):
  - No `VOLUME` directive (Railway rejects)
  - No cache mounts with custom ids (Railway's builder rejects)
  - Runtime WORKDIR must mirror repo shape so Node's module resolution
    finds `@nestjs/common` via `/app/apps/api/node_modules/`
- Health check: `/api/v1/health` (DB + Redis status)
- Auto-deploy: every push to `main`
- Public domain: `agc-api-production.up.railway.app`
- `railway.json` at repo root configures build + healthcheck
- **Postgres public proxy** (for migrations / one-off scripts from laptop):
  `postgresql://postgres:<password>@nozomi.proxy.rlwy.net:42130/railway`
  (password in Railway env, not committed)

### Vercel (web)

- Project: **agc-crm-web**
- Root Directory: **`apps/web`**
- Auto-deploy on push to `main`
- Public domain: `agc-crm-web.vercel.app`
- `apps/web/vercel.json` rewrites `/api/*` → Railway origin. Browser only
  ever hits Vercel; CORS is never an issue.

### Required Railway env vars

```
DATABASE_URL              (auto from agc-postgres)
REDIS_URL                 (auto from agc-redis)
JWT_ACCESS_SECRET         (generated)
JWT_REFRESH_SECRET        (generated)
CREDENTIALS_ENCRYPTION_KEY (base64, 32 bytes)
WEB_ORIGIN                https://agc-crm-web.vercel.app
BCRYPT_COST               12
METALS_API_KEY            (optional; admin integration preferred)
BACKUP_RETENTION_DAYS     30 (optional; defaults to 30)
METALS_CACHE_TTL_SEC      30 (optional)
```

---

## 16. Data Loaded to Production

### Clients

574 clients imported from `E:\Clients\clients_20260417.csv` (Aureus-format
export). 35 wholesalers + 539 retail + 1 skipped ("*DO NOT USE*" row). See
`apps/api/src/db/import-clients.ts`.

### Products

194 products imported from `E:\Updated_agc-product-rates.csv`. Each product
has a per-product `pricing_rule` with:
- `buy_premium_type = 'percent'`
- `buy_premium_value` = the CSV's `Percent` column
- `sell_premium_type = 'percent'`
- `sell_premium_value = '105'` (5% over spot default; operators edit per
  product via the inline editor)

See `apps/api/src/db/reset-and-import-products.ts`. Running it requires
`WIPE_CONFIRMED=yes` in env as a safety gate.

### Team users (6 admins, all role=admin)

Seeded by `apps/api/src/db/seed-team.ts`:
- hunter@atlantagoldandcoin.com
- albert@atlantagoldandcoin.com
- collin@atlantagoldandcoin.com
- alyssa@atlantagoldandcoin.com
- accounting@atlantagoldandcoin.com
- henrique.dacosta@toptal.com (added one-off; used `AGC2026!` as initial pw)

Default pw on seed: `Atlanta123!`. Each user must change on first login
(validator requires 12+ chars; seed bypasses it).

### Branding

- Favicon: uploaded from `E:\Fav Icon\AGC Fav Icon.jpg` via
  `apps/api/src/db/upload-branding-asset.ts`. Now stored as bytea in
  `branding_assets`.
- Logo: **user should re-upload through `/admin/settings`** after the
  migration-016 switch. The old disk copy is wiped on every Railway deploy;
  the new DB copy is permanent.

### Company settings (defaulted in code, editable via UI)

- Company name: Atlanta Gold and Coin
- Address: 8480 Holcomb Bridge Rd #200, Alpharetta GA 30022
- Phone: 404-236-9744
- Website: atlantagoldandcoin.com

---

## 17. Known Pending Items

### Google Calendar OAuth consent

- Client ID + secret pasted in `/admin/integrations` ✓
- Google Cloud Console OAuth client created with redirect URI ✓
- Scopes: calendar.events + calendar.readonly ✓
- **Pending: click "Authorize with Google", sign in as sales@atlantagoldandcoinbuyers.com,
  grant consent.** Until this happens, `/book` slots won't load.

### DocuSign

- Integration credentials created ✓
- **Pending:** paste the full RSA PEM (user originally pasted the key's GUID
  by mistake — need to regenerate inside DocuSign and copy the whole PEM
  block between the BEGIN RSA PRIVATE KEY and END RSA PRIVATE KEY markers).
- **Pending:** append `/restapi` to the Base Path so it reads
  `https://demo.docusign.net/restapi`.
- **Pending:** one-time consent URL — see `apps/api/src/integrations/integrations.service.ts` docstrings.
- **Pending:** writer code. The auth path works end-to-end via Test
  connection, but no service yet sends envelopes. Next feature: hook
  `invoices.finalize()` to send the relevant template (buy vs sell) for
  countersignature.

### Logo re-upload

- Commit `7f349d2` migrated logo storage from `/app/uploads` (ephemeral
  Railway disk) to `branding_assets` (Postgres bytea). Any logo that was
  uploaded pre-`7f349d2` was wiped on the next deploy.
- **User should visit `/admin/settings` and upload the logo once** via the
  new UI. After this it survives all future deploys.

### WordPress plugin install

- Plugin code at `wordpress-plugin/agc-inventory/` is complete and tested.
- **Pending:** zip it, upload to atlantagoldandcoin.com WP admin, activate,
  configure API base URL on the plugin settings page.

### Metal-default pricing rules

- Migration `e48d4c1` flipped `percent` semantics from "+X% above melt" to
  "X% of melt".
- **Product-scoped rules were fully rekeyed** by the import (194 products,
  all with buy percentages from CSV + sell default 105).
- **Metal-scoped rules (scope='metal') were NOT touched.** If any were
  stored with the old semantics they'll misprice any product that falls back
  to the metal default. Check `/admin/pricing` or `SELECT * FROM pricing_rules
  WHERE scope='metal'`; either rekey or delete them.

### Mobile navigation

- Sidebar is hidden on mobile (`hidden md:flex`). Currently no hamburger or
  mobile drawer — see the fix being applied after this doc lands.

---

## 18. How to Rebuild From Scratch

Assume empty machine, no database, no deployment targets. Here's the minimal
path.

### Local dev setup

```bash
# 1. Prereqs
#    - Node 20
#    - pnpm 9.15.9 (via corepack enable + corepack prepare pnpm@9.15.9 --activate)
#    - Postgres 16 (local or docker)
#    - Redis 7 (local or docker)

# 2. Clone + install
git clone https://github.com/AGCstore/agc-crm.git
cd agc-crm
pnpm install

# 3. Create .env in apps/api
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env — set DATABASE_URL, REDIS_URL, JWT secrets,
# CREDENTIALS_ENCRYPTION_KEY (openssl rand -base64 32)

# 4. Run migrations
cd apps/api
pnpm exec tsx src/db/migrator.ts up

# 5. (Optional) Seed team users
pnpm exec tsx src/db/seed-team.ts

# 6. (Optional) Import production data
#    - Clients: pnpm exec tsx src/db/import-clients.ts /path/to/clients.csv
#    - Products: WIPE_CONFIRMED=yes pnpm exec tsx src/db/reset-and-import-products.ts /path/to/products.csv

# 7. Run it
cd ../..
pnpm --filter @agc/api dev      # backend on :4000
pnpm --filter @agc/web dev      # frontend on :3001
```

### Production deploy

#### Railway (API)

1. Create Railway project. Connect GitHub repo `AGCstore/agc-crm`, branch `main`.
2. Add services: Postgres (managed), Redis (managed). Railway auto-injects
   `DATABASE_URL` and `REDIS_URL`.
3. Create service `agc-api`:
   - Build: Dockerfile (`apps/api/Dockerfile`), root context
   - Start command: `node dist/main.js`
   - Healthcheck: `/api/v1/health`, 60s timeout
4. Set env vars (section 15 above).
5. Deploy. Once healthy, run migrations:
   ```bash
   DATABASE_URL='postgresql://...' pnpm exec tsx apps/api/src/db/migrator.ts up
   ```
6. Seed users + import data (section 16).

#### Vercel (web)

1. Create Vercel project. Connect `AGCstore/agc-crm`, branch `main`.
2. Root Directory: `apps/web`.
3. Framework preset: Next.js (auto-detected).
4. `apps/web/vercel.json` already has the rewrite to Railway — update the
   URL there if the Railway domain changes.
5. Deploy.

#### Post-deploy sanity checks

- Visit `https://agc-api-production.up.railway.app/api/v1/health` → JSON
- Visit `https://agc-crm-web.vercel.app/login` → login form renders
- Hit `/api/v1/public/spot` → non-zero gold/silver prices (assumes
  METALS_API_KEY is set or metals.dev integration is configured)

---

## 19. Common Operations Cookbook

### Add a user

```bash
# Edit apps/api/src/db/seed-team.ts, add to TEAM array, re-run:
pnpm exec tsx apps/api/src/db/seed-team.ts
```

Or adapt `apps/api/src/db/add-henrique.ts` (not committed; inline template in
commit history) for a one-off.

### Reset a user's password

Via UI: `/admin/clients/<id>` → Reset password (returns a temp password).
Via DB: update `users.password_hash` with a fresh bcrypt hash.

### Trigger a backup manually

`POST /admin/backups/run` (admin UI "Run backup now" button does this).
Or via the daily `@Cron('0 20 * * *', { timeZone: 'America/New_York' })` in
`BackupsService`.

### Rotate the metals.dev API key

1. `/admin/integrations` → metals.dev → Configure
2. Paste new key → Save
3. Click **Test connection** (this also wipes the Redis cache so next
   `/public/spot` hit refreshes through the new creds)

### Run the test suite

```bash
cd apps/api
# Unit
pnpm test
# Integration (requires pnpm api:dev on localhost:4000)
pnpm test:integration
```

Current state: 9 integration tests, all passing.

### Import a new product CSV

1. Format: `Category,Product,Oz,Percent,FixedPrice` (see
   `E:\Updated_agc-product-rates.csv`). `Oz` = AGW/ASW. `Percent` = buy
   percentage (e.g. `96` for 96% of spot).
2. Put the file somewhere the machine can read.
3. Run:
   ```bash
   WIPE_CONFIRMED=yes DATABASE_URL=<url> \
     pnpm exec tsx apps/api/src/db/reset-and-import-products.ts /path/to/file.csv
   ```
   **This wipes existing products + product pricing rules + inventory +
   price_quotes before loading.** Invoices survive — their line items have
   `ON DELETE SET NULL` on `product_id`.

### Check what's in branding_assets

```sql
SELECT slug, mime, length(bytes) as size_bytes, updated_at
FROM branding_assets;
```

### Re-upload a branding asset via CLI

```bash
DATABASE_URL=<url> pnpm exec tsx apps/api/src/db/upload-branding-asset.ts \
  logo image/png "/path/to/logo.png"
```

---

## 20. Commit Timeline

Chronological, most-recent first. `git log --oneline origin/main` gives the
canonical list; this narrates the "why" of each.

| Commit | Feature / Fix |
|--------|---------------|
| `e48d4c1` | Catalog reset+import, % of spot × weight pricing, invoice date override + timestamps |
| `e59169c` | Metal-group layout across catalog+sheets + WordPress plugin |
| `81dda36` | Calendar OAuth callback bounces to web origin (fixed 404) |
| `b5dcd88` | Calendar: allow empty refresh_token on first save |
| `3eb5381` | `/admin/calendar` agenda view + admin event creation |
| `7482da2` | Fuzzy product picker in invoice wizard |
| `e5cdf0f` | Public `/book` → Google Calendar via OAuth2 refresh-token flow |
| `b6f1ba6` | Category sections + jump-nav on Products/In-stock + drag-reorder catalog |
| `21943d8` | Client bulk-delete + merge, inventory simplified + metal-sortable, sticky sidebars |
| `019f446` | Daily 8pm ET backups + logo caching fix (ETag) + client delete APIs |
| `808ed45` | Product import: compute metal_content_troy_oz + map CSV categories |
| `7f349d2` | KPI dashboard + branding assets in DB (deploy-safe logo/favicon) |
| `6bdb5da` | Invoice wizard: surface error for ad-hoc lines missing a catalog product |
| `33ab6ac` | Invoice wizard: required multi-payment + manual unit price + auto-add + New Item |
| `25961ce` | Invoice tabs, clients wholesale tab, /admin/buy-sheet, inventory sell-price |
| `018b5c0` | Migration 015 + multi-payment + Zelle/Venmo + 574-row client import |
| `eff6553` | /admin/in-stock-sheet + inline pricing editor + 2FA recovery script |
| `fd327f5` | Session-change spot ticker + 60s refresh + /admin/products/sheet |
| `f57480d` | Contextual page tints + in-stock summary at top of inventory |
| `93ffd05` | Branding address/phone/website on PDFs + per-side legal disclosures + notes |
| `cdff580` | Inventory consumes at sell.paid (walk-in behavior) |
| `92f394e` | Products detail page pricing editor, live web toggle, CSV import |
| `74c3894` | Logo on login + sidebars, password change UI, heard_from, team seed |
| `c67e37c` | Gitignore *.tsbuildinfo |
| `9f5a228` | Extract shared status pills out of page files (Next 15 compliance) |
| `5f1a9a5` | Point web rewrite at live Railway API URL |
| `740dbdb` | Dockerfile: preserve workspace layout for pnpm deps |
| `1f22126` | Remove buildkit cache mounts from Dockerfile |
| `4c9029b` | Drop cache mount id from Dockerfile (Railway builder requirement) |
| `a21286b` | metals.dev as admin-rotatable encrypted integration |
| `ea57eb6` | Drop VOLUME directive from API Dockerfile (Railway rejects) |
| `1a5f2cc` | Add Railway config + document Render path as alternative |
| `85012b4` | README accurate + scrub metals key from .env.example |
| `0c04890` | Vitest suite for money-path invariants |
| `1d1219d` | Batch pricing cache + carrier adapter interface |
| `d18cadd` | Invoice snapshot fidelity + real reservation workflow |
| `90f8d6b` | Admin-managed encrypted credentials for shipping + DocuSign |
| `0f8fa15` | Drop stale gitignore rules |
| `45655b4` | **Initial commit — Phase 0-4 baseline** |

---

## 21. File Reference

### Backend (`apps/api/src/`)

| File | Responsibility |
|------|----------------|
| `main.ts` | Bootstrap (Nest, CORS, helmet, global prefix `/api/v1`, versioning) |
| `app.module.ts` | Root module — aggregates every feature module |
| `pricing/pricing.service.ts` | **THE pricing formula** — `applyPremium()` |
| `invoices/invoices.service.ts` | State machine + `classifyInventoryAction()` |
| `invoices/invoice-pdf.service.ts` | pdfkit renderer — logo, address, disclosure, notes, full timestamp |
| `inventory/inventory.service.ts` | `applyMovement()` with SELECT FOR UPDATE |
| `clients/clients.service.ts` | CRUD + search + `merge()` + `bulkDelete()` |
| `products/products.service.ts` | CRUD + `reorder()` |
| `products/products-import.service.ts` | CSV import via `/admin/products/import` |
| `public/public.controller.ts` | `/public/*` endpoints |
| `public/public-cache.service.ts` | Redis cache for /public/what-we-pay |
| `metals/metals.service.ts` | metals.dev client + Redis + baseline tracking |
| `metals/metals-sse.controller.ts` | SSE stream of spot prices |
| `calendar/calendar.service.ts` | Google Calendar — OAuth refresh, FreeBusy slots, `createBooking()`, `createAdminEvent()` |
| `calendar/calendar.controller.ts` | Public `/book` + admin `/admin/calendar` + OAuth dance |
| `backups/backups.service.ts` | Daily `@Cron` + `run()` + retention |
| `settings/settings.service.ts` | Branding config + asset blob get/set |
| `integrations/integrations.registry.ts` | Provider schemas (add new providers here) |
| `integrations/integrations.service.ts` | CRUD + encrypt/decrypt |
| `crypto/crypto.service.ts` | AES-256-GCM |
| `db/types.ts` | Kysely type definitions for every table |
| `db/migrations/*.ts` | 18 migration files, applied in numeric order |
| `db/migrator.ts` | Runner — `up`, `down` |
| `db/import-clients.ts` | Aureus-format CSV client importer |
| `db/import-products.ts` | Original product importer (pre-CSV-reset version) |
| `db/reset-and-import-products.ts` | **Current** product importer — wipes + loads |
| `db/upload-branding-asset.ts` | One-shot asset uploader |
| `db/seed-team.ts` | Employee seed |

### Frontend (`apps/web/src/`)

| File | Responsibility |
|------|----------------|
| `app/layout.tsx` | Root (favicon metadata) |
| `app/providers.tsx` | React Query + auth context |
| `app/admin/layout.tsx` | Admin shell — sidebar, spot ticker, notifications bell, portal switcher |
| `app/dashboard/layout.tsx` | Client portal shell |
| `app/admin/kpi/page.tsx` | KPI dashboard with vanilla-SVG chart |
| `app/admin/calendar/page.tsx` | Agenda + new event form |
| `app/admin/invoices/new/page.tsx` | Invoice wizard |
| `app/admin/invoices/[id]/page.tsx` | Detail |
| `app/admin/inventory/page.tsx` | "Products" page — 12 sections |
| `app/admin/products/page.tsx` | "Catalog" page — DnD reorder |
| `app/admin/buy-sheet/page.tsx` | What-we-pay printable |
| `app/admin/in-stock-sheet/page.tsx` | In-stock printable |
| `app/admin/backups/page.tsx` | Backup list |
| `app/admin/integrations/page.tsx` | Creds UI per provider |
| `app/admin/settings/page.tsx` | Branding settings |
| `app/book/page.tsx` | Public booking page |
| `components/page-tint.tsx` | Navy/green contextual backgrounds |
| `components/product-combobox.tsx` | Fuzzy product picker |
| `components/inline-price-editor.tsx` | In-place premium editor |
| `components/status-pill.tsx` | Shared invoice / shipment status badges |
| `components/spot-ticker.tsx` | Header spot prices (60s poll) |
| `components/notifications-bell.tsx` | Bell with unread count |
| `lib/api-client.ts` | Fetch wrapper with auth + refresh |
| `lib/use-live-spot.ts` | SSE hook for spot prices |
| `lib/product-category.ts` | **12 display categories** + metal groups + family sort |
| `lib/sheet-types.ts` | SheetRow type shared by /admin/products/sheet consumers |
| `tailwind.config.ts` | Extended palette (ink, gold, buy=navy, sell=green) |
| `vercel.json` | Rewrites `/api/*` → Railway |

### WordPress plugin (`wordpress-plugin/agc-inventory/`)

| File | Responsibility |
|------|----------------|
| `agc-inventory.php` | Main — shortcodes, settings page, AJAX proxy, Elementor registration |
| `includes/class-agc-live-inventory-widget.php` | Elementor widget |
| `includes/class-agc-what-we-pay-widget.php` | Elementor widget |
| `assets/agc-inventory.css` | Shared styling |
| `assets/agc-inventory.js` | 1-min browser poll with 8–6 ET gate |
| `README.md` | Install + usage |

---

## 22. Glossary

| Term | Meaning |
|------|---------|
| **AGW** | Actual Gold Weight — troy oz of pure gold in a coin/bar. `gross_weight × purity`. For a 1 oz American Gold Eagle: 1.0909 gross × 0.9167 purity = 1.0000 AGW. |
| **ASW** | Actual Silver Weight — same concept for silver. |
| **Spot** | Current live per-troy-oz price of a metal. Quoted by metals.dev. |
| **Melt** | `spot × metal_content`. The intrinsic value of the metal ignoring any premium. |
| **Premium** | What we charge (or pay below) the melt value. Either `percent` (now: X% of melt) or `flat` (X $/oz of metal content). |
| **Junk silver** | 90% silver US coinage — Morgan/Peace dollars, pre-1965 halves, quarters, dimes. Priced by silver content, not numismatics. |
| **Pre-1933 gold** | US gold coinage from 1800s–1932. Numismatic value + melt value. |
| **Proof / Prestige / Premier** | US Mint collector sets with known total AGW/ASW. Live in `silver_mint_sets` display category. |
| **Reserved inventory** | Stock earmarked for a finalized but unpaid invoice. Prevents oversell. |
| **On hand** | Physical stock. `on_hand - reserved = available`. |
| **SELECT FOR UPDATE** | Postgres row lock. Used in `inventory.service.ts` to serialize concurrent reservation/consume operations. |
| **TOTP** | Time-based One-Time Password — the 6-digit codes from Google Authenticator, etc. Used for 2FA. |
| **Integration** | Third-party API we talk to (metals.dev, UPS, FedEx, DocuSign, Google Calendar). Creds stored AES-encrypted. |
| **PageTint** | Wrapper component that adds navy or green background to money-out vs money-in screens. |

---

## 23. Contact / Support

- **Business owner:** Hunter (hunter@atlantagoldandcoin.com)
- **GitHub:** https://github.com/AGCstore/agc-crm
- **Domain:** agcdesk.com (DNS pointing to agc-crm-web.vercel.app — verify
  in Vercel project settings)

---

*This document is committed to the repo. Keep it up to date when making
significant changes. If a new Claude session is picking this up, this doc
+ the commit timeline + the file reference tree should be enough to
operate safely without re-discovering everything.*

---

## 24. Changelog Addendum (2026-04-17 → 2026-04-18)

Everything below shipped after the original doc was written. Read this
section before acting on anything from the main doc above — some of
the behavior described earlier has been extended, replaced, or fixed.

### What's new

| Commit | What |
|---|---|
| `2b0e173` | **Mobile hamburger drawer** on admin + dashboard layouts. Slide-in panel, closes on route change / Esc / backdrop click. Desktop (≥md) unchanged. Also added fuzzy search to `/admin/buy-sheet`. |
| `b835156` | Fixed 403 on `POST /client/deal-requests` for admin/staff (was gated on `client` role only) — admins can now submit test requests. `/book` page redesigned: 3 top-level buttons (Buy / Sell / Appraisal) + required sub-choice for Appraisal (Only / With Intent to Sell) + red disclaimer text + email field explicitly required. Appraisal bookings auto-block 60 min server-side (was 30). |
| `d9b4339` | **Fuzzy search on every product-listing page.** Shared scorer at `apps/web/src/lib/product-search.ts` (`rankProducts<T>(rows, query)`). Same weights as the invoice wizard's combobox (+100 SKU substring, +15 SKU prefix, +60 name word-boundary, +30 name substring, +5 metal, +20/token). Applied to `/admin/buy-sheet`, `/admin/in-stock-sheet`, `/admin/inventory`, `/admin/products` (with drag disabled while searching), `/dashboard/pricing`, `/dashboard/in-stock`. |
| `c879fcc` | **Custom display categories** — rearrange + add. Migration 019 adds `products.display_category_override TEXT NULL`. New admin-only CRUD endpoints under `/admin/display-categories` (list / order / custom / delete). State stored in `app_settings` JSONB under keys `display_categories.custom` and `display_categories.order`. Public read at `/public/display-categories`. Frontend hook `useDisplayCategories()` merges builtins with custom + applies order. `/admin/categories` page (drag via @dnd-kit + add form + delete customs). Product detail page gets a "Display category" dropdown to pin any product. **Currently wired through on `/admin/inventory` only** — other 3 listing pages still use compiled-in SECTIONS order; they'll pick up dynamic order in a follow-up. Override is honored universally since the sheet endpoint passes it through. |
| `4f26c20` | Split admin dashboard volume cards into in-office vs wholesale. Added "Edit" button on closed invoices — opens an inline editor for quantity/unit price without going through void-and-recreate. (This is orthogonal to void-and-recreate — inline edit preserves the invoice number; void-and-recreate spawns a new one.) |
| `ee35085` | **Void-and-recreate invoice flow.** Button on invoice detail page cancels the invoice (reverses inventory via existing `classifyInventoryAction`) and redirects to `/admin/invoices/new?from=<id>`. Wizard reads the `from` param, fetches the source invoice, prefills client/type/notes/transaction date/line items (with unit prices preserved as overrides)/payment legs. **Same commit also added the pg18 Docker attempt that had to be reverted** — see `d8b2bd2`. And a "Now" button next to the transaction date/time inputs in the wizard. |
| `2aa3265` | **Inline product name editor** on `/admin/products/[id]`. Click "Edit" next to the h1 → input appears → Save/Enter commits via PATCH and invalidates every React Query cache that shows a product name (catalog / products / sheet / inventory / client prices / client in-stock). Historical invoices keep their original name (snapshot column unchanged — audit-correct). |
| `d8b2bd2` | **Rolled back the pg18 Docker attempt** from `ee35085`. The Debian `bookworm-slim` + PGDG apt runtime built cleanly but the healthcheck failed because `bcrypt` / native modules had been compiled against Alpine's musl libc in the prod-deps stage and wouldn't load against Debian's glibc. Went back to node:20-alpine + postgresql16-client. Site came back up. |
| `812686f` | Aligned `package.json:packageManager` to `pnpm@9.15.9` so it matches the GitHub Actions workflow + Dockerfile corepack invocation. Also served as a cache-busting push to force Railway to rebuild after the revert. |
| `31b67e7` | **Pure-JS SQL backup dumper** — `pg_dump` dependency removed entirely. `BackupsService.buildSqlDump()` walks `pg_tables` + `information_schema.columns`, emits `BEGIN / TRUNCATE / INSERT row-by-row / ALTER SEQUENCE / COMMIT` inside `session_replication_role='replica'` so FKs don't trip during restore. Output gzipped + stored in `backup_runs.dump_bytes` same as before. Download extension changed `.dump.gz → .sql.gz`. **Restore path now:** migrate a fresh DB, then `gunzip -c file.sql.gz \| psql $DATABASE_URL`. Portable across every Postgres major version forever. Dockerfile dropped `postgresql16-client` — ~40 MB smaller image. |

### New schema

Migration **019** (applied to dev + prod):
```
ALTER TABLE products ADD COLUMN display_category_override TEXT;
```

Plus two new `app_settings` JSONB keys (no schema change — these live
in the existing flexible blob):

- `display_categories.custom` — array of `{id, label, metal}` for admin-
  added categories
- `display_categories.order` — array of slugs in the operator's preferred
  rendering order

### New dependencies

- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` — used by the
  Catalog drag-reorder (already installed in the earlier session) and now
  also by `/admin/categories`. No new peer deps added since the doc.

### Sidebar rearrangement

Final admin sidebar order (see `apps/web/src/app/admin/layout.tsx` →
`NAV_ITEMS`):

```
Dashboard        → /admin
KPI              → /admin/kpi
Calendar         → /admin/calendar
Invoices         → /admin/invoices
New invoice      → /admin/invoices/new
Clients          → /admin/clients
Requests         → /admin/requests
Shipments        → /admin/shipments
Quotes           → /admin/quotes
Products         → /admin/inventory          (stock-centric, 12+custom sections)
In stock sheet   → /admin/in-stock-sheet
What we pay      → /admin/buy-sheet
Catalog          → /admin/products           (drag-reorder, CRUD)
Categories       → /admin/categories         (NEW — rearrange + add)
Integrations     → /admin/integrations
Backups          → /admin/backups
Settings         → /admin/settings
```

### New files added since the doc

| File | Role |
|---|---|
| `apps/api/src/db/migrations/019_product_display_override.ts` | Schema for the override column |
| `apps/api/src/settings/display-categories.controller.ts` | CRUD for categories (admin + public read) |
| `apps/web/src/app/admin/categories/page.tsx` | Drag-reorder + add/delete UI |
| `apps/web/src/lib/product-search.ts` | Shared fuzzy scorer |
| `apps/web/src/lib/use-display-categories.ts` | Hook that merges builtins + custom + order |

### Changed behavior to know about

1. **Backups are now plain SQL.** Not `pg_dump --format=custom` anymore.
   Restore path is `psql < file.sql` against a freshly-migrated DB, not
   `pg_restore`. The admin page already documents this.

2. **`deriveDisplayCategory` is no longer the only routing path.** Always
   prefer `resolveDisplayCategory(product, knownSlugs)` — it checks the
   override first and falls back to the heuristic. Passing the
   `knownSlugs` set (from `useDisplayCategories()`) is what makes
   deleted custom slugs fall back gracefully instead of orphaning.

3. **Native module mismatch caveat.** If you ever switch the runtime base
   image away from Alpine, you MUST also switch the `prod-deps` build
   stage to a matching base. Native deps (`bcrypt`, sharp, etc.) compile
   against the libc of whatever image installs them. Mismatching Alpine
   (musl) and Debian (glibc) crashes the container at startup with an
   obscure "invalid ELF header" — which is exactly what killed the pg18
   attempt in `ee35085`.

4. **Pinned-product routing.** A product with `display_category_override`
   set goes to that slug regardless of name. The 3 listing pages that
   haven't been converted to `useDisplayCategories()` yet (In-stock
   sheet, Buy sheet, Catalog) still honor the override because they
   read it through the sheet endpoint — but they render sections in
   compiled-in order, not admin-customized order. Rolling them over to
   the hook is a small change (same pattern as `/admin/inventory`).

5. **Void-and-recreate is a two-step user flow, not a single server
   endpoint.** The detail page POSTs `status=canceled`, then the web
   router.push() navigates to `/admin/invoices/new?from=<id>`. The
   wizard does the prefill. There's no single atomic "void and
   recreate" backend call.

### Still pending

- **Backup cron hasn't been exercised on prod yet with the new JS
  dumper.** Next 8 PM ET run will be the first test. The `/admin/backups
  → Run backup now` button lets you trigger one immediately — recommended
  as a smoke test.

- **Google Calendar OAuth consent.** Still needs the one-time "Authorize
  with Google" click on `/admin/integrations` → Google Calendar card.
  Until then, `/book` slots don't load.

- **DocuSign.** Creds saved; RSA PEM still needs to be the full block
  (operator originally pasted the key's GUID instead of the key
  content); base_path needs `/restapi` appended; consent URL needs to
  be hit once.

- **Logo re-upload.** The branding_assets migration moved storage to
  Postgres bytea so it survives deploys — but the pre-migration logo
  was wiped. Operator should upload a fresh one via `/admin/settings`.

- **Three listing pages still using static SECTIONS order.** In-stock
  sheet, Buy sheet, Catalog. Conversion pattern is:
  ```tsx
  const { sections, knownSlugs } = useDisplayCategories();
  // replace `SECTIONS` with `sections` in the render loop
  // replace `deriveDisplayCategory(p)` with `resolveDisplayCategory(p, knownSlugs)`
  ```
  Products sheet already passes `display_category_override` through.

- **WordPress plugin not yet installed** on atlantagoldandcoin.com. Code
  is at `wordpress-plugin/agc-inventory/` ready to zip + upload.

---

## 25. Changelog Addendum (2026-04-19 — "Big Release" phases 1–4)

Everything below shipped after §24. Read this section first if you already
read the main doc. **Phase 5 (PDF layout changes + QR code) is explicitly
deferred** to a future session — not in this commit. Phase 6 (operator QA
against production) is also pending.

### Scope

A 30-ticket production release spanning 8 groups (INV, PDF, SHIP, PROD, WH,
CLIENT, MOB, CAL). Ticket PDF-001 is deferred; everything else — schema,
backend, wizard, detail page, wholesale reconciliation, client model,
calendar↔CRM linking, mobile scroll — shipped in phases 1–4.

### Migrations (all additive; see `apps/api/src/db/migrations/`)

| # | Name | What |
|---|---|---|
| 020 | `020_client_company_and_emails.ts` | `clients.company TEXT`, `clients.secondary_emails JSONB NOT NULL DEFAULT '[]'`, relax `first_name`/`last_name` NOT NULL + add `clients_has_identity` CHECK (at least one of first/last/company must be non-empty), **rebuild `search_text` GENERATED column to include `company`** (drop + recreate — Postgres can't alter a GENERATED expression in place). |
| 021 | `021_shipment_delivery_speed.ts` | `shipments.delivery_speed TEXT NULL`. Validation of carrier↔speed pairing lives in `apps/api/src/shipments/delivery-speeds.ts` (not a DB CHECK — carriers rename services often). |
| 022 | `022_wholesale_paid_audit.ts` | `invoices.paid_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL` + partial index `invoices_outstanding_by_client_idx (client_id) WHERE status='finalized'` to make the wholesale AR rollup cheap. |
| 023 | `023_calendar_bookings.ts` | New `calendar_bookings` table with `id UUID PK`, `google_event_id TEXT UNIQUE`, `client_id UUID NULL FK clients ON DELETE SET NULL`, `service`, `starts_at`, `ends_at`, `name`, `email`, `phone`, `notes`, `status DEFAULT 'confirmed'`, `source DEFAULT 'public_booking'`, timestamps. Indexes on `client_id` and `starts_at DESC`. |

**Applying to prod:** run via Railway proxy per §15. They are idempotent
and reversible (`down()` implemented for each).

### New backend surfaces

- `DELETE /admin/invoices/:id` — hard-delete a draft. Service guards `status='draft'` only.
- `POST /admin/invoices/:id/email` — render PDF + email to a recipient. Body `{ to, save_to_client?: boolean }`. Never mutates invoice state (works on drafts). When `save_to_client=true` and address is new, appended to client's `secondary_emails`.
- `GET /admin/kpi/wholesale-owed` — total + per-client breakdown of finalized (not-paid) wholesale invoices. Powers the KPI card and reconciliation page.
- `GET /admin/shipments/delivery-speeds` — carrier→speeds whitelist (so the UI builds the dropdown without hardcoding). Declared **before** `:id` or Nest's UUID pipe rejects the slug.
- `GET /admin/clients/:id/appointments` — calendar bookings linked to the client (from `calendar_bookings` mirror).
- `GET /admin/calendar/bookings/pending` — bookings that failed to auto-link; admin reconciliation tray.
- `PATCH /admin/calendar/bookings/:id/client` — manually attach/detach a booking from a client.

**Existing endpoints changed:**

- `PATCH /admin/invoices/:id/status` now stamps `paid_by_user_id=<actor>` when transitioning to `paid` (WH-002 audit).
- `GET /admin/invoices/:id` detail response now includes `client_type` and `client_company`.
- `GET /admin/invoices` list response's `client_name` falls back to `company` when `first/last` are blank.
- `POST /public/calendar/book` now also writes to `calendar_bookings` + tries to auto-link to a client. Mirror failures are swallowed — the Google event stays authoritative.

### New service methods

- `InvoicesService.deleteDraft(id, actor)` — service guard `status='draft'`, hard-delete + audit.
- `InvoicesService.emailInvoice(id, { to, saveToClient }, actor)` — renders PDF to Buffer, attaches via `EmailService.send(attachments)`, optionally appends to `clients.secondary_emails`.
- `InvoicesService.listOutstandingWholesale()` — single source of truth for wholesale AR.
- `ClientsService.findOrCreateByContact({ name, email, phone, actorUserId })` — returns `{ id, created }`. Match order: primary email → secondary_emails → phone (last-10 digits). **No fuzzy matching** by design — see risks below.
- `CalendarBookingsService.recordPublicBooking()` / `listForClient(id)` / `listPending()` / `linkToClient(id, clientId, actor)`.

### Client model changes (backward-compatible)

- Added `company: string | null` and `secondary_emails: string[]` to `ClientsTable`.
- `first_name` + `last_name` are now nullable (enforced via CHECK `clients_has_identity`).
- Existing retail clients unchanged. To classify a client as wholesale, set `client_type='wholesaler'`; `company` becomes their primary identity and the name fields are optional.

### Invoice wizard rewrite (`apps/web/src/app/admin/invoices/new/page.tsx`)

Substantial refactor (~720 → ~950 lines). What changed:

1. **Running total** (INV-001) — quotes hoisted to parent via `useQueries`; `subtotal = Σ lineTotal` displayed in a sticky action rail at the bottom.
2. **Total button** (INV-002) — next to "Add split" in Step 4. Fills the last payment leg with `total − already-covered`.
3. **Line spacing** (INV-003) — grid changed from 6/2/2/1/1 to 5/2/2/2/1 so the total column no longer runs into the × button.
4. **Unified client combobox** (INV-004) — new `ClientCombobox` at `apps/web/src/components/client-combobox.tsx`. Fuzzy scorer across first/last/company/email local-part/phone digits.
5. **Draft lifecycle** (INV-005) — sticky bottom rail has `Cancel · Save · Print · Create · Email + input`. Save posts at `status='draft'`. URL updates to `?draftId=<id>` so reload resumes. Subsequent Save POSTs a fresh draft + DELETEs the old (invoice_number regenerates; drafts aren't operator-visible yet, acceptable). Delete button appears once there's a backing draftId.
6. **Print without finalize** (INV-006) — calls persistDraft() + opens `/api/v1/admin/invoices/:id/pdf` in new tab. No status mutation.
7. **Email** (INV-007) — calls persistDraft() + POST `/email`. Email input prefills from `client.email`. Checkbox "Save new addresses to client record" defaults true.
8. **Button order** (INV-008) — Cancel · Save · Print · Create · Email + input (exactly the spec).
9. **Notes wrap** (INV-009) — `whitespace-pre-wrap break-words` on the textarea AND on the detail page's notes render.
10. **Line row mobile scroll** (MOB-001) — line items wrapped in `overflow-x-auto` with `min-w-[640px]`.

### Invoice detail page updates (`apps/web/src/app/admin/invoices/[id]/page.tsx`)

- Wholesale badge in the header when `client_type='wholesaler'`.
- Company displayed alongside personal name when both are set.
- **Green "Mark paid" button** for `status='finalized' + client_type='wholesaler'` — prominent, distinct from the generic status-dropdown option (which is hidden for wholesalers to avoid double-action).
- New `PaymentMethodsPanel` renders payment legs + amounts for every invoice including drafts (INV-010).
- New `EmailInvoiceButton` — inline popover with address + "save to client" checkbox.
- Notes render uses `whitespace-pre-wrap break-words`.
- `ShipmentSection` has a carrier-aware service-level dropdown via `GET /admin/shipments/delivery-speeds`.

### New pages

- **`/admin/wholesale/reconciliation`** — table of every outstanding wholesale invoice, grouped by client, with per-invoice Mark Paid. Sidebar entry "Wholesale AR" added between "New invoice" and "Clients". (WH-001)
- **KPI card on `/admin/kpi`** — "Total owed by all wholesalers" in a gold-accent card with top-5 breakdown and a deep link to the reconciliation page. Refreshes every 30s. (WH-003)

### Client page updates

- `ClientForm` gained: type toggle (retail/wholesale), `company` field, `secondary_emails` textarea (newline-separated). Name fields become optional when type=wholesale.
- `/admin/clients/[id]` header renders company alongside name, shows Wholesale badge, lists secondary emails.
- New **Appointments** block in the timeline — pulls from `GET /admin/clients/:id/appointments`.

### Shipments tab

- New "Service" column between Carrier and Tracking.
- Inline editor's service-level dropdown populated from `/admin/shipments/delivery-speeds`, filtered to current carrier. Gracefully handles saved values no longer in the whitelist.
- `overflow-x-auto` + `min-w-[780px]` for mobile (MOB-002).

### Mobile horizontal scroll pass (MOB-002)

Flipped `overflow-hidden rounded-xl …` → `overflow-x-auto rounded-xl …` (and added `min-w-[…]` to inner `<table>`) on: `/admin/invoices`, `/admin/clients`, `/admin/products`, `/admin/inventory`, `/admin/in-stock-sheet`, `/admin/buy-sheet`, `/admin/kpi`, `/admin/shipments`, and the wholesale reconciliation page's per-client blocks. Remaining wide tables (admin dashboard, categories, backups, calendar agenda) weren't touched this pass.

### What's NOT in this release

- **Phase 5 — PDF layout** (ticket PDF-001): phone-under-email, `MM-DD-YYYY` date format, payment rows, QR code to `/register`. Deferred. Nothing in `invoice-pdf.service.ts` changed.
- **PROD-001** (Saint-Gaudens → Pre-1933): already handled by the existing regex in `apps/web/src/lib/product-category.ts:142` before this session — verified, no change needed.
- **PROD-002 / PROD-003** (editable SKUs + locations): backend already supports SKU mutation (`ProductsService.update()`). "Location" semantics ambiguous — left for a follow-up with Hunter about what "every table and product location" means concretely.

### Still pending after this commit

1. **PDF changes** (Phase 5).
2. **Prod migrations** — 020–023 need to be applied via Railway proxy once this commit is on `main`.
3. **Fuzzy-match review tray** — current calendar auto-link only does exact email/secondary/phone-last-10. Admin "suggested matches" UX is a follow-up.
4. **Remaining wide-table scroll wrappers** — categories, backups, admin dashboard, calendar agenda. Low-priority.
5. **Webhook idempotency for calendar_bookings** — we use ON CONFLICT DO UPDATE so a replay upserts cleanly, but there's no webhook endpoint yet. Reuse this path if/when added.

### Known risks / rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| `search_text` rebuild locks clients table briefly (~600 rows) | Fast enough to ignore; run off-hours if worried | `down()` restores the pre-020 expression |
| `first_name`/`last_name` allowed NULL on retail | `clients_has_identity` CHECK requires ONE of first/last/company | Drop the CHECK; columns remain nullable (no data loss) |
| Draft Save is DELETE+POST across two requests | POST-first, DELETE-after ordering → worst case is an orphan old draft admin can delete | n/a |
| Calendar auto-client-create creates duplicates | Only exact email/secondary/phone match; fuzzy-similar names go to pending tray | `calendar_bookings.client_id` can always be nulled and re-matched |
| Wholesale Mark Paid via existing status PATCH | paid_by_user_id stamped server-side automatically | Same state machine — safe |
| Delivery-speed whitelist in TS, not DB CHECK | Service rejects bad pairs with readable 400 | Pre-migration rows have `delivery_speed=NULL` |
| Email transport is SMTP via existing `EmailService` | Falls back to dev-JSON mode when `SMTP_HOST` unset | n/a |

### Files added this session

- `apps/api/src/db/migrations/020_client_company_and_emails.ts`
- `apps/api/src/db/migrations/021_shipment_delivery_speed.ts`
- `apps/api/src/db/migrations/022_wholesale_paid_audit.ts`
- `apps/api/src/db/migrations/023_calendar_bookings.ts`
- `apps/api/src/shipments/delivery-speeds.ts`
- `apps/api/src/calendar/calendar-bookings.service.ts`
- `apps/web/src/components/client-combobox.tsx`
- `apps/web/src/app/admin/wholesale/reconciliation/page.tsx`

### QA checklist — what a human should test before deploying

- [ ] Migrations 020–023 apply cleanly to prod (`pnpm exec tsx apps/api/src/db/migrator.ts up`).
- [ ] Existing retail clients still render correctly on `/admin/clients` (name shows; no "null null").
- [ ] Create a wholesale client with only a company name → saves without error; invoice list shows the company.
- [ ] Open `/admin/invoices/new` — type a product, see running total update; click "Total" in Step 4 → amount fills the last leg.
- [ ] Save a draft, reload the page → draft loads via `?draftId=`, fields re-hydrate.
- [ ] Email a draft to yourself — PDF arrives as attachment; invoice stays at `status='draft'`.
- [ ] Print a draft — PDF opens in new tab; status unchanged.
- [ ] Delete a draft — confirm dialog, redirects to drafts list.
- [ ] Finalize a wholesale sell invoice → green "Mark paid" button appears → click it → status becomes paid, `paid_by_user_id` in audit_logs.
- [ ] `/admin/wholesale/reconciliation` shows finalized wholesale invoices; disappears after Mark Paid.
- [ ] `/admin/kpi` "Total owed by all wholesalers" matches reconciliation total.
- [ ] Create a shipment — carrier dropdown drives service-level dropdown; invalid combos return a readable 400.
- [ ] Book a public appointment on `/book` with an email that matches an existing client → client's timeline shows the appointment.
- [ ] On mobile width, every table in the primary list pages scrolls horizontally instead of clipping.
