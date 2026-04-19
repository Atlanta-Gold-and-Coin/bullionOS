'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

/**
 * Wholesale reconciliation view (tickets WH-001 / WH-002 / WH-003).
 *
 * Reads `GET /admin/kpi/wholesale-owed` — a server-side rollup of every
 * finalized-but-not-yet-paid wholesale invoice, grouped by client. The
 * KPI card on /admin/kpi reads from the same endpoint, so this page and
 * the dashboard stay in lockstep.
 *
 * Columns: wholesaler · # open · $ owed · invoices.
 *
 * Each invoice row carries a Mark Paid button — transitions the invoice
 * to status='paid' and stamps paid_by_user_id (audit trail per WH-002).
 * The mutation invalidates the same query key so the row disappears
 * from the outstanding list immediately.
 */

interface OutstandingInvoice {
  id: string;
  invoice_number: string;
  total: string;
  created_at: string;
  type: 'buy' | 'sell';
}
interface OutstandingByClient {
  client_id: string;
  client_name: string;
  client_email: string | null;
  invoice_count: number;
  owed: string;
  invoices: OutstandingInvoice[];
}
interface Outstanding {
  total_owed: string;
  by_client: OutstandingByClient[];
}

export default function WholesaleReconciliationPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<Outstanding>({
    queryKey: ['admin', 'kpi', 'wholesale-owed'],
    queryFn: () => apiFetch<Outstanding>('/admin/kpi/wholesale-owed'),
  });

  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.by_client;
    return data.by_client.filter(
      (c) =>
        c.client_name.toLowerCase().includes(q) ||
        (c.client_email ?? '').toLowerCase().includes(q) ||
        c.invoices.some((i) => i.invoice_number.toLowerCase().includes(q)),
    );
  }, [data, search]);

  async function markPaid(invoiceId: string) {
    try {
      await apiFetch(`/admin/invoices/${invoiceId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'paid' }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'kpi', 'wholesale-owed'] });
      await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to mark paid');
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Wholesale reconciliation</h1>
          <p className="mt-1 text-sm text-ink-400">
            Every finalized wholesale invoice that hasn&rsquo;t been paid yet. Click
            <strong> Mark paid</strong> once we receive remittance; it clears from
            this view and the KPI card.
          </p>
        </div>
        <div className="rounded-xl border border-ink-200 bg-white px-5 py-3 text-right">
          <div className="text-xs uppercase tracking-wide text-ink-400">Total owed</div>
          <div className="font-mono text-2xl font-semibold text-ink-900">
            ${moneyfmt(data?.total_owed ?? '0')}
          </div>
          <div className="mt-0.5 text-xs text-ink-400">
            across {data?.by_client.length ?? 0} wholesaler
            {(data?.by_client.length ?? 0) === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by wholesaler, email, or invoice #"
          className="input w-full max-w-md"
        />
      </div>

      {isLoading && (
        <p className="mt-6 text-sm text-ink-400">Loading outstanding balances…</p>
      )}
      {error && (
        <div className="mt-6 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {(error as Error).message}
        </div>
      )}
      {data && filtered.length === 0 && (
        <div className="mt-8 rounded-xl border border-ink-200 bg-white p-8 text-center text-sm text-ink-500">
          {search
            ? 'No matches for that filter.'
            : '🎉 No outstanding wholesale balances. Every finalized wholesale invoice has been marked paid.'}
        </div>
      )}

      <div className="mt-6 space-y-4">
        {filtered.map((c) => (
          <ClientBlock key={c.client_id} block={c} onMarkPaid={markPaid} />
        ))}
      </div>
    </div>
  );
}

function ClientBlock({
  block,
  onMarkPaid,
}: {
  block: OutstandingByClient;
  onMarkPaid: (invoiceId: string) => Promise<void>;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-ink-200 bg-white">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-ink-100 px-5 py-3">
        <div>
          <Link
            href={`/admin/clients/${block.client_id}`}
            className="text-base font-semibold text-ink-900 hover:underline"
          >
            {block.client_name}
          </Link>
          {block.client_email && (
            <span className="ml-2 text-xs text-ink-500">{block.client_email}</span>
          )}
          <span className="ml-2 rounded-full bg-gold-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold-600">
            Wholesale
          </span>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg font-semibold text-ink-900">
            ${moneyfmt(block.owed)}
          </div>
          <div className="text-xs text-ink-400">
            {block.invoice_count} invoice{block.invoice_count === 1 ? '' : 's'}
          </div>
        </div>
      </header>

      {/* Mobile horizontal scroll wrapper (MOB-002) */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-5 py-2">Invoice #</th>
              <th className="px-5 py-2">Created</th>
              <th className="px-5 py-2">Type</th>
              <th className="px-5 py-2 text-right">Total</th>
              <th className="px-5 py-2 text-right">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {block.invoices.map((inv) => (
              <tr key={inv.id} className="border-t border-ink-100">
                <td className="px-5 py-3 font-mono">
                  <Link
                    href={`/admin/invoices/${inv.id}`}
                    className="hover:underline"
                  >
                    {inv.invoice_number}
                  </Link>
                </td>
                <td className="px-5 py-3 font-mono text-xs text-ink-500">
                  {new Date(inv.created_at).toLocaleDateString()}
                </td>
                <td className="px-5 py-3 uppercase text-xs text-ink-500">
                  {inv.type}
                </td>
                <td className="px-5 py-3 text-right font-mono">
                  ${moneyfmt(inv.total)}
                </td>
                <td className="px-5 py-3 text-right">
                  <button
                    onClick={() => onMarkPaid(inv.id)}
                    className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
                    title="Record that this wholesaler has paid — clears from outstanding totals"
                  >
                    Mark paid
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function moneyfmt(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
