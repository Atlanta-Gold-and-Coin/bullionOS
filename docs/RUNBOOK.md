# bullionOS Runbook

Operational reference for running, deploying, and recovering a bullionOS tenant. Items marked **TODO: confirm** are inferred from config/docs and not verified against a live environment.

## Where it runs

- **API** — Railway (recommended) or Render, one deploy **per tenant**. Builds from `apps/api/Dockerfile`. Health check: `GET /api/v1/health`. Start: `node dist/main.js`. Listens on `PORT` (4000 default).
- **Web** — Vercel, one project **per tenant**, root dir `apps/web` (Next.js 15). Proxies `/api/*` to the API host via `apps/web/vercel.json`.
- **metals-proxy** — Railway, **one central deploy** in the ops account, shared by all tenants. Health check: `GET /health`. Listens on `PORT` (4001 default).
- **Data stores (per tenant)** — PostgreSQL 16 + Redis 7 (Railway plugins or Render managed). DB name `agc_crm`, user `agc`.
- **WordPress plugin** — `wordpress-plugin/agc-inventory` runs on the operator's WP site (atlantagoldandcoin.com) and calls the API's public endpoints.

### Live URLs

- **TODO: confirm** production API URL per tenant (Railway-generated domain, e.g. `https://<tenant>-api.up.railway.app`).
- **TODO: confirm** production web URL per tenant (Vercel domain / customer subdomain, e.g. `https://desk.<customer>.com`).
- **TODO: confirm** central metals-proxy URL (e.g. `https://metals-proxy.<ops>.up.railway.app`).
- Local: API `http://localhost:4000` (routes `/api/v1`), web `http://localhost:3001`, Postgres `5432`, Redis `6379`, metals-proxy `4001`.

## Deploy

Full first-time tenant provisioning (~30–45 min): see `docs/PROVISIONING.md`. Condensed:

1. Push to GitHub `main`.
2. **Railway** → new project → add Postgres + Redis plugins (auto-inject `DATABASE_URL`, `REDIS_URL`) → add the repo as a service pointed at `apps/api`.
3. Set API env vars (see `apps/api/src/config/env.ts` for the full validated list): `NODE_ENV`, `PORT`, `API_BASE_URL`, `WEB_ORIGIN`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `APP_ENCRYPTION_KEY`, plus metals (`METALS_PROXY_URL` + `METALS_PROXY_KEY`, or `METALS_API_KEY`), and optional SMTP/Twilio/AWS.
4. Pre-deploy command: `node dist/db/migrator.js up` (runs migrations; a failure aborts the deploy and keeps the old container). Start command: `node dist/main.js`.
5. Generate the API domain, set it into `API_BASE_URL`.
6. **Vercel** → import repo, root `apps/web`, set `NEXT_PUBLIC_API_URL` (+ `NEXT_PUBLIC_BRAND_NAME`). Deploy.
7. Copy the final Vercel URL back into the API's `WEB_ORIGIN` (CORS must match exactly). Add any public/WordPress origins to `PUBLIC_ORIGINS`.
8. Seed the first admin (see `docs/PROVISIONING.md` § 4, `seed-team.ts`). Customer changes the temp password and enables 2FA on first login.

**Render alternative:** `render.yaml` blueprint provisions API + Postgres 16 + Redis 7 in one shot; fill the `sync:false` prompts. **TODO: confirm** which host is actually in production per tenant.

## Database backup & restore

### Backup

- **Automated:** nightly cron via `BackupsService` (pure-JS SQL dumper). Dumps are stored **inside the DB** in `backup_runs.dump_bytes`. **TODO: confirm** exact schedule — README/operator docs disagree (one says 8 PM local, one says nightly).
- **Manual:** `/admin/backups` → **Run backup now**; download any run as a SQL dump via **Download**.
- **Critical:** in-DB backups are NOT disaster recovery. Set up an off-site copy (e.g. Backblaze B2 + cron pulling the dumps). **TODO: confirm** an off-site job exists for each tenant.
- Platform-level: Railway/Render managed Postgres also has its own snapshot/backup feature — **TODO: confirm** it is enabled per tenant.

### Restore

- **TODO: confirm** restore procedure. Expected path: obtain the SQL dump (downloaded from `/admin/backups`, off-site copy, or platform snapshot), then `psql "$DATABASE_URL" < dump.sql` against a fresh/empty database, then redeploy the API (pre-deploy migrations bring schema to latest).
- For a point-in-time restore, prefer the managed-Postgres snapshot/PITR feature over the in-DB dump where available.

## Rotate secrets

Reference variable names; never commit values. All API secrets live in the Railway/Render dashboard (and `apps/api/.env` locally).

- **`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`** — rotating invalidates all existing sessions; users must log in again. Set new value in the dashboard and redeploy. Safe anytime, but expect a forced re-login wave.
- **`APP_ENCRYPTION_KEY`** — **DO NOT rotate** once any integration credential is saved; existing AES-256-GCM ciphertext becomes undecryptable. Rotation requires re-entering every integration's creds at `/admin/integrations` after the change. **TODO: confirm** whether a re-encryption migration path exists (none seen in code).
- **`METALS_PROXY_KEY` (tenant) / `TENANT_KEYS` (proxy)** — zero-downtime rotation: add new key to the proxy's `TENANT_KEYS` (keep the old), redeploy proxy; update the tenant's `METALS_PROXY_KEY`, redeploy tenant; remove the old key from `TENANT_KEYS`, redeploy proxy. Full steps in `apps/metals-proxy/README.md`.
- **`METALS_API_KEY` (master, on proxy)** — set new key on the central proxy and redeploy; tenants are unaffected (they hold Bearer keys, not the master key).
- **Integration provider creds** (UPS/FedEx/USPS/DocuSign/Gmail/Calendar/GReminders/Aurbitrage/IFS) — rotate in the provider's console, then update + **Test connection** at `/admin/integrations`. No redeploy needed.
- **`SMTP_*` / `TWILIO_*` / `AWS_*`** — update in the dashboard, redeploy.
- After any rotation, run a health check (below) and confirm login + spot prices still work.

## Health checks

- **API:** `GET /api/v1/health` → `{ status, db, time }`; `status: "ok"` with `db: "ok"` (runs `select 1`). Used by Railway/Render health checks.
- **metals-proxy:** `GET /health` → `{ ok, cached, cachedAt, consecutiveFailures, tenantKeys }`. `cached: true` and low `consecutiveFailures` means upstream is healthy.
- **Spot feed end-to-end:** `GET /api/v1/metals/spot` on the tenant API surfaces the live/cached spot or the upstream error.
- **CI gate:** `.github/workflows/ci.yml` (lint + typecheck + migrations + build) and `secret-scan.yml` (gitleaks) must be green on `main`.

## Common failures & fixes

- **Spot prices show "—"** — check `/admin/integrations` metals provider; verify `METALS_PROXY_URL` + `METALS_PROXY_KEY` on the API and that the tenant's key is in the proxy's `TENANT_KEYS`. `curl <proxy>/health` to confirm the proxy is up and `cached: true`.
- **Login loops back to the login page** — `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` (or `APP_ENCRYPTION_KEY`) changed after first login; existing tokens are invalid. Loop should stop after a fresh login. Ensure these were set BEFORE the first user signed in.
- **Pages 500 right after deploy / login works but app errors** — usually a missing/changed `JWT_*` or `APP_ENCRYPTION_KEY`. Confirm all required env vars are present (the API fails boot-time zod validation if a required one is missing/malformed — check deploy logs for "Invalid environment variables").
- **Migrations fail on deploy** — the pre-deploy command logs the failing migration; deploy aborts and the old container stays up. Usually a missing env var or a bad migration. Fix and redeploy.
- **CORS / WordPress widget blocked** — add the WP/marketing origin to `PUBLIC_ORIGINS` and confirm `WEB_ORIGIN` exactly matches the deployed Vercel URL. Confirm `frontend_pricing_enabled` is on for public buy-rate widgets.
- **EOD email didn't arrive** — verify `eod_reports_enabled` is on, at least one admin/staff has `email_notifications=true`, and SMTP works (`/admin/integrations` test). **TODO: confirm** EOD send time (docs say ~5 PM ET).
- **Invoice PDF blank/broken** — usually a missing branding logo; confirm `/admin/settings` shows the logo (stored as `bytea`, survives redeploys), then re-render.
- **Logo/favicon not appearing** — stored in `branding_assets` as `bytea`; most often browser cache — hard-refresh; otherwise re-upload at `/admin/settings`.
- **Calendar/GReminders not auto-creating clients** — `staff.email_domains` must include your staff domain so staff attendees aren't treated as customers.
- **Reset a user's 2FA** — `pnpm --filter @agc/api exec tsx src/db/disable-2fa.ts <email>` from the API host, or `/admin/users/<id>` → Disable 2FA.
- **Backups missing** — confirm the nightly cron is running (`ScheduleModule` registered once in `app.module.ts`) and that an off-site copy job exists.
