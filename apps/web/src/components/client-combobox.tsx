'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface ComboboxClient {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company?: string | null;
  email: string | null;
  phone?: string | null;
  client_type?: 'retail' | 'wholesaler';
}

/**
 * Fuzzy client picker for the invoice wizard (ticket INV-004).
 *
 * Replaces the earlier two-control pattern (separate search input + bare
 * select) with one unified combobox — same shape as ProductCombobox.
 *
 * Ranker scores each client against the query across every likely field:
 *   +100 SKU-style substring match on email local-part
 *   +60  word-boundary match in "first last" or "company"
 *   +30  substring match in "first last" or "company"
 *   +30  substring match on phone digits-only
 *   +15  per additional token that matches anywhere
 *   +10  prefix match on any of {first, last, company}
 *
 * Empty query returns the alphabetical-by-last-name list (stable stock
 * order). Keyboard: ArrowUp/Down navigate, Enter selects, Escape closes.
 * Company-only records render "Acme Coin Co." — no "null null".
 */
export function ClientCombobox({
  clients,
  value,
  onChange,
  placeholder = 'Search name, company, email, phone…',
  autoFocus = false,
}: {
  clients: ComboboxClient[];
  value: string;
  onChange: (clientId: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => clients.find((c) => c.id === value) ?? null,
    [clients, value],
  );

  // Seed the input with the selected client's display name on mount so
  // the field isn't blank when the user is editing an existing draft.
  const [primedFor, setPrimedFor] = useState<string | null>(null);
  useEffect(() => {
    if (selected && primedFor !== selected.id && !open) {
      setQuery(displayName(selected));
      setPrimedFor(selected.id);
    }
    if (!selected && primedFor !== null) {
      setQuery('');
      setPrimedFor(null);
    }
  }, [selected, primedFor, open]);

  const ranked = useMemo(() => rank(clients, query), [clients, query]);

  // Close on outside click.
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (!wrap.current) return;
      if (!wrap.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Reset cursor when the list changes.
  useEffect(() => {
    setCursor(0);
  }, [query, open]);

  return (
    <div ref={wrap} className="relative">
      <input
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          // Typing after a selection clears the binding so the operator
          // doesn't accidentally keep the old client while searching.
          if (value && displayName(selected) !== e.target.value) onChange('');
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setCursor((c) => Math.min(ranked.length - 1, c + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (e.key === 'Enter') {
            const pick = ranked[cursor];
            if (pick) {
              onChange(pick.id);
              setQuery(displayName(pick));
              setPrimedFor(pick.id);
              setOpen(false);
              e.preventDefault();
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className="input w-full"
        aria-autocomplete="list"
        aria-expanded={open}
        role="combobox"
      />
      {open && ranked.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-ink-200 bg-white shadow-lg"
        >
          {ranked.slice(0, 40).map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === cursor}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(c.id);
                setQuery(displayName(c));
                setPrimedFor(c.id);
                setOpen(false);
              }}
              onMouseEnter={() => setCursor(i)}
              className={`cursor-pointer px-3 py-2 text-sm ${
                i === cursor ? 'bg-ink-50' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink-900">{displayName(c)}</span>
                {c.client_type === 'wholesaler' && (
                  <span className="rounded-full bg-gold-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold-600">
                    Wholesale
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-ink-500">
                {[c.email, c.phone].filter(Boolean).join(' · ') || '—'}
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && ranked.length === 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-ink-200 bg-white p-3 text-xs text-ink-500 shadow-lg">
          No clients match &ldquo;{query}&rdquo;. Create the client first, then pick them
          here.
        </div>
      )}
    </div>
  );
}

export function displayName(c: ComboboxClient | null): string {
  if (!c) return '';
  const personal = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  if (personal) {
    return c.company ? `${personal} · ${c.company}` : personal;
  }
  return c.company ?? '(unnamed)';
}

// ---------- ranker ----------

function rank(
  rows: ComboboxClient[],
  q: string,
): Array<ComboboxClient & { _score?: number }> {
  const trimmed = q.trim().toLowerCase();
  if (!trimmed) {
    return [...rows].sort((a, b) => {
      const an = lastSort(a);
      const bn = lastSort(b);
      return an.localeCompare(bn);
    });
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const digitsQ = trimmed.replace(/\D/g, '');
  const scored = rows
    .map((c) => ({ c, s: score(c, trimmed, tokens, digitsQ) }))
    .filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => ({ ...x.c, _score: x.s }));
}

function score(
  c: ComboboxClient,
  q: string,
  tokens: string[],
  digitsQ: string,
): number {
  const personal = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim().toLowerCase();
  const company = (c.company ?? '').toLowerCase();
  const email = (c.email ?? '').toLowerCase();
  const emailLocal = email.split('@')[0] ?? '';
  const phoneDigits = (c.phone ?? '').replace(/\D/g, '');

  let s = 0;
  if (emailLocal && emailLocal.includes(q)) s += 100;

  // Name / company matches
  for (const name of [personal, company]) {
    if (!name) continue;
    // word-boundary
    if (new RegExp(`(^|\\s)${escape(q)}`, 'i').test(name)) s += 60;
    else if (name.includes(q)) s += 30;
    if (name.startsWith(q)) s += 10;
  }

  if (digitsQ && phoneDigits && phoneDigits.includes(digitsQ)) s += 30;
  if (email && email.includes(q)) s += 20;

  // Multi-token bonus — each additional token that matches anywhere
  if (tokens.length > 1) {
    for (const t of tokens) {
      const hit =
        personal.includes(t) ||
        company.includes(t) ||
        email.includes(t) ||
        (digitsQ && phoneDigits.includes(t.replace(/\D/g, '')));
      if (hit) s += 15;
    }
  }
  return s;
}

function escape(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function lastSort(c: ComboboxClient): string {
  return (c.last_name ?? c.company ?? c.first_name ?? '').toLowerCase();
}
