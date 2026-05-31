# bullionOS — multi-tenant precious-metals trading desk, client portal, and CRM for coin dealers

## What this is

BullionOS Desk is a precious-metals **trading desk + client portal + CRM**, licensable to coin dealers as a per-tenant deploy. Each customer runs a private instance built from the same `main` branch; the product was forked from `agc-crm` (Atlanta Gold & Coin's internal system) and de-tenanted.

Core capabilities (all wired end-to-end in code): email/password + TOTP 2FA auth, products catalog with a decimal-safe pricing engine, live metals spot feed, buy/sell invoices with an immutable line-item snapshot + PDF, inventory with real stock reservation (oversell-proof), a client portal (transactions, live pricing over SSE, lock-in quotes, deal requests with photos, shipments, messaging), an admin console, in-app/email/SMS notifications, encrypted third-party integrations (carriers, DocuSign, Gmail, Google Calendar, GReminders, Aurbitrage, IFS), CSV imports, in-DB backups, ID-document OCR (AWS Textract), RARCOA goldsheet PDF parsing, Aurbitrage wholesaler price aggregation, EOD report emails, and KPI/dashboard rollups.

Internal package names are still `@agc/*` and the DB is `agc_crm` — that's historical, not a separate product.

## Architecture

- **pnpm monorepo** (`pnpm-workspace.yaml`: `apps/*`, `packages/*`), Node ≥20.11, pnpm 9.15.9, TypeScript throughout.
- **`apps/api`** — NestJS 10 backend. Global prefix `/api`, URI versioning default `v1` → every route is under `/api/v1`. Guards run rate-limit → JWT auth → roles. Runs on Railway (or Render) per tenant.
- **`apps/web`** — Next.js 15 / React 19 admin console (`/admin/*`) + client portal (`/dashboard/*`). Runs on Vercel per tenant. Proxies `/api/*` to the API host via `vercel.json` rewrites.
- **`apps/metals-proxy`** — tiny Express service. ONE central deploy (ops account, not per-tenant) that fronts metals.dev with a single API key, caches the snapshot in-memory, and serves it to all tenant APIs via per-tenant Bearer keys. Lets the API consolidate metals.dev quota.
- **`packages/shared`** — zod schemas shared between API and web (consumed as TS source, no build step).
- **Data:** PostgreSQL 16 (primary store, all money as `NUMERIC(20,8)`, accessed via Kysely query builder + `FileMigrationProvider` migrations) and Redis 7 (metals spot cache, public-feed cache).
- **Money math is decimal-only** end-to-end (`decimal.js` + `NUMERIC(20,8)`) — never JS float — across pricing, invoicing, inventory.
- **Invoices are reproducible:** each line item snapshots all calculation inputs (weight, purity, content, spot, premium type/value, unit price), so an invoice reprints identically even after its product is hard-deleted.
- **Inventory uses real reservation** with `SELECT ... FOR UPDATE` on the inventory row inside the status-change transaction, making oversell impossible.
- **Integration credentials** (carriers, DocuSign, Gmail, etc.) are stored AES-256-GCM-encrypted in the `integrations` table and configured in-app at `/admin/integrations`; the only encryption secret in env is `APP_ENCRYPTION_KEY`.
- **Cron jobs** via `@nestjs/schedule` (`ScheduleModule.forRoot()` registered once in `app.module.ts`): nightly DB backups, Aurbitrage sync (~15 min), Gmail ingest, EOD report blast. Carrier auto-refresh polling is scaffolded but not yet scheduled.
- **`wordpress-plugin/agc-inventory`** — standalone WP/Elementor plugin (PHP) for atlantagoldandcoin.com that renders live inventory + "What We Pay" buy rates by calling the API's `@Public()` endpoints (gated behind `PUBLIC_ORIGINS` CORS + the `frontend_pricing_enabled` feature flag).

## Run it locally (prereqs + commands + ports)

Prereqs: Node 20.11+, pnpm 9+, Docker Desktop (Postgres + Redis), Git.

```powershell
# from repo root (E:\bullionOS)
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
# edit apps/api/.env: set JWT_ACCESS_SECRET, JWT_REFRESH_SECRET (>=32 chars each),
#   APP_ENCRYPTION_KEY (base64 of exactly 32 bytes). METALS_API_KEY optional locally.

pnpm install
pnpm db:up          # docker compose: postgres:5432, redis:6379
pnpm db:migrate     # runs apps/api migrations (tsx src/db/migrator.ts up)
pnpm db:seed        # seeds admin@agc.local / ChangeMe_Admin_123!
pnpm db:seed:trading  # seeds product catalog + pricing rules

# two terminals (or `pnpm dev` to run all in parallel):
pnpm api:dev        # API  -> http://localhost:4000  (routes at /api/v1)
pnpm web:dev        # web  -> http://localhost:3001
```

Ports: API **4000**, web **3001**, Postgres **5432**, Redis **6379**, metals-proxy **4001** (default; only run if working on it). Sign in at http://localhost:3001/login.

Tests: `pnpm --filter @agc/api test:unit` (pure, no API needed); `pnpm --filter @agc/api test:integration` (needs `pnpm api:dev` running — verifies DB invariants).

## Environment variables

All API vars are validated at boot by `apps/api/src/config/env.ts` (zod). Set them in **`apps/api/.env`** locally; in prod set them in the Railway/Render dashboard. NO secret values here — names only.

**API (`apps/api/.env`):**
- App: `NODE_ENV`, `PORT` (default 4000), `API_BASE_URL`, `WEB_ORIGIN`, `PUBLIC_ORIGINS` (comma-sep extra CORS origins, e.g. the WordPress site)
- DB: `DATABASE_URL`, `DATABASE_POOL_MAX`
- Redis: `REDIS_URL`
- Auth/JWT: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (each ≥32 chars), `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `BCRYPT_COST`, `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS`, `TOTP_ISSUER`
- Encryption: `APP_ENCRYPTION_KEY` (base64 of exactly 32 bytes — encrypts all in-app integration creds; **never change it once integrations are configured** or ciphertexts become undecryptable)
- Metals (direct): `METALS_API_KEY`, `METALS_API_URL`, `METALS_CACHE_TTL_SEC`
- Metals (shared proxy, preferred in prod): `METALS_PROXY_URL`, `METALS_PROXY_KEY` — when both set, `MetalsService` uses the proxy instead of metals.dev directly
- Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (blank `SMTP_HOST` → dev log-only transport)
- SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (blank SID → dev log-only)
- OCR (optional): `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (AWS Textract for ID/passport OCR; no-op when unset)
- Feature flags: `ENABLE_2FA`, `ENABLE_SIGNUP`
- Note: `PROVISIONING.md` references `JWT_SECRET`, `BACKUP_RETENTION_DAYS`, and `INVOICE_DELETE_PIN`, but the zod schema does **not** define these — treat the schema in `config/env.ts` as authoritative (likely doc drift).

**metals-proxy (central deploy env):** `METALS_API_KEY` (required), `TENANT_KEYS` (required, comma-sep Bearer tokens ≥16 chars), `METALS_API_URL`, `POLL_INTERVAL_MS`, `PORT` (default 4001).

**web (`apps/web/.env.local`):** `NEXT_PUBLIC_API_URL`; in prod also `NEXT_PUBLIC_BRAND_NAME`, optional `NEXT_PUBLIC_PRIVACY_URL`.

## Deploy

Per-tenant: API on **Railway** (or Render), web on **Vercel**. The metals-proxy is a single central deploy shared by all tenants.

- **Railway (recommended):** `railway.json` builds from `apps/api/Dockerfile` (repo as build context), health-check `/api/v1/health`, start `node dist/main.js`. **Pre-deploy command runs migrations:** `node dist/db/migrator.js up` — a failed migration aborts the deploy and keeps the old container (no half-migrated DB). Add Postgres + Redis plugins (auto-inject `DATABASE_URL` / `REDIS_URL`); set the rest of the env in the service Variables.
- **Render:** `render.yaml` blueprint provisions API (Docker) + Postgres 16 + Redis 7 together; `sync:false` vars are prompted on first deploy.
- **Vercel (web):** import repo, root `apps/web`; `vercel.json` sets build/install to run from the monorepo root. Set `NEXT_PUBLIC_API_URL` to the API host. After deploy, copy the Vercel URL back into the API's `WEB_ORIGIN` (CORS must match exactly).
- Full per-tenant walkthrough: `docs/PROVISIONING.md`. Operator day-to-day: `docs/OPERATOR_GUIDE.md`.

## Gotchas

- **`APP_ENCRYPTION_KEY` and JWT secrets are load-bearing and permanent.** Changing `APP_ENCRYPTION_KEY` after integrations are saved makes their ciphertext undecryptable. Changing JWT secrets after first login invalidates all sessions (login "loops" until users re-auth). Both must be set BEFORE the first user logs in.
- **Migrations run as a pre-deploy step** (`node dist/db/migrator.js up`). They are additive-only; renames/nullable changes go in dedicated migrations with safety notes in the header. There are 38 migrations (`001`–`038`); the README's "13 migrations" table is stale.
- **README.md is partly stale.** It still says "Atlanta Gold and Coin's internal system," lists only 13 migrations, and references `E:\agc-crm` paths and an older module list. The code (`app.module.ts`, `src/`, migrations) is the source of truth. `docs/PROVISIONING.md` + `docs/OPERATOR_GUIDE.md` describe the current de-tenanted product more accurately.
- **CORS:** public/WordPress-embedded endpoints need their origin in `PUBLIC_ORIGINS` or the browser preflight is rejected. `WEB_ORIGIN` must exactly match the deployed Vercel URL.
- **metals-proxy vs direct metals.dev:** if `METALS_PROXY_URL` + `METALS_PROXY_KEY` are both set, the proxy wins. A tenant's key must also be present in the proxy's `TENANT_KEYS` or spot prices show "—". Rotate keys via the zero-downtime pattern in `apps/metals-proxy/README.md`.
- **Backups live inside the database** (`backup_runs.dump_bytes`, pure-JS SQL dumper — no `pg_dump` binary in the image). This is NOT disaster recovery on its own; set up an off-site copy.
- **`ScheduleModule.forRoot()` must stay registered exactly once** (in `app.module.ts`). Re-registering in a feature module breaks `@Cron` wiring.
- **Module ordering in `app.module.ts` matters:** Email/Settings/Restock before Invoices/Inventory; Gmail after Rarcoa (provider-graph dependencies).
- **Feature flags** (`/admin/settings/features`, e.g. `ifs_enabled`, `frontend_pricing_enabled`, `scrap_enabled`, `eod_reports_enabled`) gate large slices of functionality — check them before assuming a feature is "broken."
- **Partially-wired integrations:** carrier tracking auto-refresh polling is not scheduled; carrier webhook verify/parse are stubs; DocuSign envelope creation is scaffolded but not wired to invoice finalize; EasyPost adapter is a placeholder.

## Key files (map)

- `apps/api/src/app.module.ts` — the canonical module list / wiring (auth, metals, pricing, products, invoices, inventory, clients, public, client-portal, settings, notifications, deal-requests, daily-updates, shipments, email, sms, price-quotes, messages, crypto, integrations, kpi, historical-invoices, backups, ocr, calendar, restock, rarcoa, gmail, aurbitrage, ifs, eod-reports, imports, health).
- `apps/api/src/main.ts` — bootstrap: global prefix `api`, URI versioning v1, CORS allowlist, helmet, cookie-parser, trust-proxy, guards order.
- `apps/api/src/config/env.ts` — **authoritative** env schema (zod), validated at boot.
- `apps/api/src/db/migrator.ts` — Kysely `FileMigrationProvider` runner (`up`/`down`).
- `apps/api/src/db/migrations/001..038_*.ts` — schema history (additive-only).
- `apps/api/src/db/seed.ts`, `seed-trading.ts`, `seed-team.ts` — local + tenant seeding.
- `apps/api/src/metals/` — spot feed + Redis cache + SSE; uses proxy when configured.
- `apps/api/src/pricing/` — pricing engine, rules, `quoteMany` batch.
- `apps/api/src/invoices/` — create + state machine + pdfkit PDF.
- `apps/api/src/inventory/` — on_hand/reserved counters, `SELECT FOR UPDATE` oversell guard, movement audit.
- `apps/api/src/integrations/` (+ `adapters/`) — encrypted credential store, carrier adapters (ups/fedex/usps/easypost), DocuSign, webhook controller.
- `apps/api/src/rarcoa/` — RARCOA wholesale goldsheet PDF parser.
- `apps/api/src/aurbitrage/` — multi-wholesaler price aggregator (full-reload sync into `aurbitrage_quotes`).
- `apps/api/src/ifs/` — IFS Clients FedEx-reseller shipping-label wizard (see `docs/IFS_API_REFERENCE.md`).
- `apps/api/src/gmail/`, `calendar/` — Google OAuth integrations (invoice email send, RARCOA ingest, bookings).
- `apps/api/src/backups/` — pure-JS SQL dumper, nightly cron, dumps stored in DB.
- `apps/api/src/health/health.controller.ts` — `GET /api/v1/health` (checks DB `select 1`).
- `apps/api/Dockerfile` — 3-stage build (build → prod-deps → runtime, tini pid1).
- `apps/web/src/` — `app/` (routes), `components/`, `lib/`.
- `apps/metals-proxy/src/index.ts` — the shared spot proxy.
- `packages/shared/src/` — shared zod schemas.
- Root: `docker-compose.yml` (local pg+redis), `railway.json`, `render.yaml`, `pnpm-workspace.yaml`, `.gitleaks.toml`, `.githooks/pre-commit`, `.github/workflows/{ci,secret-scan}.yml`.
- `scripts/provision-tenant.sh` — generates per-tenant secrets + Railway env block.
- `docs/` — `PROVISIONING.md`, `OPERATOR_GUIDE.md`, `IFS_API_REFERENCE.md`, `DECISIONS.md`, `RUNBOOK.md`, `SESSION_HANDOFF*.md`.
- `wordpress-plugin/agc-inventory/` — public-facing WP/Elementor inventory + buy-rate widgets.
