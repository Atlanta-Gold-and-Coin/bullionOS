'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { APP_SETTINGS_QUERY_KEY } from '@/lib/use-app-settings';

/**
 * Settings → Appearance
 *
 * Optional per-tenant theme overrides layered on top of the built-in
 * look. Three fields, all stored on the branding settings object:
 *
 *   - accent_color  — primary accent (buttons, links, highlights)
 *   - sidebar_bg    — admin chrome / sidebar background
 *   - font_family   — UI font stack
 *
 * Leaving a field blank ('') means "use the built-in default" — the
 * runtime theme injector only sets a --brand-* var for non-empty
 * fields, so the default look stays byte-identical. Saved via
 * PATCH /admin/settings/branding alongside the company fields.
 *
 * Admin-only — this page lives under /admin/settings/.
 */

interface Branding {
  company_name: string;
  // Theme overrides (added by the web-theming slice). Optional and
  // default '' so an un-themed tenant reproduces today's look exactly.
  accent_color?: string;
  sidebar_bg?: string;
  font_family?: string;
}

// Built-in defaults shown in the preview when a field is left blank.
// These mirror the :root --brand-* fallbacks defined in globals.css.
const DEFAULT_ACCENT = '#c8a35b';
const DEFAULT_SIDEBAR_BG = '#0f1115';
const DEFAULT_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

// A valid CSS hex color, used to gate the native color picker (which
// only accepts #rrggbb). The free-text field still allows any value.
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export default function AppearanceSettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: () => apiFetch<{ branding: Branding }>('/admin/settings'),
  });

  const [accent, setAccent] = useState('');
  const [sidebar, setSidebar] = useState('');
  const [font, setFont] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okAt, setOkAt] = useState<number | null>(null);

  // Seed the inputs once when the server payload arrives. The `seeded`
  // guard mirrors the invoice-template editor so refetches after save
  // never clobber in-flight edits.
  useEffect(() => {
    if (!data?.branding || seeded) return;
    setAccent(data.branding.accent_color ?? '');
    setSidebar(data.branding.sidebar_bg ?? '');
    setFont(data.branding.font_family ?? '');
    setSeeded(true);
  }, [data, seeded]);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      // Empty string is sent through as-is => "use default" on the BE.
      await apiFetch('/admin/settings/branding', {
        method: 'PATCH',
        body: JSON.stringify({
          accent_color: accent.trim(),
          sidebar_bg: sidebar.trim(),
          font_family: font.trim(),
        }),
      });
      // Invalidate the shared app-settings query so the live theme
      // injector picks up the change on next render.
      await qc.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      setOkAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const previewAccent = accent.trim() || DEFAULT_ACCENT;
  const previewSidebar = sidebar.trim() || DEFAULT_SIDEBAR_BG;
  const previewFont = font.trim() || DEFAULT_FONT;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center gap-3 text-sm text-ink-500">
        <Link href="/admin/settings" className="hover:underline">
          Settings
        </Link>
        <span>›</span>
        <span className="text-ink-900">Appearance</span>
      </div>
      <h1 className="mt-2 text-2xl font-semibold">Appearance</h1>
      <p className="mt-1 text-sm text-ink-400">
        Optional theme overrides. Leave a field blank to use the built-in
        default — the app looks identical to its shipped theme until you set
        something here.
      </p>

      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Theme
        </h2>
        <p className="mt-1 text-xs text-ink-400">
          Colors apply across the admin console and client portal. Changes take
          effect on the next page load.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <ColorField
            label="Accent color"
            help="Buttons, links, and highlights."
            value={accent}
            defaultHex={DEFAULT_ACCENT}
            onChange={setAccent}
          />
          <ColorField
            label="Sidebar background"
            help="Admin navigation / chrome background."
            value={sidebar}
            defaultHex={DEFAULT_SIDEBAR_BG}
            onChange={setSidebar}
          />
        </div>

        <label className="mt-5 block">
          <span className="text-sm font-medium text-ink-800">Font family</span>
          <p className="text-xs text-ink-400">
            A CSS font-family stack (e.g.{' '}
            <code className="rounded bg-ink-100 px-1 font-mono">
              Inter, system-ui, sans-serif
            </code>
            ). Blank uses the built-in font.
          </p>
          <input
            value={font}
            onChange={(e) => setFont(e.target.value)}
            maxLength={200}
            placeholder={DEFAULT_FONT}
            className="input mt-1 font-mono text-xs"
          />
        </label>
      </section>

      {/* ─── Live preview ─────────────────────────────────────────── */}
      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Preview
        </h2>
        <p className="mt-1 text-xs text-ink-400">
          Approximate — your actual theme is applied app-wide after saving.
        </p>
        <div
          className="mt-3 overflow-hidden rounded-lg border border-ink-200"
          style={{ fontFamily: previewFont }}
        >
          <div className="flex">
            <div
              className="flex w-32 shrink-0 flex-col gap-2 p-4 text-xs text-white/80"
              style={{ background: previewSidebar }}
            >
              <span className="font-semibold text-white">Navigation</span>
              <span>Dashboard</span>
              <span>Clients</span>
              <span>Products</span>
            </div>
            <div className="flex-1 bg-white p-4">
              <div className="text-sm font-semibold text-ink-900">
                Sample heading
              </div>
              <p className="mt-1 text-xs text-ink-500">
                Body text uses the chosen font family.{' '}
                <span style={{ color: previewAccent }} className="font-medium">
                  This is an accent link.
                </span>
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-white"
                  style={{ background: previewAccent }}
                >
                  Primary action
                </button>
                <span
                  className="inline-block h-6 w-6 rounded-full border border-ink-200"
                  style={{ background: previewAccent }}
                  title="Accent swatch"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
      {okAt && !error && (
        <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">
          Saved. The theme updates on your next page load.
        </div>
      )}

      <div className="mt-6 flex justify-end">
        <button
          onClick={save}
          disabled={saving || !seeded}
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ColorField({
  label,
  help,
  value,
  defaultHex,
  onChange,
}: {
  label: string;
  help: string;
  value: string;
  defaultHex: string;
  onChange: (v: string) => void;
}) {
  const trimmed = value.trim();
  const isEmpty = trimmed === '';
  // The native picker only understands #rrggbb. Fall back to the
  // built-in default so the swatch still shows something sensible when
  // the field is blank or holds a non-hex value (e.g. an rgb()/var()).
  const pickerValue = HEX_RE.test(trimmed) ? trimmed : defaultHex;

  return (
    <div>
      <span className="text-sm font-medium text-ink-800">{label}</span>
      <p className="text-xs text-ink-400">{help}</p>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={pickerValue}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-ink-200 bg-white p-0.5"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={64}
          placeholder={defaultHex}
          className="input flex-1 font-mono text-xs"
        />
        {!isEmpty && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="rounded-md border border-ink-200 px-2 py-1 text-[11px] text-ink-600 hover:bg-ink-50"
            title="Clear — use the built-in default"
          >
            Default
          </button>
        )}
      </div>
      {isEmpty && (
        <p className="mt-1 text-[11px] text-ink-400">Using built-in default.</p>
      )}
    </div>
  );
}
