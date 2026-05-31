'use client';

import { useAppSettings } from '@/lib/use-app-settings';

/**
 * Runtime tenant-theme injector.
 *
 * Reads the branding theme overrides (accent_color / sidebar_bg /
 * font_family) and emits an inline <style> that sets the matching
 * --brand-* CSS vars on :root — but ONLY for fields the tenant has
 * actually set (non-empty). Empty/unset fields are omitted so the
 * defaults declared in globals.css (today's exact look) stand.
 *
 * SSR-safety: useAppSettings is a react-query hook that returns
 * `undefined` until the client fetch resolves. On both the server
 * render and the first client render `data` is undefined, so this
 * component emits the SAME empty <style> on both sides — no hydration
 * mismatch. Once the query resolves (client-only, post-hydration) the
 * vars are applied. This means a hard refresh shows default chrome for
 * a beat before the tenant theme paints in; acceptable, and avoids any
 * SSR data dependency.
 *
 * Mounted inside <Providers> in the root layout so it sits under the
 * QueryClient context and applies app-wide (admin shell, login,
 * dashboard).
 */
export function BrandThemeStyle() {
  const { data } = useAppSettings();
  const branding = data?.branding;

  // Nothing to inject until settings load.
  if (!branding) return null;

  const lines: string[] = [];
  // Tenant accent recolors both the bright and strong gold tiers; we
  // only have a single accent input, so drive both from it (matches
  // the FE Appearance editor which exposes one accent_color field).
  if (branding.accent_color) {
    lines.push(`--brand-accent: ${branding.accent_color};`);
    lines.push(`--brand-accent-strong: ${branding.accent_color};`);
  }
  if (branding.sidebar_bg) {
    lines.push(`--brand-chrome-bg: ${branding.sidebar_bg};`);
  }
  if (branding.font_family) {
    lines.push(`--brand-font: ${branding.font_family};`);
  }

  if (lines.length === 0) return null;

  return (
    <style
      // eslint-disable-next-line react/no-danger -- emitting a CSS
      // custom-property block; values come from the tenant's own admin
      // settings and are scoped to :root var declarations.
      dangerouslySetInnerHTML={{
        __html: `:root{${lines.join('')}}`,
      }}
    />
  );
}
