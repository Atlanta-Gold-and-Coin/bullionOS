'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface ComboboxProduct {
  id: string;
  sku: string;
  name: string;
  metal: string;
}

/**
 * Fuzzy product picker for the invoice wizard.
 *
 * Replaces the bare <select> that held 600+ rows. Typing filters the list
 * by scoring SKU/name/metal against the query with a lightweight ranker:
 *   +100 substring match in SKU
 *   +60  word-boundary match in name
 *   +30  substring match in name
 *   +20  per additional token that matches anywhere
 *   +15  bonus for prefix match
 * Empty query falls back to alphabetical by name (same as stock order).
 *
 * A caller-supplied "+ New item" sentinel option can be injected at the
 * top — click it and the combobox closes with an empty value. The wizard
 * listens for an empty value with a non-empty custom-name elsewhere.
 */
export function ProductCombobox({
  products,
  value,
  adHoc,
  onChange,
  onPickAdHoc,
  placeholder = 'Search by SKU, name, or metal…',
}: {
  products: ComboboxProduct[];
  /** Selected product id, or '' when nothing picked / ad-hoc mode. */
  value: string;
  /** True when the row is in "New item" mode (show sentinel styling). */
  adHoc: boolean;
  onChange: (productId: string) => void;
  onPickAdHoc: () => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selected = useMemo(
    () => products.find((p) => p.id === value) ?? null,
    [products, value],
  );

  const ranked = useMemo(() => rank(products, query), [products, query]);

  // Keep activeIdx inside the visible list as it shrinks.
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      // +1 accounts for the "+ New item" row at index 0.
      setActiveIdx((i) => Math.min(i + 1, ranked.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitAt(activeIdx);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  function commitAt(idx: number) {
    if (idx === 0) {
      onPickAdHoc();
      setOpen(false);
      setQuery('');
      return;
    }
    const product = ranked[idx - 1];
    if (!product) return;
    onChange(product.id);
    setOpen(false);
    setQuery('');
  }

  const displayLabel = adHoc
    ? 'New item'
    : selected
      ? `${selected.sku} · ${selected.name}`
      : '';

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={open ? query : displayLabel}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={placeholder}
        className="input w-full"
        role="combobox"
        aria-expanded={open}
        aria-controls="product-combobox-list"
        aria-autocomplete="list"
      />
      {open && (
        <ul
          id="product-combobox-list"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-ink-200 bg-white shadow-lg"
          role="listbox"
        >
          <li
            role="option"
            aria-selected={activeIdx === 0}
            onMouseDown={(e) => {
              e.preventDefault();
              commitAt(0);
            }}
            onMouseEnter={() => setActiveIdx(0)}
            className={`cursor-pointer border-b border-ink-100 px-3 py-2 text-sm ${
              activeIdx === 0 ? 'bg-ink-900 text-white' : 'text-ink-900'
            }`}
          >
            + New item
            <span
              className={`ml-2 text-[10px] ${
                activeIdx === 0 ? 'text-ink-200' : 'text-ink-400'
              }`}
            >
              scrap / one-off / custom
            </span>
          </li>
          {ranked.map((p, i) => {
            const rowIdx = i + 1;
            const isActive = activeIdx === rowIdx;
            return (
              <li
                key={p.id}
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitAt(rowIdx);
                }}
                onMouseEnter={() => setActiveIdx(rowIdx)}
                className={`cursor-pointer border-b border-ink-100 px-3 py-2 text-sm last:border-b-0 ${
                  isActive ? 'bg-ink-900 text-white' : 'text-ink-900'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span
                    className={`shrink-0 font-mono text-[11px] ${
                      isActive ? 'text-ink-200' : 'text-ink-400'
                    }`}
                  >
                    {p.sku}
                  </span>
                </div>
                <div
                  className={`text-[11px] capitalize ${
                    isActive ? 'text-ink-200' : 'text-ink-400'
                  }`}
                >
                  {p.metal}
                </div>
              </li>
            );
          })}
          {ranked.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-ink-400">
              No matches. Use &ldquo;New item&rdquo; above to enter one manually.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Fuzzy scorer. Tokenizes the query on whitespace and requires every
 * token to match somewhere; otherwise the row is dropped. Score biases
 * toward SKU hits and prefix matches so typing "AU-E" promotes Eagles to
 * the top instantly.
 */
function rank(
  products: ComboboxProduct[],
  rawQuery: string,
): ComboboxProduct[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) {
    return [...products].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ p: ComboboxProduct; s: number }> = [];
  for (const p of products) {
    const sku = p.sku.toLowerCase();
    const name = p.name.toLowerCase();
    const metal = p.metal.toLowerCase();
    let score = 0;
    let matchedAll = true;

    // Every token must appear somewhere.
    for (const t of tokens) {
      if (!sku.includes(t) && !name.includes(t) && !metal.includes(t)) {
        matchedAll = false;
        break;
      }
    }
    if (!matchedAll) continue;

    if (sku.includes(q)) score += 100;
    if (sku.startsWith(q)) score += 15;
    if (name.includes(q)) score += 30;
    // Word-boundary hit in name (e.g. "eagle" in "American Gold Eagle").
    if (new RegExp(`\\b${escapeRegex(q)}`).test(name)) score += 60;
    if (metal.includes(q)) score += 5;
    // Per-token credit so multi-word queries bubble up rows that hit
    // each token.
    score += tokens.length * 20;

    scored.push({ p, s: score });
  }
  scored.sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name));
  return scored.slice(0, 200).map((x) => x.p);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
