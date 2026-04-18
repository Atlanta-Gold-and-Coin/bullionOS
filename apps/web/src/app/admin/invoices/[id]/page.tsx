'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, getAccessToken } from '@/lib/api-client';
import { StatusPill } from '@/components/status-pill';
import { PageTint } from '@/components/page-tint';

interface LineItem {
  id: string;
  position: number;
  quantity: number;
  product_name_snapshot: string;
  spot_price_per_oz: string;
  premium_type: string;
  premium_value: string;
  unit_price: string;
  line_total: string;
  is_overridden: boolean;
}

interface InvoiceDetail {
  id: string;
  invoice_number: string;
  type: 'buy' | 'sell';
  status: string;
  client_name: string;
  client_email: string | null;
  subtotal: string;
  tax: string;
  shipping: string;
  total: string;
  payment_method: string | null;
  payment_status: string;
  created_at: string;
  finalized_at: string | null;
  paid_at: string | null;
  notes: string | null;
  line_items: LineItem[];
}

const NEXT_STATUSES: Record<string, Array<{ value: string; label: string }>> = {
  draft: [
    { value: 'finalized', label: 'Finalize' },
    { value: 'canceled', label: 'Cancel' },
  ],
  finalized: [
    { value: 'paid', label: 'Mark paid' },
    { value: 'shipped', label: 'Mark shipped' },
    { value: 'canceled', label: 'Cancel' },
  ],
  paid: [{ value: 'shipped', label: 'Mark shipped' }],
  shipped: [],
  canceled: [],
};

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'invoice', id],
    queryFn: () => apiFetch<InvoiceDetail>(`/admin/invoices/${id}`),
  });

  async function setStatus(next: string) {
    try {
      await apiFetch(`/admin/invoices/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'invoice', id] });
      await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to update status');
    }
  }

  function openPdf() {
    // The PDF endpoint is auth-gated, so we fetch it with the bearer token
    // and open the resulting blob — this keeps us from sticking the token in a URL.
    const token = getAccessToken();
    fetch(`/api/v1/admin/invoices/${id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.blob())
      .then((blob) => window.open(URL.createObjectURL(blob), '_blank'))
      .catch(() => alert('Failed to open PDF'));
  }

  if (isLoading || !data) {
    return <div className="text-sm text-ink-400">Loading…</div>;
  }

  const options = NEXT_STATUSES[data.status] ?? [];

  return (
    <PageTint side={data.type === 'buy' ? 'buy' : 'sell'}>
    <div className="mx-auto max-w-4xl">
      <div className="mb-4">
        <Link href="/admin/invoices" className="text-sm text-ink-600 hover:text-ink-900">
          ← All invoices
        </Link>
      </div>

      <header className="flex items-start justify-between">
        <div>
          <h1 className="font-mono text-2xl font-semibold">{data.invoice_number}</h1>
          <p className="mt-1 text-sm text-ink-400">
            {data.type.toUpperCase()} · {data.client_name}
            {data.client_email ? ` · ${data.client_email}` : ''}
          </p>
          <p className="mt-0.5 font-mono text-xs text-ink-400">
            {formatLocalDateTime(data.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={data.status} />
          <button
            onClick={openPdf}
            className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
          >
            Download PDF
          </button>
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => setStatus(o.value)}
              className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-ink-800"
            >
              {o.label}
            </button>
          ))}
        </div>
      </header>

      <section className="mt-8 overflow-hidden rounded-xl border border-ink-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">Spot/oz</th>
              <th className="px-4 py-3 text-right">Premium</th>
              <th className="px-4 py-3 text-right">Unit</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.line_items.map((l) => (
              <tr key={l.id} className="border-t border-ink-200">
                <td className="px-4 py-3">
                  {l.product_name_snapshot}
                  {l.is_overridden && (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                      override
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono">{l.quantity}</td>
                <td className="px-4 py-3 text-right font-mono text-ink-600">
                  ${Number(l.spot_price_per_oz).toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-ink-600">
                  {l.premium_type === 'percent'
                    ? `${Number(l.premium_value).toFixed(2)}%`
                    : `$${Number(l.premium_value).toFixed(2)}/oz`}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  ${Number(l.unit_price).toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  ${Number(l.line_total).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-6 ml-auto max-w-sm space-y-1 text-sm">
        <TotalRow label="Subtotal" value={data.subtotal} />
        {Number(data.tax) > 0 && <TotalRow label="Tax" value={data.tax} />}
        {Number(data.shipping) > 0 && <TotalRow label="Shipping" value={data.shipping} />}
        <div className="border-t border-ink-200 pt-1">
          <TotalRow label="Total" value={data.total} bold />
        </div>
      </section>

      <EditHeaderSection invoice={data} />

      <ShipmentSection invoiceId={data.id} invoiceStatus={data.status} />
    </div>
    </PageTint>
  );
}

function ShipmentSection({
  invoiceId,
  invoiceStatus,
}: {
  invoiceId: string;
  invoiceStatus: string;
}) {
  const qc = useQueryClient();
  const { data: existing } = useQuery({
    queryKey: ['admin', 'shipments', 'for', invoiceId],
    queryFn: async () => {
      const all = await apiFetch<Array<{ id: string; invoice_id: string; carrier: string; tracking_number: string | null; status: string; tracking_url: string | null }>>('/admin/shipments');
      return all.find((s) => s.invoice_id === invoiceId) ?? null;
    },
  });
  const [carrier, setCarrier] = useState<'ups' | 'fedex' | 'usps' | 'other'>('ups');
  const [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    setBusy(true);
    try {
      await apiFetch('/admin/shipments', {
        method: 'POST',
        body: JSON.stringify({
          invoice_id: invoiceId,
          carrier,
          tracking_number: tracking || undefined,
        }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'shipments'] });
      await qc.invalidateQueries({ queryKey: ['admin', 'shipments', 'for', invoiceId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-ink-200 bg-white p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Shipment</h2>
      {existing ? (
        <div className="mt-3 text-sm">
          <div className="flex items-center gap-3">
            <span className="uppercase font-medium">{existing.carrier}</span>
            {existing.tracking_number ? (
              existing.tracking_url ? (
                <a
                  href={existing.tracking_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs underline-offset-2 hover:underline"
                >
                  {existing.tracking_number}
                </a>
              ) : (
                <span className="font-mono text-xs">{existing.tracking_number}</span>
              )
            ) : (
              <span className="text-xs text-ink-400">no tracking yet</span>
            )}
            <span className="ml-auto rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600">
              {existing.status.replace(/_/g, ' ')}
            </span>
          </div>
          <p className="mt-3 text-xs text-ink-400">
            Edit tracking + status on the{' '}
            <Link href="/admin/shipments" className="underline">
              shipments page
            </Link>
            .
          </p>
        </div>
      ) : invoiceStatus === 'canceled' ? (
        <p className="mt-3 text-sm text-ink-400">Cannot ship a canceled invoice.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3 md:flex-row">
          <select
            value={carrier}
            onChange={(e) =>
              setCarrier(e.target.value as 'ups' | 'fedex' | 'usps' | 'other')
            }
            className="input md:w-32"
          >
            <option value="ups">UPS</option>
            <option value="fedex">FedEx</option>
            <option value="usps">USPS</option>
            <option value="other">Other</option>
          </select>
          <input
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            placeholder="Tracking # (optional)"
            className="input flex-1"
          />
          <button
            onClick={create}
            disabled={busy}
            className="rounded-md bg-ink-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
          >
            {busy ? 'Creating…' : 'Create shipment'}
          </button>
        </div>
      )}
      {error && (
        <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}
    </section>
  );
}

function TotalRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? 'text-base font-semibold' : 'text-ink-600'}`}>
      <span>{label}</span>
      <span className="font-mono">
        ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}

/**
 * Render the transaction timestamp in the shop's tz so two invoices
 * logged minutes apart stay distinguishable. Format mirrors what the
 * PDF renderer prints, so admin screen and printed ticket match.
 */
function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'venmo', label: 'Venmo' },
  { value: 'wire', label: 'Wire' },
  { value: 'ach', label: 'ACH' },
  { value: 'card', label: 'Card' },
  { value: 'crypto', label: 'Crypto' },
] as const;

/**
 * Header-level editor for an existing invoice. Exposed on every invoice
 * regardless of status — the main use-case is cleaning up a clerical
 * error on a ticket that's already closed (finalized/paid/shipped). Line
 * items aren't editable here because changing quantities on a paid
 * ticket would need to unwind inventory movements; do that via
 * void + recreate for now.
 *
 * Collapsed by default so the detail page stays read-only until the
 * operator explicitly asks to edit.
 */
function EditHeaderSection({ invoice }: { invoice: InvoiceDetail }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [tax, setTax] = useState(String(Number(invoice.tax)));
  const [shipping, setShipping] = useState(String(Number(invoice.shipping)));
  const [paymentMethod, setPaymentMethod] = useState(invoice.payment_method ?? '');
  const [txDate, setTxDate] = useState(localDateInput(invoice.created_at));
  const [txTime, setTxTime] = useState(localTimeInput(invoice.created_at));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function save() {
    setError(null);
    setOk(null);
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        notes: notes.trim() || null,
        tax: Number(tax) || 0,
        shipping: Number(shipping) || 0,
      };
      if (paymentMethod) body.payment_method = paymentMethod;
      if (txDate) {
        const combined = new Date(`${txDate}T${txTime || '12:00'}:00`);
        if (!Number.isNaN(combined.getTime())) {
          body.transacted_at = combined.toISOString();
        }
      }
      await apiFetch(`/admin/invoices/${invoice.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'invoice', invoice.id] });
      await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
      setOk('Saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <section className="mt-8">
        {invoice.notes && (
          <div className="rounded-xl border border-ink-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                Notes
              </h2>
              <button
                onClick={() => setOpen(true)}
                className="text-xs text-ink-600 hover:text-ink-900"
              >
                Edit →
              </button>
            </div>
            <p className="mt-2 text-sm text-ink-800">{invoice.notes}</p>
          </div>
        )}
        {!invoice.notes && (
          <button
            onClick={() => setOpen(true)}
            className="rounded-md border border-ink-200 px-3 py-1.5 text-xs text-ink-700 hover:bg-ink-50"
          >
            Edit invoice details
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="mt-8 rounded-xl border border-ink-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Edit invoice details</h2>
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-ink-500 hover:text-ink-900"
        >
          Close
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-400">
        Changes apply immediately — even on closed tickets. Line items stay
        locked; to adjust quantities or prices, void + recreate.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Payment method
          </span>
          <select
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value)}
            className="input mt-1"
          >
            <option value="">— unchanged —</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Tax
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={tax}
              onChange={(e) => setTax(e.target.value)}
              className="input mt-1 font-mono"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Shipping
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={shipping}
              onChange={(e) => setShipping(e.target.value)}
              className="input mt-1 font-mono"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Transaction date
          </span>
          <input
            type="date"
            value={txDate}
            onChange={(e) => setTxDate(e.target.value)}
            className="input mt-1 font-mono"
          />
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Transaction time
          </span>
          <input
            type="time"
            value={txTime}
            onChange={(e) => setTxTime(e.target.value)}
            className="input mt-1 font-mono"
            step={60}
          />
        </label>
      </div>

      <label className="mt-4 block">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Notes
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="input mt-1"
          maxLength={2000}
        />
      </label>

      {error && (
        <div role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {ok && (
        <div className="mt-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          {ok}
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </section>
  );
}

/** Build a value for <input type="date"> from an ISO timestamp, in
 *  the local timezone so the displayed value matches the header pill. */
function localDateInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTimeInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
