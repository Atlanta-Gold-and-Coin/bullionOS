'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

interface ClientRow {
  id: string;
  // Nullable — wholesaler rows (company-only) and webhook-auto-created
  // clients (single-word names from Gmail / GReminders / Calendar) can
  // leave one half blank. Defend with `?? ''` before .trim() /
  // .toLowerCase() on every read site below; the DB has always allowed
  // NULL here, the interface was overpromising.
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  region: string | null;
  is_portal_enabled: boolean;
  user_id: string | null;
  invoice_count: number;
  last_invoice_at: string | null;
  score?: number;
  created_at: string;
  client_type: 'retail' | 'wholesaler';
}

type Tab = 'retail' | 'wholesaler' | 'all';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'all', label: 'All' },
  // Labels track what operators actually call them — "Client" for retail
  // walk-ins, "Wholesale" for companies.
  { id: 'retail', label: 'Clients' },
  { id: 'wholesaler', label: 'Wholesale' },
];

export default function ClientsListPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'clients', q, tab],
    queryFn: () => {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (tab !== 'all') params.set('client_type', tab);
      const qs = params.toString();
      return apiFetch<ClientRow[]>(`/admin/clients${qs ? `?${qs}` : ''}`);
    },
    placeholderData: keepPreviousData,
  });

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    const ids = (data ?? []).map((c) => c.id);
    const allOn = ids.every((id) => selected.has(id)) && ids.length > 0;
    setSelected(allOn ? new Set() : new Set(ids));
  }

  // Simple name-based duplicate heuristic: first_name + last_name lowercased.
  // Different emails or phone are fine — the operator confirms before merging.
  const duplicates = useMemo(() => {
    const groups = new Map<string, ClientRow[]>();
    for (const c of data ?? []) {
      const key = `${(c.first_name ?? '').trim().toLowerCase()}|${(c.last_name ?? '').trim().toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }, [data]);

  async function bulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (
      !confirm(
        `Delete ${ids.length} client${ids.length === 1 ? '' : 's'}? Clients with invoices will be skipped. This cannot be undone.`,
      )
    ) {
      return;
    }
    setBulkError(null);
    setBulkResult(null);
    try {
      const resp = await apiFetch<{
        deleted: number;
        skipped: Array<{ id: string; reason: string }>;
      }>('/admin/clients/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      setSelected(new Set());
      setBulkResult(
        `Deleted ${resp.deleted}${
          resp.skipped.length ? ` · skipped ${resp.skipped.length} (invoices attached)` : ''
        }`,
      );
      await qc.invalidateQueries({ queryKey: ['admin', 'clients'] });
    } catch (err) {
      setBulkError(err instanceof ApiError ? err.message : 'Bulk delete failed');
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Clients</h1>
          <p className="mt-1 text-sm text-ink-400">
            {data?.length ?? 0} row{(data?.length ?? 0) === 1 ? '' : 's'}
            {duplicates.length > 0 && (
              <>
                {' · '}
                <Link href="#duplicates" className="underline-offset-2 hover:underline">
                  {duplicates.length} possible duplicate group{duplicates.length === 1 ? '' : 's'}
                </Link>
              </>
            )}
          </p>
        </div>
        <Link
          href="/admin/clients/new"
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800"
        >
          New client
        </Link>
      </div>

      <nav className="mt-5 flex gap-1 border-b border-ink-200 text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              setSelected(new Set());
            }}
            className={`-mb-px border-b-2 px-3 py-2 transition ${
              tab === t.id
                ? 'border-ink-900 font-medium text-ink-900'
                : 'border-transparent text-ink-600 hover:text-ink-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, email, phone, city…"
          className="input md:w-96"
        />
        {selected.size > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-ink-200 bg-white px-3 py-1 text-sm">
            <span className="text-ink-600">
              {selected.size} selected
            </span>
            <button
              onClick={bulkDelete}
              className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
            >
              Delete selected
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="rounded-md border border-ink-200 px-3 py-1 text-xs hover:bg-ink-50"
            >
              Clear
            </button>
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-400">
        Fuzzy search — typos and partial matches work. Rows with invoices can&rsquo;t be deleted;
        archive the portal account instead.
      </p>
      {bulkError && (
        <div role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {bulkError}
        </div>
      )}
      {bulkResult && (
        <div className="mt-2 rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">
          {bulkResult}
        </div>
      )}

      {/* MOB-002: horizontal scroll on narrow viewports. */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-ink-200 bg-white">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-ink-400">Loading…</div>
        ) : (
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={
                      (data?.length ?? 0) > 0 &&
                      (data ?? []).every((c) => selected.has(c.id))
                    }
                    onChange={toggleAll}
                    aria-label="Select all on this page"
                  />
                </th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email · Phone</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Portal</th>
                <th className="px-4 py-3 text-right">Invoices</th>
                <th className="px-4 py-3 text-right">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-ink-200 align-top hover:bg-ink-50/50"
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id)}
                      aria-label={`Select ${`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/clients/${c.id}`}
                      className="font-medium hover:underline"
                    >
                      {c.last_name ?? ''}, {c.first_name ?? ''}
                    </Link>
                    {c.client_type === 'wholesaler' && (
                      <span className="ml-2 rounded-full bg-gold-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold-600">
                        Wholesale
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-600">
                    <div>{c.email ?? <span className="text-ink-400">—</span>}</div>
                    <div className="text-xs text-ink-400">{c.phone ?? ''}</div>
                  </td>
                  <td className="px-4 py-3 text-ink-600">
                    {[c.city, c.region].filter(Boolean).join(', ') || (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.is_portal_enabled && c.user_id ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
                        enabled
                      </span>
                    ) : c.user_id ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                        disabled
                      </span>
                    ) : (
                      <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500">
                        retail
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{c.invoice_count}</td>
                  <td className="px-4 py-3 text-right text-ink-400">
                    {c.last_invoice_at
                      ? new Date(c.last_invoice_at).toLocaleDateString()
                      : '—'}
                  </td>
                </tr>
              ))}
              {(!data || data.length === 0) && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-ink-400">
                    {q.trim() ? `No matches for "${q}".` : 'No clients in this view.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {duplicates.length > 0 && (
        <section id="duplicates" className="mt-8">
          <h2 className="text-sm font-semibold">
            Possible duplicates (same first + last name)
          </h2>
          <p className="mt-1 text-xs text-ink-400">
            Click &ldquo;Keep&rdquo; on the row you want to survive. Invoices, quotes, shipments, and
            requests from the others are re-linked to it before they&rsquo;re deleted.
          </p>
          <div className="mt-3 space-y-3">
            {duplicates.slice(0, 20).map((group, i) => (
              <DuplicateGroup key={i} group={group} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function DuplicateGroup({ group }: { group: ClientRow[] }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function merge(keeperId: string) {
    const losers = group.filter((g) => g.id !== keeperId).map((g) => g.id);
    if (losers.length === 0) return;
    if (
      !confirm(
        `Keep this record and merge ${losers.length} other${losers.length === 1 ? '' : 's'} into it? This re-points invoices and deletes the duplicates.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ merged: number }>('/admin/clients/merge', {
        method: 'POST',
        body: JSON.stringify({ keeper_id: keeperId, loser_ids: losers }),
      });
      setDone(`Merged ${r.merged} record(s) into this one.`);
      await qc.invalidateQueries({ queryKey: ['admin', 'clients'] });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Merge failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4">
      <div className="mb-2 text-xs font-medium text-ink-600">
        {group[0].last_name ?? ''}, {group[0].first_name ?? ''} · {group.length} records
      </div>
      {done && (
        <div className="mb-2 rounded-md bg-green-50 px-3 py-1 text-xs text-green-700">{done}</div>
      )}
      {err && (
        <div className="mb-2 rounded-md bg-red-50 px-3 py-1 text-xs text-red-700">{err}</div>
      )}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {group.map((c) => (
          <div
            key={c.id}
            className="flex items-start justify-between gap-3 rounded-md border border-ink-100 p-3"
          >
            <div className="text-xs">
              <div className="font-medium">
                {c.first_name ?? ''} {c.last_name ?? ''}
                {c.client_type === 'wholesaler' && (
                  <span className="ml-1 text-[10px] uppercase text-gold-600">(wholesale)</span>
                )}
              </div>
              <div className="text-ink-400">
                {c.email ?? '—'} · {c.phone ?? '—'}
              </div>
              <div className="text-ink-400">
                {[c.city, c.region].filter(Boolean).join(', ') || '—'}
              </div>
              <div className="text-ink-400">
                {c.invoice_count} invoice{c.invoice_count === 1 ? '' : 's'}
              </div>
            </div>
            <button
              onClick={() => merge(c.id)}
              disabled={busy || Boolean(done)}
              className="rounded-md bg-ink-900 px-3 py-1 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-60"
            >
              {busy ? '…' : 'Keep this, merge others →'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
