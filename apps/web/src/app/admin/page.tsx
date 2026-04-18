'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { StatusPill } from '@/components/status-pill';

interface InvoiceRow {
  id: string;
  invoice_number: string;
  type: 'buy' | 'sell';
  status: string;
  total: string;
  created_at: string;
}

interface Product {
  id: string;
  sku: string;
  name: string;
}

export default function AdminDashboard() {
  const { data: invoices } = useQuery({
    queryKey: ['admin', 'invoices', 'recent'],
    queryFn: () => apiFetch<InvoiceRow[]>('/admin/invoices'),
  });
  const { data: products } = useQuery({
    queryKey: ['admin', 'products'],
    queryFn: () => apiFetch<Product[]>('/admin/products'),
  });

  const recent = (invoices ?? []).slice(0, 8);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Trading desk</h1>
          <p className="mt-1 text-sm text-ink-400">Live overview</p>
        </div>
        <Link
          href="/admin/invoices/new"
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800"
        >
          New invoice
        </Link>
      </div>

      {/*
       * Dashboard totals exclude draft + canceled invoices — only paid,
       * finalized, or shipped rows count toward realized volume. Split
       * into buy vs sell so the operator sees money-in and money-out
       * independently instead of a single lumped number.
       */}
      {(() => {
        const committed = (invoices ?? []).filter(
          (i) => i.status !== 'draft' && i.status !== 'canceled',
        );
        const buyTotal = committed
          .filter((i) => i.type === 'buy')
          .reduce((s, i) => s + Number(i.total), 0);
        const sellTotal = committed
          .filter((i) => i.type === 'sell')
          .reduce((s, i) => s + Number(i.total), 0);
        return (
          <section className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Products active" value={String(products?.length ?? '—')} />
            <Stat
              label="Committed invoices"
              value={String(committed.length)}
            />
            <Stat
              label="Buy volume"
              value={invoices ? `$${buyTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
              tone="buy"
            />
            <Stat
              label="Sell volume"
              value={invoices ? `$${sellTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
              tone="sell"
            />
          </section>
        );
      })()}

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">
            Recent invoices
          </h2>
          <Link href="/admin/invoices" className="text-xs text-ink-600 hover:text-ink-900">
            View all →
          </Link>
        </div>
        <div className="mt-3 overflow-hidden rounded-xl border border-ink-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th className="px-4 py-3">Invoice</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Created</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-ink-400">
                    No invoices yet.{' '}
                    <Link href="/admin/invoices/new" className="text-ink-900 underline">
                      Create one
                    </Link>
                    .
                  </td>
                </tr>
              )}
              {recent.map((inv) => (
                <tr key={inv.id} className="border-t border-ink-200">
                  <td className="px-4 py-3 font-mono">
                    <Link href={`/admin/invoices/${inv.id}`} className="hover:underline">
                      {inv.invoice_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{inv.type.toUpperCase()}</td>
                  <td className="px-4 py-3">
                    <StatusPill status={inv.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    ${Number(inv.total).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-3 text-right text-ink-400">
                    {new Date(inv.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'buy' | 'sell';
}) {
  const accent =
    tone === 'buy'
      ? 'border-buy-200 bg-buy-50'
      : tone === 'sell'
        ? 'border-sell-200 bg-sell-50'
        : 'border-ink-200 bg-white';
  const valueColor =
    tone === 'buy' ? 'text-buy-700' : tone === 'sell' ? 'text-sell-700' : 'text-ink-900';
  return (
    <div className={`rounded-xl border p-5 ${accent}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${valueColor}`}>
        {value}
      </div>
    </div>
  );
}

