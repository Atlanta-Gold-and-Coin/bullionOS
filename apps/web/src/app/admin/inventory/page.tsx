'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { PageTint } from '@/components/page-tint';
import type { SheetRow } from '@/lib/sheet-types';
import {
  METAL_GROUPS,
  resolveDisplayCategory,
  compareByFamily,
  groupSectionsByMetal,
} from '@/lib/product-category';
import { useDisplayCategories } from '@/lib/use-display-categories';
import { rankProducts } from '@/lib/product-search';

interface InventoryRow {
  product_id: string;
  sku: string;
  name: string;
  metal: string;
  category: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  available: number;
  weighted_avg_cost: string;
  last_purchase_price: string | null;
  updated_at: string;
  show_on_website: boolean;
}

interface EnrichedRow extends InventoryRow {
  /** Resolved slug — builtin DisplayCategory id or a custom slug. */
  displayCategory: string;
  // Set by the product sheet query — live sell price from the current
  // pricing rule + spot.
  sellPrice: string | null;
  weight_troy_oz: string;
}

export default function AdminInventoryPage() {
  const [search, setSearch] = useState('');
  const { sections, knownSlugs } = useDisplayCategories();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'inventory'],
    queryFn: () => apiFetch<InventoryRow[]>('/admin/inventory'),
    refetchInterval: 60_000,
  });
  const { data: sheet } = useQuery({
    queryKey: ['admin', 'products', 'sheet'],
    queryFn: () => apiFetch<SheetRow[]>('/admin/products/sheet'),
    refetchInterval: 60_000,
  });

  // Join the inventory rows with the sheet so each row carries sell price,
  // product weight, and the operator's override (for resolveDisplayCategory).
  const sheetByProduct = useMemo(() => {
    const m = new Map<string, SheetRow>();
    for (const s of sheet ?? []) m.set(s.product_id, s);
    return m;
  }, [sheet]);

  const enrichedAll = useMemo<EnrichedRow[]>(() => {
    return (data ?? []).map((r) => {
      const s = sheetByProduct.get(r.product_id);
      return {
        ...r,
        displayCategory: resolveDisplayCategory(
          {
            metal: r.metal,
            category: r.category,
            name: r.name,
            display_category_override: s?.display_category_override ?? null,
          },
          knownSlugs,
        ),
        sellPrice: s?.sell_price ?? null,
        weight_troy_oz: '0', // not in InventoryRow; family sort will fall
        // back to name parsing which is sufficient for the counter use-case.
      };
    });
  }, [data, sheetByProduct]);

  // Rank + filter against the search query. Empty query returns every row.
  const enriched = useMemo(
    () => rankProducts(enrichedAll, search),
    [enrichedAll, search],
  );

  // Group the enriched rows into the user-facing sections. Keep both
  // in-stock and out-of-stock buckets per section so the counter can see
  // everything in one place.
  const sectionRows = useMemo(() => {
    const out = new Map<string, { inStock: EnrichedRow[]; outOfStock: EnrichedRow[] }>();
    for (const section of sections) {
      out.set(section.id, { inStock: [], outOfStock: [] });
    }
    // Ensure 'other' always exists so rows pinned to deleted slugs still
    // render somewhere. knownSlugs excludes deleted customs already, so
    // their displayCategory has been coerced to the heuristic default.
    if (!out.has('other')) out.set('other', { inStock: [], outOfStock: [] });
    for (const row of enriched) {
      const b = out.get(row.displayCategory) ?? out.get('other')!;
      if (row.available > 0) b.inStock.push(row);
      else b.outOfStock.push(row);
    }
    for (const bucket of out.values()) {
      bucket.inStock.sort(compareByFamily);
      bucket.outOfStock.sort(compareByFamily);
    }
    return out;
  }, [enriched, sections]);

  const totalUnits = useMemo(
    () => enriched.filter((r) => r.available > 0).reduce((n, r) => n + r.available, 0),
    [enriched],
  );
  const inStockCount = enriched.filter((r) => r.available > 0).length;

  // Visibility-hide empty sections so the jump bar stays tight on small
  // catalogues. Expose both in-stock and out-of-stock counts for badges.
  const sectionsToRender = sections.filter((s) => {
    const b = sectionRows.get(s.id);
    return b && (b.inStock.length + b.outOfStock.length) > 0;
  });

  return (
    <PageTint side="sell">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Products</h1>
            <p className="mt-1 text-sm text-ink-400">
              Live stock grouped by family. In-stock items appear first in each
              section; out-of-stock rows collapse below them.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by SKU, name, or metal…"
            className="input w-full md:w-96"
            aria-label="Search products"
          />
          {search.trim() && (
            <span className="text-xs text-ink-400">
              {enriched.length} match{enriched.length === 1 ? '' : 'es'}
              <button
                onClick={() => setSearch('')}
                className="ml-2 underline-offset-2 hover:underline"
              >
                clear
              </button>
            </span>
          )}
        </div>

        <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryCard label="In-stock SKUs" value={String(inStockCount)} />
          <SummaryCard label="Total units available" value={String(totalUnits)} />
          <SummaryCard
            label="Out of stock"
            value={String(enriched.filter((r) => r.available <= 0).length)}
            muted
          />
          <SummaryCard
            label="Total products tracked"
            value={String(enriched.length)}
            muted
          />
        </section>

        {/* Jump bar grouped by metal so the operator sees Gold / Silver /
            Platinum / Palladium as primary hubs with category sub-links. */}
        {sectionsToRender.length > 0 && (
          <nav className="sticky top-0 z-10 -mx-2 mt-6 overflow-x-auto rounded-xl border border-sell-200 bg-white/95 px-2 py-2 backdrop-blur">
            <div className="flex min-w-max items-center gap-4 text-xs">
              {groupSectionsByMetal(sectionsToRender).map((g) => (
                <div key={g.metal} className="flex items-center gap-1">
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide border ${METAL_GROUPS[g.metal].accentClass}`}
                  >
                    {METAL_GROUPS[g.metal].label}
                  </span>
                  {g.sections.map((s) => {
                    const b = sectionRows.get(s.id)!;
                    return (
                      <a
                        key={s.id}
                        href={`#${s.id}`}
                        className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-ink-700 hover:bg-sell-50"
                      >
                        {s.label}
                        <span className="rounded-full bg-sell-100 px-1.5 text-[10px] text-sell-700">
                          {b.inStock.length}
                        </span>
                      </a>
                    );
                  })}
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
              {g.sections.map((s) => {
                const b = sectionRows.get(s.id)!;
                return (
                  <CategorySection
                    key={s.id}
                    id={s.id}
                    label={s.label}
                    inStock={b.inStock}
                    outOfStock={b.outOfStock}
                  />
                );
              })}
            </div>
          ))}

        {!isLoading && sectionsToRender.length === 0 && (
          <div className="mt-8 rounded-xl border border-ink-200 bg-white p-12 text-center text-sm text-ink-400">
            No products yet. Add some under Catalog.
          </div>
        )}
      </div>
    </PageTint>
  );
}

function SummaryCard({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        muted ? 'border-ink-200 bg-white/70' : 'border-sell-200 bg-white'
      }`}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-ink-400">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-xl font-semibold ${
          muted ? 'text-ink-600' : 'text-sell-700'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function CategorySection({
  id,
  label,
  inStock,
  outOfStock,
}: {
  id: string;
  label: string;
  inStock: EnrichedRow[];
  outOfStock: EnrichedRow[];
}) {
  const [showOut, setShowOut] = useState(false);
  return (
    <section id={id} className="mt-8 scroll-mt-24">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-sell-700">{label}</h2>
        <span className="text-xs text-ink-400">
          {inStock.length} in stock · {outOfStock.length} out of stock
        </span>
      </div>
      {/* MOB-002: horizontal scroll on narrow viewports. */}
      <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">We sell for</th>
              <th className="px-4 py-3 text-right">Adjust</th>
            </tr>
          </thead>
          <tbody>
            {inStock.map((r) => (
              <InventoryRowView key={r.product_id} row={r} />
            ))}
            {inStock.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-ink-400">
                  Nothing in stock in this category.
                </td>
              </tr>
            )}
            {showOut &&
              outOfStock.map((r) => (
                <InventoryRowView key={r.product_id} row={r} dimmed />
              ))}
          </tbody>
        </table>
        {outOfStock.length > 0 && (
          <button
            onClick={() => setShowOut((v) => !v)}
            className="w-full border-t border-ink-100 bg-ink-50/60 px-4 py-2 text-left text-xs font-medium text-ink-600 hover:bg-ink-100"
          >
            {showOut ? '▾ Hide' : '▸ Show'} {outOfStock.length} out-of-stock row
            {outOfStock.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </section>
  );
}

function InventoryRowView({ row, dimmed }: { row: EnrichedRow; dimmed?: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function adjust() {
    const n = Number(delta);
    if (!Number.isFinite(n) || n === 0 || !Number.isInteger(n)) {
      setError('Enter a non-zero integer');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/admin/inventory/${row.product_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ delta: n, notes: notes || undefined }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'inventory'] });
      setOpen(false);
      setDelta('');
      setNotes('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Adjust failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr
        className={`border-t border-ink-200 align-top ${
          dimmed ? 'bg-ink-50/40 text-ink-400' : ''
        }`}
      >
        <td className="px-4 py-3">
          <div className="font-medium">{row.name}</div>
          <div className="font-mono text-xs text-ink-400">{row.sku}</div>
        </td>
        <td className="px-4 py-3 text-right font-mono font-semibold">
          {row.available}
          {row.quantity_reserved > 0 && (
            <span className="ml-1 text-[10px] font-normal text-ink-400">
              ({row.quantity_reserved} reserved)
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right font-mono text-ink-900">
          {row.sellPrice ? `$${Number(row.sellPrice).toFixed(2)}` : '—'}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-ink-200 px-2 py-1 text-xs hover:bg-ink-50"
          >
            {open ? 'Close' : 'Adjust'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-ink-100 bg-ink-50/40">
          <td colSpan={4} className="px-4 py-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <label className="text-xs font-medium text-ink-600">
                Delta
                <input
                  value={delta}
                  onChange={(e) => setDelta(e.target.value)}
                  placeholder="+5 or -3"
                  className="input ml-2 w-24 font-mono"
                />
              </label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Reason / notes"
                className="input md:w-80"
                maxLength={500}
              />
              <button
                onClick={adjust}
                disabled={busy}
                className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-60"
              >
                {busy ? 'Applying…' : 'Apply'}
              </button>
              {error && <span className="text-xs text-red-700">{error}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
