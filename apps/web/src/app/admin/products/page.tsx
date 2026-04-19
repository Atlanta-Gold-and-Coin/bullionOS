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
  deriveDisplayCategory,
  compareByFamily,
  groupSectionsByMetal,
  type DisplayCategory,
} from '@/lib/product-category';
import { rankProducts } from '@/lib/product-search';

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
      const ca = deriveDisplayCategory(a);
      const cb = deriveDisplayCategory(b);
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
    const out = new Map<DisplayCategory, Product[]>();
    for (const s of SECTIONS) out.set(s.id, []);
    for (const p of visibleItems) {
      const c = deriveDisplayCategory(p);
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
    const aCat = deriveDisplayCategory(activeProduct);
    const oCat = deriveDisplayCategory(overProduct);
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
      await apiFetch('/admin/products/reorder', {
        method: 'POST',
        body: JSON.stringify({ order: nextFlat.map((p) => p.id) }),
      });
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
        <nav className="sticky top-0 z-10 -mx-2 mt-6 overflow-x-auto rounded-xl border border-ink-200 bg-white/95 px-2 py-2 backdrop-blur">
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
}: {
  id: string;
  label: string;
  rows: Product[];
  dragDisabled: boolean;
}) {
  return (
    <section id={id} className="mt-4 scroll-mt-24">
      <h3 className="mb-2 text-sm font-semibold text-ink-700">{label}</h3>
      {/* MOB-002: horizontal scroll on narrow viewports. */}
      <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="w-8 px-2 py-3" />
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3 text-right">Weight (oz)</th>
              <th className="px-4 py-3 text-right">Purity</th>
              <th className="px-4 py-3 text-right">Content (oz)</th>
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
                <SortableRow key={p.id} product={p} dragDisabled={dragDisabled} />
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
}: {
  product: Product;
  dragDisabled: boolean;
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
        <Link href={`/admin/products/${product.id}`} className="hover:underline">
          {product.sku}
        </Link>
      </td>
      <td className="px-4 py-3">
        <Link href={`/admin/products/${product.id}`} className="hover:underline">
          {product.name}
        </Link>
        {!product.is_active && (
          <span className="ml-2 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium text-ink-500">
            inactive
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-right font-mono">
        {Number(product.weight_troy_oz).toFixed(4)}
      </td>
      <td className="px-4 py-3 text-right font-mono">
        {Number(product.purity).toFixed(4)}
      </td>
      <td className="px-4 py-3 text-right font-mono">
        {Number(product.metal_content_troy_oz).toFixed(4)}
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
        <Link
          href={`/admin/products/${product.id}`}
          className="text-xs text-ink-600 hover:text-ink-900"
        >
          Edit →
        </Link>
      </td>
    </tr>
  );
}
