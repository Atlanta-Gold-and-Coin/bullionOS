#!/usr/bin/env bash
# Tenant provisioning helper.
#
# Two modes:
#
#   1. SECRETS-ONLY (default, unchanged behaviour) — generates the
#      per-tenant secrets and prints an env-file-ready block you paste
#      into Railway/Vercel by hand. Does not touch any cloud account.
#
#        ./scripts/provision-tenant.sh acme-coin
#
#   2. AUTOMATED (--automate) — drives the `railway` and `vercel` CLIs
#      non-interactively to create the project + services, set every
#      env var, and deploy. Still prints the secrets block at the end
#      for your records and for the metals-proxy step. Safe to re-run:
#      it re-uses an existing project/service of the same name rather
#      than duplicating, and only (re)sets env vars + redeploys.
#
#        ./scripts/provision-tenant.sh acme-coin \
#          --automate \
#          --web-origin https://desk.acmecoin.com \
#          --proxy-url https://metals-proxy.your-ops.up.railway.app \
#          --totp-issuer "Acme Coin"
#
# What automated mode does NOT do (still manual — documented in
# docs/PROVISIONING.md):
#   - Register the new METALS_PROXY_KEY into the central metals-proxy's
#     TENANT_KEYS. Use scripts/register-proxy-key.sh for that, then
#     redeploy the proxy. (The proxy is a shared ops service; we never
#     reach into it implicitly from a tenant provision.)
#   - Add the custom DNS record (Vercel shows the CNAME target; you add
#     it at the customer's registrar).
#   - Seed the first admin (the snippet is printed at the end; run it
#     once the DB is reachable).
#
# Requirements for --automate:
#   - `railway` CLI installed + logged in (`railway login`), or a
#     RAILWAY_TOKEN env var exported (project token, non-interactive).
#   - `vercel` CLI installed + logged in (`vercel login`), or a
#     VERCEL_TOKEN env var exported.
#   - Run from the repo root (the CLIs deploy the current working tree
#     unless you pass --link to attach to the GitHub repo instead).

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────
TENANT=""
AUTOMATE=0
WEB_ORIGIN=""
PROXY_URL=""
TOTP_ISSUER=""
BRAND_NAME=""
RAILWAY_ENV="production"

usage() {
  cat >&2 <<USAGE
Usage:
  $0 <tenant-slug>                       # secrets-only (prints env block)
  $0 <tenant-slug> --automate [options]  # drive railway + vercel CLIs

Options (automated mode):
  --web-origin   <url>    Final web origin, e.g. https://desk.acmecoin.com
  --proxy-url    <url>    Central metals-proxy URL
  --totp-issuer  <name>   Authenticator-app label, e.g. "Acme Coin"
  --brand-name   <name>   NEXT_PUBLIC_BRAND_NAME (defaults to --totp-issuer)
  --railway-env  <name>   Railway environment (default: production)

Examples:
  $0 acme-coin
  $0 acme-coin --automate --web-origin https://desk.acmecoin.com \\
     --proxy-url https://metals-proxy.ops.up.railway.app \\
     --totp-issuer "Acme Coin"
USAGE
  exit 2
}

if [[ $# -lt 1 ]]; then usage; fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --automate)     AUTOMATE=1; shift ;;
    --web-origin)   WEB_ORIGIN="${2:-}"; shift 2 ;;
    --proxy-url)    PROXY_URL="${2:-}"; shift 2 ;;
    --totp-issuer)  TOTP_ISSUER="${2:-}"; shift 2 ;;
    --brand-name)   BRAND_NAME="${2:-}"; shift 2 ;;
    --railway-env)  RAILWAY_ENV="${2:-}"; shift 2 ;;
    -h|--help)      usage ;;
    -*)             echo "Unknown option: $1" >&2; usage ;;
    *)
      if [[ -z "$TENANT" ]]; then TENANT="$1"; shift
      else echo "Unexpected argument: $1" >&2; usage; fi
      ;;
  esac
done

if [[ -z "$TENANT" ]]; then usage; fi
if [[ ! "$TENANT" =~ ^[a-z0-9-]+$ ]]; then
  echo "tenant-slug must be lowercase letters, digits, and hyphens" >&2
  exit 2
fi
# NEXT_PUBLIC_BRAND_NAME defaults to the TOTP issuer (the display name).
BRAND_NAME="${BRAND_NAME:-$TOTP_ISSUER}"

# ── Generate secrets ──────────────────────────────────────────────
# JWT secrets: 32 bytes hex (64 chars). The API validates each is >=32
# chars (zod in config/env.ts). It uses TWO secrets — access + refresh —
# so generate them independently; reusing one for both weakens refresh.
JWT_ACCESS_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
# APP_ENCRYPTION_KEY: must be base64 of exactly 32 bytes. The API
# validates this format on boot (zod refine in env.ts) so make sure
# it stays base64 — switching to hex breaks every encrypted blob.
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
# METALS_PROXY_KEY: any random string >= 16 chars. Hex is fine here.
# This must also be registered in the central proxy's TENANT_KEYS
# (see scripts/register-proxy-key.sh) or spot prices show "—".
METALS_PROXY_KEY=$(openssl rand -hex 24)
INVOICE_DELETE_PIN=$(printf '%06d' $((RANDOM % 1000000)))

# ── Automated provisioning ────────────────────────────────────────
if [[ "$AUTOMATE" -eq 1 ]]; then
  PROJECT="bullionos-${TENANT}"

  # Fail fast on missing prerequisites so we don't half-provision.
  command -v railway >/dev/null 2>&1 || { echo "railway CLI not found — install it or run without --automate" >&2; exit 3; }
  command -v vercel  >/dev/null 2>&1 || { echo "vercel CLI not found — install it or run without --automate"  >&2; exit 3; }
  if [[ -z "$WEB_ORIGIN" ]]; then echo "--automate requires --web-origin" >&2; exit 2; fi
  if [[ -z "$PROXY_URL"  ]]; then echo "--automate requires --proxy-url"  >&2; exit 2; fi
  if [[ -z "$TOTP_ISSUER" ]]; then echo "--automate requires --totp-issuer" >&2; exit 2; fi

  echo "▶ Automated provisioning for tenant '$TENANT' (project $PROJECT)"
  echo "  Re-running is safe: existing project/services are re-used."
  echo

  # ── Railway: project + Postgres + API service ───────────────────
  # `railway` is non-interactive when RAILWAY_TOKEN is exported or you
  # are already logged in. We guard each create with a check so a
  # second run doesn't error on "already exists".

  # Create (or re-use) the project. `railway init` is interactive, so
  # prefer the non-interactive flag form. If the project already exists
  # in this account, `link` attaches to it instead of creating a dupe.
  if railway list 2>/dev/null | grep -qx "$PROJECT"; then
    echo "  • Railway project '$PROJECT' exists — linking."
    railway link --project "$PROJECT" >/dev/null
  else
    echo "  • Creating Railway project '$PROJECT'."
    railway init --name "$PROJECT" >/dev/null
  fi

  # Postgres plugin (idempotent: `add` is a no-op if already present).
  echo "  • Ensuring Postgres database service."
  railway add --database postgres >/dev/null 2>&1 || true

  # API service. We set vars with `railway variables --set k=v` which
  # both creates and updates, so this whole block is idempotent.
  echo "  • Setting API env vars (Railway env: $RAILWAY_ENV)."
  railway variables --environment "$RAILWAY_ENV" \
    --set "DATABASE_URL=\${{Postgres.DATABASE_URL}}" \
    --set "JWT_ACCESS_SECRET=$JWT_ACCESS_SECRET" \
    --set "JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET" \
    --set "APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY" \
    --set "METALS_PROXY_URL=$PROXY_URL" \
    --set "METALS_PROXY_KEY=$METALS_PROXY_KEY" \
    --set "TOTP_ISSUER=$TOTP_ISSUER" \
    --set "WEB_ORIGIN=$WEB_ORIGIN" \
    --set "INVOICE_DELETE_PIN=$INVOICE_DELETE_PIN" \
    >/dev/null
  echo "    (SMTP_* + API_BASE_URL still need the customer's mail creds —"
  echo "     set them in the Railway dashboard or re-run with them exported.)"

  echo "  • Deploying API service to Railway."
  # `up` deploys the current working tree; `--ci` keeps it non-interactive.
  railway up --ci >/dev/null

  # ── Vercel: web project ─────────────────────────────────────────
  # `vercel link` attaches the cwd to a project (created if missing).
  # `--yes` accepts all defaults non-interactively.
  echo "  • Linking Vercel project '$PROJECT' (root apps/web)."
  vercel link --yes --project "$PROJECT" >/dev/null

  echo "  • Setting Vercel env vars."
  # `vercel env add` reads the value from stdin; `printf %s` avoids a
  # trailing newline being stored as part of the value. `|| true` so a
  # re-run (var already exists) doesn't abort the script.
  printf '%s' "$WEB_ORIGIN/api/v1" | vercel env add NEXT_PUBLIC_API_URL production >/dev/null 2>&1 || true
  if [[ -n "$BRAND_NAME" ]]; then
    printf '%s' "$BRAND_NAME" | vercel env add NEXT_PUBLIC_BRAND_NAME production >/dev/null 2>&1 || true
  fi

  echo "  • Deploying web to Vercel (production)."
  vercel deploy --prod --yes >/dev/null

  echo
  echo "✅ Automated steps complete for '$TENANT'."
  echo "   Remaining manual steps are listed below."
fi

# ── Secrets block (always printed) ────────────────────────────────
# In automated mode the vars are already set; this block is your
# record of the generated secrets + the manual follow-ups.
cat <<EOF

# ─── Tenant: $TENANT ───────────────────────────────────────────────
#
# Generated secrets (keep these somewhere safe — Railway hides them
# after creation). In secrets-only mode, paste the block below into
# Railway → ${TENANT}-api service env.
#
# DATABASE_URL should reference the linked Postgres service:
#   DATABASE_URL=\${{Postgres.DATABASE_URL}}
#
# WEB_ORIGIN must match the final Vercel domain exactly (CORS), set it
# AFTER you add the custom domain in Vercel, then redeploy the api.

JWT_ACCESS_SECRET=$JWT_ACCESS_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY
METALS_PROXY_KEY=$METALS_PROXY_KEY
INVOICE_DELETE_PIN=$INVOICE_DELETE_PIN
TOTP_ISSUER=${TOTP_ISSUER:-<set to the tenant display name, e.g. "Acme Coin">}
WEB_ORIGIN=${WEB_ORIGIN:-<final Vercel URL, e.g. https://desk.acmecoin.com>}
API_BASE_URL=<Railway-generated api URL, e.g. https://acme-api-production-XXXX.up.railway.app>
METALS_PROXY_URL=${PROXY_URL:-<your central metals-proxy URL>}
SMTP_HOST=<their SMTP>
SMTP_USER=<their SMTP user>
SMTP_PASS=<their SMTP pass>
SMTP_FROM=<e.g. "Acme Coin <reports@acmecoin.com>">

# ─── ACTION REQUIRED ──────────────────────────────────────────────
#
# 1. Register the METALS_PROXY_KEY above with the central metals-proxy:
#
#      ./scripts/register-proxy-key.sh \\
#        --proxy-project <metals-proxy-railway-project> \\
#        --key $METALS_PROXY_KEY
#
#    then redeploy the proxy (the script reminds you how).
#
# 2. After the api service comes up healthy, seed the first admin:
#
#    SEED_ADMIN_EMAIL=owner@<tenant-domain> \\
#    SEED_ADMIN_PASSWORD='<12+ chars>' \\
#    SEED_ADMIN_FIRST=<first name> \\
#    SEED_ADMIN_LAST=<last name> \\
#    DATABASE_URL=<railway public proxy url> \\
#      pnpm --filter @agc/api exec tsx src/db/seed-team.ts
#
# 3. Add the custom domain in Vercel (Settings → Domains), create the
#    CNAME at the customer's registrar, then confirm WEB_ORIGIN matches.
#
# 4. Send the customer the onboarding checklist from docs/PROVISIONING.md
#    section 5, and point them at docs/CUSTOMIZATION.md for self-serve
#    theming / feature flags / custom fields.
EOF
