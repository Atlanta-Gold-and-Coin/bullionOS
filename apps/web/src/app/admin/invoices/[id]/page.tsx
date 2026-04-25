'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, getAccessToken } from '@/lib/api-client';
import { StatusPill } from '@/components/status-pill';
import { PageTint } from '@/components/page-tint';
import { useAuth } from '@/lib/auth-context';

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

/**
 * Next-step options for the status-transition buttons on the detail
 * page. Returns the list of valid transitions from the current status,
 * tuned by invoice type + client_type.
 *
 * Apr 2026 operator spec: "make client invoices be marked finalized
 * simply when Mark Paid is clicked — essentially removing the
 * Finalize button." So:
 *   - Retail sell draft    → just [Mark Paid, Cancel] (backend
 *                             routes draft → paid as a direct_sale).
 *   - Wholesale sell draft → stays [Finalize, Cancel] so AR behavior
 *                             (open-invoice ledger until payment
 *                             lands) is preserved.
 *   - Buy drafts           → [Mark Paid, Cancel] in every case —
 *                             a buy never reserves, so Finalize
 *                             never added value.
 * Other states unchanged.
 */
function nextStatusesFor(invoice: {
  status: string;
  type: 'buy' | 'sell';
  client_type?: 'retail' | 'wholesaler';
}): Array<{ value: string; label: string }> {
  switch (invoice.status) {
    case 'draft': {
      // Retail sell + any buy → skip Finalize, go straight to Paid.
      // Wholesale sell keeps the explicit Finalize step.
      const skipFinalize =
        invoice.type === 'buy' || invoice.client_type !== 'wholesaler';
      return skipFinalize
        ? [
            { value: 'paid', label: 'Mark Paid' },
            { value: 'canceled', label: 'Cancel' },
          ]
        : [
            { value: 'finalized', label: 'Finalize' },
            { value: 'canceled', label: 'Cancel' },
          ];
    }
    case 'finalized':
      return [
        { value: 'paid', label: 'Mark Paid' },
        { value: 'shipped', label: 'Mark Shipped' },
        { value: 'canceled', label: 'Cancel' },
      ];
    case 'paid':
      return [{ value: 'shipped', label: 'Mark Shipped' }];
    // shipped → paid supports the wholesale "ship first, pay later"
    // workflow. Invoice stays on Wholesale AR until this fires.
    case 'shipped':
      return [{ value: 'paid', label: 'Mark Paid' }];
    case 'canceled':
    default:
      return [];
  }
}

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  // Oversell override: admin-only. Lets a sell invoice finalize or consume
  // stock that isn't (or won't be) on the shelf. Rare — used for agreed
  // pre-sales against incoming shipments. Scoped to this page-load; the
  // next successful status transition resets it so a distracted operator
  // can't silently oversell on subsequent tickets.
  const [forceOversell, setForceOversell] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'invoice', id],
    queryFn: () => apiFetch<InvoiceDetail>(`/admin/invoices/${id}`),
  });

  async function setStatus(next: string) {
    try {
      const body: Record<string, unknown> = { status: next };
      // Only attach force_oversell on transitions that actually touch
      // inventory — no-op transitions don't need it and sending it would
      // muddy the audit log.
      if (forceOversell && isAdmin && (next === 'finalized' || next === 'paid' || next === 'shipped')) {
        body.force_oversell = true;
      }
      await apiFetch(`/admin/invoices/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setForceOversell(false);
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
  /**
   * PIN-gated force delete. Works on any status except shipped (physical
   * goods already out). Prompts twice: a confirm + a PIN entry, matching
   * the product Purge pattern. Clears caches and routes back to the
   * invoices list on success.
   */
  async function forceDelete() {
    if (!data) return;
    if (
      !confirm(
        `Permanently delete invoice ${data.invoice_number}?\n\nThis removes the row and all line items. No "Restore" afterwards. If you want a safe reversal, use Void & recreate instead.`,
      )
    )
      return;
    const pin = prompt('Enter delete PIN to confirm:');
    if (!pin) return;
    try {
      await apiFetch(
        `/admin/invoices/${id}?pin=${encodeURIComponent(pin.trim())}`,
        { method: 'DELETE' },
      );
      await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
      router.push('/admin/invoices');
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Delete failed');
    }
  }

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

  /**
   * Print-direct: fetch the PDF, drop it into a hidden iframe that lives
   * on this same document, and call print() from inside. No download
   * step, no new tab, no blocked popup. Works for drafts too — the PDF
   * renderer has no status gate, so operators can print an in-progress
   * ticket for a client to review.
   */
  function printPdf() {
    const token = getAccessToken();
    fetch(`/api/v1/admin/invoices/${id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error('fetch failed');
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        // Remove any previous print frame from an earlier click so we
        // don't leak DOM nodes if the operator prints several times.
        const prior = document.getElementById('agc-print-frame');
        if (prior) prior.remove();

        const iframe = document.createElement('iframe');
        iframe.id = 'agc-print-frame';
        iframe.style.cssText =
          'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
        iframe.src = url;
        iframe.onload = () => {
          // Small defer so the browser's PDF viewer finishes rendering
          // before we poke the print dialog. Without this, Chrome
          // occasionally prints a blank page on the first call.
          setTimeout(() => {
            try {
              iframe.contentWindow?.focus();
              iframe.contentWindow?.print();
            } catch {
              // Fallback if an embedded PDF can't accept print() — open
              // in a new tab so the operator still has a path.
              window.open(url, '_blank');
            }
          }, 250);
        };
        document.body.appendChild(iframe);
        // Revoke the blob URL after a minute so the page doesn't hold
        // memory for every print click through the session.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(() => alert('Failed to print'));
  }

  if (isLoading || !data) {
    return <div className="text-sm text-ink-400">Loading…</div>;
  }

  const options = nextStatusesFor({
    status: data.status,
    type: data.type,
    client_type: data.client_type,
  });

  return (
    <PageTint side={data.type === 'buy' ? 'buy' : 'sell'}>
    <div className="mx-auto max-w-4xl">
      <div className="mb-4">
        <Link href="/admin/invoices" className="text-sm text-ink-600 hover:text-ink-900">
          ← All invoices
        </Link>
      </div>

      {/* Hero card (Apr 2026 polish). Previously this was a plain flex
          row; operators were asking for something that reads like an
          invoice "cover sheet" rather than a page title. The card now
          carries a side-specific accent rail (buy-600 / sell-600), a
          large invoice number + type badge, and a small metadata strip.
          Action cluster sits to the right on md+, wraps below on mobile. */}
      <section className="relative mb-2 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
        {/* Accent rail — buy/sell color */}
        <div
          aria-hidden
          className={`absolute inset-y-0 left-0 w-1 ${
            data.type === 'buy' ? 'bg-buy-600' : 'bg-sell-600'
          }`}
        />
        <header className="flex flex-col gap-4 p-5 md:flex-row md:items-start md:justify-between md:p-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  data.type === 'buy'
                    ? 'bg-buy-600/10 text-buy-700'
                    : 'bg-sell-600/10 text-sell-700'
                }`}
              >
                {data.type === 'buy' ? 'Buy ticket' : 'Invoice'}
              </span>
              {data.client_type === 'wholesaler' && (
                <span className="rounded-full bg-gold-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gold-600">
                  Wholesale
                </span>
              )}
            </div>
            <h1 className="mt-1 font-mono text-3xl font-semibold tracking-tight text-ink-900">
              {data.invoice_number}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-600">
              <span className="font-medium text-ink-800">{data.client_name}</span>
              {data.client_company &&
                !data.client_name.includes(data.client_company) && (
                  <>
                    <span className="text-ink-300">·</span>
                    <span>{data.client_company}</span>
                  </>
                )}
              {data.client_email && (
                <>
                  <span className="text-ink-300">·</span>
                  <a
                    href={`mailto:${data.client_email}`}
                    className="hover:text-ink-900 hover:underline"
                  >
                    {data.client_email}
                  </a>
                </>
              )}
            </div>
            <p className="mt-0.5 font-mono text-xs text-ink-400">
              {formatLocalDateTime(data.created_at)}
            </p>
          </div>
        {/* Apr 2026 polish: header action cluster is broken into three
            visual groups so the 6–9 buttons that can appear here stop
            looking like a single undifferentiated row.
              1. File-actions pill (Print · Download · Email) — grouped
                 together so operators recognize them as "same family."
              2. Status transitions (Continue editing, Mark paid, dropdown
                 options) — the primary-hero group, dark fill.
              3. Destructive (Void & recreate, Delete) — visually
                 separated by a slim divider + quieter styling so the
                 eye doesn't land on them first.
            Every onClick/handler is preserved verbatim. */}
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={data.status} paymentStatus={data.payment_status} />

          {/* File-actions pill. EmailInvoiceButton is its own component
              (manages its own popover); keeping it inside the pill means
              its trigger button sits alongside Print + Download for
              consistent visual weight. */}
          <div className="inline-flex rounded-md border border-ink-200 bg-ink-50/50 p-0.5">
            <button
              onClick={printPdf}
              className="rounded px-3 py-1 text-sm text-ink-700 hover:bg-white hover:text-ink-900"
              title="Open the print dialog directly — works on drafts too"
            >
              Print
            </button>
            <button
              onClick={openPdf}
              className="rounded px-3 py-1 text-sm text-ink-700 hover:bg-white hover:text-ink-900"
              title="Download the PDF"
            >
              Download
            </button>
            <EmailInvoiceButton
              invoiceId={data.id}
              defaultTo={data.client_email ?? ''}
            />
          </div>

          {/* Draft-only "Continue editing" → resumes the wizard bound to
              this draft via ?draftId. Without this, operators landing on
              the detail page of a saved-but-unfinished invoice have no
              path back to line-item editing and resort to Void & recreate
              (which throws away numbering continuity). */}
          {data.status === 'draft' && (
            <Link
              href={`/admin/invoices/new?draftId=${data.id}`}
              className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-ink-800"
              title="Open the invoice wizard to edit line items, quantities, and payment"
            >
              Continue editing
            </Link>
          )}

          {/* Wholesale-specific Mark Paid button (WH-002). More prominent
              than the generic "Mark paid" option in the status dropdown;
              stamps paid_by_user_id automatically via the service.
              Shown on `finalized` AND `shipped` — wholesalers commonly
              pay after the goods arrive, so AR must stay open through
              the shipped state until this fires. */}
          {data.client_type === 'wholesaler' &&
            (data.status === 'finalized' || data.status === 'shipped') &&
            !data.paid_at && (
              <button
                onClick={() => setStatus('paid')}
                className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-green-700"
                title="Record that this wholesaler has paid — removes from outstanding totals"
              >
                Mark Paid
              </button>
            )}

          {/* Status transition buttons. Hide the generic "Mark paid" from
              the list for wholesalers — they use the dedicated green
              button above. */}
          {options
            .filter(
              (o) =>
                !(data.client_type === 'wholesaler' && o.value === 'paid'),
            )
            .map((o) => (
              <button
                key={o.value}
                onClick={() => setStatus(o.value)}
                className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-ink-800"
              >
                {o.label}
              </button>
            ))}

          {/* Destructive group, visually separated. Void & recreate is
              amber (reversible, keeps history); Delete is red and
              admin-PIN-gated (permanent). */}
          <span aria-hidden className="mx-1 h-6 w-px bg-ink-200" />
          <button
            onClick={voidAndRecreate}
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
            title="Void this invoice and start a new one with the same fields pre-filled"
          >
            Void &amp; Recreate
          </button>
          {isAdmin && data.status !== 'shipped' && (
            <button
              onClick={forceDelete}
              className="rounded-md px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
              title="Permanently delete this invoice (PIN-gated)"
            >
              Delete
            </button>
          )}
        </div>
      </header>

      {/* Metrics strip — at-a-glance summary inside the hero card so
          operators don't have to scan line items to learn the total,
          item count, or whether payment is booked. Lives inside the
          same card to read as "invoice summary", not a separate
          widget. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-ink-100 px-5 py-4 md:grid-cols-4 md:px-6">
        <MetricCell
          label="Total"
          value={`$${Number(data.total).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`}
          prominent
        />
        <MetricCell label="Items" value={String(data.line_items.length)} />
        <MetricCell
          label="Status"
          value={String(data.status).replace('_', ' ')}
          mono={false}
          capitalize
        />
        <MetricCell
          label={data.paid_at ? 'Paid' : 'Unpaid'}
          value={
            data.paid_at ? formatLocalDateTime(data.paid_at) : '—'
          }
          mono={!!data.paid_at}
        />
      </div>
      </section>

      {/* Oversell override — admin-only, sell invoices only, and only while
          there's still a stock-moving transition available. Consciously
          placed outside the button row so it reads as a modifier, not a
          mid-row control. Resets after the next successful transition. */}
      {isAdmin &&
        data.type === 'sell' &&
        (options.some((o) => o.value === 'finalized' || o.value === 'paid' || o.value === 'shipped')) && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <input
              id="force-oversell"
              type="checkbox"
              checked={forceOversell}
              onChange={(e) => setForceOversell(e.target.checked)}
              className="mt-0.5"
            />
            <label htmlFor="force-oversell" className="leading-snug">
              <span className="font-semibold">Override stock check</span> — allow
              this invoice to reserve/consume more than is on hand. Used for
              pre-sales against incoming stock. Inventory will go negative;
              every movement is audit-logged.
            </label>
          </div>
        )}

      {/* Line items table. Apr 2026 polish: zebra striping on even rows
          so the eye can track long lists; sticky-ish header row inside
          the card; tabular-nums on all money columns so decimals line
          up; subtle tint (buy → red, sell → green) on the header row
          matching the hero accent. */}
      <section className="mt-6 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead
            className={`text-left text-[11px] font-semibold uppercase tracking-wider ${
              data.type === 'buy'
                ? 'bg-buy-600/5 text-buy-700'
                : 'bg-sell-600/5 text-sell-700'
            }`}
          >
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
            {data.line_items.map((l, idx) => (
              <tr
                key={l.id}
                className={`border-t border-ink-100 ${
                  idx % 2 === 1 ? 'bg-ink-50/50' : ''
                }`}
              >
                <td className="px-4 py-3">
                  <span className="font-medium text-ink-900">
                    {l.product_name_snapshot}
                  </span>
                  {l.is_overridden && (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                      override
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">
                  {l.quantity}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-500">
                  ${Number(l.spot_price_per_oz).toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-500">
                  {l.premium_type === 'percent'
                    ? `${Number(l.premium_value).toFixed(2)}%`
                    : `$${Number(l.premium_value).toFixed(2)}/oz`}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">
                  ${Number(l.unit_price).toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums text-ink-900">
                  ${Number(l.line_total).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Totals card — right-aligned on md+, full width on phone. The
          TOTAL row gets a subtle side-colored background so it reads
          as the terminal figure without needing a big border rule. */}
      <section className="mt-4 md:ml-auto md:max-w-sm">
        <div className="overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
          <div className="space-y-1 px-4 py-3 text-sm">
            <TotalRow label="Subtotal" value={data.subtotal} />
            {Number(data.tax) > 0 && <TotalRow label="Tax" value={data.tax} />}
            {Number(data.shipping) > 0 && (
              <TotalRow label="Shipping" value={data.shipping} />
            )}
          </div>
          <div
            className={`flex items-baseline justify-between border-t border-ink-200 px-4 py-3 ${
              data.type === 'buy'
                ? 'bg-buy-600/5'
                : 'bg-sell-600/5'
            }`}
          >
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Total
            </span>
            <span
              className={`font-mono text-xl font-semibold tabular-nums ${
                data.type === 'buy' ? 'text-buy-700' : 'text-sell-700'
              }`}
            >
              $
              {Number(data.total).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
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

interface ShipmentRow {
  id: string;
  invoice_id: string;
  carrier: string;
  tracking_number: string | null;
  delivery_speed: string | null;
  status: string;
  tracking_url: string | null;
  created_at: string;
}

function ShipmentSection({
  invoiceId,
  invoiceStatus,
}: {
  invoiceId: string;
  invoiceStatus: string;
}) {
  const qc = useQueryClient();
  // Multiple shipments per invoice (migration 034): a large wholesale
  // order or a split retail send often goes out in two or three
  // packages. Pull everything for this invoice, render each with its
  // own carrier / tracking / status, and keep the add-new form below
  // so operators can drop in another package anytime.
  const { data: existing } = useQuery<ShipmentRow[]>({
    queryKey: ['admin', 'shipments', 'for', invoiceId],
    queryFn: async () => {
      const all = await apiFetch<ShipmentRow[]>('/admin/shipments');
      return all
        .filter((s) => s.invoice_id === invoiceId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
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
      // Reset the form so the operator can queue another without
      // re-clearing fields — common case is 2-3 packages in a row.
      setTracking('');
      setDeliverySpeed('');
      await qc.invalidateQueries({ queryKey: ['admin', 'shipments'] });
      await qc.invalidateQueries({ queryKey: ['admin', 'shipments', 'for', invoiceId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const shipments = existing ?? [];
  const hasAny = shipments.length > 0;
  const addFormDisabled = invoiceStatus === 'canceled';

  return (
    <section className="mt-8 rounded-xl border border-ink-200 bg-white p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          {hasAny
            ? `Shipments · ${shipments.length}`
            : 'Shipments'}
        </h2>
        {hasAny && (
          <Link
            href="/admin/shipments"
            className="text-[11px] text-ink-500 underline-offset-2 hover:underline"
          >
            manage all →
          </Link>
        )}
      </div>

      {hasAny && (
        <ul className="mt-3 space-y-2">
          {shipments.map((s, i) => (
            <li
              key={s.id}
              className="rounded-md border border-ink-100 bg-ink-50/40 px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-900 text-[10px] font-semibold text-white">
                  {i + 1}
                </span>
                <span className="font-medium uppercase">{s.carrier}</span>
                {s.delivery_speed && (
                  <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-700">
                    {s.delivery_speed}
                  </span>
                )}
                {s.tracking_number ? (
                  s.tracking_url ? (
                    <a
                      href={s.tracking_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs underline-offset-2 hover:underline"
                    >
                      {s.tracking_number}
                    </a>
                  ) : (
                    <span className="font-mono text-xs">{s.tracking_number}</span>
                  )
                ) : (
                  <span className="text-xs text-ink-400">no tracking yet</span>
                )}
                <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-ink-600 ring-1 ring-ink-200">
                  {s.status.replace(/_/g, ' ')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {addFormDisabled ? (
        !hasAny && (
          <p className="mt-3 text-sm text-ink-400">Cannot ship a canceled invoice.</p>
        )
      ) : (
        <div className="mt-4 border-t border-ink-100 pt-4">
          <div className="mb-2 text-[11px] font-medium text-ink-500">
            {hasAny ? 'Add another shipment' : 'Create shipment'}
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap">
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
              {busy ? 'Creating…' : hasAny ? 'Add shipment' : 'Create shipment'}
            </button>
          </div>
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
 * Small summary cell used in the hero card's metrics strip. Four sit in
 * a row on md+, collapsing to a 2-column grid on phone. `prominent`
 * bumps the value to ~2xl for the Total cell; `capitalize` is only
 * meaningful on text values like the status word; everything else
 * defaults to a tabular-nums mono figure so number columns line up.
 */
function MetricCell({
  label,
  value,
  prominent = false,
  mono = true,
  capitalize = false,
}: {
  label: string;
  value: string;
  prominent?: boolean;
  mono?: boolean;
  capitalize?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
        {label}
      </div>
      <div
        className={`mt-0.5 ${
          prominent ? 'text-2xl font-semibold text-ink-900' : 'text-base text-ink-700'
        } ${mono ? 'font-mono tabular-nums' : ''} ${capitalize ? 'capitalize' : ''}`}
      >
        {value}
      </div>
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
            <span className="font-medium text-ink-800">
              {/*
                Format payment method for display. CSS `capitalize` would
                render "ach" as "Ach" which reads like a typo on a
                financial document; hard-case it via formatPaymentMethod
                so ACH (and any future all-caps acronym) stays shouty.
              */}
              {formatPaymentMethod(leg.method) || '(unspecified)'}
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
    // Styled to slot cleanly inside the header's file-actions pill
    // alongside Print + Download — no outer border (the pill carries
    // that), same hover treatment as its siblings.
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded px-3 py-1 text-sm text-ink-700 hover:bg-white hover:text-ink-900"
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

/**
 * Format a payment-method slug for human display.
 *
 * Most slugs ("cash", "check", "zelle") want title-case. Short
 * acronyms (ACH) must stay fully uppercase — "Ach" reads as a typo on
 * a financial document. Mirror of the backend's PDF-side capitalize()
 * so the web and the PDF read identically.
 */
function formatPaymentMethod(s: string): string {
  if (!s) return '';
  const upper = s.toUpperCase();
  if (upper === 'ACH') return 'ACH';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
