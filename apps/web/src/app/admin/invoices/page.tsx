'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { StatusPill } from '@/components/status-pill';

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

type Tab = 'drafts' | 'sales' | 'purchase' | 'wholesale' | 'all';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'drafts', label: 'Drafts' },
  { id: 'sales', label: 'Sales' },
  { id: 'purchase', label: 'Purchase' },
  { id: 'wholesale', label: 'Wholesale' },
  { id: 'all', label: 'All' },
];

/**
 * Map each tab to a server-side filter. Drafts cuts by status; Sales and
 * Purchase cut by invoice type (sell vs buy); Wholesale cuts by the
 * client's client_type. Passing the filter as a query param keeps the
 * payload small — no client-side filtering needed.
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
    case 'all':
    default:
      return '/admin/invoices';
  }
}

export default function InvoicesPage() {
  const [tab, setTab] = useState<Tab>('drafts');
  const { data } = useQuery({
    queryKey: ['admin', 'invoices', tab],
    queryFn: () => apiFetch<InvoiceRow[]>(queryFor(tab)),
  });

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
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((inv) => (
              <tr key={inv.id} className="border-t border-ink-200 hover:bg-ink-50/50">
                <td className="px-4 py-3 font-mono">
                  <Link href={`/admin/invoices/${inv.id}`} className="hover:underline">
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
              </tr>
            ))}
            {(!data || data.length === 0) && (
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
