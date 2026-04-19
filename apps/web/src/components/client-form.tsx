'use client';

import { useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api-client';

export interface ClientFormValues {
  first_name: string;
  last_name: string;
  /** Organization name (migration 020). Primary identity for wholesale. */
  company: string;
  email: string;
  /** Additional email addresses — newline-separated in the textarea. */
  secondary_emails: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  notes: string;
  heard_from: string;
  /** Retail (default) vs wholesaler. Drives the name-or-company requirement. */
  client_type: 'retail' | 'wholesaler';
  is_portal_enabled?: boolean;
}

// Common answers for the "how heard about us" datalist. Free-form — the
// datalist is a suggestion, not a constraint.
const HEARD_FROM_OPTIONS = [
  'Google search',
  'Facebook',
  'Instagram',
  'Referral',
  'Radio',
  'TV',
  'Driving by',
  'Repeat customer',
  'Other',
];

export function ClientForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: ClientFormValues;
  submitLabel: string;
  onSubmit: (vals: ClientFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof ClientFormValues>(k: K, v: ClientFormValues[K]) {
    setF((p) => ({ ...p, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit(f);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  // Retail/wholesale drives the name requirement: retail must have a
  // personal name; wholesale can identify by company alone. The backend
  // CHECK constraint `clients_has_identity` enforces this server-side too.
  const isWholesale = f.client_type === 'wholesaler';
  const nameRequired = !isWholesale;

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-ink-200 bg-white p-6">
      {/* Client type toggle (CLIENT-001). Wholesale records can skip the
          personal name entirely — the company field becomes primary ID. */}
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-ink-400">
          Client type
        </span>
        <div className="mt-1 inline-flex rounded-md border border-ink-200 bg-ink-50 p-1">
          <button
            type="button"
            onClick={() => set('client_type', 'retail')}
            className={`rounded px-3 py-1 text-sm ${
              !isWholesale ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600'
            }`}
          >
            Retail / individual
          </button>
          <button
            type="button"
            onClick={() => set('client_type', 'wholesaler')}
            className={`rounded px-3 py-1 text-sm ${
              isWholesale ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600'
            }`}
          >
            Wholesale / company
          </button>
        </div>
      </div>

      {isWholesale && (
        <L label="Company name *">
          <input
            required
            value={f.company}
            onChange={(e) => set('company', e.target.value)}
            className="input"
            maxLength={200}
            placeholder="Acme Coin Co."
          />
        </L>
      )}

      <div className="grid grid-cols-2 gap-3">
        <L label={`First name${nameRequired ? ' *' : ''}`}>
          <input
            required={nameRequired}
            value={f.first_name}
            onChange={(e) => set('first_name', e.target.value)}
            className="input"
            maxLength={80}
            placeholder={isWholesale ? 'Primary contact (optional)' : ''}
          />
        </L>
        <L label={`Last name${nameRequired ? ' *' : ''}`}>
          <input
            required={nameRequired}
            value={f.last_name}
            onChange={(e) => set('last_name', e.target.value)}
            className="input"
            maxLength={80}
            placeholder={isWholesale ? 'Primary contact (optional)' : ''}
          />
        </L>
      </div>

      {!isWholesale && (
        <L label="Company (optional)">
          <input
            value={f.company}
            onChange={(e) => set('company', e.target.value)}
            className="input"
            maxLength={200}
            placeholder="If the client is also a business"
          />
        </L>
      )}

      <div className="grid grid-cols-2 gap-3">
        <L label="Email (primary)">
          <input
            type="email"
            value={f.email}
            onChange={(e) => set('email', e.target.value)}
            className="input"
            maxLength={254}
          />
        </L>
        <L label="Phone">
          <input
            value={f.phone}
            onChange={(e) => set('phone', e.target.value)}
            className="input"
            maxLength={40}
          />
        </L>
      </div>

      <L label="Additional emails (one per line)">
        <textarea
          value={f.secondary_emails}
          onChange={(e) => set('secondary_emails', e.target.value)}
          className="input whitespace-pre-wrap"
          rows={2}
          placeholder="accountant@example.com&#10;partner@example.com"
        />
      </L>
      <L label="Address line 1">
        <input
          value={f.address_line1}
          onChange={(e) => set('address_line1', e.target.value)}
          className="input"
          maxLength={200}
        />
      </L>
      <L label="Address line 2">
        <input
          value={f.address_line2}
          onChange={(e) => set('address_line2', e.target.value)}
          className="input"
          maxLength={200}
        />
      </L>
      <div className="grid grid-cols-4 gap-3">
        <L label="City">
          <input
            value={f.city}
            onChange={(e) => set('city', e.target.value)}
            className="input"
            maxLength={100}
          />
        </L>
        <L label="State/Region">
          <input
            value={f.region}
            onChange={(e) => set('region', e.target.value)}
            className="input"
            maxLength={100}
          />
        </L>
        <L label="Postal">
          <input
            value={f.postal_code}
            onChange={(e) => set('postal_code', e.target.value)}
            className="input"
            maxLength={20}
          />
        </L>
        <L label="Country">
          <input
            value={f.country}
            onChange={(e) => set('country', e.target.value)}
            className="input"
            maxLength={100}
          />
        </L>
      </div>
      <L label="How they heard about us">
        <input
          list="heard-from-options"
          value={f.heard_from}
          onChange={(e) => set('heard_from', e.target.value)}
          className="input"
          maxLength={200}
          placeholder="Google, referral, radio…"
        />
        <datalist id="heard-from-options">
          {HEARD_FROM_OPTIONS.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </L>
      <L label="Internal notes">
        <textarea
          value={f.notes}
          onChange={(e) => set('notes', e.target.value)}
          className="input"
          rows={3}
          maxLength={2000}
        />
      </L>

      {error && (
        <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700 hover:bg-ink-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-400">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

export function toDto(v: ClientFormValues) {
  const secondary = v.secondary_emails
    .split(/[\r\n,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    first_name: v.first_name.trim() || undefined,
    last_name: v.last_name.trim() || undefined,
    company: v.company.trim() || undefined,
    email: v.email.trim() || undefined,
    secondary_emails: secondary.length > 0 ? secondary : undefined,
    phone: v.phone.trim() || undefined,
    address_line1: v.address_line1.trim() || undefined,
    address_line2: v.address_line2.trim() || undefined,
    city: v.city.trim() || undefined,
    region: v.region.trim() || undefined,
    postal_code: v.postal_code.trim() || undefined,
    country: v.country.trim() || undefined,
    notes: v.notes.trim() || undefined,
    heard_from: v.heard_from.trim() || undefined,
    client_type: v.client_type,
  };
}

/**
 * Hydrate a ClientFormValues from a server response. Accepts the subset
 * of fields we show in the form so both create-from-scratch and
 * edit-existing use the same shape.
 */
export function fromClient(
  c: Partial<ClientFormValues> & { secondary_emails?: string | string[] | null },
): ClientFormValues {
  const secondary = Array.isArray(c.secondary_emails)
    ? c.secondary_emails.join('\n')
    : typeof c.secondary_emails === 'string'
      ? c.secondary_emails
      : '';
  return {
    first_name: c.first_name ?? '',
    last_name: c.last_name ?? '',
    company: c.company ?? '',
    email: c.email ?? '',
    secondary_emails: secondary,
    phone: c.phone ?? '',
    address_line1: c.address_line1 ?? '',
    address_line2: c.address_line2 ?? '',
    city: c.city ?? '',
    region: c.region ?? '',
    postal_code: c.postal_code ?? '',
    country: c.country ?? '',
    notes: c.notes ?? '',
    heard_from: c.heard_from ?? '',
    client_type: c.client_type ?? 'retail',
  };
}
