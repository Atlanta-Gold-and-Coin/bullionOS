'use client';

import { useQuery } from '@tanstack/react-query';
import { FLAG_KEYS, VALUE_KEYS, type FlagKey, type ValueKey } from '@agc/shared';
import { apiFetch } from './api-client';

/**
 * Frontend mirror of the AppSettingsResponse shape from the API.
 * Kept hand-written (not auto-generated) since both ends are small
 * and the registry is the source of truth on the server.
 *
 * The flag/value KEY SET is derived from '@agc/shared' (FLAG_KEYS /
 * VALUE_KEYS) so the FE never drifts from the BE registry. To add a
 * new flag or value:
 *   1. Add the entry to apps/api/src/settings/settings-registry.ts.
 *   2. Add the key to packages/shared/src/settings-keys.ts.
 *   3. Read it in components via useFlag(name) / useSetting(key).
 *
 * Note: useSetting still needs the per-key VALUE TYPE (number vs
 * string), which keys alone can't carry — ValueShape stays the
 * hand-written type map for that. Its keys must stay in sync with
 * VALUE_KEYS (enforced structurally below).
 */

export type FlagName = FlagKey;

export interface ValueShape {
  'dashboard.new_clients_baseline': number;
  'ifs.sender_match': string;
  'eod_report.from_email': string;
  'app.url': string;
  'staff.email_domains': string;
  'dealer_board.url': string;
}

export interface BrandingPayload {
  company_name: string;
  company_tagline: string;
  address_line1: string;
  address_line2: string;
  address_city_state_zip: string;
  phone: string;
  website: string;
  has_logo: boolean;
  logo_url: string | null;
  has_favicon: boolean;
  favicon_url: string | null;
  // Tenant theming overrides. Empty string => use the built-in
  // default (today's hardcoded look). Injected at runtime as
  // --brand-* CSS vars by layout.tsx, consumed in globals.css /
  // tailwind.config.ts via var(--brand-*, <currentHex>) fallbacks.
  accent_color: string;
  sidebar_bg: string;
  font_family: string;
}

export interface AppSettings {
  branding: BrandingPayload;
  flags: Record<FlagName, boolean>;
  values: ValueShape;
}

const APP_SETTINGS_KEY = ['app-settings'] as const;

/**
 * One-shot fetch of every FE-readable setting. Cached for 60s — flags
 * and values change rarely, so we don't need a fresh hit per page nav.
 * Cache invalidates when the admin Settings → Features page mutates.
 */
export function useAppSettings() {
  return useQuery<AppSettings>({
    queryKey: APP_SETTINGS_KEY,
    queryFn: () => apiFetch<AppSettings>('/admin/settings'),
    staleTime: 60_000,
  });
}

/** Returns the boolean state of a feature flag. Defaults to `true` until loaded. */
export function useFlag(name: FlagName): boolean {
  const { data } = useAppSettings();
  // While loading, optimistically render the feature ON. The alternative
  // (default OFF) would briefly hide enabled features on every nav,
  // which feels worse than the rare flash for actually-disabled ones.
  if (!data) return true;
  return data.flags[name];
}

/** Returns the typed value for a registry key. Returns the registry default until loaded. */
export function useSetting<K extends keyof ValueShape>(name: K): ValueShape[K] {
  const { data } = useAppSettings();
  if (!data) {
    // Mirror the BE registry defaults so first-paint behavior is
    // sensible without a network roundtrip.
    const fallback: ValueShape = {
      'dashboard.new_clients_baseline': 0,
      'ifs.sender_match': '',
      'eod_report.from_email': '',
      'app.url': '',
      'staff.email_domains': '',
      'dealer_board.url': '',
    };
    return fallback[name];
  }
  return data.values[name];
}

// Reference the imported key arrays so they're retained as the
// source-of-truth handshake with '@agc/shared' (and to make the
// dependency explicit for tooling). FLAG_KEYS/VALUE_KEYS drive the
// FlagKey/ValueKey types above.
export { FLAG_KEYS, VALUE_KEYS };
export type { ValueKey };

export const APP_SETTINGS_QUERY_KEY = APP_SETTINGS_KEY;
