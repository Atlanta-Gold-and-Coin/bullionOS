# Provisioning a new tenant

How to spin up a new BullionOS Desk customer. Plan on 30–45 minutes the first time, ~15 minutes once you've done it once — or a couple of minutes with the automated path below.

This guide assumes:
- You already have the central `metals-proxy` deployed and running.
- You have admin access to Railway, Vercel, and your DNS provider.
- You have the `railway` and `vercel` CLIs installed and logged in.

## 0. Automated path (recommended)

`scripts/provision-tenant.sh` can drive the `railway` and `vercel` CLIs non-interactively so you don't click through both dashboards. It generates the per-tenant secrets, creates the Railway project + Postgres + API service, links a Vercel web project, sets every env var, and deploys both.

```bash
# from the repo root, with `railway` and `vercel` logged in
# (or RAILWAY_TOKEN / VERCEL_TOKEN exported for fully headless CI)
./scripts/provision-tenant.sh acme-coin \
  --automate \
  --web-origin https://desk.acmecoin.com \
  --proxy-url https://metals-proxy.your-ops.up.railway.app \
  --totp-issuer "Acme Coin"
```

The script is **safe to re-run**: it re-uses an existing project/service of the same name (`bullionos-<slug>`) instead of duplicating, and only (re)sets env vars and redeploys. It generates fresh `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `APP_ENCRYPTION_KEY`, `METALS_PROXY_KEY`, and `INVOICE_DELETE_PIN` and **never hardcodes any secret** — re-running rotates the generated secrets, so capture the printed block on the first successful run.

> **Heads-up on re-running:** because each run regenerates secrets, only re-run on a tenant that is already live if you actually intend to rotate keys (and remember `APP_ENCRYPTION_KEY` and the JWT secrets are load-bearing — see the Gotchas in `CLAUDE.md`). For a plain redeploy, push to the repo / run `railway up` directly instead.

Three steps are deliberately left manual and are printed in the script's `ACTION REQUIRED` block:

1. **Register the new `METALS_PROXY_KEY` with the central proxy.** The proxy is a shared ops service, so we never reach into it implicitly. Use the dedicated helper:

   ```bash
   ./scripts/register-proxy-key.sh \
     --proxy-project bullionos-metals-proxy \
     --key <the-printed-METALS_PROXY_KEY>
   ```

   It **appends** the key to the proxy's `TENANT_KEYS` (never drops existing keys — zero-downtime, matching `apps/metals-proxy/README.md`) and redeploys the proxy so it loads the new key. If you'd rather edit `TENANT_KEYS` by hand, run it with `--print-only --current "<existing,csv>"` to just compute the new value. **The proxy must redeploy** for a new key to take effect (it reads `TENANT_KEYS` at boot).

2. **Seed the first admin** (snippet below in section 4).
3. **Add the custom domain + DNS** in Vercel and confirm `WEB_ORIGIN` matches (section 3).

You can also run `provision-tenant.sh` **without** `--automate` to just print the secrets + env block and do the dashboard steps manually — that's the original behaviour, documented in detail in sections 1–6 below.

## 1. Create the Railway project (Postgres + API)

1. In the Railway dashboard, **New Project → Empty Project**. Name it after the tenant: `bullionos-acme-coin`.
2. Inside the project, **+ New → Database → Postgres**. Name the service `db`.
3. **+ New → GitHub Repo** → select the `bullionOS` repo, point it at `apps/api`. Name the service `api`.
4. On the `api` service, set environment variables (copy from the `db` service where noted):

   | Var | Value | Source |
   | --- | --- | --- |
   | `DATABASE_URL` | (reference) | from `db` service: `${{db.DATABASE_URL}}` |
   | `WEB_ORIGIN` | `https://acme.bullionos-desk.com` | their final web origin |
   | `JWT_ACCESS_SECRET` | random 32+ chars | `openssl rand -hex 32` |
   | `JWT_REFRESH_SECRET` | random 32+ chars | `openssl rand -hex 32` (generate independently from the access secret) |
   | `APP_ENCRYPTION_KEY` | base64 of exactly 32 bytes | `openssl rand -base64 32` |
   | `METALS_PROXY_URL` | `https://metals-proxy.your-ops.up.railway.app` | your central proxy |
   | `METALS_PROXY_KEY` | new tenant Bearer | `openssl rand -hex 24`, then register with `scripts/register-proxy-key.sh` (adds it to the proxy's `TENANT_KEYS`) |
   | `TOTP_ISSUER` | `Acme Coin` | shows in their authenticator app |
   | `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | their SMTP creds | per-tenant |
   | `BACKUP_RETENTION_DAYS` | `30` | optional, default fine |
   | `INVOICE_DELETE_PIN` | random 6-digit | tenant chooses |

5. Set the **Pre-deploy command**: `node dist/db/migrator.js up`. This runs migrations on every deploy.
6. Set the **Start command**: `node dist/main.js`.
7. **Generate Domain** on the `api` service (e.g. `acme-api.up.railway.app`).

## 2. Create the Vercel project (web)

1. **Add New Project** → import the `bullionOS` repo.
2. **Root Directory**: `apps/web`.
3. **Framework Preset**: Next.js (auto-detected).
4. Set environment variables:

   | Var | Value |
   | --- | --- |
   | `NEXT_PUBLIC_API_URL` | the Railway api service domain from step 1.7 |
   | `NEXT_PUBLIC_BRAND_NAME` | `Acme Coin` |
   | `NEXT_PUBLIC_PRIVACY_URL` | their privacy policy URL (optional) |

5. Add Vercel rewrites if not already configured — `apps/web/vercel.json` should already proxy `/api/v1/*` to `${NEXT_PUBLIC_API_URL}/api/v1/*`.
6. Hit **Deploy**.

## 3. Wire DNS

1. In Vercel, **Settings → Domains → Add** the customer's chosen subdomain (e.g. `desk.acmecoin.com`).
2. Vercel shows the CNAME target. Add that record in the customer's DNS.
3. Update the Railway `WEB_ORIGIN` env to match the final subdomain.

## 4. Seed the first admin

Once Railway shows the API service healthy, exec into it (or run locally with `DATABASE_URL` pointed at the new DB):

```bash
SEED_ADMIN_EMAIL=owner@acmecoin.com \
SEED_ADMIN_PASSWORD='ChangeMe!2026Now' \
SEED_ADMIN_FIRST=Jane \
SEED_ADMIN_LAST=Doe \
DATABASE_URL=<railway-public-url> \
  pnpm --filter @agc/api exec tsx src/db/seed-team.ts
```

The customer signs in once with that password, changes it under `/dashboard/security`, enables 2FA, and you're done.

## 5. Customer onboarding

Send them this checklist:

1. **Sign in** at the URL you provisioned, change the temp password.
2. **Enable 2FA** at `/dashboard/security`.
3. **Configure branding** at `/admin/settings` — company name, address, phone, website, logo, favicon. White-label tenants can also set accent/sidebar colors + font and turn off the "Powered by BullionOS" lockup here (see `docs/CUSTOMIZATION.md`).
4. **Toggle features** at `/admin/settings/features` — turn off anything they don't need (IFS, scrap, client tracking, etc.).
5. **Connect integrations** at `/admin/integrations` — Gmail, Google Calendar, GReminders, etc., as needed.
6. **Import historical data** at `/admin/imports` if they have CSVs — products, clients, past invoices.
7. **Add team members** at `/admin/users`.
8. **Test the price sheet** — adjust premium% / fixed prices on a few products; verify spot ticker updates.

## 6. Bookkeeping

- Keep a record of which `METALS_PROXY_KEY` belongs to which tenant.
- Keep a record of each tenant's Railway + Vercel project URLs.
- Schedule the central metals-proxy + each tenant's DB for separate backup retention.

## Cost estimate per tenant

- Railway API + Postgres (small): ~$15–25/mo
- Vercel Pro (shared across tenants): ~$20/mo total
- metals.dev: amortized via the central proxy
- Email (per-tenant SMTP): varies — Gmail Workspace seat or SES

Total infra: ~$30–50/mo per tenant. Plenty of room above this if you charge $300+/mo per seat or $500+ /mo flat.

## When something goes sideways

- **Migrations fail on deploy**: pre-deploy command shows the error. Likely a missing env var. Fix and redeploy.
- **Login works but pages 500**: usually missing `JWT_SECRET` or `APP_ENCRYPTION_KEY`. Both must be set BEFORE the first user logs in (token validation fails otherwise).
- **Spot prices show "—"**: check `METALS_PROXY_URL` + `METALS_PROXY_KEY`. Verify the tenant's key is in the proxy's `TENANT_KEYS`. `curl https://your-proxy/health` to confirm the proxy itself is up.
- **Logo / favicon not appearing**: those are stored as `bytea` in `branding_assets` — re-upload via `/admin/settings`. Browser cache is the most common culprit; hard-refresh.
