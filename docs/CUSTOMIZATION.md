# Customizing a tenant (theming, flags, custom fields)

Everything here is **self-serve** from inside the app — no redeploy, no code change. It's aimed at the tenant's owner/admin. Operators provisioning a new tenant should point the customer at this doc after handing over the login (see `docs/PROVISIONING.md` § 5).

Every customization is **opt-in and backward-compatible**: leave a field blank / a toggle at its default and the app looks and behaves exactly as it does out of the box. Empty theme fields fall back to the built-in BullionOS palette and font; new flags default to today's behaviour; custom-field schemas start empty.

## Appearance (theming)

`/admin/settings` has an **Appearance** section with three optional fields:

| Field | What it changes | Empty = |
| --- | --- | --- |
| `accent_color` | The primary accent (buttons, links, active nav, the "gold" highlight). | Built-in BullionOS accent |
| `sidebar_bg` | The admin sidebar / chrome background. | Built-in chrome color |
| `font_family` | The app's UI font (a CSS `font-family` value, e.g. `Inter, system-ui, sans-serif`). | Built-in default font |

How it works under the hood:

- The defaults are real CSS variables (`--brand-accent`, `--brand-accent-strong`, `--brand-chrome-bg`, `--brand-font`) seeded in `globals.css` to the **current hardcoded values**, so a tenant that sets nothing renders byte-identically to before.
- When a tenant fills in a field, the web app injects an inline `<style>` at the document root overriding only the variables that were set (non-empty). Tailwind's accent/chrome colors read those variables with the current hex as the fallback, so partial customization (e.g. accent only) leaves everything else untouched.
- The Appearance editor shows a **live preview swatch** so the admin can see the accent/sidebar colors before saving. "Use default" = clear the field.

Saved via `PATCH /admin/settings/branding` alongside the existing branding fields (company name, address, logo, favicon, …). Logo/favicon still live in the DB and survive redeploys; the theme colors/font live in `app_settings`.

### Logo

The logo set at `/admin/settings` is served at `/api/v1/public/branding/logo`. The app's logo component renders that tenant logo wherever a logo appears (login, admin sidebar header, client portal) when one is uploaded, and falls back to the inline BullionOS mark when none is set.

## Platform branding (white-label)

| Flag | Default | Effect when **off** |
| --- | --- | --- |
| `show_platform_branding` | **on** | Hides the "Powered by BullionOS" lockup + platform logo in the footer and the login tagline. |

White-label tenants turn this **off** at `/admin/settings/features`. Leaving it on (the default) keeps the platform attribution exactly as it is today.

## Dealer Board link

| Value key | Default | Effect |
| --- | --- | --- |
| `dealer_board.url` | `""` (empty) | Empty **hides** the Dealer Board nav link. Set a URL to show the link and point it there. |

This replaces the previously hardcoded dealer-board URL — the link now only appears if the tenant configures one, and goes wherever they point it. Set it at `/admin/settings`.

## Custom fields (clients & products)

Tenants can add their own fields to client and product records without a schema migration — the values are stored in a JSON `custom_fields` column on each `clients` / `products` row (defaults to `{}`, so existing rows are unaffected).

### Defining the schema

`/admin/settings` → **Custom Fields** editor. You manage two independent lists — one for **clients**, one for **products**. Each field definition is:

| Property | Required | Notes |
| --- | --- | --- |
| `key` | yes | Stable machine key stored in `custom_fields` (e.g. `loyalty_tier`). Don't rename it after data exists. |
| `label` | yes | Human label shown on the form. |
| `type` | yes | One of `text`, `number`, `select`, `date`, `boolean`. |
| `options` | only for `select` | The list of choices. |

The schema is stored in `app_settings` under `custom_fields_schema` as `{ clients: FieldDef[], products: FieldDef[] }` (default `{ clients: [], products: [] }`). It's returned from `GET /admin/settings` as `customFieldSchema` and saved via `PATCH /admin/settings/custom-fields`.

### Using the fields

Once a field is defined, the client and product **create/edit forms** automatically render an input per field (typed by its `type`) and read/write the entity's `custom_fields`. The create/update APIs accept an optional `custom_fields` object and persist/return it as-is (passthrough — no server-side validation), so values round-trip cleanly.

Removing a field definition just stops it from rendering on the form; any values already stored under that key stay in `custom_fields` (so you can re-add the field later without data loss). Use a fresh `key` if you want a clean slate.

## Owner-private client visibility

Some client records (the owner's personal record, a staff testing record) should be hidden from the rest of the team but still roll up into KPIs. Mark a client **Owner-private** at `/admin/clients/<id>/edit` — only users with `can_view_owner_private` can see them.

Grant that capability per user from `/admin/users/<id>` → **Can view owner-private clients** checkbox (bound to `can_view_owner_private`, saved via the user PATCH). This replaces the old approach of granting it by hand-editing the database or hardcoding specific owner emails — new tenants grant it entirely through the admin UI.

## What an operator still controls (not self-serve)

A few branding-adjacent settings are env vars (need a redeploy), not in-app:

- `TOTP_ISSUER` — the label in staff authenticator apps.
- `NEXT_PUBLIC_BRAND_NAME` — the build-time fallback brand name (the in-app company name overrides it at runtime).
- `WEB_ORIGIN` / DNS / custom domain — see `docs/PROVISIONING.md`.

## Quick reference: where each setting lives

| Customization | Where | Mechanism |
| --- | --- | --- |
| Accent / sidebar color, font | `/admin/settings` → Appearance | `PATCH /admin/settings/branding`, CSS vars |
| Logo / favicon | `/admin/settings` | DB (`branding_assets`) |
| Hide "Powered by BullionOS" | `/admin/settings/features` | `show_platform_branding` flag |
| Dealer Board link | `/admin/settings` | `dealer_board.url` value |
| Custom client/product fields | `/admin/settings` → Custom Fields | `PATCH /admin/settings/custom-fields`, `custom_fields` JSON column |
| Owner-private grant | `/admin/users/<id>` | `can_view_owner_private` checkbox |
| Feature toggles (IFS, scrap, etc.) | `/admin/settings/features` | feature flags (see `docs/OPERATOR_GUIDE.md`) |
