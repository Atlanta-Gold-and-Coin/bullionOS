'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

/**
 * Aurbitrage browse page — flat quotes list grouped by product, with
 * each product showing best-bid (highest) + best-ask (lowest) across
 * dealers, expandable to show every dealer's quote with a click-thru
 * to the dealer's actual listing.
 *
 * Cron syncs every 15 min; "Refresh now" hits the same path manually.
 */

interface Quote {
  id: string;
  aurbitrage_sku_id: number;
  product_name: string;
  category: string | null;
  sub_category: string | null;
  product_type: string | null;
  metal: string | null;
  equivalent_oz: number | null;
  side: 'bid' | 'ask';
  dealer: string;
  dealer_id: number | null;
  price: number;
  price_format: string | null;
  format: string | null;
  data_source: string | null;
  notes: string | null;
  shipping_note: string | null;
  quote_date: string | null;
}

interface SyncState {
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  last_sync_quote_count: number | null;
  configured: boolean;
}

interface SyncResult {
  ok: boolean;
  message: string;
  quote_count: number;
  synced_at: string;
}

interface ProductGroup {
  sku_id: number;
  name: string;
  category: string | null;
  sub_category: string | null;
  metal: string | null;
  equivalent_oz: number | null;
  bids: Quote[]; // sorted desc — highest bid first
  asks: Quote[]; // sorted asc — lowest ask first
}

const METAL_FILTERS = ['all', 'gold', 'silver', 'platinum', 'palladium'] as const;
type MetalFilter = (typeof METAL_FILTERS)[number];

export default function AurbitragePage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [search, setSearch] = useState('');
  const [metalFilter, setMetalFilter] = useState<MetalFilter>('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const { data: state } = useQuery<SyncState>({
    queryKey: ['admin', 'aurbitrage', 'state'],
    queryFn: () => apiFetch<SyncState>('/admin/aurbitrage/state'),
    refetchInterval: 30_000,
  });

  const { data: quotes = [], isLoading } = useQuery<Quote[]>({
    queryKey: ['admin', 'aurbitrage', 'quotes'],
    queryFn: () => apiFetch<Quote[]>('/admin/aurbitrage/quotes'),
  });

  const sync = useMutation<SyncResult, ApiError, void>({
    mutationFn: () =>
      apiFetch<SyncResult>('/admin/aurbitrage/sync', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'aurbitrage'] });
    },
  });

  // Group flat quotes back into one entry per product, with bids/asks
  // sorted so the best price for each side is at index 0.
  const groups = useMemo<ProductGroup[]>(() => {
    const m = new Map<number, ProductGroup>();
    for (const q of quotes) {
      let g = m.get(q.aurbitrage_sku_id);
      if (!g) {
        g = {
          sku_id: q.aurbitrage_sku_id,
          name: q.product_name,
          category: q.category,
          sub_category: q.sub_category,
          metal: q.metal,
          equivalent_oz: q.equivalent_oz,
          bids: [],
          asks: [],
        };
        m.set(q.aurbitrage_sku_id, g);
      }
      if (q.side === 'bid') g.bids.push(q);
      else g.asks.push(q);
    }
    for (const g of m.values()) {
      // Highest bid first (someone wants to PAY more)
      g.bids.sort((a, b) => b.price - a.price);
      // Lowest ask first (someone is willing to SELL for less)
      g.asks.sort((a, b) => a.price - b.price);
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [quotes]);

  // Apply search + metal filter to the grouped list.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return groups.filter((g) => {
      if (metalFilter !== 'all' && g.metal !== metalFilter) return false;
      if (!needle) return true;
      const hay = `${g.name} ${g.category ?? ''} ${g.sub_category ?? ''} ${g.metal ?? ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [groups, search, metalFilter]);

  function toggleExpand(skuId: number) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(skuId)) n.delete(skuId);
      else n.add(skuId);
      return n;
    });
  }

  return (
    <div className="mx-auto max-w-6xl">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
        <div aria-hidden className="absolute inset-y-0 left-0 w-1 bg-gold-500" />
        <div className="p-5 md:p-6">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            Wholesaler price comparison
          </div>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink-900">
            Aurbitrage
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-500">
            Aggregated buy/sell quotes across major wholesalers (MTB, Dillon
            Gage, APMEX, Pinehurst, Sunshine Mint). Click any row to see all
            dealers&apos; quotes with a link back to their listing. Synced
            every 15 min; admin can refresh on demand.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-ink-100 pt-4 md:grid-cols-4">
            <Metric
              label="Products"
              value={String(groups.length)}
            />
            <Metric
              label="Quotes stored"
              value={String(quotes.length)}
            />
            <Metric
              label="Last sync"
              value={
                state?.last_synced_at
                  ? formatRelative(state.last_synced_at)
                  : '—'
              }
            />
            <Metric
              label="Status"
              value={
                !state?.configured
                  ? 'not configured'
                  : state?.last_sync_status === 'ok'
                    ? 'ok'
                    : state?.last_sync_status === 'error'
                      ? 'error'
                      : 'pending'
              }
              tone={
                !state?.configured
                  ? 'muted'
                  : state?.last_sync_status === 'error'
                    ? 'warn'
                    : 'good'
              }
            />
          </div>
          {state?.last_sync_status === 'error' && state.last_sync_message && (
            <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Last sync failed: {state.last_sync_message}
            </div>
          )}
        </div>
      </section>

      {/* Filter + actions row */}
      <section className="mt-4 rounded-xl border border-ink-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="9" cy="9" r="6" />
              <path d="m14 14 4 4" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Filter — try "eagle", "1/10 oz", "platinum"'
              className="w-full rounded-md border border-ink-200 bg-white py-1.5 pl-9 pr-3 text-sm text-ink-900 placeholder:text-ink-400 focus:border-ink-900 focus:outline-none focus:ring-1 focus:ring-ink-900"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {METAL_FILTERS.map((m) => (
              <button
                key={m}
                onClick={() => setMetalFilter(m)}
                className={`rounded-md border px-2 py-1 capitalize ${
                  metalFilter === m
                    ? 'border-ink-900 bg-ink-900 text-white'
                    : 'border-ink-200 text-ink-600 hover:text-ink-900'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          {isAdmin && (
            <button
              onClick={() => sync.mutate()}
              disabled={sync.isPending || !state?.configured}
              className="ml-auto rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-60"
            >
              {sync.isPending ? 'Refreshing…' : 'Refresh now'}
            </button>
          )}
        </div>
        {sync.error && (
          <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
            {sync.error.message}
          </div>
        )}
        {sync.data && (
          <div className="mt-2 rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">
            {sync.data.message}
          </div>
        )}
      </section>

      {/* Empty / loading / configure-prompt states */}
      {!state?.configured && !isLoading && (
        <div className="mt-6 rounded-xl border border-ink-200 bg-white p-8 text-center text-sm text-ink-500">
          Aurbitrage isn&apos;t configured yet. Add an API key on{' '}
          <a
            href="/admin/integrations"
            className="text-ink-700 underline decoration-ink-300 underline-offset-2 hover:text-ink-900"
          >
            Integrations
          </a>{' '}
          to start syncing.
        </div>
      )}
      {isLoading && (
        <div className="mt-6 rounded-xl border border-ink-200 bg-white p-12 text-center text-sm text-ink-400">
          Loading…
        </div>
      )}
      {!isLoading && state?.configured && filtered.length === 0 && (
        <div className="mt-6 rounded-xl border border-ink-200 bg-white p-12 text-center text-sm text-ink-400">
          {quotes.length === 0
            ? 'No quotes yet. Hit Refresh now to pull the latest from Aurbitrage.'
            : `No products match the current filter. `}
          {search.trim() !== '' && (
            <button
              onClick={() => setSearch('')}
              className="text-ink-700 underline decoration-ink-300 underline-offset-2 hover:text-ink-900"
            >
              Clear search
            </button>
          )}
        </div>
      )}

      {/* Product list */}
      {filtered.length > 0 && (
        <section className="mt-4 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
          <ul className="divide-y divide-ink-100">
            {filtered.map((g) => (
              <ProductRow
                key={g.sku_id}
                group={g}
                expanded={expanded.has(g.sku_id)}
                onToggle={() => toggleExpand(g.sku_id)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ProductRow({
  group,
  expanded,
  onToggle,
}: {
  group: ProductGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const bestBid = group.bids[0];
  const bestAsk = group.asks[0];
  return (
    <li className="text-sm">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-4 px-5 py-3 text-left hover:bg-ink-50"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-ink-900">{group.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
            {group.metal && (
              <span className="capitalize">{group.metal}</span>
            )}
            {group.sub_category && (
              <>
                <span>·</span>
                <span>{group.sub_category}</span>
              </>
            )}
            {group.equivalent_oz && (
              <>
                <span>·</span>
                <span className="font-mono">
                  {group.equivalent_oz} oz
                </span>
              </>
            )}
          </div>
        </div>
        <div className="hidden text-right md:block">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
            Best bid
          </div>
          {bestBid ? (
            <PriceTag quote={bestBid} accent="green" />
          ) : (
            <span className="text-xs text-ink-300">—</span>
          )}
        </div>
        <div className="hidden text-right md:block">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
            Best ask
          </div>
          {bestAsk ? (
            <PriceTag quote={bestAsk} accent="amber" />
          ) : (
            <span className="text-xs text-ink-300">—</span>
          )}
        </div>
        <span
          aria-hidden
          className={`text-ink-400 transition ${expanded ? 'rotate-90' : ''}`}
        >
          ›
        </span>
      </button>
      {expanded && (
        <div className="border-t border-ink-100 bg-ink-50/30 px-5 py-3">
          <div className="grid gap-4 md:grid-cols-2">
            <DealerColumn
              title="Bids (someone wants to BUY from us)"
              quotes={group.bids}
              accent="green"
            />
            <DealerColumn
              title="Asks (someone is SELLING to us)"
              quotes={group.asks}
              accent="amber"
            />
          </div>
        </div>
      )}
    </li>
  );
}

function DealerColumn({
  title,
  quotes,
  accent,
}: {
  title: string;
  quotes: Quote[];
  accent: 'green' | 'amber';
}) {
  if (quotes.length === 0) {
    return (
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
          {title}
        </div>
        <div className="mt-1 text-xs text-ink-400">No quotes</div>
      </div>
    );
  }
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
        {title}
      </div>
      <ul className="mt-2 space-y-1">
        {quotes.map((q, i) => (
          <li
            key={q.id}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${
              i === 0 ? 'bg-white shadow-sm ring-1 ring-ink-200' : ''
            }`}
          >
            <span className="min-w-0 flex-1 truncate font-medium text-ink-800">
              {q.dealer}
              {i === 0 && (
                <span className="ml-1 text-[10px] uppercase text-ink-400">
                  best
                </span>
              )}
            </span>
            <PriceTag quote={q} accent={accent} />
            {q.data_source && (
              <a
                href={q.data_source}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[10px] text-ink-400 underline-offset-2 hover:text-ink-700 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                source ↗
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PriceTag({ quote, accent }: { quote: Quote; accent: 'green' | 'amber' }) {
  const cls =
    accent === 'green'
      ? 'text-green-700'
      : 'text-amber-700';
  // We request DollarPerOz from the API, so $-format quotes are
  // already $/oz. Append the unit so operators can compare dealers
  // at a glance without second-guessing the basis. Percentage-format
  // quotes (premiums on dealers that only quote relative to spot)
  // render as N% — same convention as Aurbitrage's own UI.
  const isPct = quote.format === '%';
  const formatted = isPct
    ? `${quote.price.toFixed(2)}%`
    : `$${quote.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <span className={`font-mono text-sm font-semibold tabular-nums ${cls}`}>
      {formatted}
      {!isPct && (
        <span className="ml-0.5 text-[10px] font-normal text-ink-400">
          /oz
        </span>
      )}
    </span>
  );
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn' | 'muted';
}) {
  const valueCls =
    tone === 'good'
      ? 'text-green-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : tone === 'muted'
          ? 'text-ink-400'
          : 'text-ink-900';
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
        {label}
      </div>
      <div className={`mt-0.5 text-sm font-medium ${valueCls}`}>{value}</div>
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    const sec = Math.max(0, Math.floor(diff / 1000));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  } catch {
    return iso;
  }
}
