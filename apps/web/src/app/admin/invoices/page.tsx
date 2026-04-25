'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { StatusPill } from '@/components/status-pill';
import { useAuth } from '@/lib/auth-context';

interface InvoiceRow {
  id: string;
  invoice_number: string;
  type: 'buy' | 'sell';
  status: string;
  subtotal: string;
  total: string;
  created_at: string;
  payment_status: string;
  client_name: string;
  client_type: 'retail' | 'wholesaler';
}

type Tab =
  | 'recent'
  | 'drafts'
  | 'unpaid'
  | 'sales'
  | 'purchase'
  | 'wholesale'
  | 'canceled'
  | 'all';

const TABS: Array<{ id: Tab; label: string }> = [
  // 'Recent' moved from the dashboard (Apr 2026) — top-level tab so
  // invoice triage has a single home. Defaults to the opening tab on
  // this page.
  { id: 'recent', label: 'Recent' },
  { id: 'drafts', label: 'Drafts' },
  // Cross-type AR view: finalized/shipped + payment_status!=paid.
  // Added so the Unpaid hero metric has a direct click target; keeps
  // "what's owed to us?" a single click away from the invoice home.
  { id: 'unpaid', label: 'Unpaid' },
  { id: 'sales', label: 'Sales' },
  { id: 'purchase', label: 'Purchase' },
  { id: 'wholesale', label: 'Wholesale' },
  // Canceled rows are hard-deletable by admins — cleanup for test
  // records or accidental voids.
  { id: 'canceled', label: 'Canceled' },
  { id: 'all', label: 'All' },
];

/**
 * Map each tab to a server-side filter. Drafts cuts by status; Sales and
 * Purchase cut by invoice type (sell vs buy); Wholesale cuts by the
 * client's client_type. Recent mirrors "All" server-side; the page
 * slices to the top N on the client so the quick scan stays short.
 */
function queryFor(tab: Tab): string {
  switch (tab) {
    case 'drafts':
      return '/admin/invoices?status=draft';
    case 'sales':
      return '/admin/invoices?type=sell&client_type=retail';
    case 'purchase':
      return '/admin/invoices?type=buy';
    case 'wholesale':
      return '/admin/invoices?client_type=wholesaler';
    case 'canceled':
      return '/admin/invoices?status=canceled';
    // Unpaid has no server-side filter (payment_status isn't a query
    // param on /admin/invoices), so we fetch everything and narrow
    // client-side in `filtered`. The list caps at 500 rows, so the
    // cost is bounded.
    case 'unpaid':
    case 'recent':
    case 'all':
    default:
      return '/admin/invoices';
  }
}

export default function InvoicesPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [tab, setTab] = useState<Tab>('recent');
  const { data } = useQuery({
    queryKey: ['admin', 'invoices', tab],
    queryFn: () => apiFetch<InvoiceRow[]>(queryFor(tab)),
  });

  async function deleteRow(id: string, invoiceNumber: string) {
    // Canceled-invoice deletion is admin-only + audit-logged on the
    // server. We still confirm on the client because it's terminal.
    if (
      !confirm(
        `Permanently delete invoice ${invoiceNumber}?\n\nThis removes the row and its line items. The audit log retains the delete event, but the invoice history itself is gone.`,
      )
    )
      return;
    try {
      await apiFetch(`/admin/invoices/${id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Delete failed');
    }
  }
  // Canceled + draft rows are each visible on exactly one tab — their
  // own. Everywhere else (Recent / Sales / Purchase / Wholesale / All)
  // hides them so day-to-day triage only sees committed invoices.
  // Unpaid additionally narrows to (finalized|shipped) +
  // payment_status != paid. API doesn't support a status≠X or
  // payment_status filter, so we strip client-side — the 500-row cap
  // on the list endpoint keeps this trivial.
  const filtered = (data ?? []).filter((inv) => {
    if (tab === 'canceled') return inv.status === 'canceled';
    if (tab === 'drafts') return inv.status === 'draft';
    if (tab === 'unpaid') {
      return (
        (inv.status === 'finalized' || inv.status === 'shipped') &&
        inv.payment_status !== 'paid'
      );
    }
    return inv.status !== 'canceled' && inv.status !== 'draft';
  });
  // "Recent" is a compact top-N slice of the same payload "All" fetches.
  // Rendered-at-top-of-list is the UX win; the server payload is small
  // enough (<= 500 rows) that filtering client-side is fine.
  const displayRows = tab === 'recent' ? filtered.slice(0, 15) : filtered;

  // Top-of-page metric strip — quick scan of "what's in this view" so
  // operators don't have to count rows or eyeball the table. Computed
  // against `data` (the full payload for the current tab) rather than
  // `filtered` so the draft / canceled tabs still show meaningful
  // counts of their own rows.
  const metrics = useMemo(() => {
    const rows = data ?? [];
    const totalSum = rows
      .filter((r) => r.status !== 'draft' && r.status !== 'canceled')
      .reduce((s, r) => s + Number(r.total || 0), 0);
    const drafts = rows.filter((r) => r.status === 'draft').length;
    const unpaid = rows.filter(
      (r) =>
        (r.status === 'finalized' || r.status === 'shipped') &&
        r.payment_status !== 'paid',
    ).length;
    const canceled = rows.filter((r) => r.status === 'canceled').length;
    return {
      totalSum,
      count: rows.filter((r) => r.status !== 'draft' && r.status !== 'canceled')
        .length,
      drafts,
      unpaid,
      canceled,
    };
  }, [data]);

  return (
    <div className="mx-auto max-w-6xl">
      {/* Hero card — invoice surface summary. Same visual language as
          the invoice-detail page (rounded-xl + shadow-sm card, small
          uppercase-kerned metric labels). Provides a "what's here?"
          one-glance read so operators don't have to scroll the table
          to learn the shape of the current view. */}
      <section className="relative overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-ink-900"
        />
        <header className="flex flex-col gap-4 p-5 md:flex-row md:items-start md:justify-between md:p-6">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
              Invoices
            </div>
            <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink-900">
              {filtered.length}
              <span className="ml-1 text-base font-normal text-ink-500">
                row{filtered.length === 1 ? '' : 's'} in {TABS.find((t) => t.id === tab)?.label.toLowerCase()}
              </span>
            </h1>
          </div>
          <Link
            href="/admin/invoices/new"
            className="inline-flex items-center justify-center rounded-md bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-ink-800"
          >
            New invoice
          </Link>
        </header>

        <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-ink-100 px-5 py-4 md:grid-cols-4 md:px-6">
          <InvoiceMetric
            label="Committed total"
            value={`$${metrics.totalSum.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}`}
            mono
            prominent
            hint={`${metrics.count} non-draft non-canceled`}
          />
          <InvoiceMetric
            label="Unpaid"
            value={String(metrics.unpaid)}
            mono
            tone={metrics.unpaid > 0 ? 'warn' : 'neutral'}
            hint={metrics.unpaid ? 'finalized + shipped' : 'all caught up'}
            onClick={metrics.unpaid > 0 ? () => setTab('unpaid') : undefined}
          />
          <InvoiceMetric
            label="Drafts"
            value={String(metrics.drafts)}
            mono
            tone={metrics.drafts > 0 ? 'info' : 'neutral'}
            onClick={metrics.drafts > 0 ? () => setTab('drafts') : undefined}
          />
          <InvoiceMetric
            label="Canceled"
            value={String(metrics.canceled)}
            mono
            tone="muted"
            onClick={metrics.canceled > 0 ? () => setTab('canceled') : undefined}
          />
        </div>
      </section>

      <nav className="mt-5 flex gap-1 overflow-x-auto border-b border-ink-200 text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 transition ${
              tab === t.id
                ? 'border-ink-900 font-medium text-ink-900'
                : 'border-transparent text-ink-600 hover:text-ink-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* MOB-002: horizontal scroll on narrow viewports instead of clipping.
          Apr 2026 polish: card matches the hero (rounded-xl + shadow-sm),
          zebra striping on even rows, colored type badges, tabular-nums
          on money columns. */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-ink-200 bg-white shadow-sm">
        <table className="w-full min-w-[780px] text-sm">
          <thead className="bg-ink-50 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            <tr>
              <th className="px-4 py-3">Invoice</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Payment</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3 text-right">Created</th>
              {isAdmin && tab === 'canceled' && <th className="px-4 py-3"></th>}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((inv, idx) => (
              <tr
                key={inv.id}
                className={`border-t border-ink-100 transition hover:bg-ink-50 ${
                  idx % 2 === 1 ? 'bg-ink-50/40' : ''
                }`}
              >
                <td className="px-4 py-3 font-mono">
                  {/* Drafts deep-link straight into the wizard so operators
                      can keep adding line items without detouring through
                      the read-only detail page first. Non-drafts go to
                      the detail page as before. */}
                  <Link
                    href={
                      inv.status === 'draft'
                        ? `/admin/invoices/new?draftId=${inv.id}`
                        : `/admin/invoices/${inv.id}`
                    }
                    className="font-semibold text-ink-900 hover:underline"
                    title={
                      inv.status === 'draft'
                        ? 'Resume editing this draft'
                        : 'Open invoice details'
                    }
                  >
                    {inv.invoice_number}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-ink-900">{inv.client_name}</div>
                  {inv.client_type === 'wholesaler' && (
                    <span className="mt-0.5 inline-block rounded-full bg-gold-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gold-600">
                      Wholesale
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${
                      inv.type === 'buy'
                        ? 'bg-buy-600/10 text-buy-700'
                        : 'bg-sell-600/10 text-sell-700'
                    }`}
                  >
                    {inv.type === 'buy' ? 'Buy' : 'Sell'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={inv.status} paymentStatus={inv.payment_status} />
                </td>
                <td className="px-4 py-3 text-xs capitalize text-ink-600">
                  {inv.payment_status.replace('_', ' ')}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-ink-900">
                  ${Number(inv.total).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </td>
                <td className="px-4 py-3 text-right text-xs text-ink-500">
                  {new Date(inv.created_at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </td>
                {isAdmin && tab === 'canceled' && (
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteRow(inv.id, inv.invoice_number);
                      }}
                      className="rounded-md px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
                      title="Permanently delete this canceled invoice"
                    >
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {displayRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-ink-400">
                  No invoices in this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Metric cell used in the hero card. `tone` lets the numeric color
 * match the semantic meaning: unpaid=amber, drafts=blue, canceled=
 * muted grey, anything else neutral ink-900. `prominent` bumps to
 * 2xl — reserved for the top-line committed total.
 *
 * When `onClick` is provided, renders as a button with hover affordance
 * so operators can drill from a count straight into the filtered tab
 * (Unpaid → unpaid tab, Drafts → drafts tab). Skipped when the count
 * is zero so we don't tease a click that would land on an empty view.
 */
function InvoiceMetric({
  label,
  value,
  hint,
  mono = false,
  prominent = false,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
  prominent?: boolean;
  tone?: 'neutral' | 'warn' | 'info' | 'muted';
  onClick?: () => void;
}) {
  const toneCls =
    tone === 'warn'
      ? 'text-amber-700'
      : tone === 'info'
        ? 'text-buy-700'
        : tone === 'muted'
          ? 'text-ink-400'
          : 'text-ink-900';
  const body = (
    <>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
        {label}
      </div>
      <div
        className={`mt-0.5 ${mono ? 'font-mono tabular-nums' : ''} ${
          prominent ? 'text-2xl font-semibold' : 'text-base font-medium'
        } ${toneCls}`}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-0.5 text-[10px] text-ink-400">{hint}</div>
      )}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="group -m-1 rounded-md p-1 text-left transition hover:bg-ink-50"
        aria-label={`Filter to ${label}`}
      >
        {body}
        <div
          aria-hidden
          className="mt-0.5 text-[10px] text-ink-300 transition group-hover:text-ink-500"
        >
          view →
        </div>
      </button>
    );
  }
  return <div>{body}</div>;
}
