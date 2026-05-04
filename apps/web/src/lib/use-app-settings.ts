'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api-client';

/**
 * Frontend mirror of the AppSettingsResponse shape from the API.
 * Kept hand-written (not auto-generated) since both ends are small
 * and the registry is the source of truth on the server.
 *
 * To add a new flag or value:
 *   1. Add the entry to apps/api/src/settings/settings-registry.ts.
 *   2. Add the corresponding key to FlagName/ValueShape below.
 *   3. Read it in components via useFlag(name) / useSetting(key).
 */

export type FlagName =
  | 'client_tracking_enabled'
  | 'scrap_enabled'
  | 'ifs_enabled'
  | 'eod_reports_enabled'
  | 'frontend_pricing_enabled'
  | 'compliance_photos_enabled';

export interface ValueShape {
  'dashboard.new_clients_baseline': number;
  'ifs.sender_match': string;
  'eod_report.from_email': string;
  'app.url': string;
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
    };
    return fallback[name];
  }
  return data.values[name];
}

export const APP_SETTINGS_QUERY_KEY = APP_SETTINGS_KEY;
