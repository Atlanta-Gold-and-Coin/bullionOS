'use client';

import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

/**
 * RARCOA daily pricing tab.
 *
 * Replaces the "copy the emailed PDF into a Google Sheet" workflow
 * (AGC.RARCOA REF SHEET). Admin uploads the daily PDF; backend
 * parses it into a structured snapshot; this page renders:
 *
 *   - Upload dropzone (admin only)
 *   - Header: as-of date + time + basis gold (compared to today's
 *     live spot so operators can sanity-check "is this fresh?")
 *   - 4 section tables:
 *       • Uncertified gold (small) — VF/XF/AU/BU
 *       • Uncertified gold (large) — LP/LT POL / VF/XF / AU/CU / Uncirculated
 *       • Certified gold — MS61-MS66 (rendered with both clean + w/Spots
 *         columns, the way Sheet1 of the Google Sheet did)
 *       • Silver dollars — Morgan NGC, Morgan PCGS, Peace NGC, Peace PCGS
 *         × MS-63..MS-67, with a Clean/Toned toggle
 *   - History picker to switch to a prior day's sheet.
 *
 * Every AGC-marked-down price comes from the server's rarcoa-markdowns
 * table (derived directly from the operator's Google Sheet formulas).
 * Phase 2 will hook up the email listener so uploads become automatic.
 */

type Section =
  | 'uncertified_gold'
  | 'uncertified_large_gold'
  | 'certified_gold'
  | 'morgan_dollar'
  | 'peace_dollar';

interface Cell {
  section: Section;
  product: string;
  grade: string;
  raw_bid: number | null;
  raw_ask: number | null;
  ngc_only: boolean;
  agc_clean: number | null;
  agc_spots: number | null;
  agc_toned: number | null;
}

interface Snapshot {
  sheet_id: string | null;
  as_of_date: string | null;
  as_of_time: string | null;
  basis_gold: number | null;
  ingested_at: string | null;
  ingested_by_user_id: string | null;
  cells: Cell[];
}

interface SheetRow {
  id: string;
  as_of_date: string;
  as_of_time: string | null;
  basis_gold: number | null;
  ingested_at: string;
}

interface GmailStatus {
  configured: boolean;
  authorized: boolean;
  enabled: boolean;
  mailbox: string | null;
  poll_interval_minutes: number | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
}

interface PollResult {
  checked: boolean;
  matched: number;
  ingested: number;
  details: Array<{
    message_id: string;
    from: string | null;
    subject: string | null;
    internal_date: string | null;
    outcome:
      | 'ingested'
      | 'skipped-no-url'
      | 'skipped-fetch-fail'
      | 'skipped-parse-fail'
      | 'error';
    as_of_date?: string | null;
    pdf_url?: string | null;
    error?: string | null;
  }>;
  skipped_reason?: string;
}

export default function RarcoaPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  // Selection is by sheet id, not date — RARCOA publishes multiple
  // sheets per day (morning + midday + afternoon), each with its own
  // id. `null` means "latest", same UX as before.
  const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Free-text filter applied across section label + product name. Lets the
  // counter type "$20", "Morgan", "Liberty", "MS-63" and see only matching
  // rows without scrolling through 30+ products.
  const [search, setSearch] = useState('');

  const { data: history = [] } = useQuery<SheetRow[]>({
    queryKey: ['admin', 'rarcoa', 'history'],
    queryFn: () => apiFetch<SheetRow[]>('/admin/rarcoa'),
  });

  const queryKey = ['admin', 'rarcoa', 'snapshot', selectedSheetId ?? 'latest'];
  const { data: snapshot, isLoading } = useQuery<Snapshot>({
    queryKey,
    queryFn: () =>
      apiFetch<Snapshot>(
        selectedSheetId
          ? `/admin/rarcoa/by-id/${encodeURIComponent(selectedSheetId)}`
          : '/admin/rarcoa/latest',
      ),
  });

  const upload = useMutation<Snapshot, ApiError, File>({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiFetch<Snapshot>('/admin/rarcoa/upload', {
        method: 'POST',
        body: fd,
      });
    },
    onSuccess: (snap) => {
      setFlash(
        `Ingested ${snap.cells.length} price rows for ${snap.as_of_date}${
          snap.as_of_time ? ' ' + snap.as_of_time : ''
        }.`,
      );
      setErr(null);
      setSelectedSheetId(null); // jump back to "latest" view
      qc.invalidateQueries({ queryKey: ['admin', 'rarcoa'] });
    },
    onError: (e) => {
      setFlash(null);
      setErr(e instanceof ApiError ? e.message : 'Upload failed');
    },
  });

  const deleteMut = useMutation<void, ApiError, string>({
    mutationFn: (id: string) =>
      apiFetch(`/admin/rarcoa/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      // Drop the selection — pointing at a deleted sheet would return
      // an empty snapshot and confuse the operator.
      setSelectedSheetId(null);
      qc.invalidateQueries({ queryKey: ['admin', 'rarcoa'] });
    },
  });

  // Gmail auto-ingest status + manual poll. Pulled alongside the rarcoa
  // queries so the admin can see at a glance whether auto-ingest is
  // configured, authorized, and when the next check is likely to fire.
  const { data: gmailStatus } = useQuery<GmailStatus>({
    queryKey: ['admin', 'gmail', 'status'],
    queryFn: () => apiFetch<GmailStatus>('/admin/integrations/gmail/status'),
    // Re-poll the status after authorization / test-connection changes.
    refetchInterval: 60_000,
  });
  const pollMut = useMutation<PollResult, ApiError, void>({
    mutationFn: () =>
      apiFetch<PollResult>('/admin/integrations/gmail/poll', { method: 'POST' }),
    onSuccess: (r) => {
      if (r.ingested > 0) {
        setFlash(`Auto-ingested ${r.ingested} sheet${r.ingested === 1 ? '' : 's'} from Gmail.`);
        qc.invalidateQueries({ queryKey: ['admin', 'rarcoa'] });
      }
      qc.invalidateQueries({ queryKey: ['admin', 'gmail', 'status'] });
    },
  });

  const bySection = useMemo(() => {
    const m: Record<Section, Cell[]> = {
      uncertified_gold: [],
      uncertified_large_gold: [],
      certified_gold: [],
      morgan_dollar: [],
      peace_dollar: [],
    };
    const needle = search.trim().toLowerCase();
    for (const c of snapshot?.cells ?? []) {
      if (needle) {
        // Search against section label + product name. Grade is a column
        // header, not a row signal, so filtering by grade would leave rows
        // with missing columns — not worth the UX cost for power users
        // who can already scan a row once the product is in view.
        const hay = `${sectionLabel(c.section)} ${c.product}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      m[c.section]?.push(c);
    }
    return m;
  }, [snapshot, search]);

  const totalMatched =
    bySection.uncertified_gold.length +
    bySection.uncertified_large_gold.length +
    bySection.certified_gold.length +
    bySection.morgan_dollar.length +
    bySection.peace_dollar.length;

  return (
    <div className="mx-auto max-w-6xl">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
        <div aria-hidden className="absolute inset-y-0 left-0 w-1 bg-gold-500" />
        <div className="p-5 md:p-6">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            Wholesale supplier
          </div>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink-900">
            RARCOA Goldsheet
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-500">
            Daily bid/ask indications from RARCOA (
            <a
              href="https://rarcoa.com"
              className="underline-offset-2 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              rarcoa.com
            </a>
            ). Upload the PDF they email to sales@ and the in-store AGC
            pricing (Sheet1 equivalent) is computed automatically.
          </p>
          {snapshot && snapshot.as_of_date && (
            <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-ink-100 pt-4 md:grid-cols-4">
              <Metric
                label="Sheet date"
                value={formatDate(snapshot.as_of_date)}
              />
              <Metric
                label="Quote time"
                value={snapshot.as_of_time ?? '—'}
              />
              <Metric
                label="Basis gold"
                value={
                  snapshot.basis_gold !== null
                    ? `$${snapshot.basis_gold.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`
                    : '—'
                }
                mono
              />
              <Metric
                label="Ingested"
                value={
                  snapshot.ingested_at
                    ? new Date(snapshot.ingested_at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })
                    : '—'
                }
              />
            </div>
          )}
        </div>
      </section>

      {/* Search + history picker — kept together so the counter's
          entry point (type product name, scan day) lives above the
          fold. Upload / Gmail / settings get pushed to the bottom
          where they don't get in the way of daily use. */}
      {snapshot && snapshot.as_of_date && (
        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder='Filter prices — try "$20", "Morgan", "Liberty", "MS-63"'
            />
            {history.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-ink-500">History:</span>
                <button
                  onClick={() => setSelectedSheetId(null)}
                  className={`rounded-md border px-2 py-1 ${
                    selectedSheetId === null
                      ? 'border-ink-900 bg-ink-900 text-white'
                      : 'border-ink-200 text-ink-600 hover:text-ink-900'
                  }`}
                >
                  Latest
                </button>
                {history.slice(0, 10).map((h) => (
                  <button
                    key={h.id}
                    onClick={() => setSelectedSheetId(h.id)}
                    className={`rounded-md border px-2 py-1 ${
                      selectedSheetId === h.id
                        ? 'border-ink-900 bg-ink-900 text-white'
                        : 'border-ink-200 text-ink-600 hover:text-ink-900'
                    }`}
                    title={`Basis ${
                      h.basis_gold !== null ? '$' + h.basis_gold.toFixed(2) : '—'
                    }`}
                  >
                    {formatDate(h.as_of_date)}
                    {h.as_of_time && (
                      <span className="ml-1 text-[10px] opacity-70">
                        {h.as_of_time}
                      </span>
                    )}
                  </button>
                ))}
                {isAdmin && selectedSheetId && (
                  <button
                    onClick={() => {
                      const row = history.find((h) => h.id === selectedSheetId);
                      if (
                        row &&
                        confirm(
                          `Delete the RARCOA sheet for ${formatDate(row.as_of_date)}${
                            row.as_of_time ? ' ' + row.as_of_time : ''
                          }?`,
                        )
                      )
                        deleteMut.mutate(row.id);
                    }}
                    className="rounded-md border border-red-200 px-2 py-1 text-red-700 hover:bg-red-50"
                  >
                    Delete this sheet
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Loading / empty states */}
      {isLoading && !snapshot && (
        <div className="mt-6 rounded-xl border border-ink-200 bg-white p-12 text-center text-sm text-ink-400">
          Loading…
        </div>
      )}
      {!isLoading && snapshot && !snapshot.as_of_date && (
        <div className="mt-6 rounded-xl border border-ink-200 bg-white p-12 text-center text-sm text-ink-400">
          No RARCOA sheet ingested yet. Upload today&apos;s PDF at the bottom of the page.
        </div>
      )}

      {/* Section tables — filtered by `search`. Sections with 0
          matching rows are hidden entirely; if the whole search
          returns nothing we render a small empty state so the page
          doesn't go blank under the picker. */}
      {snapshot && snapshot.as_of_date && (
        <>
          {bySection.uncertified_gold.length > 0 && (
            <SectionCard
              title="Uncertified gold · small"
              subtitle="VF / XF / AU / BU — AGC pays 82% of RARCOA bid."
              cells={bySection.uncertified_gold}
              columns={['VF', 'XF', 'AU', 'BU']}
              showSpots={false}
            />
          )}
          {bySection.uncertified_large_gold.length > 0 && (
            <SectionCard
              title="Uncertified gold · large"
              subtitle="$5/$10/$20 Liberty + St. Gaudens. AGC uses its own buy rates for these — shown here for RARCOA reference only."
              cells={bySection.uncertified_large_gold}
              columns={['LP/LT POL', 'VF/XF', 'AU/CU', 'Uncirculated']}
              showSpots={false}
              agcPricesOptional
            />
          )}
          {bySection.certified_gold.length > 0 && (
            <SectionCard
              title="Certified gold · MS61 – MS66"
              subtitle="Each grade has a clean and a w/Spots derived price. Spots typically get 92–98% of the clean AGC price."
              cells={bySection.certified_gold}
              columns={['MS61', 'MS62', 'MS63', 'MS64', 'MS65', 'MS66']}
              showSpots
            />
          )}
          {(bySection.morgan_dollar.length > 0 ||
            bySection.peace_dollar.length > 0) && (
            <SilverCard
              morgan={bySection.morgan_dollar}
              peace={bySection.peace_dollar}
            />
          )}
          {search.trim() !== '' && totalMatched === 0 && (
            <div className="mt-4 rounded-xl border border-ink-200 bg-white p-8 text-center text-sm text-ink-400">
              No products match <span className="font-mono text-ink-700">{search}</span>.{' '}
              <button
                onClick={() => setSearch('')}
                className="text-ink-700 underline decoration-ink-300 underline-offset-2 hover:text-ink-900"
              >
                Clear search
              </button>
            </div>
          )}
        </>
      )}

      {/* ── Admin / meta section, pushed to the bottom so the daily
          use flow (scan prices) isn't cluttered by setup cards. */}

      {/* Gmail auto-ingest status */}
      {gmailStatus && (
        <GmailStatusCard
          status={gmailStatus}
          onPoll={() => pollMut.mutate()}
          polling={pollMut.isPending}
          result={pollMut.data ?? null}
          error={pollMut.error?.message ?? null}
        />
      )}

      {/* Upload card — bottom of the page. Admins can still drag
          in a new sheet when auto-ingest misses one, but the happy
          path (prices are already here) doesn't surface this. */}
      {isAdmin && (
        <UploadCard
          onFile={(f) => upload.mutate(f)}
          busy={upload.isPending}
          flash={flash}
          error={err}
        />
      )}
    </div>
  );
}

/* ═════════════ Search input ═════════════ */

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative flex-1 min-w-[240px]">
      {/* Magnifier icon — hand-rolled so we don't pull in an icon lib. */}
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-ink-200 bg-white py-1.5 pl-9 pr-8 text-sm text-ink-900 placeholder:text-ink-400 focus:border-ink-900 focus:outline-none focus:ring-1 focus:ring-ink-900"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-ink-400 hover:bg-ink-100 hover:text-ink-700"
        >
          ×
        </button>
      )}
    </div>
  );
}

/* ═════════════ Upload card ═════════════ */

function UploadCard({
  onFile,
  busy,
  flash,
  error,
}: {
  onFile: (f: File) => void;
  busy: boolean;
  flash: string | null;
  error: string | null;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  function pick() {
    inputRef.current?.click();
  }

  return (
    <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Upload today&apos;s goldsheet</h2>
        <span className="text-xs text-ink-500">
          PDF · up to 3 MB
        </span>
      </div>
      <div
        onClick={pick}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        className={`mt-3 flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-sm transition ${
          dragOver
            ? 'border-gold-500 bg-gold-500/10 text-ink-900'
            : 'border-ink-200 bg-ink-50/50 text-ink-500 hover:border-gold-500/50 hover:text-ink-700'
        }`}
      >
        {busy
          ? 'Parsing PDF…'
          : 'Drop the RARCOA PDF here, or click to choose a file.'}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      {flash && (
        <div className="mt-3 rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">
          {flash}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
    </section>
  );
}

/* ═════════════ Section table (gold) ═════════════ */

function SectionCard({
  title,
  subtitle,
  cells,
  columns,
  showSpots,
  agcPricesOptional = false,
}: {
  title: string;
  subtitle: string;
  cells: Cell[];
  columns: string[];
  showSpots: boolean;
  /** Some sections have no AGC markdown by design (SEE AG&C BUY RATES). */
  agcPricesOptional?: boolean;
}) {
  // Pivot cells into { product: { grade: cell } }. Preserves first-seen
  // product order which matches the Google Sheet for easy visual diff.
  const { productOrder, byProduct } = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, Record<string, Cell>>();
    for (const c of cells) {
      if (!map.has(c.product)) {
        map.set(c.product, {});
        order.push(c.product);
      }
      map.get(c.product)![c.grade] = c;
    }
    return { productOrder: order, byProduct: map };
  }, [cells]);

  if (productOrder.length === 0) return null;

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
      <div className="border-b border-ink-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        {/* `divide-x` on every <tr> draws a vertical gridline between
            cells (Tailwind's divide applies border-left to every
            non-first child). Row separators are `border-t` per <tr>.
            Together: full grid without hand-adding borders per cell. */}
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-ink-50 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            <tr className="divide-x divide-ink-100">
              <th className="px-4 py-3">Product</th>
              {columns.map((col) => (
                <th
                  key={col}
                  colSpan={showSpots ? 2 : 1}
                  className="px-4 py-3 text-right"
                >
                  {col}
                  {showSpots && (
                    <span className="ml-1 block text-[10px] font-normal normal-case tracking-normal text-ink-400">
                      clean · w/spots
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {productOrder.map((product, i) => (
              <tr
                key={product}
                className={`divide-x divide-ink-100 border-t border-ink-100 ${
                  i % 2 === 1 ? 'bg-ink-50/40' : ''
                }`}
              >
                <td className="px-4 py-3 font-medium text-ink-900">
                  {product}
                </td>
                {columns.map((col) => {
                  const c = byProduct.get(product)?.[col];
                  return (
                    <GoldPriceCell
                      key={col}
                      cell={c}
                      showSpots={showSpots}
                      agcOptional={agcPricesOptional}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GoldPriceCell({
  cell,
  showSpots,
  agcOptional,
}: {
  cell: Cell | undefined;
  showSpots: boolean;
  agcOptional: boolean;
}) {
  if (!cell) {
    return showSpots ? (
      <>
        <td className="px-4 py-3 text-right text-ink-300">—</td>
        <td className="px-4 py-3 text-right text-ink-300">—</td>
      </>
    ) : (
      <td className="px-4 py-3 text-right text-ink-300">—</td>
    );
  }
  return showSpots ? (
    <>
      <td className="px-4 py-3 text-right">
        <AgcPrice value={cell.agc_clean} rawBid={cell.raw_bid} rawAsk={cell.raw_ask} ngc={cell.ngc_only} agcOptional={agcOptional} />
      </td>
      <td className="px-4 py-3 text-right">
        <AgcPrice value={cell.agc_spots} rawBid={cell.raw_bid} rawAsk={cell.raw_ask} ngc={cell.ngc_only} agcOptional={agcOptional} hideRaw />
      </td>
    </>
  ) : (
    <td className="px-4 py-3 text-right">
      <AgcPrice value={cell.agc_clean} rawBid={cell.raw_bid} rawAsk={cell.raw_ask} ngc={cell.ngc_only} agcOptional={agcOptional} />
    </td>
  );
}

/** Shows AGC price (big) + RARCOA bid/ask (small grey). */
function AgcPrice({
  value,
  rawBid,
  rawAsk,
  ngc,
  agcOptional,
  hideRaw = false,
}: {
  value: number | null;
  rawBid: number | null;
  rawAsk: number | null;
  ngc: boolean;
  agcOptional: boolean;
  hideRaw?: boolean;
}) {
  if (value === null && rawBid === null) {
    return <span className="text-ink-300">—</span>;
  }
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span
        className={`font-mono tabular-nums ${
          value !== null ? 'font-semibold text-ink-900' : 'text-ink-400'
        }`}
        title={
          value === null && agcOptional
            ? 'AGC uses its own buy rates for this product.'
            : undefined
        }
      >
        {value !== null
          ? `$${value.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 2,
            })}`
          : agcOptional
            ? 'AGC rates'
            : '—'}
      </span>
      {!hideRaw && (
        <span className="text-[10px] font-mono tabular-nums text-ink-400">
          {ngc && 'NGC '}
          {rawBid !== null ? rawBid : '—'} / {rawAsk !== null ? rawAsk : '—'}
        </span>
      )}
    </span>
  );
}

/* ═════════════ Silver dollar card (Morgan + Peace w/ tone toggle) ═════════════ */

function SilverCard({
  morgan,
  peace,
}: {
  morgan: Cell[];
  peace: Cell[];
}) {
  const [tone, setTone] = useState<'clean' | 'toned'>('clean');
  if (morgan.length === 0 && peace.length === 0) return null;

  const grades = ['MS-63', 'MS-64', 'MS-65', 'MS-66', 'MS-67'];

  const lookup = (rows: Cell[], product: string, house: 'NGC' | 'PCGS') =>
    rows.find((c) => c.product === product && c.grade === house);

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">
            Certified silver dollars
          </h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Morgan (pre-1921) + Peace. NGC/PCGS × MS-63 to MS-67. AGC
            pays 85% of RARCOA for clean, 75% for toned/tarnished.
          </p>
        </div>
        <div className="inline-flex rounded-md border border-ink-200 bg-ink-50/50 p-0.5 text-xs">
          <button
            onClick={() => setTone('clean')}
            className={`rounded px-3 py-1 ${
              tone === 'clean'
                ? 'bg-white font-semibold text-ink-900 shadow-sm'
                : 'text-ink-500 hover:text-ink-900'
            }`}
          >
            Clean
          </button>
          <button
            onClick={() => setTone('toned')}
            className={`rounded px-3 py-1 ${
              tone === 'toned'
                ? 'bg-white font-semibold text-ink-900 shadow-sm'
                : 'text-ink-500 hover:text-ink-900'
            }`}
          >
            Toned
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-ink-50 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            <tr className="divide-x divide-ink-100">
              <th className="px-4 py-3">Grade</th>
              <th className="px-4 py-3 text-right">Morgan · NGC</th>
              <th className="px-4 py-3 text-right">Morgan · PCGS</th>
              <th className="px-4 py-3 text-right">Peace · NGC</th>
              <th className="px-4 py-3 text-right">Peace · PCGS</th>
            </tr>
          </thead>
          <tbody>
            {grades.map((g, i) => {
              const mN = lookup(morgan, g, 'NGC');
              const mP = lookup(morgan, g, 'PCGS');
              const pN = lookup(peace, g, 'NGC');
              const pP = lookup(peace, g, 'PCGS');
              return (
                <tr
                  key={g}
                  className={`divide-x divide-ink-100 border-t border-ink-100 ${
                    i % 2 === 1 ? 'bg-ink-50/40' : ''
                  }`}
                >
                  <td className="px-4 py-3 font-medium text-ink-900">{g}</td>
                  {[mN, mP, pN, pP].map((c, idx) => (
                    <td key={idx} className="px-4 py-3 text-right">
                      <AgcPrice
                        value={
                          c
                            ? tone === 'toned'
                              ? c.agc_toned
                              : c.agc_clean
                            : null
                        }
                        rawBid={c?.raw_bid ?? null}
                        rawAsk={c?.raw_ask ?? null}
                        ngc={c?.ngc_only ?? false}
                        agcOptional={false}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ═════════════ Helpers ═════════════ */

function Metric({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
        {label}
      </div>
      <div className={`mt-0.5 text-sm text-ink-900 ${mono ? 'font-mono tabular-nums' : ''}`}>
        {value}
      </div>
    </div>
  );
}

/**
 * Human-readable section label used for search matching so typing
 * "morgan" or "peace" or "uncertified" filters to the right section
 * even though the DB stores the machine-style name.
 */
function sectionLabel(s: Section): string {
  switch (s) {
    case 'uncertified_gold':
      return 'uncertified gold';
    case 'uncertified_large_gold':
      return 'uncertified gold large';
    case 'certified_gold':
      return 'certified gold';
    case 'morgan_dollar':
      return 'morgan silver dollar';
    case 'peace_dollar':
      return 'peace silver dollar';
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  // Kysely/pg can return DATE columns as either bare 'YYYY-MM-DD' or
  // full ISO timestamps ('2026-04-24T00:00:00.000Z') depending on how
  // the row was serialized — slicing the first 10 chars handles both.
  // Parse into local-tz Date so "Apr 24" never drifts to "Apr 23" in
  // the operator's timezone.
  const dateOnly = iso.slice(0, 10);
  const [y, m, d] = dateOnly.split('-');
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/* ═════════════ Gmail auto-ingest status ═════════════ */

/**
 * Gmail auto-ingest status card. Surfaces:
 *   - whether the Gmail integration is configured/authorized/enabled
 *   - "Check now" button to fire the poll on demand (same path the cron
 *     runs every 15 min — useful when the email just landed)
 *   - per-message outcome list from the most recent poll, so the admin
 *     can see exactly which RARCOA emails were ingested vs skipped
 *   - a short "configure it" CTA when the integration is missing
 */
function GmailStatusCard({
  status,
  onPoll,
  polling,
  result,
  error,
}: {
  status: GmailStatus;
  onPoll: () => void;
  polling: boolean;
  result: PollResult | null;
  error: string | null;
}) {
  const ready = status.configured && status.authorized && status.enabled;

  return (
    <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">
            Gmail auto-ingest
          </h2>
          <p className="mt-0.5 text-xs text-ink-500">
            {ready ? (
              <>
                Polling{' '}
                <span className="font-medium text-ink-700">
                  {status.mailbox ?? 'sales@'}
                </span>{' '}
                every 15 min for the daily RARCOA email. New sheets ingest
                automatically.
              </>
            ) : (
              <>
                Not yet active. Configure it on{' '}
                <a
                  href="/admin/integrations"
                  className="underline decoration-ink-300 underline-offset-2 hover:text-ink-900"
                >
                  Integrations
                </a>{' '}
                to skip the manual upload.
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <GmailStatusBadge status={status} />
          {ready && (
            <button
              onClick={onPoll}
              disabled={polling}
              className="rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-60"
            >
              {polling ? 'Checking…' : 'Check now'}
            </button>
          )}
        </div>
      </div>

      {/* Most recent poll outcome — folded into the card so the admin
          doesn't have to hunt for "did it actually work?" */}
      {error && (
        <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
      {result && !error && (
        <div className="mt-3 rounded-md bg-ink-50/60 p-3 text-xs">
          {result.skipped_reason ? (
            <p className="text-ink-500">
              Poll skipped — {result.skipped_reason}.
            </p>
          ) : result.matched === 0 ? (
            <p className="text-ink-500">
              No unprocessed RARCOA emails in the last 2 days.
            </p>
          ) : (
            <>
              <p className="text-ink-700">
                Matched {result.matched} · ingested{' '}
                <span className="font-semibold text-ink-900">
                  {result.ingested}
                </span>
              </p>
              <ul className="mt-2 space-y-1">
                {result.details.map((d) => (
                  <li
                    key={d.message_id}
                    className="flex items-start gap-2 border-t border-ink-100 pt-1 text-[11px]"
                  >
                    <OutcomeBadge outcome={d.outcome} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-ink-800">
                        {d.subject ?? '(no subject)'}
                      </div>
                      <div className="truncate text-ink-400">
                        {d.from ?? '—'}
                        {d.as_of_date ? ` · sheet ${formatDate(d.as_of_date)}` : ''}
                      </div>
                      {d.error && (
                        <div className="mt-0.5 font-mono text-[10px] text-red-700">
                          {d.error}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function GmailStatusBadge({ status }: { status: GmailStatus }) {
  let tone: 'ok' | 'warn' | 'muted' = 'muted';
  let label = 'not configured';
  if (!status.configured) {
    tone = 'muted';
    label = 'not configured';
  } else if (!status.authorized) {
    tone = 'warn';
    label = 'not authorized';
  } else if (!status.enabled) {
    tone = 'warn';
    label = 'disabled';
  } else if (status.last_test_ok === false) {
    tone = 'warn';
    label = 'test failed';
  } else {
    tone = 'ok';
    label = 'active';
  }
  const cls =
    tone === 'ok'
      ? 'bg-green-100 text-green-700'
      : tone === 'warn'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-ink-100 text-ink-500';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function OutcomeBadge({ outcome }: { outcome: PollResult['details'][number]['outcome'] }) {
  const { label, cls } = (() => {
    switch (outcome) {
      case 'ingested':
        return { label: 'ingested', cls: 'bg-green-100 text-green-700' };
      case 'skipped-no-url':
        return { label: 'no link', cls: 'bg-ink-100 text-ink-500' };
      case 'skipped-fetch-fail':
        return { label: 'fetch failed', cls: 'bg-amber-100 text-amber-700' };
      case 'skipped-parse-fail':
        return { label: 'parse failed', cls: 'bg-amber-100 text-amber-700' };
      case 'error':
        return { label: 'error', cls: 'bg-red-100 text-red-700' };
    }
  })();
  return (
    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}
