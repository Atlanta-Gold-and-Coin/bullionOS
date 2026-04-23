'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, getAccessToken } from '@/lib/api-client';
import { ClientCombobox, displayName, type ComboboxClient } from '@/components/client-combobox';

/**
 * localStorage key for the sticky day picker. The accountant enters
 * a long run of entries for a single historical day, so snapping the
 * date back to "today" on every page reload is actively harmful —
 * they'd have to re-type the month. Persist across reloads; only the
 * user's explicit date-picker selection overrides.
 */
const STICKY_DATE_KEY = 'agc.historical-invoices.date';

/**
 * Historical invoices — admin page for reconciling past-system
 * transactions into AGC Desk's KPI rollups. Day-granular, one row per
 * past invoice, totals only. Accountant can:
 *
 *   - Pick a date, quick-add rows for that day (type / amount /
 *     optional client name + reference + wholesale flag + notes).
 *   - Upload a CSV for bulk import.
 *   - See a running daily summary (count + sales/purchases/wholesale).
 *   - Edit or delete any prior row.
 *
 * Does NOT touch `invoices`, `products`, `inventory`, or any client-
 * facing surface. Flows into /admin/kpi via a UNION in the rollup SQL.
 */

type InvType = 'buy' | 'sell';

interface HistoricalInvoiceRow {
  id: string;
  date: string;
  type: InvType;
  amount: string;
  is_wholesale: boolean;
  client_id: string | null;
  client_name: string | null;
  client_display_name: string | null;
  reference: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
}

interface DaySummary {
  count: number;
  sales: string;
  purchases: string;
  wholesale: string;
}

function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function money(s: string | number): string {
  const n = Number(s);
  if (!isFinite(n)) return '$0.00';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function HistoricalInvoicesPage() {
  const qc = useQueryClient();
  // Date state starts at today but rehydrates from localStorage on
  // mount. Can't read localStorage during the initial useState because
  // that runs server-side during Next.js SSR — guard behind useEffect.
  const [date, setDate] = useState<string>(todayIso());
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(STICKY_DATE_KEY) : null;
    if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved)) setDate(saved);
  }, []);
  // Mirror every operator-driven date change back into localStorage so
  // a refresh or tab re-open keeps them on the day they were booking.
  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem(STICKY_DATE_KEY, date);
  }, [date]);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['admin', 'historical-invoices', date],
    queryFn: () =>
      apiFetch<HistoricalInvoiceRow[]>(
        `/admin/historical-invoices?from=${date}&to=${date}&limit=500`,
      ),
  });

  const { data: summary } = useQuery({
    queryKey: ['admin', 'historical-invoices', 'summary', date],
    queryFn: () =>
      apiFetch<DaySummary>(
        `/admin/historical-invoices/summary?from=${date}&to=${date}`,
      ),
  });

  // Preload the full client list so QuickAdd can render the combobox
  // without hitting the API per-keystroke. Reuses the same cache key
  // as the invoice wizard — pages share the fetch if the user just
  // came from /admin/invoices/new. 10-minute staleTime because client
  // roster changes are rare during an entry session.
  const { data: clients } = useQuery<ComboboxClient[]>({
    queryKey: ['admin', 'clients', 'all'],
    queryFn: () => apiFetch<ComboboxClient[]>('/admin/clients'),
    staleTime: 10 * 60_000,
  });

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'historical-invoices'] });
    qc.invalidateQueries({ queryKey: ['admin', 'kpi'] });
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Historical invoices</h1>
          <p className="mt-1 text-sm text-ink-400">
            Record past-system invoices so the KPI rollup reflects prior months.
            Totals only — no line items, no inventory, no client-facing surface.
          </p>
        </div>
      </div>

      {/* Day picker + summary */}
      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
        <div className="flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Date
            </span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="input mt-1 font-mono"
            />
          </label>
          <div className="flex-1 text-right">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              This day
            </div>
            <div className="mt-1 text-sm text-ink-700">
              <span className="font-semibold">{summary?.count ?? 0}</span> entr{summary?.count === 1 ? 'y' : 'ies'}
              {' · '}
              Sales <span className="font-mono font-semibold text-green-700">{money(summary?.sales ?? 0)}</span>
              {' · '}
              Purchases <span className="font-mono font-semibold text-red-700">{money(summary?.purchases ?? 0)}</span>
              {Number(summary?.wholesale ?? 0) > 0 && (
                <>
                  {' · '}
                  <span className="text-ink-500">of which wholesale</span>{' '}
                  <span className="font-mono font-semibold text-gold-700">{money(summary?.wholesale ?? 0)}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Multi-row entry form — mirrors the line-item pattern used on
          /admin/invoices/new so the accountant can type a day's worth
          of past invoices in one pass, then submit the batch. */}
      <BatchAdd date={date} clients={clients ?? []} onAdded={refetchAll} />

      {/* CSV import */}
      <CsvImport onImported={refetchAll} />

      {/* Daily list */}
      <section className="mt-6 overflow-hidden rounded-xl border border-ink-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Reference</th>
              <th className="px-4 py-3 text-center">Wholesale</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-ink-400">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && (rows ?? []).length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-ink-400">
                  No entries for {date}. Add one above, or upload a CSV.
                </td>
              </tr>
            )}
            {(rows ?? []).map((r) => (
              <RowEntry key={r.id} row={r} onChanged={refetchAll} />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/**
 * Draft row inside the BatchAdd form. Stays purely client-side until
 * the operator hits "Save all"; at that point every row is POSTed one
 * at a time and any per-row failure gets rendered back onto its own
 * draft so the operator can fix just the broken one instead of losing
 * the whole batch.
 */
interface DraftEntry {
  /** Stable local id — not persisted, only used as React key / error lookup. */
  key: string;
  type: InvType;
  amount: string;
  /** UUID of the linked CRM client, if one was picked. null for free-text. */
  clientId: string | null;
  /** Display name. Auto-fills from picked client; still editable for overrides / walk-ins. */
  clientName: string;
  reference: string;
  isWholesale: boolean;
  notes: string;
  /** Per-row error message, populated on submit if this row's POST failed. */
  error: string | null;
}

function emptyDraft(): DraftEntry {
  return {
    key: cryptoRandomKey(),
    type: 'sell',
    amount: '',
    clientId: null,
    clientName: '',
    reference: '',
    isWholesale: false,
    notes: '',
    error: null,
  };
}

/** Cheap unique-enough id for React keys — no persistence needed. */
function cryptoRandomKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Multi-row entry form. Mirrors the line-item UX on /admin/invoices/new:
 * each row is an independent entry, operators can append/remove freely,
 * and "Save all" submits the batch. Failed rows stay visible with their
 * error message; succeeded rows disappear. Replaces the prior single-
 * entry QuickAdd so the accountant can type one day's full invoice
 * list before pressing save.
 */
function BatchAdd({
  date,
  clients,
  onAdded,
}: {
  date: string;
  clients: ComboboxClient[];
  onAdded: () => void;
}) {
  const [drafts, setDrafts] = useState<DraftEntry[]>(() => [emptyDraft()]);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<
    | { saved: number; failed: number }
    | null
  >(null);

  function patchDraft(key: string, patch: Partial<DraftEntry>) {
    setDrafts((cur) => cur.map((d) => (d.key === key ? { ...d, ...patch, error: null } : d)));
  }

  function removeDraft(key: string) {
    setDrafts((cur) => {
      const next = cur.filter((d) => d.key !== key);
      // Never leave the form empty — keep at least one editable row so
      // the accountant doesn't have to click "Add row" before typing.
      return next.length === 0 ? [emptyDraft()] : next;
    });
  }

  function appendDraft() {
    setDrafts((cur) => [...cur, emptyDraft()]);
  }

  async function saveAll() {
    setSummary(null);
    // Validate locally first — don't fire any POSTs if every row would
    // fail the amount check. Mark the bad ones inline and stop.
    let anyInvalid = false;
    const validated = drafts.map((d) => {
      const n = Number(String(d.amount).replace(/[$,]/g, ''));
      const empty = !d.amount.trim();
      if (empty) {
        anyInvalid = true;
        return { ...d, error: 'Amount is required.' };
      }
      if (!isFinite(n) || n < 0) {
        anyInvalid = true;
        return { ...d, error: 'Enter a non-negative dollar amount.' };
      }
      return { ...d, error: null };
    });
    setDrafts(validated);
    if (anyInvalid) return;

    setBusy(true);
    let saved = 0;
    const remaining: DraftEntry[] = [];
    // Serial loop — the table is tiny and keeping writes in order makes
    // the post-save UI easier to reason about than Promise.all races.
    for (const d of validated) {
      const n = Number(String(d.amount).replace(/[$,]/g, ''));
      try {
        await apiFetch('/admin/historical-invoices', {
          method: 'POST',
          body: JSON.stringify({
            date,
            type: d.type,
            amount: n,
            is_wholesale: d.isWholesale,
            client_id: d.clientId,
            client_name: d.clientName.trim() || null,
            reference: d.reference.trim() || null,
            notes: d.notes.trim() || null,
          }),
        });
        saved += 1;
      } catch (err) {
        remaining.push({
          ...d,
          error: err instanceof ApiError ? err.message : 'Save failed',
        });
      }
    }
    // Successes drop out of the form; failures stay visible with their
    // error so the operator can fix + retry only the broken rows. If
    // every row succeeded, reset back to a single empty starter row.
    setDrafts(remaining.length === 0 ? [emptyDraft()] : remaining);
    setSummary({ saved, failed: remaining.length });
    setBusy(false);
    if (saved > 0) onAdded();
  }

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Add entries for {date}
        </h2>
        <span className="text-xs text-ink-400">
          {drafts.length} row{drafts.length === 1 ? '' : 's'} pending
        </span>
      </div>

      <div className="mt-3 space-y-3">
        {drafts.map((d, i) => (
          <DraftRow
            key={d.key}
            index={i}
            draft={d}
            clients={clients}
            onPatch={(p) => patchDraft(d.key, p)}
            onRemove={() => removeDraft(d.key)}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button
          onClick={appendDraft}
          className="rounded-md border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
          type="button"
        >
          + Add another row
        </button>
        <div className="flex items-center gap-3">
          {summary && (
            <span className="text-xs text-ink-500">
              {summary.saved > 0 && (
                <span className="font-semibold text-green-700">
                  Saved {summary.saved}
                </span>
              )}
              {summary.saved > 0 && summary.failed > 0 && ' · '}
              {summary.failed > 0 && (
                <span className="font-semibold text-red-700">
                  {summary.failed} failed
                </span>
              )}
            </span>
          )}
          <button
            onClick={saveAll}
            disabled={busy}
            className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
            type="button"
          >
            {busy
              ? 'Saving…'
              : `Save ${drafts.length === 1 ? 'entry' : `all ${drafts.length}`}`}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * One draft row. Packs every field inline for keyboard-fast entry —
 * type, amount, client combobox, free-text name, reference, wholesale,
 * notes — with a compact remove button at the end. The combobox and
 * the name field are siblings rather than a single hybrid control so
 * walk-in rows ("Jane at counter") don't need a dummy CRM client
 * record to display sensibly.
 */
function DraftRow({
  index,
  draft,
  clients,
  onPatch,
  onRemove,
}: {
  index: number;
  draft: DraftEntry;
  clients: ComboboxClient[];
  onPatch: (patch: Partial<DraftEntry>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          Entry {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="text-[11px] text-ink-400 hover:text-red-600"
          aria-label="Remove this entry"
        >
          ✕ Remove
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
        <label className="block sm:col-span-1">
          <span className="text-[11px] font-medium text-ink-500">Type</span>
          <select
            value={draft.type}
            onChange={(e) => onPatch({ type: e.target.value as InvType })}
            className="input mt-1"
          >
            <option value="sell">Sell</option>
            <option value="buy">Buy</option>
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[11px] font-medium text-ink-500">Amount</span>
          <input
            type="text"
            inputMode="decimal"
            value={draft.amount}
            onChange={(e) => onPatch({ amount: e.target.value })}
            placeholder="0.00"
            className="input mt-1 font-mono"
          />
        </label>
        <div className="sm:col-span-4">
          <span className="text-[11px] font-medium text-ink-500">
            Link to client (optional)
          </span>
          <div className="mt-1">
            <ClientCombobox
              clients={clients}
              value={draft.clientId ?? ''}
              onChange={(id) => {
                const picked = id ? clients.find((c) => c.id === id) ?? null : null;
                // Auto-fill the display-name field with the picked
                // client's formatted name so the accountant doesn't
                // have to re-type it. They can still edit it for
                // per-row annotations ("Bob Smith — cash deal").
                onPatch({
                  clientId: id || null,
                  clientName: picked
                    ? displayName(picked)
                    : draft.clientName,
                });
              }}
              placeholder="Search existing clients…"
            />
          </div>
        </div>
        <label className="block sm:col-span-3">
          <span className="text-[11px] font-medium text-ink-500">
            Display name
          </span>
          <input
            type="text"
            value={draft.clientName}
            onChange={(e) => onPatch({ clientName: e.target.value })}
            placeholder="Retail, Jane Smith…"
            className="input mt-1"
            maxLength={200}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[11px] font-medium text-ink-500">Reference</span>
          <input
            type="text"
            value={draft.reference}
            onChange={(e) => onPatch({ reference: e.target.value })}
            placeholder="POS-4501"
            className="input mt-1 font-mono"
            maxLength={120}
          />
        </label>
        <label className="block sm:col-span-8">
          <span className="text-[11px] font-medium text-ink-500">Notes</span>
          <input
            type="text"
            value={draft.notes}
            onChange={(e) => onPatch({ notes: e.target.value })}
            className="input mt-1"
            maxLength={2000}
          />
        </label>
        <label className="flex items-end gap-2 sm:col-span-4">
          <input
            type="checkbox"
            checked={draft.isWholesale}
            onChange={(e) => onPatch({ isWholesale: e.target.checked })}
            className="mb-2 h-4 w-4"
          />
          <span className="mb-2 text-xs text-ink-700">Wholesale</span>
        </label>
      </div>
      {draft.error && (
        <div className="mt-2 rounded-md bg-red-50 px-3 py-1.5 text-xs text-red-700">
          {draft.error}
        </div>
      )}
    </div>
  );
}

function RowEntry({ row, onChanged }: { row: HistoricalInvoiceRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function toggleWholesale() {
    setBusy(true);
    try {
      await apiFetch(`/admin/historical-invoices/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_wholesale: !row.is_wholesale }),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete this ${row.type} entry of ${money(row.amount)}?`)) return;
    setDeleting(true);
    try {
      await apiFetch(`/admin/historical-invoices/${row.id}`, { method: 'DELETE' });
      onChanged();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <tr className="border-t border-ink-200 hover:bg-ink-50/40">
      <td className="px-4 py-3">
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
            row.type === 'sell'
              ? 'bg-green-50 text-green-700'
              : 'bg-red-50 text-red-700'
          }`}
        >
          {row.type.toUpperCase()}
        </span>
      </td>
      <td className="px-4 py-3 text-right font-mono font-semibold">
        {money(row.amount)}
      </td>
      <td className="px-4 py-3 text-ink-700">
        {row.client_display_name || <span className="text-ink-400">—</span>}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-ink-500">
        {row.reference || <span className="text-ink-300">—</span>}
      </td>
      <td className="px-4 py-3 text-center">
        <button
          onClick={toggleWholesale}
          disabled={busy}
          className={`rounded-md px-2 py-0.5 text-xs font-medium transition ${
            row.is_wholesale
              ? 'bg-gold-100 text-gold-700 hover:bg-gold-200'
              : 'bg-ink-50 text-ink-400 hover:bg-ink-100'
          }`}
        >
          {row.is_wholesale ? '✓ Wholesale' : 'Retail'}
        </button>
      </td>
      <td className="px-4 py-3 text-xs text-ink-500">
        {row.notes || <span className="text-ink-300">—</span>}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={remove}
          disabled={deleting}
          className="rounded-md border border-red-200 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
        >
          {deleting ? '…' : 'Delete'}
        </button>
      </td>
    </tr>
  );
}

function CsvImport({ onImported }: { onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ inserted: number; errors: Array<{ row: number; message: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setResult(null);
    setError(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const token = getAccessToken();
      const res = await fetch('/api/v1/admin/historical-invoices/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message ?? 'Import failed');
      setResult(json);
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-ink-200 bg-ink-50/30 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Bulk import from CSV
          </h2>
          <p className="mt-1 text-xs text-ink-500">
            Columns (case-insensitive): <code>date</code>, <code>type</code>, <code>amount</code>,
            <code>wholesale</code>, <code>client_name</code>, <code>reference</code>, <code>notes</code>.
            The accountant can export straight from QuickBooks / the old POS and
            rename the columns to match.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            id="hist-csv"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
            className="hidden"
          />
          <label
            htmlFor="hist-csv"
            className="cursor-pointer rounded-md border border-ink-300 bg-white px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            {busy ? 'Importing…' : 'Upload CSV'}
          </label>
        </div>
      </div>

      {result && (
        <div className="mt-3 rounded-md bg-green-50 px-3 py-2 text-xs text-green-800">
          Imported <strong>{result.inserted}</strong> row{result.inserted === 1 ? '' : 's'}.
          {result.errors.length > 0 && (
            <>
              {' '}
              <strong>{result.errors.length}</strong> row{result.errors.length === 1 ? '' : 's'} skipped:
              <ul className="mt-1 list-disc pl-5">
                {result.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>
                    Row {e.row}: {e.message}
                  </li>
                ))}
                {result.errors.length > 20 && <li>…{result.errors.length - 20} more.</li>}
              </ul>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}
    </section>
  );
}
