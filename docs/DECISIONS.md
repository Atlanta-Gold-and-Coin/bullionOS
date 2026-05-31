# Decision Log

Append-only record of architectural and operational decisions for bullionOS.

**Format:** each entry is `## YYYY-MM-DD — <decision>` followed by a short *why*. **Newest at the top.** Never edit or delete past entries; if a decision is reversed, add a new entry that supersedes it and say so.

Entries dated 2026-05-31 below are **(reconstructed from code)** — inferred from the repository's current state, config, and comments rather than recorded at the time the decision was made.

---

## 2026-05-31 — Money is decimal-only end-to-end: `decimal.js` in code, `NUMERIC(20,8)` in Postgres (reconstructed from code)

No JS `number` ever touches a price, premium, weight, or total. Every monetary/weight column is `NUMERIC(20,8)`; arithmetic goes through `decimal.js` and `common/money` helpers. Floating-point rounding is unacceptable in a trading/invoicing system where a fraction of a troy ounce of gold is real money, and bugs here are silent and compounding. (Evidence: `apps/api/src/common/money.ts`, pricing/invoice/inventory modules, README security posture.)

## 2026-05-31 — Invoice line items snapshot every pricing input so invoices are reproducible after product deletion (reconstructed from code)

Each invoice line captures name, gross weight, purity, metal content, spot, premium type/value, unit price, and line total at finalize time, and products use `SET NULL` on delete (migrations `009`, `010`). An invoice must reprint byte-identically years later even if the underlying product was edited or hard-deleted — required for tax/audit defensibility and customer trust. Pricing history can never be retroactively altered by catalog edits.

## 2026-05-31 — Inventory reservation guarded by `SELECT ... FOR UPDATE` to make oversell impossible (reconstructed from code)

Sell-side finalize reserves stock, ship consumes it, cancel releases it; buy-side paid adds stock. The status-change transaction takes a row lock on the inventory row so concurrent finalize attempts serialize (migration `011`, `024` oversell override; covered by an integration test). Coins are physical, unique-ish, single-quantity goods; double-selling the same item is a real-world loss and a customer-facing failure, so correctness beats throughput here.

## 2026-05-31 — Third-party integration credentials are encrypted in-DB (AES-256-GCM), configured in-app, never in env (reconstructed from code)

Carrier/DocuSign/Gmail/IFS/Aurbitrage creds live AES-256-GCM-encrypted in the `integrations` table (migration `008`), set at `/admin/integrations`, redacted in API responses. The only related secret in env is the master `APP_ENCRYPTION_KEY`. This keeps a single per-tenant deploy from sprawling into dozens of env secrets, lets operators rotate provider creds without a redeploy, and keeps secrets off the platform's env surface. Trade-off: `APP_ENCRYPTION_KEY` becomes permanent — rotating it orphans all ciphertext.

## 2026-05-31 — A single central metals-proxy fronts metals.dev for all tenants (reconstructed from code)

`apps/metals-proxy` is one shared Express service caching metals.dev and serving tenants via per-tenant Bearer keys; tenant APIs use it when `METALS_PROXY_URL` + `METALS_PROXY_KEY` are set, else fall back to direct metals.dev. With many tenants polling directly, metals.dev quota multiplies N× and the master key is exposed in every tenant's env. The proxy collapses it to one upstream call per minute, hides the master key, and allows central key rotation/revocation. (Evidence: `apps/metals-proxy/src/index.ts`, `config/env.ts` proxy vars.)

## 2026-05-31 — Migrations run as a deploy pre-step that aborts the deploy on failure (reconstructed from code)

`railway.json` sets `preDeployCommand: node dist/db/migrator.js up`, run inside the new image before it swaps in; a failed migration aborts the deploy and keeps the old container. The comment cites a prior incident where `032_supplier_prices` shipped unapplied during a RARCOA release. This guarantees code and schema move together and removes the class of "deployed but DB not migrated" bugs without risking a half-migrated database.

## 2026-05-31 — Single per-tenant deploy with in-app feature flags rather than separate builds (reconstructed from code)

All tenants build from the same `main`; capability differences are runtime toggles at `/admin/settings/features` (`ifs_enabled`, `frontend_pricing_enabled`, `scrap_enabled`, `eod_reports_enabled`, `compliance_photos_enabled`, etc.). A solo maintainer can't sustain per-customer forks; flags keep one codebase shippable to every tenant while letting each turn off what they don't use. (Evidence: `docs/OPERATOR_GUIDE.md` features table, `docs/PROVISIONING.md`.)

## 2026-05-31 — Backups are a pure-JS in-DB SQL dumper, not `pg_dump` (reconstructed from code)

`BackupsService` writes SQL dumps into `backup_runs.dump_bytes` on a nightly cron; the Dockerfile comment notes `postgresql-client` was removed because version mismatches with the managed Postgres caused recurring fire drills. A pure-JS dumper has no external-binary version coupling. Documented trade-off: in-DB backups are not disaster recovery — operators must add an off-site copy (`docs/OPERATOR_GUIDE.md` § Backups).

## 2026-05-31 — Secret leakage defended in CI (gitleaks) with a local pre-commit hook as nice-to-have (reconstructed from code)

`.github/workflows/secret-scan.yml` runs gitleaks (config `.gitleaks.toml`) on every push/PR and must pass to merge; `.githooks/pre-commit` greps staged diffs for credential shapes locally. The workflow comment references an April 2026 rotation incident after which history was vetted. CI is the canonical gate because local hooks can be bypassed; the hook just shortens the feedback loop.
