#!/usr/bin/env bash
# Register a tenant's METALS_PROXY_KEY into the central metals-proxy's
# TENANT_KEYS env (the comma-separated allow-list of Bearer tokens).
#
# The metals-proxy is a single SHARED ops service that fronts metals.dev
# for every tenant (see apps/metals-proxy/README.md). Adding a tenant
# means appending its Bearer key here. This follows the zero-downtime
# pattern from that README: we only ever APPEND — never drop — keys, so
# existing tenants keep working while the new one comes online.
#
# Usage (drive Railway, where the proxy is hosted):
#   ./scripts/register-proxy-key.sh \
#     --proxy-project bullionos-metals-proxy \
#     --key <the-tenant's-METALS_PROXY_KEY>
#
# Or, if you prefer to edit TENANT_KEYS by hand, run with --print-only
# to just compute the new comma-separated value and instructions:
#   ./scripts/register-proxy-key.sh --current "$EXISTING" --key <key> --print-only
#
# Requirements:
#   - `railway` CLI installed + logged in, or RAILWAY_TOKEN exported
#     (unless you use --print-only with --current).
#
# Safe to re-run: if the key is already present, it's a no-op.

set -euo pipefail

PROXY_PROJECT=""
KEY=""
RAILWAY_ENV="production"
PROXY_SERVICE="metals-proxy"   # the service name inside the proxy project
CURRENT_OVERRIDE=""
PRINT_ONLY=0

usage() {
  cat >&2 <<USAGE
Usage:
  $0 --proxy-project <name> --key <bearer> [--railway-env <env>] [--service <name>]
  $0 --key <bearer> --current "<existing,csv>" --print-only

Options:
  --proxy-project <name>   Railway project hosting the metals-proxy.
  --service       <name>   Service name inside that project (default: metals-proxy).
  --railway-env   <env>    Railway environment (default: production).
  --key           <bearer> The tenant's METALS_PROXY_KEY to add.
  --current       <csv>    Existing TENANT_KEYS value (only with --print-only).
  --print-only             Don't touch Railway; just print the new value + steps.
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy-project) PROXY_PROJECT="${2:-}"; shift 2 ;;
    --service)       PROXY_SERVICE="${2:-}"; shift 2 ;;
    --railway-env)   RAILWAY_ENV="${2:-}"; shift 2 ;;
    --key)           KEY="${2:-}"; shift 2 ;;
    --current)       CURRENT_OVERRIDE="${2:-}"; shift 2 ;;
    --print-only)    PRINT_ONLY=1; shift ;;
    -h|--help)       usage ;;
    *)               echo "Unknown option: $1" >&2; usage ;;
  esac
done

if [[ -z "$KEY" ]]; then echo "--key is required" >&2; usage; fi
# A proxy Bearer must be >=16 chars (the proxy rejects shorter ones).
if [[ ${#KEY} -lt 16 ]]; then
  echo "key looks too short (${#KEY} chars) — proxy requires >=16" >&2
  exit 2
fi

# ── Determine the current TENANT_KEYS value ───────────────────────
if [[ -n "$CURRENT_OVERRIDE" ]]; then
  CURRENT="$CURRENT_OVERRIDE"
elif [[ "$PRINT_ONLY" -eq 1 ]]; then
  CURRENT=""   # nothing supplied + print-only => treat as empty
else
  command -v railway >/dev/null 2>&1 || { echo "railway CLI not found — use --print-only with --current, or install railway" >&2; exit 3; }
  if [[ -z "$PROXY_PROJECT" ]]; then echo "--proxy-project is required (or use --print-only)" >&2; exit 2; fi
  railway link --project "$PROXY_PROJECT" --service "$PROXY_SERVICE" >/dev/null 2>&1 || \
    railway link --project "$PROXY_PROJECT" >/dev/null
  # Read the current value. `railway variables` with a kv format lets us
  # grep the single var without printing the whole env to the terminal.
  CURRENT="$(railway variables --environment "$RAILWAY_ENV" --kv 2>/dev/null \
    | sed -n 's/^TENANT_KEYS=//p' || true)"
fi

# ── Compute the new value (append-only, dedup) ────────────────────
# Split on commas, trim whitespace, drop empties, skip if KEY already
# present, then re-join.
NEW="$CURRENT"
already=0
IFS=',' read -ra existing <<<"$CURRENT"
for k in "${existing[@]}"; do
  k="$(echo "$k" | tr -d '[:space:]')"
  [[ -z "$k" ]] && continue
  if [[ "$k" == "$KEY" ]]; then already=1; fi
done

if [[ "$already" -eq 1 ]]; then
  echo "ℹ Key already present in TENANT_KEYS — nothing to do."
  exit 0
fi

if [[ -z "$NEW" ]]; then
  NEW="$KEY"
else
  NEW="${NEW},${KEY}"
fi

# Mask the key in any human-facing output so it doesn't hit scrollback.
masked="${KEY:0:4}…${KEY: -4}"

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  cat <<EOF
# New TENANT_KEYS value for the metals-proxy (append-only):
TENANT_KEYS=$NEW

# Set this on the proxy service and redeploy:
#   railway variables --set "TENANT_KEYS=<above>" && railway up --ci
EOF
  exit 0
fi

echo "• Appending tenant key ($masked) to $PROXY_PROJECT/$PROXY_SERVICE TENANT_KEYS."
railway variables --environment "$RAILWAY_ENV" --set "TENANT_KEYS=$NEW" >/dev/null

echo "• Redeploying the metals-proxy so the new key takes effect."
# The proxy reads TENANT_KEYS at boot, so it must redeploy to pick up
# the change. `up --ci` deploys the current working tree non-interactively;
# if you deploy the proxy from its own repo, run that pipeline instead.
railway up --ci >/dev/null || {
  echo "  ⚠ redeploy via 'railway up' failed — trigger a redeploy from the" >&2
  echo "    Railway dashboard or your proxy's deploy pipeline so the new" >&2
  echo "    TENANT_KEYS value is loaded." >&2
}

echo "✅ Registered. Verify with: curl https://<proxy>/health  (tenantKeys count should be +1)"
