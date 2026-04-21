'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, getAccessToken } from '@/lib/api-client';

interface Branding {
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

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => apiFetch<{ branding: Branding }>('/admin/settings'),
  });

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="mt-1 text-sm text-ink-400">Branding that appears on invoices and PDFs.</p>

      <BrandingForm
        branding={data?.branding}
        onChanged={() => qc.invalidateQueries({ queryKey: ['admin', 'settings'] })}
      />

      <LogoCard
        branding={data?.branding}
        onChanged={() => qc.invalidateQueries({ queryKey: ['admin', 'settings'] })}
      />

      <FaviconCard
        branding={data?.branding}
        onChanged={() => qc.invalidateQueries({ queryKey: ['admin', 'settings'] })}
      />

      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Other settings
        </h2>
        <ul className="mt-3 divide-y divide-ink-200 text-sm">
          <li className="flex items-center justify-between py-2">
            <div>
              <div className="font-medium text-ink-900">Invoice template</div>
              <div className="text-xs text-ink-500">
                Footer comments + legal disclosure text that renders on
                every invoice PDF.
              </div>
            </div>
            <Link
              href="/admin/settings/invoice-template"
              className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700 hover:bg-ink-50"
            >
              Open →
            </Link>
          </li>
          <li className="flex items-center justify-between py-2">
            <div>
              <div className="font-medium text-ink-900">Email templates</div>
              <div className="text-xs text-ink-500">
                Subject + body copy for operator-sent emails, with variable
                placeholders.
              </div>
            </div>
            <Link
              href="/admin/settings/email-templates"
              className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700 hover:bg-ink-50"
            >
              Open →
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}

function FaviconCard({
  branding,
  onChanged,
}: {
  branding?: Branding;
  onChanged: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bust, setBust] = useState(0);

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const token = getAccessToken();
      const res = await fetch('/api/v1/admin/settings/favicon', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? 'Upload failed');
      }
      setBust(Date.now());
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function remove() {
    setError(null);
    try {
      await apiFetch('/admin/settings/favicon', { method: 'DELETE' });
      setBust(Date.now());
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Remove failed');
    }
  }

  const has = Boolean(branding?.has_favicon);

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Favicon</h2>
      <p className="mt-1 text-xs text-ink-400">
        PNG, JPEG, SVG, or ICO up to 1 MB. Appears in the browser tab.
      </p>

      <div className="mt-4 flex items-center gap-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-ink-200 bg-ink-50 p-2">
          {has ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/v1/public/branding/favicon?v=${bust}`}
              alt="Favicon preview"
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="text-[10px] text-ink-400">none</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
            }}
            className="hidden"
            id="favicon-input"
          />
          <label
            htmlFor="favicon-input"
            className="inline-block cursor-pointer rounded-md bg-ink-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-ink-800"
          >
            {uploading ? 'Uploading…' : has ? 'Replace favicon' : 'Upload favicon'}
          </label>
          {has && (
            <button
              onClick={remove}
              className="rounded-md border border-ink-200 px-4 py-1.5 text-sm text-ink-700 hover:bg-red-50 hover:text-red-700"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
    </section>
  );
}

function BrandingForm({
  branding,
  onChanged,
}: {
  branding?: Branding;
  onChanged: () => void;
}) {
  // One piece of state so syncing from the server payload is a single assignment.
  const [form, setForm] = useState({
    company_name: '',
    company_tagline: '',
    address_line1: '',
    address_line2: '',
    address_city_state_zip: '',
    phone: '',
    website: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync once when fresh data lands and the form is still empty.
  if (branding && form.company_name === '' && branding.company_name) {
    setForm({
      company_name: branding.company_name,
      company_tagline: branding.company_tagline,
      address_line1: branding.address_line1,
      address_line2: branding.address_line2,
      address_city_state_zip: branding.address_city_state_zip,
      phone: branding.phone,
      website: branding.website,
    });
  }

  function field<K extends keyof typeof form>(k: K) {
    return {
      value: form[k],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [k]: e.target.value })),
    };
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await apiFetch('/admin/settings/branding', {
        method: 'PATCH',
        body: JSON.stringify(form),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Company</h2>
      <p className="mt-1 text-xs text-ink-400">
        Name, address, and contact info appear on every invoice PDF.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-ink-800">Name</span>
          <input {...field('company_name')} className="input mt-1" maxLength={100} />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-800">Tagline</span>
          <input {...field('company_tagline')} className="input mt-1" maxLength={200} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-sm font-medium text-ink-800">Address line 1</span>
          <input {...field('address_line1')} className="input mt-1" maxLength={120} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-sm font-medium text-ink-800">Address line 2 (optional)</span>
          <input {...field('address_line2')} className="input mt-1" maxLength={120} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-sm font-medium text-ink-800">City, State ZIP</span>
          <input
            {...field('address_city_state_zip')}
            className="input mt-1"
            maxLength={120}
            placeholder="Alpharetta, GA 30022"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-800">Phone</span>
          <input
            {...field('phone')}
            className="input mt-1"
            maxLength={40}
            placeholder="404-236-9744"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-800">Website</span>
          <input
            {...field('website')}
            className="input mt-1"
            maxLength={120}
            placeholder="atlantagoldandcoin.com"
          />
        </label>
      </div>
      {error && (
        <div role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md bg-ink-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}

function LogoCard({
  branding,
  onChanged,
}: {
  branding?: Branding;
  onChanged: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cache-bust the logo preview after upload/delete so the new image shows.
  const [bust, setBust] = useState(0);

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const token = getAccessToken();
      const res = await fetch('/api/v1/admin/settings/logo', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? 'Upload failed');
      }
      setBust(Date.now());
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function remove() {
    setError(null);
    try {
      await apiFetch('/admin/settings/logo', { method: 'DELETE' });
      setBust(Date.now());
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Remove failed');
    }
  }

  const hasLogo = Boolean(branding?.has_logo);

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Invoice logo</h2>
      <p className="mt-1 text-xs text-ink-400">
        PNG or JPEG up to 1&nbsp;MB. Appears at the top of every invoice PDF.
      </p>

      <div className="mt-4 flex items-center gap-6">
        <div className="flex h-24 w-40 items-center justify-center rounded-md border border-dashed border-ink-200 bg-ink-50 p-3">
          {hasLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/v1/public/branding/logo?v=${bust}`}
              alt="Logo preview"
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="text-xs text-ink-400">No logo</span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
            }}
            className="hidden"
            id="logo-input"
          />
          <label
            htmlFor="logo-input"
            className="inline-block cursor-pointer rounded-md bg-ink-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-ink-800"
          >
            {uploading ? 'Uploading…' : hasLogo ? 'Replace logo' : 'Upload logo'}
          </label>
          {hasLogo && (
            <button
              onClick={remove}
              className="rounded-md border border-ink-200 px-4 py-1.5 text-sm text-ink-700 hover:bg-red-50 hover:text-red-700"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
    </section>
  );
}
