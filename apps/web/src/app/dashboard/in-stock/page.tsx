'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { rankProducts } from '@/lib/product-search';
import { useAppSettings } from '@/lib/use-app-settings';

interface InStockItem {
  product_id: string;
  sku: string;
  name: string;
  metal: string;
  category: string;
  available: number;
}

export default function ClientInStockPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['client', 'in-stock'],
    queryFn: () => apiFetch<InStockItem[]>('/client/in-stock'),
    refetchInterval: 60_000,
  });
  const { data: appSettings } = useAppSettings();
  const brand = appSettings?.branding.company_name ?? 'us';

  const filtered = useMemo(
    () => rankProducts(data ?? [], search),
    [data, search],
  );

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">In stock</h1>
      <p className="mt-1 text-sm text-ink-400">
        Items currently available from {brand}. Contact us to purchase.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by SKU, name, or metal…"
          className="input w-full md:w-96"
          aria-label="Search in-stock items"
        />
        {search.trim() && (
          <span className="text-xs text-ink-400">
            {filtered.length} match{filtered.length === 1 ? '' : 'es'}
            <button
              onClick={() => setSearch('')}
              className="ml-2 underline-offset-2 hover:underline"
            >
              clear
            </button>
          </span>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-ink-200 bg-white">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-ink-400">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Metal</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Available</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.product_id} className="border-t border-ink-200">
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.name}</div>
                    <div className="font-mono text-xs text-ink-400">{r.sku}</div>
                  </td>
                  <td className="px-4 py-3 capitalize text-ink-600">{r.metal}</td>
                  <td className="px-4 py-3 capitalize text-ink-600">{r.category}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold">
                    {r.available}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-ink-400">
                    {search.trim()
                      ? `No matches for "${search}".`
                      : 'No items in stock right now.'}
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
