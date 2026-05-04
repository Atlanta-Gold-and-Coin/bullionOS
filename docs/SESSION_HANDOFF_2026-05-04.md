# Session Handoff — 2026-05-04

Picks up where the IFS Phase 2 / BullionOS-rebrand session left off. Read
this end-to-end if you're continuing work; the operational details
matter.

## TL;DR

- All commits pushed to `origin/main`. Railway auto-deploys the API
  (`agc-api`); Vercel auto-deploys the web frontend.
- The last commit on main is `1d052e3` (category-selector pill colors).
- Latest visible work: BullionOS dark-theme rebrand of the admin shell
  (sidebar / header / footer / login + interior dark surfaces), IFS
  Phase 2 wizard, scrap calculator + buy/sell invoice flow, compliance
  photo attachments, owner-private client/invoice visibility for
  Hunter + Tim, client tracking dashboard tile + page driven by
  Google Calendar (N)/(R) tags.
- Outstanding: DocuSign sandbox creds (Hunter to gather), Backblaze
  off-site backup setup (Hunter to sign up).

## What shipped this session

### IFS Clients (FedEx reseller) — Phase 2

Full create-label wizard at `/admin/shipments/new-label`:

- 16 wizard service methods on `IfsService` (one per IFS endpoint:
  `#2 basic_data`, `#3-#5 senders/recipients`, `#8 ZIP/service compat`,
  `#9/#11 FedEx address verify`, `#13 zone`, `#14 packaging
  restriction`, `#16 weight check`, `#17 insurance popup tree`,
  `#19 hold-at-location`, `#20 cost preview`, `#26 create label`,
  `#28 details refresh`, `#31 void`).
- Six wizard steps: Sender → Recipient → Service → Package/Insurance
  → Cost preview → Submit.
- Sender auto-picks "Your ATL Taxidermy" by company-name match against
  `#3` saved senders. Falls back to IFS `primary_id`, then first row.
  **The configured saved sender is `11555 MEDLOCK BRIDGE RD #100,
  DULUTH GA 30097`** (not the Alpharetta address Hunter originally
  mentioned — the wizard will hydrate the Duluth address per his "fine
  for now" call).
- Recipient pre-fills from invoice when launched with
  `?invoice_id=<uuid>` (link button on `/admin/invoices/[id]`).
- Address verification (`#9`) with diff dialog, `#11` accept-corrected,
  `#17` insurance popup chain (multi-piece >$75k forwards operator to
  ifsclients.com — no auto-split implemented).
- On `#26` success: persists to `ifs_shipments`, AND when invoice_id
  was passed also writes a row to `shipments` table via
  `ShipmentsService.create({carrier:'fedex', ...})` so it surfaces in
  every existing FedEx/UPS/USPS shipment list. Notification fires
  through the existing path.
- Validation gate added: recipient email is REQUIRED before submit
  (IFS rejects `#26` with "Please Enter Valid Recipient Email Address"
  if blank, despite the docs claiming it's only required when
  `hold_for_pu=1`).

**Scheduled status refresh** — IFS-side polling because operators
don't have direct FedEx API creds:

- `IfsService.runStatusRefresh()` walks every `ifs_shipments` row
  with `voided_at IS NULL AND delivered_at IS NULL`, calls
  `viewShipmentDetails` (`#28`), maps the FedEx status string to our
  `ShipmentStatus` enum, and pipes through `ShipmentIngestService.ingest()`
  so the linked `shipments` row advances and the client notification
  fires.
- **Schedule is windowed**, per Hunter: Mon-Fri only, 8:00–11:45 ET +
  16:00–17:30 ET (three `@Cron` decorators in `IfsService` — a single
  cron expression couldn't cleanly cover the 17:30 boundary). 23
  fires/business day. Tz `America/New_York`.
- Manual trigger: `POST /admin/ifs/refresh-status` and a bonus call
  baked into the existing "Refresh from carriers" button on
  `/admin/shipments`.

**EOD reports**

- Now sent FROM `Atlanta Gold & Coin <info@atlantagoldandcoin.com>`
  via per-message `from?` override on `EmailService.send()`.
  *Important note*: Gmail SMTP only honors From addresses that match
  the authenticated user OR a configured "Send mail as" alias. Hunter
  said he set up the alias; haven't independently verified.
- Added next-day forecast section (`tomorrow_forecast` / per-metal):
  any non-canceled BUY invoice dated tomorrow contributes. Renders in
  the HTML email + plaintext fallback.

### Scrap workflows (`/admin/scrap/*`)

- `Scrap Calculator` — multi-row quick-quote tool. Live spot ribbon
  for Au/Ag/Pt/Pd. Each row: metal → purity dropdown → weight + unit
  (dwt/g/toz) → spot $ → spot value → % off → final price. Math:
  `final = spot × purity × weight_in_toz × (1 - pct/100)` for buy,
  `+ pct/100` for sell.
- `Scrap Invoice` — buy/sell toggle (default buy). Same row-builder
  as the calculator. Hydrates from sessionStorage when launched via
  the calculator's "Add to new invoice" button. Submits via
  `POST /admin/invoices` with **ad-hoc line items only** (`product_id`
  unset, `custom_name` + `override_unit_price` filled). Per Hunter:
  scrap stays out of the catalog price sheets.
- Industry-standard purity tables in
  `apps/web/src/app/admin/scrap/_lib/scrap-types.ts`:
  - Gold: 9K, 10K, 12K, 14K, 16K, 18K, 20K, 21K, 22K, 24K
  - Silver: .800, .835, .875, .900, .925, .958, .999
  - Platinum: .585, .600, .800, .850, .900, .950, .999
  - Palladium: .500, .950, .999
- KPI / EOD: scrap rolls under "other / scrap" — no per-metal
  categorization yet (deferred per Hunter).

### Compliance photo attachments

- New `invoice_attachments` table (migration 037, inline `bytea`,
  15 MB cap, kinds: `id` / `client_photo` / `item` / `other`).
- Backend: `InvoiceAttachmentsService` + controller (mirrors the
  existing `ClientAttachmentsService` pattern). Routes:
  `GET /admin/invoices/:id/attachments`,
  `POST /admin/invoices/:id/attachments` (multipart),
  `GET /admin/invoice-attachments/:id/file`,
  `DELETE /admin/invoice-attachments/:id`.
- Scrap-invoice creation page hosts three photo capture sections
  (HTML5 `capture="environment"` opens rear camera on mobile, file
  picker on desktop). Files held in memory until the invoice POST
  returns `id`, then uploaded sequentially with progress UI.
- `/admin/invoices/[id]` has a new operator-only Attachments section
  that auto-renders when any rows exist + an "+ Add more" inline
  uploader. PDFs + client portal both ignore the new table — strictly
  operator-only.

### Owner-private client / invoice visibility

Per Hunter, his personal client record's transactions need to be
hidden from other admin/staff while still flowing into KPI/EOD totals.

- Migration 038 adds `clients.is_owner_private` (boolean) +
  `users.can_view_owner_private` (boolean). Migration sets the
  allowlist flag for `hunter@atlantagoldandcoin.com` +
  `accounting@atlantagoldandcoin.com` (Tim).
- `apps/api/src/common/owner-privacy.helper.ts` exports
  `canViewOwnerPrivate(db, userId)`.
- Filtered surfaces (when caller is not on allowlist):
  - `InvoicesService.list()` — drops rows
  - `InvoicesService.getById()` — 404 (NOT 403; existence is itself
    confidential)
  - `InvoicesService.listOutstandingWholesale()` — drops both live +
    historical wholesale rows
  - `ClientsService.list()` — drops rows
  - `ClientsService.getById()` — 404
  - `ClientsService.getTimeline()` — 404 via getById gate
  - PDF download + email-invoice — 404 via getById gate
- KPI / EOD / dashboard rolled-up totals do NOT filter — privacy is
  detail-level only; the dollars still reconcile.
- ClientForm at `/admin/clients/[id]/edit` shows an amber checkbox
  ("Owner-private (restricted visibility)") gated to allowlisted users
  via `useAuth()`. `/auth/me` now surfaces `can_view_owner_private`
  so the FE can conditionally render.
- **Currently flagged**: client `6de4829a-33c3-457a-a2f6-e0d2e5267912`
  ("Hunter Rhodes" / huntrho@proton.me / company "Atlanta Gold and Coin",
  has 1 buy invoice). Other Hunter-named records are NOT flagged.

### Client tracking (Google Calendar (N)/(R) tags)

- Operators tag bookings with `(N)` for new / `(R)` for returning in
  Google Calendar event titles. AGC pulls live from the configured
  Sales calendar (`sales@atlantagoldandcoinbuyers.com` per the
  google_calendar integration row — note the `-buyers-` domain).
- Backend method `CalendarService.getClientTrackingMonthly(months)`
  buckets events by ET wall-clock month, parses `(N)` / `(R)` case-
  insensitively, drops events whose title contains
  "cancel"/"canceled"/"cancelled" or whose Google `status` is
  `'cancelled'`.
- API path: `GET /admin/calendar/client-tracking?months=N`.
  **NOT under `/admin/clients/*`** — that path is shadowed by
  `AdminClientsController.getById(:id)` and would 400 with
  ParseUUIDPipe. Lesson learned, documented inline.
- Surfaces:
  - Dashboard KPI card above daily updates: current month new vs
    returning, MoM delta, 6-month sparkline. **Hard-coded baseline
    `NEW_CLIENTS_BASELINE = 72`** at top of `apps/web/src/app/admin/page.tsx`
    — drives the inline "/ 72 baseline" + progress bar on the New tile.
  - `/admin/clients/tracking` page: 6/12/24/36-month range selector,
    summary tiles (range total / this month / cumulative-since), bar
    chart, per-month table with running cumulative-new column.

### Multi-select bulk delete on drafts

- Drafts tab on `/admin/invoices` now has a checkbox column +
  sticky amber action bar (`N drafts selected · [Delete N drafts]`).
  Selection clears on tab change.
- Backend: `POST /admin/invoices/bulk-delete-drafts` (declared BEFORE
  `DELETE /:id` to dodge route shadowing). Validates every id is
  `status='draft'` in one transaction; any non-draft rolls the whole
  batch back. Cap 200/batch.
- Audit log: one `invoice.draft.delete` per row (so existing filters
  keep working) + a parent `invoice.bulk_delete` row with the full id
  list for forensic correlation.

### Quality-of-life invoice fixes

- `+ Free-form line` button on `/admin/invoices/new` + scrap invoice
  page. Adds a row in explicit ad-hoc mode (`ad_hoc: true` flag on
  `DraftLine`). The LineRow checks the flag and renders the Item Name
  input directly (auto-focused) instead of the ProductCombobox —
  fixes a real UX bug where typing into the combobox's search input
  evaporated on blur.
- `+ New client` button next to the ClientCombobox on both the
  regular invoice wizard and the scrap-invoice page. Uses a shared
  `<QuickAddClient>` component (`apps/web/src/components/quick-add-client.tsx`)
  that pops a small inline form, creates the client via
  `POST /admin/clients`, auto-selects them into the picker.

### Dashboard / login UX

- Mobile Buy/Sell volume overflow — round to whole dollars +
  responsive `text-xl md:text-2xl` + `overflow-hidden truncate`.
- Login page redirect by role: admin/staff → `/admin`, client →
  `/dashboard`. `AuthContext.login` now resolves with the user
  object so the page can route synchronously (no React re-render
  wait).
- Home page (`/`) now also routes admins/staff to `/admin` — the
  earlier login-page-only fix didn't catch users restoring a
  session via refresh cookie.

### Invoice date edit fix (`finalized_at` / `paid_at` propagation)

- KPI / EOD bucket invoices on `COALESCE(finalized_at, created_at)`,
  but the invoice header edit was only updating `created_at` —
  causing date changes to silently NOT move invoices in those
  reports.
- `InvoicesService.editHeader` now snaps `finalized_at` and `paid_at`
  to the new `transacted_at` when those columns are non-null. Audit
  log captures the prior values so date corrections are recoverable.
- FE invalidates `['admin', 'kpi']` after a date edit so the chart
  refreshes immediately.

### Bug fixes worth knowing about

- `shipment_tracking_events` `ON CONFLICT (shipment_id, carrier_event_id)`
  was failing because the unique index in migration 013 is **partial**
  (`WHERE carrier_event_id IS NOT NULL`). Postgres requires the
  predicate on the conflict target. Fixed in `ShipmentIngestService.ingest()`
  by adding `.where('carrier_event_id', 'is not', null)` to the
  Kysely `.onConflict()` clause.
- `GmailService.ensureLabel()` was crashing every 15 min with
  "Label name exists or conflicts" (race between list + create).
  Now catches the 409 + re-lists to grab the now-existing label id.
- Owner-private invoice list filter was on `clients.is_owner_private`
  (correct), NOT on `invoices.created_by_user_id` — so Hunter's
  invoices for OTHER clients stay visible to all admins, only his
  personal client's invoices hide. Documented because the user
  asked to verify.

### BullionOS visual rebrand

The biggest visual change of the session.

- New brand component file: `apps/web/src/components/bullion-os-logo.tsx`
  exports `<BullionOSLogo>` (compact ring+bar for sidebar),
  `<BullionOSWordmark>` (`bullion` + gold `OS`, optional tagline),
  `<BullionOSHeroMark>` (hexagon + PCB circuit traces + 3D bar for
  login splash). All inline SVG.
- Tailwind extensions in `tailwind.config.ts`:
  - `gold.300` (#f3d266) + `gold.400` (#e7b934) — brighter accents.
    Existing 500/600 stay as-is for tuned tan.
  - `bos.{black, night, line, text, mute}` — chrome surface tokens.
- `globals.css`:
  - `body` background flipped to `#05060d` (BullionOS dark backdrop).
  - **`.bos-theme` override layer** scoped to the admin shell —
    redefines the heaviest-used Tailwind color utilities
    (`bg-white`, `bg-ink-50/100/200` + slashed variants,
    `border-ink-100/200/300`, `text-ink-400` through 900,
    primary-button `bg-ink-900`, pastel callout bgs/text in amber/
    sky/emerald/red/green/buy/sell/yellow/orange/blue/slate/violet)
    so existing markup flips dark inside the admin scope without a
    single per-page edit. Login / public booking / register /
    client portal sit OUTSIDE the scope and stay light.
  - **Critical CSS rule**: `.bos-theme button, .bos-theme select,
    .bos-theme input, .bos-theme textarea { color: inherit; }` —
    browsers DON'T inherit color into form elements by default;
    they reset to user-agent `ButtonText`/`FieldText` system colors.
    This rule fixes the Catalog / In-Stock-Sheet / What-We-Pay
    product names which render inside `<button>` (InlineField pattern).
- AdminLayout (`apps/web/src/app/admin/layout.tsx`):
  - Sidebar dark with the BullionOS ring+bar mark + "AGC Desk · Admin"
    subtitle, gold-400 tinted active nav state.
  - Header dark with the spot ticker + notifications bell.
  - **`<AdminFooter>`**: "Powered by bullionOS" wordmark on the
    bos-night surface at the bottom of every admin page.
  - Wrapping div carries the `.bos-theme` class.
- Login page:
  - Full BullionOS hero — `<BullionOSHeroMark size={140}>` + big
    wordmark with "Precious Metals · Powered by Software" tagline.
  - Form on `bos-night` surface, gold-400 primary button, dark
    inputs.
  - "Powered by bullionOS" microcopy at the bottom.
- Spot ticker in the header:
  - Lightened text (was unreadable on the dark header).
  - Now reads the per-metal `change` field that `/metals/spot`
    already returns — renders ▲ / ▼ / · with reactive
    emerald/red/mute color + percent. Tooltip carries absolute
    delta.

### Other adds

- Manh Ha (`haxoan87@gmail.com`) created as admin with temp password
  `Ev4C2xMSbFVfWZ`. Note: temp password was given inline in the
  conversation; if Hunter wants to rotate, generate fresh.
- DocuSign integration code already exists
  (`apps/api/src/integrations/docusign.service.ts`) but is **not
  configured** in prod (no `integrations` row). Walked Hunter through
  the JWT Grant setup steps; he hasn't gathered creds yet. The
  existing service handles JWT signing + token cache + webhook
  signature verification + envelope creation stub.

## State of prod

- Last commit on `origin/main`: **`1d052e3`**
- Recent commit chain (newest first):
  ```
  1d052e3 fix(branding): category selector pills + sticky nav bg
  831ea34 fix(branding): pricesheet We Pay / We Sell column tints
  7a5bae7 fix(branding): bright chromatic text + button color inheritance
  3bf8165 fix(branding): brighter text + dark pastel callouts in dark theme
  8f6b676 feat(branding): full dark theme + reactive spot ticker + sign-out fix
  6d54989 feat(branding): BullionOS visual identity for admin shell + login
  …
  ```
- Railway: `agc-api` auto-deploys from main. Migrations run on
  pre-deploy. Currently up — no pending migrations.
- Vercel: web frontend auto-deploys from main. Builds typically
  take 2-3 min after push.
- DB has both Hunter records — flagged: `6de4829a-…`. Manh Ha user
  exists (`3b978a20-4a3b-4e47-8b51-acfb4ecf1d2f`).

## Pending / asked-for but not yet built

1. **DocuSign integration setup** — Hunter needs to gather sandbox
   creds (Integration Key, User ID, Account ID, RSA private key PEM,
   base path). Once credentials are in `/admin/integrations`, the
   "Send for signature" button + Connect webhook are ~2-3 hours of
   work.
2. **Backblaze off-site backup** — Hunter needs to sign up for B2,
   create a bucket, generate an Application Key. Once creds are in
   hand, ~1 hour to add the `b2` provider, daily upload cron,
   "Last uploaded" UI on `/admin/backups`.
3. **DB-internal backup risk** — pointed out that the daily SQL
   dumps are stored INSIDE the database (in `backup_runs.dump_bytes`).
   If the DB is lost, the in-app backups are lost too. Mitigation
   layers explained in the conversation; Backblaze is the priority
   add. Operator can also download dumps manually from `/admin/backups`
   for offsite storage in the meantime.
4. **Possible follow-ups**:
   - Re-enable the FedEx-direct adapter if Hunter ever obtains FedEx
     API creds (the existing `ShipmentPollService` is wired and will
     start picking up tracking the moment the integration is
     configured — no code change needed).
   - Webhooks on IFS for push status updates (asked Hunter to inquire
     with IFS support; no answer yet).
   - PR/SR multi-ship variant for >$75k single-piece insurance flow
     (currently bumps operator to ifsclients.com).
   - International / customs / AES on the IFS wizard (deferred).
   - Per-metal categorization for scrap in KPI / EOD (currently
     rolls to "other"). Would need a `metal` column on
     `invoice_line_items` or pseudo-products.
   - Recipient `#6` hydration on IFS wizard (currently typeahead
     returns id+name; operator manually fills the address).

## Operational details

### Identities

- **Hunter** (admin):
  - User id: `fb56cd44-523d-4ebb-8809-d286f656d7e0`
  - Email: `hunter@atlantagoldandcoin.com`
  - Personal client (owner-private): `6de4829a-33c3-457a-a2f6-e0d2e5267912`
- **Tim** (admin, accounting):
  - Email: `accounting@atlantagoldandcoin.com`
  - On owner-private allowlist
- **Manh Ha** (admin):
  - User id: `3b978a20-4a3b-4e47-8b51-acfb4ecf1d2f`
  - Email: `haxoan87@gmail.com`
  - Temp password issued (rotate if compromised)
  - NOT on owner-private allowlist

### Deploy + creds

- API deploy: `git push origin main` → Railway auto-builds
  `agc-api` → `preDeployCommand: node dist/db/migrator.js up`
  applies migrations → service redeploys.
- Web deploy: same push triggers Vercel build → 2-3 min.
- Pull Railway service env vars:
  ```bash
  cd /e/agc-crm && railway variables --service agc-api --kv
  ```
- Useful one-liners (DB ops from local machine):
  - `APP_ENCRYPTION_KEY` is in Railway env — needed to decrypt
    `integrations.credentials_encrypted` blobs.
  - `DATABASE_PUBLIC_URL` for prod DB — pull from Railway each
    session via:
    ```bash
    railway variables --service agc-postgres --kv | grep DATABASE_PUBLIC_URL
    ```
    Use the public proxy URL (NOT the internal `…railway.internal`
    hostname — that only resolves inside Railway containers).
  - Encryption format: AES-256-GCM, blob layout
    `nonce(12) || ciphertext || authTag(16)`. See
    `apps/api/src/crypto/crypto.service.ts`.
  - One-off scripts that need pg + bcrypt should `cd
    /e/agc-crm/apps/api && node -e ...` so the pnpm-hoisted
    node_modules resolve.

### Configured integrations (prod, encrypted in `integrations` table)

- `ifs` — IFS Clients (FedEx labels). Account `10162`, user
  `AGC_agc_AGC`. Tested working.
- `google_calendar` — wired to `sales@atlantagoldandcoinbuyers.com`
  (note: `-buyers-` domain). Calendar id same as account, tz
  `America/New_York`.
- `gmail` — RARCOA auto-ingest, polls every 15 min. Recently fixed
  the label-conflict crash loop.
- `metals` — metals.dev API, used for spot prices.
- `aurbitrage` — Aurbitrage wholesaler price aggregator.
- `fedex` — NOT configured (Hunter doesn't have direct FedEx creds).
  The `ShipmentPollService` no-ops gracefully on missing creds.
- `ups` / `usps` — same status as fedex.
- `docusign` — NOT configured. Code ready; awaiting sandbox creds.
- `greminders` — appointment reminders.

### Constants / hard-coded values worth knowing

- New-clients baseline: `NEW_CLIENTS_BASELINE = 72` in
  `apps/web/src/app/admin/page.tsx`.
- Backup retention: `BACKUP_RETENTION_DAYS=30` (env var,
  `apps/api/src/backups/backups.service.ts`).
- Invoice delete PIN: `INVOICE_DELETE_PIN=016275` (env, default).
- Bulk-delete drafts cap: 200 per request.
- Invoice attachments: 15 MB cap, kinds
  `id` / `client_photo` / `item` / `other`.
- Default IFS sender match: company-name "your atl taxidermy"
  (case-insensitive substring).
- Daily backup cron: `0 20 * * *` Eastern (8 PM ET).
- IFS status refresh crons (Mon-Fri ET):
  `*/15 8-11`, `*/15 16`, `0,15,30 17`.
- EOD report cron: `0 0 17 * * 1-5` (5 PM ET Mon-Fri).
- EOD From: hard-coded `Atlanta Gold & Coin <info@atlantagoldandcoin.com>`
  in `apps/api/src/eod-reports/eod-reports.service.ts`.

## Code patterns / where things live

```
apps/api/src/
├─ ifs/                              ← IFS Phase 2
│  ├─ ifs.service.ts                 (16 wizard methods + cron)
│  ├─ ifs.controller.ts              (admin-only routes)
│  └─ dto/wizard.dto.ts              (class-validator DTOs)
├─ invoices/
│  ├─ invoice-attachments.service.ts ← compliance photos
│  ├─ invoice-attachments.controller.ts
│  └─ invoices.service.ts            ← bulkDeleteDrafts here
├─ common/
│  └─ owner-privacy.helper.ts        ← canViewOwnerPrivate(db, userId)
├─ db/migrations/
│  ├─ 037_invoice_attachments.ts
│  └─ 038_owner_private_invoices.ts
├─ calendar/
│  └─ calendar.service.ts            ← getClientTrackingMonthly()
└─ eod-reports/
   └─ eod-reports.service.ts         ← per-message From override

apps/web/src/
├─ app/
│  ├─ globals.css                    ← .bos-theme dark override layer
│  ├─ login/page.tsx                 ← BullionOS hero
│  ├─ page.tsx                       ← role-based home redirect
│  └─ admin/
│     ├─ layout.tsx                  ← sidebar/header/footer + .bos-theme
│     ├─ page.tsx                    ← dashboard + ClientTypeKpi + KpiTile
│     ├─ scrap/                      ← calculator + invoice + photo capture
│     │  ├─ _lib/scrap-types.ts      (purity tables, math)
│     │  ├─ _lib/scrap-row-builder.tsx
│     │  ├─ _lib/photo-capture.tsx
│     │  ├─ calculator/page.tsx
│     │  └─ invoice/page.tsx
│     ├─ clients/tracking/page.tsx   ← (N)/(R) tracking history
│     └─ shipments/new-label/page.tsx ← IFS Phase 2 wizard
├─ components/
│  ├─ bullion-os-logo.tsx            ← Logo / Wordmark / HeroMark
│  ├─ quick-add-client.tsx           ← inline new-client modal
│  └─ spot-ticker.tsx                ← reactive arrows
└─ lib/
   ├─ auth-context.tsx               ← login() returns user
   └─ use-live-spot.ts

tailwind.config.ts                   ← gold.300/400 + bos.* tokens
docs/
├─ SESSION_HANDOFF_IFS_PHASE2.md     ← prior session
├─ IFS_API_REFERENCE.md              ← all IFS endpoint specs
└─ SESSION_HANDOFF_2026-05-04.md     ← this file
```

### Patterns to be aware of

1. **Controller route ordering matters.** Nest matches in declaration
   order. Two specific bugs caught this session:
   - `GET /admin/clients/tracking` was shadowed by
     `AdminClientsController.getById(:id)` and would 400 because
     "tracking" failed `ParseUUIDPipe`. Moved to
     `/admin/calendar/client-tracking` (frontend URL unchanged).
   - `POST /admin/invoices/bulk-delete-drafts` was carefully
     declared BEFORE `DELETE /:id` for the same reason.

2. **Owner-private gating.** `InvoicesService.list()` and `getById()`
   accept `actorUserId?` in their opts. Helper looks up
   `users.can_view_owner_private` and either filters
   (`c.is_owner_private = false` in the where clause) or returns 404.
   Apply this pattern to ANY new surface that shows invoice/client
   data to staff — KPI/EOD intentionally don't filter.

3. **CSS dark-theme override pattern.** New utility classes that
   appear on admin pages need to be added to the `.bos-theme` block
   in `globals.css` if they reference colors that should adapt.
   Slashed/translucent variants (e.g. `bg-white/95`,
   `bg-red-50/40`) are DISTINCT classes and need their own override
   line. Form elements (`<button>`, `<input>`, `<select>`,
   `<textarea>`) DO NOT inherit `color` from parents; the
   `color: inherit` rule in `.bos-theme` fixes this — don't remove it.

4. **Owner-private flag flipping.** UI: `/admin/clients/[id]/edit`
   → amber "Owner-private" checkbox at bottom (visible only to
   allowlisted users). SQL alternative:
   `UPDATE clients SET is_owner_private = true WHERE id = '<uuid>';`

5. **Adding a user to the owner-private allowlist.** One-line UPDATE,
   no code change:
   ```sql
   UPDATE users SET can_view_owner_private = true
   WHERE lower(email) = 'someone@atlantagoldandcoin.com';
   ```

## Known wrinkles / things that might trip you up

- **`.tmp.driveupload/` + `docs/SESSION_LOG.md` + `resume.ps1/`** are
  always present as untracked files in the working tree. Ignore them
  when committing.
- **`pg` module resolution**: one-off Node scripts that import `pg`
  must run from `apps/api/` (where pnpm hoists the dep). Running
  from `/e/agc-crm/` directly will get `Cannot find module 'pg'`.
- **The owner-private filter on `invoices.list()`** uses Kysely's
  fluent API — when adding new where clauses note that the
  `let q = ...` builder gets reassigned, so chaining matters.
- **Vercel CDN cache** — after a frontend deploy, hard-refresh
  (`Ctrl+Shift+R`) to bypass any in-tab cached JS chunks.
  Hunter has hit this multiple times.
- **The `Hunter Stone` client** (id `a05bf9e6-…`) is a different
  person, NOT Hunter Rhodes. Don't accidentally flag it as
  owner-private.
- **EOD email `From: info@`** depends on Gmail's "Send mail as" alias
  being configured under the `sales@…buyers.com` mailbox. If the
  alias isn't set up, Gmail silently rewrites From back to
  `sales@…buyers.com` — no bounce, just doesn't accomplish the goal.
- **Scrap purity table** (`apps/web/src/app/admin/scrap/_lib/scrap-types.ts`)
  — Hunter approved the current set on 2026-05-01. If new purities
  are needed, just add to `PURITY_OPTIONS[metal]`.

## Suggested next steps (in priority order)

1. **Backblaze off-site backup** — biggest single risk reduction.
   Hunter just needs to sign up + send the keys.
2. **DocuSign sandbox setup + envelope-create button** — once Hunter
   gathers creds.
3. **Polish dark theme** — keep an eye out for any pages with
   surprise white surfaces (translucent variants are the most likely
   gotcha). Add to `.bos-theme` overrides as discovered.
4. **Per-metal scrap categorization in KPI** — small DB migration
   (nullable `metal` column on `invoice_line_items`) + a
   `COALESCE(p.metal, li.metal)` in the EOD/KPI queries. ~30 min.
5. **IFS recipient `#6` hydration** — currently typeahead returns
   id+name; operator manually re-fills the address from the saved
   recipient list. Adding `getRecipient(id)` would auto-fill. ~30 min.

## Useful tooling / scripts

- `apps/api/scripts/ifs-smoke-test.mjs` — read-only smoke against
  prod IFS. Fetches creds from DB, hits #2/#3/#4/#5/#8/#13.
- The DocuSign service already has a `testConnection()` that
  exchanges JWT for OAuth token — `/admin/integrations` "Test"
  button uses it once creds are saved.

---

If a section here doesn't match what you're seeing, trust the code
over the doc — happy to be wrong, but the file references are the
ground truth as of `1d052e3`.
