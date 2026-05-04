'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { StatusPill } from '@/components/status-pill';
import { useAppSettings } from '@/lib/use-app-settings';

interface InvoiceRow {
  id: string;
  invoice_number: string;
  type: 'buy' | 'sell';
  status: string;
  payment_status?: string;
  total: string;
  created_at: string;
}

export default function ClientTransactions() {
  const { data, isLoading } = useQuery({
    queryKey: ['client', 'invoices'],
    queryFn: () => apiFetch<InvoiceRow[]>('/client/invoices'),
  });
  const { data: appSettings } = useAppSettings();
  const brand = appSettings?.branding.company_name ?? 'us';

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Transactions</h1>
      <p className="mt-1 text-sm text-ink-400">Your buy and sell history with {brand}.</p>

      <div className="mt-6 overflow-hidden rounded-xl border border-ink-200 bg-white">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-ink-400">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th className="px-4 py-3">Invoice</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Date</th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((inv) => (
                <tr key={inv.id} className="border-t border-ink-200 hover:bg-ink-50/50">
                  <td className="px-4 py-3 font-mono">
                    <Link
                      href={`/dashboard/transactions/${inv.id}`}
                      className="hover:underline"
                    >
                      {inv.invoice_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{inv.type.toUpperCase()}</td>
                  <td className="px-4 py-3">
                    <StatusPill status={inv.status} paymentStatus={inv.payment_status} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    ${Number(inv.total).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-3 text-right text-ink-400">
                    {new Date(inv.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
              {(!data || data.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-ink-400">
                    No transactions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
