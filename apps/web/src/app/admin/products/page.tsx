'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
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
import {
  SECTIONS,
  METAL_GROUPS,
  resolveDisplayCategory,
  compareByFamily,
  groupSectionsByMetal,
  type DisplayCategory,
} from '@/lib/product-category';
import { rankProducts } from '@/lib/product-search';
import { InlineField } from '@/components/inline-field';
import { savePatch, saveOrder } from '@/lib/product-mutations';
import type { SheetRow } from '@/lib/sheet-types';

interface Product {
  id: string;
  sku: string;
  name: string;
  metal: string;
  category: string;
  weight_troy_oz: string;
  purity: string;
  metal_content_troy_oz: string;
  is_active: boolean;
  show_on_website: boolean;
  sort_order: number;
}

/**
 * Per-product inventory + pricing snapshot the Catalog row renders
 * alongside its name/sku cells. Single source of truth so every
 * stock-related column (on-hand, reserved badge, sell price, location)
 * reads from the same /admin/products/sheet response — one round-trip
 * per page load, not one per column.
 *
 * This page absorbed the old /admin/inventory ("Products" tab) that
 * used to be a separate surface. Hoisting the shape to module scope so
 * SortableRow + StockCell can both type their props against it
 * without a circular/nested definition.
 */
interface StockSnapshot {
  on_hand: number;
  reserved: number;
  sell_price: string | null;
  location: string;
}

/**
 * Catalog page. Products are grouped by metal → category (Gold Coins, Gold
 * Bars, Pre-1933 Gold, Silver Coins, Generic Silver, Platinum Coins / Bars,
 * Palladium Coins / Bars, Other) with a family sort inside each.
 *
 * Drag-reorder still works, but scoped per category: the drop zone is the
 * current section only. Cross-section drag is intentionally disabled —
 * changing a product's metal/category happens on the detail page, not here.
 */
export default function ProductsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'products'],
    queryFn: () => apiFetch<Product[]>('/admin/products'),
  });
  // The sheet endpoint carries live quantity_on_hand + available per
  // product. Join by product_id so the Catalog row can show + edit stock
  // without a second round-trip per row. Refreshes on the same cadence
  // as the inventory page.
  const { data: sheet } = useQuery({
    queryKey: ['admin', 'products', 'sheet'],
    queryFn: () => apiFetch<SheetRow[]>('/admin/products/sheet'),
    refetchInterval: 60_000,
  });
  const stockByProduct = useMemo(() => {
    const m = new Map<string, StockSnapshot>();
    for (const s of sheet ?? []) {
      m.set(s.product_id, {
        on_hand: s.quantity_on_hand,
        reserved: s.quantity_reserved,
        sell_price: s.sell_price,
        location: s.location,
      });
    }
    return m;
  }, [sheet]);

  // Local mirror of the server order. We split by section for the DnD
  // contexts; on drop we persist the flattened order back to the server.
  const [items, setItems] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (!data) return;
    // Default order within each category: family sort (keeps Eagles, etc.
    // grouped by size). Operators can still drag to override; after a
    // drag, sort_order becomes the source of truth for that section.
    const sorted = [...data].sort((a, b) => {
      const ca = resolveDisplayCategory(a);
      const cb = resolveDisplayCategory(b);
      // Use the SECTIONS array index to order categories consistently.
      const ia = SECTIONS.findIndex((s) => s.id === ca);
      const ib = SECTIONS.findIndex((s) => s.id === cb);
      if (ia !== ib) return ia - ib;
      // Within the same category, fall back to server sort_order if it
      // diverges from a pristine family sort — respects manual reorders.
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return compareByFamily(a, b);
    });
    setItems(sorted);
  }, [data]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  // When a search query is active we hide non-matching rows but keep
  // the grouped layout so operators see which section a hit lives in.
  // Drag-reorder is disabled in that mode — shuffling a filtered subset
  // would reorder against sparse indices and land rows in the wrong
  // place inside the full catalog. Clear the search to reorder.
  const searchActive = search.trim().length > 0;
  const visibleItems = useMemo(
    () => (searchActive ? rankProducts(items, search) : items),
    [items, search, searchActive],
  );

  const sectionRows = useMemo(() => {
    // Section map keyed on string (not DisplayCategory) because
    // resolveDisplayCategory returns a string — which covers builtins
    // plus admin-added custom slugs. Bucketing against the builtin
    // SECTIONS list means custom slugs simply get no bucket, which
    // is the right "fall off the visible list" behavior here.
    const out = new Map<string, Product[]>();
    for (const s of SECTIONS) out.set(s.id, []);
    for (const p of visibleItems) {
      const c = resolveDisplayCategory(p);
      out.get(c)?.push(p);
    }
    return out;
  }, [visibleItems]);

  const sectionsToRender = SECTIONS.filter(
    (s) => (sectionRows.get(s.id)?.length ?? 0) > 0,
  );

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // Find which category the drag originated in so we can constrain the
    // reorder to that section.
    const activeProduct = items.find((p) => p.id === active.id);
    const overProduct = items.find((p) => p.id === over.id);
    if (!activeProduct || !overProduct) return;
    const aCat = resolveDisplayCategory(activeProduct);
    const oCat = resolveDisplayCategory(overProduct);
    if (aCat !== oCat) return;

    const sectionList = sectionRows.get(aCat)!;
    const oldIdx = sectionList.findIndex((p) => p.id === active.id);
    const newIdx = sectionList.findIndex((p) => p.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const reorderedSection = arrayMove(sectionList, oldIdx, newIdx);

    // Rebuild the full flat list from per-section arrays so server
    // sort_order reflects the visible UI.
    const nextFlat: Product[] = [];
    for (const s of SECTIONS) {
      if (s.id === aCat) nextFlat.push(...reorderedSection);
      else if (sectionRows.get(s.id)) nextFlat.push(...sectionRows.get(s.id)!);
    }

    const previous = items;
    setItems(nextFlat);
    try {
      await saveOrder(qc, nextFlat.map((p) => p.id));
      qc.setQueryData(['admin', 'products'], nextFlat);
    } catch (err) {
      setItems(previous);
      alert(
        err instanceof ApiError
          ? `Reorder failed: ${err.message}`
          : 'Reorder failed',
      );
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Catalog</h1>
          <p className="mt-1 text-sm text-ink-400">
            Grouped by metal and family. Drag the{' '}
            <span className="font-mono">⋮⋮</span> handle to reorder within a
            category — order applies everywhere the catalog is listed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/products/import"
            className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700 hover:bg-ink-50"
          >
            Import CSV
          </Link>
          <Link
            href="/admin/products/new"
            className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800"
          >
            New product
          </Link>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by SKU, name, or metal…"
          className="input w-full md:w-96"
          aria-label="Search catalog"
        />
        {searchActive && (
          <span className="text-xs text-ink-400">
            {visibleItems.length} match{visibleItems.length === 1 ? '' : 'es'} ·
            drag disabled while searching
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
        // top-14 sits exactly under the admin layout's sticky header
        // (py-3 + SpotTicker ~= 56px). Without this the nav collides
        // with the spot-ticker bar and hides behind it at scroll.
        <nav className="sticky top-14 z-20 -mx-2 mt-6 overflow-x-auto rounded-xl border border-ink-200 bg-white/95 px-2 py-2 shadow-sm backdrop-blur">
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
                    className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-ink-700 hover:bg-ink-50"
                  >
                    {s.label}
                    <span className="rounded-full bg-ink-100 px-1.5 text-[10px] text-ink-600">
                      {sectionRows.get(s.id)!.length}
                    </span>
                  </a>
                ))}
              </div>
            ))}
          </div>
        </nav>
      )}

      {isLoading ? (
        <div className="mt-6 rounded-xl border border-ink-200 bg-white p-8 text-center text-sm text-ink-400">
          Loading…
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          {groupSectionsByMetal(sectionsToRender).map((g) => (
            <div key={g.metal}>
              <h2
                className={`mt-10 mb-2 rounded-md border px-3 py-2 text-lg font-semibold ${METAL_GROUPS[g.metal].accentClass}`}
              >
                {METAL_GROUPS[g.metal].label}
              </h2>
              {g.sections.map((s) => (
                <CatalogSection
                  key={s.id}
                  id={s.id}
                  label={s.label}
                  rows={sectionRows.get(s.id)!}
                  dragDisabled={searchActive}
                  stockByProduct={stockByProduct}
                />
              ))}
            </div>
          ))}
        </DndContext>
      )}
    </div>
  );
}

function CatalogSection({
  id,
  label,
  rows,
  dragDisabled,
  stockByProduct,
}: {
  id: string;
  label: string;
  rows: Product[];
  dragDisabled: boolean;
  stockByProduct: Map<string, StockSnapshot>;
}) {
  return (
    <section id={id} className="mt-4 scroll-mt-24">
      <h3 className="mb-2 text-sm font-semibold text-ink-700">{label}</h3>
      {/* MOB-002: horizontal scroll on narrow viewports. Min-width
          widened from 900 → 1060 to accommodate the two additional
          columns (Sell price, Location) folded in from the old
          Products tab. */}
      <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full min-w-[1060px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="w-8 px-2 py-3" />
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Metal</th>
              <th className="px-4 py-3 text-right">Weight (oz)</th>
              <th className="px-4 py-3 text-right">Purity</th>
              <th className="px-4 py-3 text-right">Content (oz)</th>
              <th className="px-4 py-3 text-right">On hand</th>
              {/* New columns: live sell price + storage location.
                  Both moved in from the old /admin/inventory page so
                  Catalog is a complete single surface. */}
              <th className="px-4 py-3 text-right">Sell</th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3 text-center">On website</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <SortableContext
            items={rows.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            <tbody>
              {rows.map((p) => (
                <SortableRow
                  key={p.id}
                  product={p}
                  dragDisabled={dragDisabled}
                  stock={
                    stockByProduct.get(p.id) ?? {
                      on_hand: 0,
                      reserved: 0,
                      sell_price: null,
                      location: 'main',
                    }
                  }
                />
              ))}
            </tbody>
          </SortableContext>
        </table>
      </div>
    </section>
  );
}

function SortableRow({
  product,
  dragDisabled,
  stock,
}: {
  product: Product;
  dragDisabled: boolean;
  stock: StockSnapshot;
}) {
  const qc = useQueryClient();
  const [checked, setChecked] = useState(product.show_on_website);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: product.id, disabled: dragDisabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    background: isDragging ? '#f7f7f8' : undefined,
  };

  useEffect(() => {
    setChecked(product.show_on_website);
  }, [product.show_on_website]);

  async function toggleWebsite(next: boolean) {
    const prev = checked;
    setChecked(next);
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/admin/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ show_on_website: next }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'products'] });
    } catch (err) {
      setChecked(prev);
      setError(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className="border-t border-ink-200 hover:bg-ink-50/50"
    >
      <td className="px-2 py-3 text-center">
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
      <td className="px-4 py-3 font-mono text-xs">
        {/*
          PROD-003: editable SKU. InlineField PATCHes /admin/products/:id
          with the new sku (service normalizes + rejects duplicates with a
          400). The detail link is relocated to a small arrow icon so the
          cell is still keyboard-clickable for edits without capturing
          stray clicks meant for navigation.
        */}
        <div className="flex items-center gap-1">
          <InlineField
            value={product.sku}
            onSave={(next) => savePatch(product.id, qc, { sku: next.toUpperCase() })}
            maxLength={64}
            ariaLabel="product sku"
            displayClassName="font-mono"
            // Mirror the server-side regex so the UI rejects invalid input
            // before the round-trip. Empty string would bypass that regex,
            // so we also explicitly require at least one char.
            validate={(v) => {
              const trimmed = v.trim();
              if (trimmed.length === 0) return 'SKU required';
              if (!/^[A-Z0-9._-]+$/i.test(trimmed)) {
                return 'A–Z, 0–9, _ or -';
              }
              return null;
            }}
          />
          <Link
            href={`/admin/products/${product.id}`}
            className="text-ink-400 hover:text-ink-900"
            aria-label="Open product detail"
            title="Open product detail"
          >
            ↗
          </Link>
        </div>
      </td>
      <td className="px-4 py-3">
        <InlineField
          value={product.name}
          onSave={(next) => savePatch(product.id, qc, { name: next })}
          maxLength={200}
          ariaLabel="product name"
          displayClassName="font-medium"
          validate={(v) => (v.trim().length === 0 ? 'Name required' : null)}
        />
        {!product.is_active && (
          <span className="ml-2 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium text-ink-500">
            inactive
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <select
          value={product.metal}
          onChange={(e) =>
            savePatch(product.id, qc, { metal: e.target.value })
          }
          className="input h-8 py-0 text-xs capitalize"
        >
          <option value="gold">Gold</option>
          <option value="silver">Silver</option>
          <option value="platinum">Platinum</option>
          <option value="palladium">Palladium</option>
        </select>
      </td>
      <td className="px-4 py-3 text-right font-mono">
        <InlineField
          value={String(product.weight_troy_oz)}
          onSave={(next) =>
            savePatch(product.id, qc, { weight_troy_oz: Number(next) })
          }
          type="number"
          step="0.0001"
          min={0.00000001}
          ariaLabel="weight"
          format={(v) => Number(v).toFixed(4)}
          validate={(v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n <= 0) return 'Must be > 0';
            return null;
          }}
        />
      </td>
      <td className="px-4 py-3 text-right font-mono">
        <InlineField
          value={String(product.purity)}
          onSave={(next) =>
            savePatch(product.id, qc, { purity: Number(next) })
          }
          type="number"
          step="0.0001"
          min={0.0001}
          max={1}
          ariaLabel="purity"
          format={(v) => Number(v).toFixed(4)}
          validate={(v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n <= 0 || n > 1)
              return 'Between 0 and 1';
            return null;
          }}
        />
      </td>
      <td className="px-4 py-3 text-right font-mono text-ink-500">
        {/* Content is derived (weight × purity) — read-only; auto-updates
            when weight or purity saves. */}
        {Number(product.metal_content_troy_oz).toFixed(4)}
      </td>
      <td className="px-4 py-3 text-right">
        <StockCell
          productId={product.id}
          onHand={stock.on_hand}
          reserved={stock.reserved}
        />
      </td>
      {/* Live sell price from /admin/products/sheet — snapshot at page
          load, refreshes on the same 60-second cadence. Em dash when
          pricing rules aren't set for this product yet. */}
      <td className="px-4 py-3 text-right font-mono text-ink-700">
        {stock.sell_price
          ? `$${Number(stock.sell_price).toFixed(2)}`
          : '—'}
      </td>
      {/* Storage location — inline editor that hits
          PATCH /admin/inventory/:productId/location (PROD-002). Trimmed
          server-side; empty collapses to 'main'. No fan-out to pricing
          queries since only the inventory listing consumes it. */}
      <td className="px-4 py-3 text-xs">
        <InlineField
          value={stock.location}
          onSave={async (next) => {
            await apiFetch(`/admin/inventory/${product.id}/location`, {
              method: 'PATCH',
              body: JSON.stringify({ location: next.trim() || 'main' }),
            });
            await qc.invalidateQueries({
              queryKey: ['admin', 'products', 'sheet'],
            });
          }}
          maxLength={64}
          ariaLabel="storage location"
          displayClassName="font-mono text-ink-700"
        />
      </td>
      <td className="px-4 py-3 text-center">
        <label className="inline-flex cursor-pointer items-center">
          <input
            type="checkbox"
            checked={checked}
            disabled={busy}
            onChange={(e) => toggleWebsite(e.target.checked)}
            className="peer sr-only"
          />
          <div
            className={`relative h-5 w-9 rounded-full transition ${
              checked ? 'bg-green-500' : 'bg-ink-200'
            } ${busy ? 'opacity-60' : ''}`}
          >
            <div
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                checked ? 'left-[18px]' : 'left-0.5'
              }`}
            />
          </div>
        </label>
        {error && <div className="mt-1 text-[10px] text-red-700">{error}</div>}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2 text-xs">
          <Link
            href={`/admin/products/${product.id}`}
            className="text-ink-600 hover:text-ink-900"
          >
            Edit →
          </Link>
          {product.is_active ? (
            <DeleteButton productId={product.id} productName={product.name} />
          ) : (
            <>
              <RestoreButton productId={product.id} productName={product.name} />
              <PurgeButton productId={product.id} productName={product.name} />
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * Soft-delete the product. The backend flips is_active=false, which
 * removes the row from every list query that passes `onlyActive: true`
 * (the sheet endpoint, /public/what-we-pay, /public/in-stock, the
 * invoice wizard combobox, the WordPress plugin feeds). The Catalog
 * keeps the row visible with an "inactive" badge so admins can restore
 * it without a DB round-trip.
 *
 * Hard-delete is not exposed in the UI — historical invoices are safe
 * per migration 010 (product_id SET NULL), but accidental hard-delete
 * is unrecoverable from the UI, so we gate it behind a direct API call
 * or a future "Permanently delete" flow.
 */
function DeleteButton({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function run() {
    if (
      !confirm(
        `Delete "${productName}"?\n\nIt'll disappear from In-stock, What We Pay, the client portal, and the WordPress plugin feed. The row stays in the Catalog as "inactive" so you can restore it later.`,
      )
    )
      return;
    // PIN gate — second wall against accidental delete-clicks during
    // rapid catalog edits. Server re-enforces (?pin=<PIN>) so hitting
    // the API directly without the PIN still fails.
    const pin = prompt('Enter delete PIN:');
    if (!pin) return;
    setBusy(true);
    try {
      await apiFetch(
        `/admin/products/${productId}?pin=${encodeURIComponent(pin.trim())}`,
        { method: 'DELETE' },
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['admin', 'products'] }),
        qc.invalidateQueries({ queryKey: ['admin', 'products', 'sheet'] }),
        qc.invalidateQueries({ queryKey: ['admin', 'inventory'] }),
        qc.invalidateQueries({ queryKey: ['client', 'prices'] }),
        qc.invalidateQueries({ queryKey: ['client', 'in-stock'] }),
      ]);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={run}
      disabled={busy}
      className="rounded-md border border-red-200 px-2 py-0.5 text-red-700 hover:bg-red-50 disabled:opacity-60"
    >
      {busy ? '…' : 'Delete'}
    </button>
  );
}

/**
 * Permanent row delete — only shown for inactive products, so the
 * operator has already passed one gate (soft-delete) and consciously
 * clicked it a second time. Still PIN-protected server-side. The row
 * is fully removed from `products`; historical invoices/movement rows
 * are unaffected (FKs cascade / set-null per migrations 010 + 012).
 */
function PurgeButton({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function run() {
    if (
      !confirm(
        `Permanently delete "${productName}"?\n\nThis row will be GONE — no "Restore" afterwards. Historical invoices that reference it stay intact, but the SKU disappears from every dropdown, sheet, and feed forever.`,
      )
    )
      return;
    const pin = prompt('Enter delete PIN to confirm permanent deletion:');
    if (!pin) return;
    setBusy(true);
    try {
      await apiFetch(
        `/admin/products/${productId}?hard=1&pin=${encodeURIComponent(pin.trim())}`,
        { method: 'DELETE' },
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['admin', 'products'] }),
        qc.invalidateQueries({ queryKey: ['admin', 'products', 'sheet'] }),
        qc.invalidateQueries({ queryKey: ['admin', 'inventory'] }),
      ]);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Purge failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={run}
      disabled={busy}
      title={`Permanently delete "${productName}" — cannot be undone`}
      className="rounded-md border border-red-400 bg-red-50 px-2 py-0.5 text-red-800 hover:bg-red-100 disabled:opacity-60"
    >
      {busy ? '…' : 'Purge'}
    </button>
  );
}

/**
 * Flip is_active back to true. Catalog rows with the "inactive" badge
 * get this instead of the Delete button so a mistaken removal is a
 * one-click undo.
 */
function RestoreButton({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await savePatch(productId, qc, { is_active: true });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Restore failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={run}
      disabled={busy}
      title={`Restore "${productName}" — makes it visible everywhere again`}
      className="rounded-md border border-green-300 px-2 py-0.5 text-green-800 hover:bg-green-50 disabled:opacity-60"
    >
      {busy ? '…' : 'Restore'}
    </button>
  );
}

/**
 * Inline inventory adjuster on the Catalog row. Hits
 * PATCH /admin/inventory/:productId — the same endpoint the dedicated
 * Products page uses. Delta can be positive (restock) or negative
 * (manual shrinkage / transfer), non-zero integer only.
 *
 * Collapsed: shows the current on-hand value. Click to expand into a
 * +/- numeric input. Every successful save invalidates the sheet +
 * inventory queries so every other page shows the new count on its
 * next fetch.
 */
function StockCell({
  productId,
  onHand,
  reserved,
}: {
  productId: string;
  onHand: number;
  /** Open-invoice reservations; surfaced as a tiny "N reserved" badge. */
  reserved: number;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  // Optional audit note written onto the movement row. Folded in from
  // the old /admin/inventory page (was a separate form field) so every
  // adjustment keeps its "why" attached to the history.
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function apply(raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0 || !Number.isInteger(n)) {
      setErr('non-zero integer');
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await apiFetch(`/admin/inventory/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          delta: n,
          // Prefer the operator's own note; fall back to a generic
          // label so the movement history always has something
          // recognizable in the 'notes' column.
          notes: notes.trim() || 'Catalog quick-adjust',
        }),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['admin', 'products', 'sheet'] }),
        qc.invalidateQueries({ queryKey: ['admin', 'inventory'] }),
      ]);
      setDelta('');
      setNotes('');
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message ?? 'Failed');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    // Display rule: never show a negative number to the operator. The
    // DB + movement audit still tracks reality (a forced oversell
    // leaves onHand < 0), but the UI clamps the visible count to 0
    // and surfaces the shortage as a small "oversold by N" chip. This
    // keeps the dashboards / sheets from reading as alarming-red
    // while preserving the underlying accounting via the movement
    // history. (Public /public/in-stock already filters > 0, so
    // customers never see negatives regardless.)
    const oversoldBy = onHand < 0 ? -onHand : 0;
    const displayOnHand = Math.max(0, onHand);
    const tone = displayOnHand > 0 ? 'text-ink-900' : 'text-ink-400';
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-0.5 font-mono hover:border-ink-200"
        title={
          oversoldBy > 0
            ? `Oversold by ${oversoldBy} (admin override). Click to adjust.`
            : reserved > 0
              ? `${reserved} reserved by open invoices. Click to adjust.`
              : 'Click to adjust'
        }
      >
        <span className={tone}>{displayOnHand}</span>
        {/* Reservation badge — folded in from the old Products page.
            Only renders when reserved > 0 so quiet rows stay quiet. */}
        {reserved > 0 && (
          <span className="rounded-full bg-amber-100 px-1.5 text-[9px] font-medium text-amber-700">
            {reserved}r
          </span>
        )}
        {oversoldBy > 0 && (
          <span className="rounded-full bg-red-100 px-1.5 text-[9px] font-medium text-red-700">
            −{oversoldBy}
          </span>
        )}
      </button>
    );
  }
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => apply('-1')}
        disabled={busy}
        aria-label="Decrement stock"
        className="rounded-md border border-ink-200 px-1.5 text-sm hover:bg-red-50 hover:text-red-700 disabled:opacity-60"
      >
        −
      </button>
      <input
        type="number"
        step="1"
        value={delta}
        onChange={(e) => setDelta(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply(delta);
          } else if (e.key === 'Escape') {
            setDelta('');
            setOpen(false);
          }
        }}
        placeholder="+3 / -1"
        className="input h-7 w-16 py-0 text-right font-mono text-xs"
        disabled={busy}
        autoFocus
      />
      <button
        type="button"
        onClick={() => apply('+1')}
        disabled={busy}
        aria-label="Increment stock"
        className="rounded-md border border-ink-200 px-1.5 text-sm hover:bg-green-50 hover:text-green-700 disabled:opacity-60"
      >
        +
      </button>
      <button
        type="button"
        onClick={() => apply(delta)}
        disabled={busy || delta === ''}
        className="rounded-md bg-ink-900 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-ink-800 disabled:opacity-60"
      >
        {busy ? '…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={() => {
          setDelta('');
          setNotes('');
          setErr(null);
          setOpen(false);
        }}
        disabled={busy}
        aria-label="Cancel"
        className="rounded-md border border-ink-200 px-1 text-[11px] text-ink-500 hover:bg-ink-50"
      >
        ✕
      </button>
      {/* Optional audit note. Stays inline so the whole adjust stays in
          one row — the expanded editor already flows onto its own line
          via whitespace-wrap at narrower viewports. */}
      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="why? (optional)"
        maxLength={200}
        disabled={busy}
        className="input ml-1 h-7 w-40 py-0 text-xs"
        aria-label="Adjustment note"
      />
      {err && <span className="ml-1 text-[10px] text-red-700">{err}</span>}
    </div>
  );
}
