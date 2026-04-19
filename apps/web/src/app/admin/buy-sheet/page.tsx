'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { PageTint } from '@/components/page-tint';
import { InlinePriceEditor, type PricingRule } from '@/components/inline-price-editor';
import { useLiveSpot } from '@/lib/use-live-spot';
import type { SheetRow } from '@/lib/sheet-types';
import {
  SECTIONS,
  METAL_GROUPS,
  deriveDisplayCategory,
  compareByFamily,
  groupSectionsByMetal,
  type DisplayCategory,
} from '@/lib/product-category';
import { rankProducts } from '@/lib/product-search';

interface EnrichedSheet extends SheetRow {
  displayCategory: DisplayCategory;
}

/**
 * "What we pay" — every active product with its current buy price, grouped
 * by metal and then by category. Mirrors the in-stock sheet layout but
 * doesn't filter by availability (operators need to quote on anything in
 * the catalog regardless of stock).
 */
export default function BuySheetPage() {
  const qc = useQueryClient();
  const { spot } = useLiveSpot();
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'products', 'sheet'],
    queryFn: () => apiFetch<SheetRow[]>('/admin/products/sheet'),
    refetchInterval: 60_000,
  });

  // Filter before grouping so categories show only matching rows and
  // empty sections disappear from the jump-nav automatically.
  const filtered = useMemo(
    () => rankProducts(data ?? [], search),
    [data, search],
  );

  const bySection = useMemo(() => {
    const out = new Map<DisplayCategory, EnrichedSheet[]>();
    for (const s of SECTIONS) out.set(s.id, []);
    for (const row of filtered) {
      const enriched: EnrichedSheet = {
        ...row,
        displayCategory: deriveDisplayCategory(row),
      };
      out.get(enriched.displayCategory)?.push(enriched);
    }
    for (const list of out.values()) list.sort(compareByFamily);
    return out;
  }, [filtered]);

  const sectionsToRender = SECTIONS.filter((s) => (bySection.get(s.id)?.length ?? 0) > 0);

  return (
    <PageTint side="buy">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">What we pay</h1>
            <p className="mt-1 text-sm text-ink-400">
              Every active product, grouped by metal and family. Prices refresh
              every minute. Click Edit on any row to adjust the buy/sell
              premium.
            </p>
          </div>
          <div className="text-right text-xs text-ink-400">
            {spot?.asOf ? `Spot updated ${timeSince(spot.asOf)}` : '—'}
          </div>
        </div>

        <div className="mt-4">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by SKU, name, or metal…"
            className="input w-full md:w-96"
            aria-label="Search products"
          />
          {search.trim() && (
            <span className="ml-3 text-xs text-ink-400">
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

        {sectionsToRender.length > 0 && (
          <nav className="sticky top-0 z-10 -mx-2 mt-6 overflow-x-auto rounded-xl border border-buy-200 bg-white/95 px-2 py-2 backdrop-blur">
            <div className="flex min-w-max items-center gap-4 text-xs">
              {groupSectionsByMetal(sectionsToRender).map((g) => (
                <div key={g.metal} className="flex items-center gap-1">
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide border ${METAL_GROUPS[g.metal].accentClass}`}
                  >
                    {METAL_GROUPS[g.metal].label}
                  </span>
                  {g.sections.map((s) => (
                    <a
                      key={s.id}
                      href={`#${s.id}`}
                      className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-ink-700 hover:bg-buy-50"
                    >
                      {s.label}
                      <span className="rounded-full bg-buy-100 px-1.5 text-[10px] text-buy-700">
                        {bySection.get(s.id)!.length}
                      </span>
                    </a>
                  ))}
                </div>
              ))}
            </div>
          </nav>
        )}

        {isLoading && (
          <div className="mt-8 rounded-xl border border-ink-200 bg-white p-8 text-center text-sm text-ink-400">
            Loading…
          </div>
        )}

        {!isLoading &&
          groupSectionsByMetal(sectionsToRender).map((g) => (
            <div key={g.metal}>
              <h2
                className={`mt-10 mb-2 rounded-md border px-3 py-2 text-lg font-semibold ${METAL_GROUPS[g.metal].accentClass}`}
              >
                {METAL_GROUPS[g.metal].label}
              </h2>
              {g.sections.map((s) => (
                <BuySection
                  key={s.id}
                  id={s.id}
                  label={s.label}
                  rows={bySection.get(s.id)!}
                  onEdited={() =>
                    qc.invalidateQueries({ queryKey: ['admin', 'products', 'sheet'] })
                  }
                />
              ))}
            </div>
          ))}

        {!isLoading && sectionsToRender.length === 0 && (
          <div className="mt-8 rounded-xl border border-ink-200 bg-white p-12 text-center text-sm text-ink-400">
            No active products.
          </div>
        )}
      </div>
    </PageTint>
  );
}

function BuySection({
  id,
  label,
  rows,
  onEdited,
}: {
  id: string;
  label: string;
  rows: EnrichedSheet[];
  onEdited: () => void;
}) {
  return (
    <section id={id} className="mt-4 scroll-mt-24">
      <h3 className="mb-2 text-sm font-semibold text-buy-700">{label}</h3>
      {/* MOB-002: horizontal scroll on narrow viewports. */}
      <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3 text-right">On hand</th>
              <th className="px-4 py-3 text-right">We pay</th>
              <th className="px-4 py-3 text-right">We sell</th>
              <th className="px-4 py-3 text-right w-32">Edit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <BuyRowView key={r.product_id} row={r} onEdited={onEdited} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BuyRowView({ row, onEdited }: { row: EnrichedSheet; onEdited: () => void }) {
  const { data: rule } = useQuery({
    queryKey: ['admin', 'product', row.product_id, 'rule'],
    queryFn: () =>
      apiFetch<PricingRule>(`/admin/products/${row.product_id}/pricing-rule`),
  });
  return (
    <tr className="border-t border-ink-200 align-top">
      <td className="px-4 py-3">
        <div className="font-medium">{row.name}</div>
        <div className="font-mono text-xs text-ink-400">{row.sku}</div>
      </td>
      <td className="px-4 py-3 text-right font-mono text-ink-600">
        {row.quantity_on_hand}
      </td>
      <td className="px-4 py-3 text-right font-mono text-ink-900">
        {row.buy_price !== null ? `$${Number(row.buy_price).toFixed(2)}` : '—'}
      </td>
      <td className="px-4 py-3 text-right font-mono text-ink-600">
        {row.sell_price !== null ? `$${Number(row.sell_price).toFixed(2)}` : '—'}
      </td>
      <td className="px-4 py-3">
        {rule ? (
          <InlinePriceEditor
            productId={row.product_id}
            rule={rule}
            onChanged={onEdited}
          />
        ) : (
          <span className="text-xs text-ink-400">…</span>
        )}
      </td>
    </tr>
  );
}

function timeSince(iso: string): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

