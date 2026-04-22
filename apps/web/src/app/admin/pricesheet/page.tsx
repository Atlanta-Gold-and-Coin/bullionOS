'use client';

import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SheetRow } from '@/lib/sheet-types';
import { rankProducts } from '@/lib/product-search';
import { useLiveSpot } from '@/lib/use-live-spot';
import { saveOrder } from '@/lib/product-mutations';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * Quick Reference Price Sheet.
 *
 * Single-surface cheat sheet for operators quoting at the counter —
 * every active product with its current buy + sell price, fuzzy
 * search at the top, and a margin signal under each price:
 *   We Pay  → "X% of spot" (buy as share of melt value)
 *   We Sell → "+$X over spot" (sell markup in dollars over melt)
 *
 * Ordering follows the same global sort_order every other product
 * listing honors — drag-reorder here re-ranks the catalog everywhere.
 * Disabled while a search query is active (reordering a filtered
 * subset against sparse positions would land rows in the wrong
 * places inside the full catalog — same constraint as In Stock
 * Sheet / Buy Sheet / Catalog).
 *
 * Admin-only page (admin+staff nav); margin signals never leak to
 * client-facing pricing pages.
 */

type Metal = 'gold' | 'silver' | 'platinum' | 'palladium';

export default function PriceSheetPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const { spot } = useLiveSpot();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'products', 'sheet'],
    queryFn: () => apiFetch<SheetRow[]>('/admin/products/sheet'),
    refetchInterval: 60_000,
    // Keep the previous rows rendered during the 60s refetch so the
    // table doesn't flash to "Loading…" on tab re-focus or a window
    // blur/focus cycle. Without this, the poll would blank the UI
    // mid-scroll.
    placeholderData: keepPreviousData,
    // Treat data fresh for just under the poll interval so hitting
    // the page from elsewhere in the app hydrates instantly from the
    // React Query cache instead of hitting the API again.
    staleTime: 55_000,
  });

  // Empty search → rows stay in server sort_order. Active search →
  // rankProducts returns ranked hits. Reorder is disabled in that
  // mode (see below) so the ordering only matters at the display
  // layer here.
  const filtered = useMemo(
    () => rankProducts(data ?? [], search),
    [data, search],
  );

  const dragDisabled = search.trim().length > 0;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // bySection isn't used — price sheet is a flat list — so we work
    // off the server's full sorted catalog (data) rather than the
    // filtered view. Drag is disabled while filtered, so `data` and
    // `filtered` are identical here in practice, but using `data`
    // keeps the invariant explicit.
    const rows = data ?? [];
    const oldIdx = rows.findIndex((r) => r.product_id === active.id);
    const newIdx = rows.findIndex((r) => r.product_id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const reordered = arrayMove(rows, oldIdx, newIdx);
    try {
      await saveOrder(qc, reordered.map((r) => r.product_id));
    } catch (err) {
      alert((err as Error).message ?? 'Reorder failed');
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Quick price sheet</h1>
          <p className="mt-1 text-sm text-ink-400">
            Live buy and sell prices side-by-side. Drag the handle on
            any row to reorder — the new order syncs to every other
            product-listing page.
          </p>
        </div>
        <div className="text-right text-xs text-ink-400">
          {spot?.asOf ? `Spot updated ${fmtTimeSince(spot.asOf)}` : '—'}
        </div>
      </div>

      <div className="mt-4">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by SKU, name, or metal…"
          className="input w-full md:w-96"
          autoFocus
          aria-label="Search products"
        />
        {search.trim() && (
          <span className="ml-3 text-xs text-ink-400">
            {filtered.length} match{filtered.length === 1 ? '' : 'es'} · reorder
            disabled while searching
            <button
              onClick={() => setSearch('')}
              className="ml-2 underline-offset-2 hover:underline"
            >
              clear
            </button>
          </span>
        )}
      </div>

      <div className="mt-6 overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="w-8 px-2 py-3" />
              <th className="px-4 py-3">Product</th>
              {/* Column tints match the semantic side:
                  - We pay = money going out to the customer → red tint
                  - We sell = money coming in from the customer → green tint
                  Kept subtle so the numbers still lead the column.
                  Two premium columns bookend the price pair:
                    Buy premium   (how much below melt we buy)   — red
                    Sell premium  (how much above melt we sell)  — green */}
              <th className="bg-red-50/40 px-4 py-3 text-right text-red-600/80">
                Buy premium
              </th>
              <th className="bg-red-50/70 px-4 py-3 text-right text-red-700">
                We pay
              </th>
              <th className="bg-green-50/70 px-4 py-3 text-right text-green-700">
                We sell
              </th>
              <th className="bg-green-50/40 px-4 py-3 text-right text-green-600/80">
                Sell premium
              </th>
            </tr>
          </thead>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={filtered.map((p) => p.product_id)}
              strategy={verticalListSortingStrategy}
            >
              <tbody>
                {isLoading && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-10 text-center text-sm text-ink-400"
                    >
                      Loading…
                    </td>
                  </tr>
                )}
                {!isLoading && filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-10 text-center text-sm text-ink-400"
                    >
                      {search.trim()
                        ? `No matches for "${search}".`
                        : 'No products.'}
                    </td>
                  </tr>
                )}
                {filtered.map((p) => (
                  <PriceRow
                    key={p.product_id}
                    row={p}
                    spot={spot}
                    dragDisabled={dragDisabled}
                  />
                ))}
              </tbody>
            </SortableContext>
          </DndContext>
        </table>
      </div>
    </div>
  );
}

function PriceRow({
  row,
  spot,
  dragDisabled,
}: {
  row: SheetRow;
  spot: {
    gold: string;
    silver: string;
    platinum: string;
    palladium: string;
  } | null;
  dragDisabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.product_id, disabled: dragDisabled });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    background: isDragging ? '#f7f7f8' : undefined,
  };

  const spotForMetal = spot
    ? Number(spot[row.metal as Metal] ?? 0)
    : 0;
  // metal_content = weight × purity per unit. Multiplying by spot
  // gives the raw metal value of one unit. Dividing our quoted price
  // by that value is the "% of spot" figure — 100% means we buy at
  // pure melt, 96% on a buy means we're 4pts below melt, etc.
  const weight = Number(row.weight_troy_oz) || 0;
  const purity = Number(row.purity) || 0;
  const metalContent = weight * purity;
  const meltValue = spotForMetal * metalContent;

  const buyPct =
    meltValue > 0 && row.buy_price !== null
      ? (Number(row.buy_price) / meltValue) * 100
      : null;
  // We Sell subtitle is dollar-markup over spot melt value, not a
  // percentage — operator's mental model at the counter is "we're
  // charging $X over melt," not "we're charging 105%." Negative
  // values (sell below melt) are unusual but displayed verbatim so
  // pricing-rule misconfigurations are obvious.
  const sellOverSpot =
    meltValue > 0 && row.sell_price !== null
      ? Number(row.sell_price) - meltValue
      : null;
  // Buy premium = what we pay BELOW melt. Positive = discount to melt
  // (typical for generic bullion), negative = we're paying above melt
  // (sometimes happens for semi-numismatic where the numismatic spread
  // drags buys up).
  const buyUnderSpot =
    meltValue > 0 && row.buy_price !== null
      ? meltValue - Number(row.buy_price)
      : null;
  const buyUnderPct =
    buyUnderSpot !== null && meltValue > 0
      ? (buyUnderSpot / meltValue) * 100
      : null;
  const sellOverPct =
    sellOverSpot !== null && meltValue > 0
      ? (sellOverSpot / meltValue) * 100
      : null;

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className="border-t border-ink-200 hover:bg-ink-50/50"
    >
      <td className="px-2 py-3 text-center align-middle">
        <button
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          disabled={dragDisabled}
          className={`px-1 ${
            dragDisabled
              ? 'cursor-not-allowed text-ink-200'
              : 'cursor-grab text-ink-400 hover:text-ink-900 active:cursor-grabbing'
          }`}
        >
          ⋮⋮
        </button>
      </td>
      <td className="px-4 py-3">
        <div className="font-medium">{row.name}</div>
        <div className="font-mono text-xs text-ink-400">
          {row.sku}
          <span className="ml-2 capitalize">{row.metal}</span>
        </div>
      </td>
      {/* Buy premium — sits LEFT of We pay. Dollar amount leading,
          percent as subtitle. Signed: positive = buying below melt. */}
      <td className="bg-red-50/20 px-4 py-3 text-right">
        {buyUnderSpot !== null ? (
          <>
            <div className="font-mono font-semibold text-red-700/80">
              {buyUnderSpot >= 0
                ? `-$${buyUnderSpot.toFixed(2)}`
                : `+$${Math.abs(buyUnderSpot).toFixed(2)}`}
            </div>
            {buyUnderPct !== null && (
              <div className="font-mono text-[11px] text-red-500/70">
                {buyUnderPct >= 0
                  ? `${buyUnderPct.toFixed(2)}% off spot`
                  : `${Math.abs(buyUnderPct).toFixed(2)}% over spot`}
              </div>
            )}
          </>
        ) : (
          <span className="text-ink-300">—</span>
        )}
      </td>
      <td className="bg-red-50/40 px-4 py-3 text-right">
        {/* % of spot is the operator's lead signal at the counter —
            "we're at 96% of spot" communicates the ask faster than
            the dollar figure. Dollar moves to the subtitle. */}
        {buyPct !== null ? (
          <>
            <div className="font-mono font-semibold text-red-700">
              {buyPct.toFixed(1)}% of spot
            </div>
            <div className="font-mono text-[11px] text-red-500/80">
              {row.buy_price !== null
                ? `$${Number(row.buy_price).toFixed(2)}`
                : '—'}
            </div>
          </>
        ) : (
          <div className="font-mono font-semibold text-red-700">
            {row.buy_price !== null
              ? `$${Number(row.buy_price).toFixed(2)}`
              : '—'}
          </div>
        )}
      </td>
      <td className="bg-green-50/40 px-4 py-3 text-right">
        <div className="font-mono font-semibold text-green-700">
          {row.sell_price !== null
            ? `$${Number(row.sell_price).toFixed(2)}`
            : '—'}
        </div>
        {sellOverSpot !== null && (
          <div className="font-mono text-[11px] text-green-600/80">
            {sellOverSpot >= 0
              ? `+$${sellOverSpot.toFixed(2)} over spot`
              : `-$${Math.abs(sellOverSpot).toFixed(2)} under spot`}
          </div>
        )}
      </td>
      {/* Sell premium — sits RIGHT of We sell. Dollar amount only per
          operator spec; percent subtitle added so the two premium
          columns visually balance. */}
      <td className="bg-green-50/20 px-4 py-3 text-right">
        {sellOverSpot !== null ? (
          <>
            <div className="font-mono font-semibold text-green-700/80">
              {sellOverSpot >= 0
                ? `+$${sellOverSpot.toFixed(2)}`
                : `-$${Math.abs(sellOverSpot).toFixed(2)}`}
            </div>
            {sellOverPct !== null && (
              <div className="font-mono text-[11px] text-green-600/70">
                {sellOverPct >= 0
                  ? `+${sellOverPct.toFixed(2)}% over spot`
                  : `-${Math.abs(sellOverPct).toFixed(2)}% under spot`}
              </div>
            )}
          </>
        ) : (
          <span className="text-ink-300">—</span>
        )}
      </td>
    </tr>
  );
}

function fmtTimeSince(iso: string): string {
  const diff = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return new Date(iso).toLocaleTimeString();
}
