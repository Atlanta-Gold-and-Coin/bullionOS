'use client';

import { useState } from 'react';
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

type Tab = 'recent' | 'drafts' | 'sales' | 'purchase' | 'wholesale' | 'canceled' | 'all';

const TABS: Array<{ id: Tab; label: string }> = [
  // 'Recent' moved from the dashboard (Apr 2026) — top-level tab so
  // invoice triage has a single home. Defaults to the opening tab on
  // this page.
  { id: 'recent', label: 'Recent' },
  { id: 'drafts', label: 'Drafts' },
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
  // API doesn't support a status≠X filter, so we strip client-side —
  // the 500-row cap on the list endpoint keeps this trivial.
  const filtered = (data ?? []).filter((inv) => {
    if (tab === 'canceled') return inv.status === 'canceled';
    if (tab === 'drafts') return inv.status === 'draft';
    return inv.status !== 'canceled' && inv.status !== 'draft';
  });
  // "Recent" is a compact top-N slice of the same payload "All" fetches.
  // Rendered-at-top-of-list is the UX win; the server payload is small
  // enough (<= 500 rows) that filtering client-side is fine.
  const displayRows = tab === 'recent' ? filtered.slice(0, 15) : filtered;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <Link
          href="/admin/invoices/new"
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800"
        >
          New invoice
        </Link>
      </div>

      <nav className="mt-5 flex gap-1 border-b border-ink-200 text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 transition ${
              tab === t.id
                ? 'border-ink-900 font-medium text-ink-900'
                : 'border-transparent text-ink-600 hover:text-ink-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* MOB-002: horizontal scroll on narrow viewports instead of clipping. */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full min-w-[780px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Invoice</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Payment</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3 text-right">Created</th>
              {/* Admin-only column: delete canceled invoices. Width
                  kept narrow so it doesn't steal focus from the main
                  data columns. */}
              {isAdmin && tab === 'canceled' && <th className="px-4 py-3"></th>}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((inv) => (
              <tr key={inv.id} className="border-t border-ink-200 hover:bg-ink-50/50">
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
                    className="hover:underline"
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
                  <div className="font-medium">{inv.client_name}</div>
                  {inv.client_type === 'wholesaler' && (
                    <span className="text-[10px] font-medium uppercase tracking-wide text-gold-600">
                      Wholesale
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">{inv.type.toUpperCase()}</td>
                <td className="px-4 py-3">
                  <StatusPill status={inv.status} />
                </td>
                <td className="px-4 py-3 text-ink-600">{inv.payment_status}</td>
                <td className="px-4 py-3 text-right font-mono">
                  ${Number(inv.total).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-3 text-right text-ink-400">
                  {new Date(inv.created_at).toLocaleString()}
                </td>
                {isAdmin && tab === 'canceled' && (
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteRow(inv.id, inv.invoice_number);
                      }}
                      className="rounded-md border border-red-200 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
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
                <td colSpan={7} className="px-4 py-12 text-center text-ink-400">
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
