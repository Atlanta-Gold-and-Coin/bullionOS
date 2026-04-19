'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, getAccessToken } from '@/lib/api-client';
import { StatusPill } from '@/components/status-pill';
import { PageTint } from '@/components/page-tint';

interface LineItem {
  id: string;
  position: number;
  /** Null when the original line was ad-hoc or the product has been deleted. */
  product_id: string | null;
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
  client_id: string;
  client_name: string;
  client_email: string | null;
  /** Wholesale vs retail — drives the "Mark paid" button + receivables view. */
  client_type?: 'retail' | 'wholesaler';
  client_company?: string | null;
  subtotal: string;
  tax: string;
  shipping: string;
  total: string;
  payment_method: string | null;
  payment_methods: Array<{
    method: string;
    reference: string | null;
    amount: string;
  }>;
  payment_status: string;
  created_at: string;
  finalized_at: string | null;
  paid_at: string | null;
  paid_by_user_id?: string | null;
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
  const router = useRouter();
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

  /**
   * Void & recreate flow. Cancels the current invoice (which reverses
   * any inventory movements the old lines caused — see
   * classifyInventoryAction) and then kicks the operator over to the
   * new-invoice wizard with ?from=<id> so every field pre-fills from
   * this ticket as a starting point.
   */
  async function voidAndRecreate() {
    const msg =
      data?.status === 'draft'
        ? 'Cancel this draft and open a new blank invoice with the same fields pre-filled?'
        : 'Void this invoice and open a new editable copy?\n\nInventory tied to the old ticket will be released (reservations) or returned to stock (paid sales). The old invoice stays in the history as CANCELED — totals on any past reports won\u2019t change.';
    if (!confirm(msg)) return;
    try {
      if (data?.status !== 'canceled') {
        await apiFetch(`/admin/invoices/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'canceled' }),
        });
      }
      await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
      router.push(`/admin/invoices/new?from=${id}`);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Void failed');
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

      <header className="flex flex-col items-start justify-between gap-3 md:flex-row md:flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold">{data.invoice_number}</h1>
            {data.client_type === 'wholesaler' && (
              <span className="rounded-full bg-gold-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold-600">
                Wholesale
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-400">
            {data.type.toUpperCase()} · {data.client_name}
            {data.client_company &&
              !data.client_name.includes(data.client_company) && (
                <span className="text-ink-500"> · {data.client_company}</span>
              )}
            {data.client_email ? ` · ${data.client_email}` : ''}
          </p>
          <p className="mt-0.5 font-mono text-xs text-ink-400">
            {formatLocalDateTime(data.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={data.status} />
          {/* Wholesale-specific Mark Paid button (WH-002). More prominent
              than the generic "Mark paid" option in the status dropdown;
              stamps paid_by_user_id automatically via the service. */}
          {data.client_type === 'wholesaler' && data.status === 'finalized' && (
            <button
              onClick={() => setStatus('paid')}
              className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700"
              title="Record that this wholesaler has paid — removes from outstanding totals"
            >
              Mark paid
            </button>
          )}
          <button
            onClick={openPdf}
            className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
          >
            Download PDF
          </button>
          <EmailInvoiceButton
            invoiceId={data.id}
            defaultTo={data.client_email ?? ''}
          />
          {/* Void & recreate — surfaced on every status so an operator
              can correct a line item by opening a fresh copy. Cancels the
              current invoice (which reverses any inventory it caused) and
              opens the wizard pre-filled. */}
          <button
            onClick={voidAndRecreate}
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
            title="Void this invoice and start a new one with the same fields pre-filled"
          >
            Void &amp; recreate
          </button>
          {/* Hide the generic "Mark paid" from the status dropdown for
              wholesalers — they use the dedicated green button above. */}
          {options
            .filter(
              (o) =>
                !(data.client_type === 'wholesaler' && o.value === 'paid'),
            )
            .map((o) => (
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

      {/* Payment methods block — shown for every status including draft
          (INV-010) so operators can verify the split is correct before
          finalizing. Renders from payment_methods[] JSONB; falls back to
          the legacy single payment_method column if the array is empty. */}
      <PaymentMethodsPanel invoice={data} />

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
      const all = await apiFetch<
        Array<{
          id: string;
          invoice_id: string;
          carrier: string;
          tracking_number: string | null;
          delivery_speed: string | null;
          status: string;
          tracking_url: string | null;
        }>
      >('/admin/shipments');
      return all.find((s) => s.invoice_id === invoiceId) ?? null;
    },
  });

  // Delivery-speed whitelist (SHIP-001). Fetched once + cached forever —
  // the list only changes when the API's delivery-speeds.ts does.
  const { data: speeds } = useQuery({
    queryKey: ['admin', 'shipments', 'delivery-speeds'],
    queryFn: () =>
      apiFetch<Record<'usps' | 'ups' | 'fedex' | 'other', string[]>>(
        '/admin/shipments/delivery-speeds',
      ),
    staleTime: Infinity,
  });

  const [carrier, setCarrier] = useState<'ups' | 'fedex' | 'usps' | 'other'>('ups');
  const [tracking, setTracking] = useState('');
  const [deliverySpeed, setDeliverySpeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset speed when carrier changes — the prior value may no longer be
  // valid for the new carrier's whitelist.
  const carrierSpeeds = speeds?.[carrier] ?? [];
  if (deliverySpeed && !carrierSpeeds.includes(deliverySpeed)) {
    // Intentionally not a useEffect — safe to run inline on each render
    // since setting to '' is idempotent once the guard above is satisfied.
    setTimeout(() => setDeliverySpeed(''), 0);
  }

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
          delivery_speed: deliverySpeed || undefined,
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
          <div className="flex flex-wrap items-center gap-3">
            <span className="uppercase font-medium">{existing.carrier}</span>
            {existing.delivery_speed && (
              <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-700">
                {existing.delivery_speed}
              </span>
            )}
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
            Edit tracking, speed + status on the{' '}
            <Link href="/admin/shipments" className="underline">
              shipments page
            </Link>
            .
          </p>
        </div>
      ) : invoiceStatus === 'canceled' ? (
        <p className="mt-3 text-sm text-ink-400">Cannot ship a canceled invoice.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2 md:flex-row md:flex-wrap">
          <select
            value={carrier}
            onChange={(e) =>
              setCarrier(e.target.value as 'ups' | 'fedex' | 'usps' | 'other')
            }
            className="input md:w-28"
          >
            <option value="ups">UPS</option>
            <option value="fedex">FedEx</option>
            <option value="usps">USPS</option>
            <option value="other">Other</option>
          </select>
          <select
            value={deliverySpeed}
            onChange={(e) => setDeliverySpeed(e.target.value)}
            disabled={carrierSpeeds.length === 0}
            className="input md:w-56"
          >
            <option value="">
              {carrierSpeeds.length === 0
                ? '— no service levels —'
                : '— service level —'}
            </option>
            {carrierSpeeds.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            placeholder="Tracking # (optional)"
            className="input flex-1 md:min-w-[200px]"
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
 * Payment methods + amounts (ticket INV-010). Source of truth is the
 * JSONB `payment_methods` array written at create/update time; we also
 * fall back to the legacy single-method column for rows that predate the
 * array format. Draft invoices get the same treatment so operators can
 * verify the split before finalizing.
 */
function PaymentMethodsPanel({ invoice }: { invoice: InvoiceDetail }) {
  const legs = invoice.payment_methods ?? [];
  if (legs.length === 0 && !invoice.payment_method) {
    return (
      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Payment
        </h2>
        <p className="mt-2 text-sm text-ink-400">No payment recorded.</p>
      </section>
    );
  }

  const displayLegs =
    legs.length > 0
      ? legs
      : // Synthetic single-leg row from the legacy column so the render
        // stays uniform.
        [
          {
            method: invoice.payment_method ?? '',
            reference: null,
            amount: invoice.total,
          },
        ];

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Payment
        </h2>
        {invoice.paid_at && (
          <span className="text-xs text-green-700">
            Paid {new Date(invoice.paid_at).toLocaleDateString()}
          </span>
        )}
      </div>
      <ul className="mt-3 divide-y divide-ink-100">
        {displayLegs.map((leg, i) => (
          <li
            key={i}
            className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
          >
            <span className="font-medium capitalize text-ink-800">
              {leg.method || '(unspecified)'}
            </span>
            {leg.reference && (
              <span className="truncate text-xs text-ink-500">{leg.reference}</span>
            )}
            <span className="ml-auto font-mono">
              $
              {Number(leg.amount).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Email this invoice as a PDF attachment. Opens a popover input
 * prefilled with the client's primary email; clicking Send POSTs to
 * /email. The address is optionally saved as a secondary on the client
 * record so repeated emails to that accountant/partner remember it.
 */
function EmailInvoiceButton({
  invoiceId,
  defaultTo,
}: {
  invoiceId: string;
  defaultTo: string;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(defaultTo);
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setFlash(null);
    try {
      const res = await apiFetch<{ sent_to: string; saved_to_client: boolean }>(
        `/admin/invoices/${invoiceId}/email`,
        {
          method: 'POST',
          body: JSON.stringify({ to: to.trim().toLowerCase(), save_to_client: save }),
        },
      );
      setFlash(
        res.saved_to_client
          ? `Sent · saved to client record`
          : `Sent to ${res.sent_to}`,
      );
      setTimeout(() => setOpen(false), 1200);
    } catch (err) {
      setFlash(err instanceof ApiError ? err.message : 'Send failed');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
        title="Email this invoice as a PDF attachment"
      >
        Email
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-ink-200 bg-white p-2 shadow-sm">
      <input
        type="email"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="recipient@example.com"
        className="input w-56"
        autoFocus
      />
      <label className="flex items-center gap-1 text-[11px] text-ink-500">
        <input
          type="checkbox"
          checked={save}
          onChange={(e) => setSave(e.target.checked)}
        />
        save
      </label>
      <button
        onClick={send}
        disabled={busy || !to}
        className="rounded-md bg-ink-900 px-3 py-1 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
      >
        {busy ? 'Sending…' : 'Send'}
      </button>
      <button
        onClick={() => setOpen(false)}
        className="rounded-md px-2 py-1 text-xs text-ink-500 hover:bg-ink-50"
      >
        Cancel
      </button>
      {flash && (
        <span className="w-full text-[11px] text-ink-600">{flash}</span>
      )}
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
            {/* INV-009: preserve line breaks + wrap long tokens so notes
                can't overflow the card container. */}
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-800">
              {invoice.notes}
            </p>
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

        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Transaction date &amp; time
            </span>
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                setTxDate(
                  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
                    now.getDate(),
                  ).padStart(2, '0')}`,
                );
                setTxTime(
                  `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
                );
              }}
              className="rounded-md bg-ink-900 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-ink-800"
            >
              Now
            </button>
          </div>
          <div className="mt-1 flex gap-2">
            <input
              type="date"
              value={txDate}
              onChange={(e) => setTxDate(e.target.value)}
              className="input font-mono md:w-44"
              aria-label="Transaction date"
            />
            <input
              type="time"
              value={txTime}
              onChange={(e) => setTxTime(e.target.value)}
              className="input font-mono md:w-32"
              aria-label="Transaction time"
              step={60}
            />
          </div>
        </div>
        <div className="hidden md:block" />
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
