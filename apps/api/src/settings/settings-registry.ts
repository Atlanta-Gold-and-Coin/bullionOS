/**
 * Registry of frontend-readable settings.
 *
 * Two flavors:
 *   - FLAG_REGISTRY: boolean feature toggles (e.g. "is the IFS shipping
 *     wizard enabled in this tenant"). Stored under `flags.<name>` keys
 *     in app_settings; the FE reads them via useFlag(name).
 *   - VALUE_REGISTRY: typed scalars that drive UI behavior or text
 *     (e.g. dashboard baseline, IFS sender-match string). Stored under
 *     dotted keys; FE reads via useSetting(key).
 *
 * Each entry carries a default + type; SettingsService coerces the
 * stored jsonb to that type before returning. New flags/values:
 *   1. Add an entry here.
 *   2. (Optional) wire an admin UI control to PATCH it.
 *   3. Consume with useFlag/useSetting on the FE or
 *      SettingsService.getFlag/getValue on the BE.
 */

export interface FlagDef {
  default: boolean;
  description: string;
}

export interface ValueDefBase<T> {
  default: T;
  description: string;
}
export type StringValueDef = ValueDefBase<string> & { type: 'string' };
export type NumberValueDef = ValueDefBase<number> & { type: 'number' };
export type ValueDef = StringValueDef | NumberValueDef;

export const FLAG_REGISTRY = {
  client_tracking_enabled: {
    default: true,
    description:
      'Show the new/returning client tracking dashboard tile + /admin/clients/tracking page (driven by Google Calendar (N)/(R) tags).',
  },
  scrap_enabled: {
    default: true,
    description:
      'Enable scrap calculator + scrap-invoice flow under /admin/scrap.',
  },
  ifs_enabled: {
    default: false,
    description:
      'Enable IFS Clients (FedEx reseller) shipping label wizard. Requires an `ifs` integration to be configured.',
  },
  eod_reports_enabled: {
    default: true,
    description:
      'Send the daily end-of-day email report to admins/staff with email_notifications enabled.',
  },
  frontend_pricing_enabled: {
    default: false,
    description:
      'Expose public buy-rate / live-pricing widgets (the WordPress plugin reads these). Off by default — most tenants will not need it.',
  },
  compliance_photos_enabled: {
    default: true,
    description:
      'Show ID + client photo + item photo capture sections on scrap invoices. Some jurisdictions require this; others do not.',
  },
} as const satisfies Record<string, FlagDef>;

export type FlagName = keyof typeof FLAG_REGISTRY;

export const VALUE_REGISTRY = {
  'dashboard.new_clients_baseline': {
    type: 'number',
    default: 0,
    description:
      'Monthly new-clients goal shown on the dashboard tile. 0 hides the baseline UI.',
  },
  'ifs.sender_match': {
    type: 'string',
    default: '',
    description:
      'Substring (case-insensitive) used to auto-pick the default saved sender from the IFS sender list. Empty string falls through to IFS\'s primary_id.',
  },
  'eod_report.from_email': {
    type: 'string',
    default: '',
    description:
      'RFC 5322 From header for the EOD report email (e.g. "Acme Coin <reports@acmecoin.com>"). Empty falls back to the SMTP_FROM env default.',
  },
  'app.url': {
    type: 'string',
    default: '',
    description:
      'Canonical public app URL (e.g. https://desk.acmecoin.com). Used in email/PDF deep-links. When empty, links fall back to relative paths.',
  },
} as const satisfies Record<string, ValueDef>;

export type ValueName = keyof typeof VALUE_REGISTRY;

/** Inferred TypeScript type for a registry value, e.g. number for baseline. */
export type ValueOf<K extends ValueName> =
  typeof VALUE_REGISTRY[K]['type'] extends 'number' ? number : string;

/** Public response shape for GET /admin/settings consumers. */
export interface AppSettingsResponse {
  branding: import('./settings.service').BrandingSettings;
  flags: Record<FlagName, boolean>;
  values: { [K in ValueName]: ValueOf<K> };
}
