'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, getAccessToken } from '@/lib/api-client';
import { StatusPill } from '@/components/status-pill';

interface LineItem {
  id: string;
  quantity: number;
  product_name_snapshot: string;
  unit_price: string;
  line_total: string;
}

interface InvoiceDetail {
  id: string;
  invoice_number: string;
  type: 'buy' | 'sell';
  status: string;
  subtotal: string;
  tax: string;
  shipping: string;
  total: string;
  payment_method: string | null;
  payment_status: string;
  created_at: string;
  notes: string | null;
  line_items: LineItem[];
}

export default function ClientInvoiceDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, isLoading } = useQuery({
    queryKey: ['client', 'invoice', id],
    queryFn: () => apiFetch<InvoiceDetail>(`/client/invoices/${id}`),
  });

  function openPdf() {
    const token = getAccessToken();
    fetch(`/api/v1/client/invoices/${id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.blob())
      .then((b) => window.open(URL.createObjectURL(b), '_blank'))
      .catch(() => alert('Failed to open PDF'));
  }

  if (isLoading || !data) return <div className="text-sm text-ink-400">Loading…</div>;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4">
        <Link href="/dashboard/transactions" className="text-sm text-ink-600 hover:text-ink-900">
          ← All transactions
        </Link>
      </div>

      <header className="flex items-start justify-between">
        <div>
          <h1 className="font-mono text-2xl font-semibold">{data.invoice_number}</h1>
          <p className="mt-1 text-sm text-ink-400">
            {data.type.toUpperCase()} · {new Date(data.created_at).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={data.status} paymentStatus={data.payment_status} />
          <button
            onClick={openPdf}
            className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
          >
            Download PDF
          </button>
        </div>
      </header>

      <section className="mt-6 overflow-hidden rounded-xl border border-ink-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">Unit</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.line_items.map((l) => (
              <tr key={l.id} className="border-t border-ink-200">
                <td className="px-4 py-3">{l.product_name_snapshot}</td>
                <td className="px-4 py-3 text-right font-mono">{l.quantity}</td>
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

      <section className="mt-6 ml-auto max-w-xs space-y-1 text-sm">
        <Row label="Subtotal" value={data.subtotal} />
        {Number(data.tax) > 0 && <Row label="Tax" value={data.tax} />}
        {Number(data.shipping) > 0 && <Row label="Shipping" value={data.shipping} />}
        <div className="border-t border-ink-200 pt-1">
          <Row label="Total" value={data.total} bold />
        </div>
      </section>

      {data.notes && (
        <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Notes</h2>
          <p className="mt-2 text-sm text-ink-800 whitespace-pre-wrap">{data.notes}</p>
        </section>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? 'text-base font-semibold' : 'text-ink-600'}`}>
      <span>{label}</span>
      <span className="font-mono">
        ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}
