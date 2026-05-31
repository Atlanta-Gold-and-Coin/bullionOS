/**
 * Canonical key sets for frontend-readable settings, shared between the
 * NestJS API and the Next.js web app.
 *
 * These are the source of truth for *which* flag/value keys exist. The API's
 * settings-registry (apps/api/src/settings/settings-registry.ts) remains the
 * source of truth for the defaults + descriptions map; it should keep these
 * key sets in sync. The web app derives its FlagKey/ValueKey unions from here
 * instead of hardcoding local unions.
 *
 * IMPORTANT: the existing keys below are copied verbatim from the API's
 * FLAG_REGISTRY / VALUE_REGISTRY. New keys for the tenant-customization work
 * are appended at the end of each list.
 */

export const FLAG_KEYS = [
  // existing flags (verbatim from apps/api settings-registry FLAG_REGISTRY)
  'client_tracking_enabled',
  'scrap_enabled',
  'ifs_enabled',
  'eod_reports_enabled',
  'frontend_pricing_enabled',
  'compliance_photos_enabled',
  // new
  'show_platform_branding',
] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

export const VALUE_KEYS = [
  // existing values (verbatim from apps/api settings-registry VALUE_REGISTRY)
  'dashboard.new_clients_baseline',
  'ifs.sender_match',
  'eod_report.from_email',
  'app.url',
  'staff.email_domains',
  // new
  'dealer_board.url',
] as const;
export type ValueKey = (typeof VALUE_KEYS)[number];
