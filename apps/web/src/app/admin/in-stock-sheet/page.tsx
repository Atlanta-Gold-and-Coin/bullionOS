'use client';

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { PageTint } from '@/components/page-tint';
import { InlinePriceEditor, type PricingRule } from '@/components/inline-price-editor';
import { useLiveSpot } from '@/lib/use-live-spot';
import type { SheetRow } from '@/lib/sheet-types';
import {
  SECTIONS,
  deriveDisplayCategory,
  compareByFamily,
  type DisplayCategory,
} from '@/lib/product-category';

interface EnrichedSheet extends SheetRow {
  displayCategory: DisplayCategory;
}

export default function InStockSheetPage() {
  const qc = useQueryClient();
  const { spot } = useLiveSpot();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'products', 'sheet'],
    queryFn: () => apiFetch<SheetRow[]>('/admin/products/sheet'),
    refetchInterval: 60_000,
  });

  const bySection = useMemo(() => {
    const out = new Map<DisplayCategory, EnrichedSheet[]>();
    for (const s of SECTIONS) out.set(s.id, []);
    for (const row of data ?? []) {
      if (row.available <= 0) continue; // in-stock only
      const enriched: EnrichedSheet = {
        ...row,
        displayCategory: deriveDisplayCategory(row),
      };
      out.get(enriched.displayCategory)?.push(enriched);
    }
    for (const list of out.values()) list.sort(compareByFamily);
    return out;
  }, [data]);

  const sectionsToRender = SECTIONS.filter((s) => (bySection.get(s.id)?.length ?? 0) > 0);

  return (
    <PageTint side="sell">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">In-stock sheet</h1>
            <p className="mt-1 text-sm text-ink-400">
              Grouped by product family. Click any price column header to jump
              sections. Edit premiums inline — saves to the product&rsquo;s pricing
              rule.
            </p>
          </div>
          <div className="text-right text-xs text-ink-400">
            {spot?.asOf ? `Spot updated ${timeSince(spot.asOf)}` : '—'}
          </div>
        </div>

        {sectionsToRender.length > 0 && (
          <nav className="sticky top-0 z-10 -mx-2 mt-6 overflow-x-auto rounded-xl border border-sell-200 bg-white/95 px-2 py-2 backdrop-blur">
            <div className="flex min-w-max gap-1 text-xs">
              {sectionsToRender.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium text-ink-700 hover:bg-sell-50"
                >
                  {s.label}
                  <span className="rounded-full bg-sell-100 px-1.5 text-[10px] text-sell-700">
                    {bySection.get(s.id)!.length}
                  </span>
                </a>
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
          sectionsToRender.map((s) => (
            <SheetSection
              key={s.id}
              id={s.id}
              label={s.label}
              rows={bySection.get(s.id)!}
              onEdited={() =>
                qc.invalidateQueries({ queryKey: ['admin', 'products', 'sheet'] })
              }
            />
          ))}

        {!isLoading && sectionsToRender.length === 0 && (
          <div className="mt-8 rounded-xl border border-ink-200 bg-white p-12 text-center text-sm text-ink-400">
            Nothing in stock right now.
          </div>
        )}
      </div>
    </PageTint>
  );
}

function SheetSection({
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
    <section id={id} className="mt-8 scroll-mt-24">
      <h2 className="mb-2 text-base font-semibold text-sell-700">{label}</h2>
      <div className="overflow-hidden rounded-xl border border-ink-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">We buy</th>
              <th className="px-4 py-3 text-right">We sell</th>
              <th className="px-4 py-3 text-right w-32">Edit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <SheetRowView key={r.product_id} row={r} onEdited={onEdited} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SheetRowView({ row, onEdited }: { row: EnrichedSheet; onEdited: () => void }) {
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
      <td className="px-4 py-3 text-right font-mono font-semibold">{row.available}</td>
      <td className="px-4 py-3 text-right font-mono text-ink-900">
        {row.buy_price !== null ? `$${Number(row.buy_price).toFixed(2)}` : '—'}
      </td>
      <td className="px-4 py-3 text-right font-mono text-ink-900">
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
