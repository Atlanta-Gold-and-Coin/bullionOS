'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAppSettings } from '@/lib/use-app-settings';

/**
 * Client-facing shape for a locked quote. Intentionally *does not*
 * include premium_type / premium_value — those are the buy/sell formula
 * inputs and stay on the backend. The unit_price + line_total fields
 * are the derived numbers the customer actually cares about.
 */
interface Quote {
  id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  product_metal: string;
  side: 'buy' | 'sell';
  quantity: number;
  spot_price_per_oz: string;
  unit_price: string;
  line_total: string;
  expires_at: string;
  converted_invoice_id: string | null;
  created_at: string;
}

export default function ClientQuotesPage() {
  const { data } = useQuery({
    queryKey: ['client', 'quotes'],
    queryFn: () => apiFetch<Quote[]>('/client/quotes'),
    refetchInterval: 30_000,
  });
  const { data: appSettings } = useAppSettings();
  const brand = appSettings?.branding.company_name ?? 'us';

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Locked-in quotes</h1>
      <p className="mt-1 text-sm text-ink-400">
        Prices we agreed to hold for 15 minutes. Convert to a transaction by contacting {brand}.
      </p>

      <div className="mt-6 overflow-hidden rounded-xl border border-ink-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Locked</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Side</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">Unit</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((q) => (
              <tr key={q.id} className="border-t border-ink-200">
                <td className="px-4 py-3 text-ink-400">
                  {new Date(q.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium">{q.product_name}</div>
                  <div className="font-mono text-xs text-ink-400">{q.product_sku}</div>
                </td>
                <td className="px-4 py-3 uppercase">{q.side}</td>
                <td className="px-4 py-3 text-right font-mono">{q.quantity}</td>
                <td className="px-4 py-3 text-right font-mono">
                  ${Number(q.unit_price).toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  ${Number(q.line_total).toFixed(2)}
                </td>
                <td className="px-4 py-3">
                  <QuoteStatus quote={q} />
                </td>
              </tr>
            ))}
            {(!data || data.length === 0) && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-ink-400">
                  No quotes yet. Lock one in from the{' '}
                  <a href="/dashboard/pricing" className="underline">
                    pricing page
                  </a>
                  .
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QuoteStatus({ quote }: { quote: Quote }) {
  if (quote.converted_invoice_id) {
    return (
      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
        converted
      </span>
    );
  }
  const expiresAt = new Date(quote.expires_at);
  const now = Date.now();
  if (expiresAt.getTime() < now) {
    return (
      <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600">
        expired
      </span>
    );
  }
  const minsLeft = Math.max(0, Math.round((expiresAt.getTime() - now) / 60_000));
  return (
    <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
      active · {minsLeft}m
    </span>
  );
}
