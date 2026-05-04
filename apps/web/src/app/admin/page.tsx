'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, getAccessToken } from '@/lib/api-client';
import { useFlag, useSetting } from '@/lib/use-app-settings';

/**
 * Admin dashboard.
 *
 * Apr 2026 redesign:
 *   - Removed the "Recent invoices" table. That view now lives as a
 *     "Recent" tab on /admin/invoices alongside Drafts/Sales/Purchase/
 *     Wholesale/All, so invoice triage has one home.
 *   - Added the Daily Updates card — a single-author feed post with
 *     team comments (migration 026). Hunter-style editorial voice:
 *     one person posts, everyone else reacts. Posting, edit, delete
 *     are gated by users.can_post_daily_update; comments are open to
 *     any admin/staff.
 *   - Added a 12-month sales/purchases/wholesale bar chart below the
 *     feed, fed by /admin/kpi?period=month&buckets=12. Same data the
 *     KPI page uses at a coarser level — helpful at-a-glance pulse
 *     on the dashboard without switching pages.
 */

interface InvoiceRow {
  id: string;
  invoice_number: string;
  type: 'buy' | 'sell';
  status: string;
  total: string;
  created_at: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}

interface DailyUpdateAttachment {
  id: string;
  filename: string;
  mime: string;
  created_at: string;
}
interface DailyUpdateComment {
  id: string;
  body: string;
  author_user_id: string;
  author_email: string | null;
  created_at: string;
  updated_at: string;
}
interface DailyUpdate {
  id: string;
  body: string;
  author_user_id: string;
  author_email: string | null;
  created_at: string;
  updated_at: string;
  attachments: DailyUpdateAttachment[];
  comments: DailyUpdateComment[];
}

interface MonthBucket {
  bucket_start: string;
  purchases: string;
  sales: string;
  wholesale: string;
}

export default function AdminDashboard() {
  const { data: invoices } = useQuery({
    queryKey: ['admin', 'invoices', 'dashboard-totals'],
    queryFn: () => apiFetch<InvoiceRow[]>('/admin/invoices'),
  });
  const { data: products } = useQuery({
    queryKey: ['admin', 'products'],
    queryFn: () => apiFetch<Product[]>('/admin/products'),
  });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Trading desk</h1>
          <p className="mt-1 text-sm text-ink-400">Live overview</p>
        </div>
        <Link
          href="/admin/invoices/new"
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800"
        >
          New invoice
        </Link>
      </div>

      {/* Quick-stat tiles — draft + canceled excluded, so only realized
          volume is shown. */}
      {(() => {
        const committed = (invoices ?? []).filter(
          (i) => i.status !== 'draft' && i.status !== 'canceled',
        );
        const buyTotal = committed
          .filter((i) => i.type === 'buy')
          .reduce((s, i) => s + Number(i.total), 0);
        const sellTotal = committed
          .filter((i) => i.type === 'sell')
          .reduce((s, i) => s + Number(i.total), 0);
        return (
          <section className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Products active" value={String(products?.length ?? '—')} />
            <Stat label="Committed invoices" value={String(committed.length)} />
            <Stat
              label="Buy volume"
              // Whole-dollar precision on the dashboard rollup — the
              // cents are noise at the daily-summary aggregation level
              // and used to push 8+ digit values past the card's right
              // edge on mobile (grid-cols-2 → ~170px wide each).
              value={invoices ? `$${buyTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
              tone="buy"
            />
            <Stat
              label="Sell volume"
              value={invoices ? `$${sellTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
              tone="sell"
            />
          </section>
        );
      })()}

      {/* New / Returning client KPI — sits above the daily update so
          it's the first thing operators see after the volume row.
          Sourced from calendar event titles ("(N)" / "(R)") via
          /admin/clients/tracking. */}
      <section className="mt-10">
        <ClientTypeKpi />
      </section>

      {/* Daily update card — the main feed element. Comments thread below. */}
      <section className="mt-10">
        <DailyUpdateCard />
      </section>

      {/* Monthly sales/purchases/wholesale chart. Reuses the same KPI
          rollup the dedicated KPI page uses. */}
      <section className="mt-10">
        <MonthlyTotalsChart />
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'buy' | 'sell';
}) {
  const accent =
    tone === 'buy'
      ? 'border-buy-200 bg-buy-50'
      : tone === 'sell'
        ? 'border-sell-200 bg-sell-50'
        : 'border-ink-200 bg-white';
  const valueColor =
    tone === 'buy' ? 'text-buy-700' : tone === 'sell' ? 'text-sell-700' : 'text-ink-900';
  return (
    // overflow-hidden + min-w-0 + truncate on the inner value lets the
    // card shrink correctly inside a 2-col grid on narrow phones.
    // text-xl on mobile / text-2xl on md+ keeps headline values
    // readable without forcing the operator to scroll horizontally
    // when daily volume runs to 6-7 digits.
    <div className={`rounded-xl border p-5 ${accent} overflow-hidden`}>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div
        className={`mt-2 truncate text-xl font-semibold tabular-nums md:text-2xl ${valueColor}`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Client Type KPI (New vs Returning, month-over-month) ─────────────

interface TrackingBucket {
  bucket_start: string;
  bucket_label: string;
  new_count: number;
  returning_count: number;
  cumulative_new: number;
  total: number;
}

/**
 * Dashboard widget rolling up calendar bookings tagged "(N)" / "(R)"
 * by operators in the appointment title. Shows current month + prior
 * month side-by-side with a delta and a 6-month sparkline of new
 * clients. Source endpoint: GET /admin/calendar/client-tracking
 * (lives under /admin/calendar/* to avoid being shadowed by
 * AdminClientsController's @Get(':id') UUID route).
 */
function ClientTypeKpi() {
  const newClientsBaseline = useSetting('dashboard.new_clients_baseline');
  const { data, isLoading, error } = useQuery<{
    months: number;
    buckets: TrackingBucket[];
  }>({
    queryKey: ['admin', 'clients', 'tracking', 6],
    queryFn: () =>
      apiFetch<{ months: number; buckets: TrackingBucket[] }>(
        '/admin/calendar/client-tracking?months=6',
      ),
    // Operators add (N)/(R) to titles a couple times a day at most;
    // 5-min stale window is plenty fresh for a dashboard tile.
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="rounded-xl border border-ink-200 bg-white p-5 text-sm text-ink-400">
        Loading client tracking…
      </div>
    );
  }
  if (error || !data || data.buckets.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">
          Client tracking
        </div>
        <p className="mt-2 text-sm text-amber-900">
          {error
            ? 'Calendar integration not configured — can\'t pull (N)/(R) tags right now.'
            : 'No calendar events with (N) or (R) tags found.'}
        </p>
      </div>
    );
  }

  // Buckets are oldest-first; current month is last, prior is second-to-last.
  const buckets = data.buckets;
  const current = buckets[buckets.length - 1];
  const prior = buckets.length >= 2 ? buckets[buckets.length - 2] : null;
  const newDelta = prior ? current.new_count - prior.new_count : null;
  const retDelta = prior ? current.returning_count - prior.returning_count : null;
  const maxNew = Math.max(1, ...buckets.map((b) => b.new_count));

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Client tracking · this month
          </h2>
          <p className="mt-0.5 text-[11px] text-ink-400">
            From calendar titles tagged (N) / (R). Untagged events skipped.
          </p>
        </div>
        <Link
          href="/admin/clients/tracking"
          className="text-xs text-ink-500 underline-offset-2 hover:underline"
        >
          full history →
        </Link>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiTile
          label={`New · ${current.bucket_label}`}
          value={current.new_count}
          delta={newDelta}
          deltaLabel={prior ? `vs ${prior.bucket_label}` : null}
          tone="emerald"
          // Monthly target. Edit via Settings → Features
          // (`dashboard.new_clients_baseline`). 0 hides the baseline UI.
          baseline={newClientsBaseline > 0 ? newClientsBaseline : undefined}
        />
        <KpiTile
          label={`Returning · ${current.bucket_label}`}
          value={current.returning_count}
          delta={retDelta}
          deltaLabel={prior ? `vs ${prior.bucket_label}` : null}
          tone="sky"
        />
        <div className="col-span-2 md:col-span-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
            Last 6 months · new
          </div>
          <div className="mt-2 flex h-16 items-end gap-1">
            {buckets.map((b) => {
              const h = b.new_count > 0 ? Math.max(6, (b.new_count / maxNew) * 100) : 4;
              const isCurrent = b === current;
              return (
                <div
                  key={b.bucket_start}
                  title={`${b.bucket_label}: ${b.new_count} new · ${b.returning_count} returning`}
                  className="flex-1 cursor-default"
                >
                  <div
                    className={
                      'rounded-sm ' +
                      (isCurrent ? 'bg-emerald-600' : 'bg-emerald-300')
                    }
                    style={{ height: `${h}%` }}
                  />
                  <div className="mt-1 truncate text-center text-[9px] text-ink-400">
                    {b.bucket_label.slice(0, 3)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  delta,
  deltaLabel,
  tone,
  baseline,
}: {
  label: string;
  value: number;
  delta: number | null;
  deltaLabel: string | null;
  tone: 'emerald' | 'sky';
  /**
   * Monthly target. When set, renders alongside the headline number
   * as "X / N" plus a small progress bar (capped at 100%) so the
   * tile shows both the actual count and how far through the goal
   * the operator is.
   */
  baseline?: number;
}) {
  const accent =
    tone === 'emerald'
      ? 'border-emerald-200 bg-emerald-50'
      : 'border-sky-200 bg-sky-50';
  const valueColor = tone === 'emerald' ? 'text-emerald-800' : 'text-sky-800';
  const barColor = tone === 'emerald' ? 'bg-emerald-500' : 'bg-sky-500';
  const deltaSign = delta !== null && delta > 0 ? '+' : '';
  const deltaColor =
    delta === null
      ? 'text-ink-400'
      : delta > 0
        ? 'text-emerald-700'
        : delta < 0
          ? 'text-red-700'
          : 'text-ink-500';
  // Clamp the progress bar at 100% — overshooting the goal still
  // shows a full bar (the "X / N" text carries the actual ratio).
  const pctOfBaseline =
    baseline && baseline > 0
      ? Math.min(100, Math.round((value / baseline) * 100))
      : null;
  return (
    <div className={`rounded-md border p-3 ${accent}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-500 truncate">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <div
          className={`text-2xl font-semibold tabular-nums ${valueColor}`}
        >
          {value}
        </div>
        {baseline !== undefined && (
          <div className="text-[11px] text-ink-500">
            / <span className="font-mono tabular-nums">{baseline}</span>{' '}
            baseline
          </div>
        )}
      </div>
      {pctOfBaseline !== null && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/70">
          <div
            className={`h-full rounded-full ${barColor} transition-all`}
            style={{ width: `${pctOfBaseline}%` }}
          />
        </div>
      )}
      {delta !== null && deltaLabel && (
        <div className={`mt-1 text-[11px] ${deltaColor}`}>
          {deltaSign}
          {delta} {deltaLabel}
        </div>
      )}
    </div>
  );
}

// ─── Daily Update card ─────────────────────────────────────────────────

function DailyUpdateCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'daily-update', 'latest'],
    queryFn: () =>
      apiFetch<DailyUpdate | null>('/admin/daily-updates/latest'),
    refetchInterval: 60_000,
  });
  const { data: perm } = useQuery({
    queryKey: ['admin', 'daily-update', 'can-post'],
    queryFn: () =>
      apiFetch<{ can_post: boolean }>('/admin/daily-updates/me/can-post'),
    staleTime: 5 * 60_000,
  });
  const canPost = perm?.can_post === true;

  const [composeOpen, setComposeOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Files staged during compose before the post exists. On Save/Post,
  // we upload each file to the resulting daily_update_id. If the
  // composer is editing an existing post, new files upload immediately
  // against the already-known id.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);

  function openCompose() {
    setDraft('');
    setPendingFiles([]);
    setComposeOpen(true);
    setEditing(false);
  }
  function openEdit() {
    setDraft(data?.body ?? '');
    setPendingFiles([]);
    setEditing(true);
    setComposeOpen(true);
  }

  async function uploadOneFile(dailyUpdateId: string, file: File): Promise<void> {
    const fd = new FormData();
    fd.append('file', file);
    await apiFetch(`/admin/daily-updates/${dailyUpdateId}/attachments`, {
      method: 'POST',
      body: fd,
    });
  }

  async function save() {
    const body = draft.trim();
    if (!body) return;
    setUploadBusy(true);
    try {
      let targetId: string;
      if (editing && data) {
        await apiFetch(`/admin/daily-updates/${data.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ body }),
        });
        targetId = data.id;
      } else {
        const created = await apiFetch<{ id: string }>('/admin/daily-updates', {
          method: 'POST',
          body: JSON.stringify({ body }),
        });
        targetId = created.id;
      }
      // Sequential uploads so one failure doesn't orphan the others.
      // Small N (operators attach a handful of photos max) means
      // serial latency is negligible and the user sees a clean
      // progression.
      for (const f of pendingFiles) {
        await uploadOneFile(targetId, f);
      }
      await qc.invalidateQueries({ queryKey: ['admin', 'daily-update'] });
      setComposeOpen(false);
      setDraft('');
      setPendingFiles([]);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setUploadBusy(false);
    }
  }

  async function remove() {
    if (!data) return;
    if (!confirm('Delete this daily update? This also removes all comments and attachments.')) return;
    try {
      await apiFetch(`/admin/daily-updates/${data.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['admin', 'daily-update'] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Delete failed');
    }
  }

  async function uploadFile(file: File) {
    if (!data) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      await apiFetch(`/admin/daily-updates/${data.id}/attachments`, {
        method: 'POST',
        body: fd,
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'daily-update'] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Upload failed');
    }
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">
            Daily update
          </h2>
          {data && (
            <p className="mt-1 text-xs text-ink-400">
              Posted by {data.author_email ?? 'unknown'} ·{' '}
              {new Date(data.created_at).toLocaleString()}
              {data.updated_at !== data.created_at && (
                <span className="italic"> · edited</span>
              )}
            </p>
          )}
        </div>
        {canPost && !composeOpen && (
          <div className="flex items-center gap-2">
            {data ? (
              <>
                <button
                  onClick={openEdit}
                  className="rounded-md border border-ink-200 px-3 py-1 text-xs hover:bg-ink-50"
                >
                  Edit
                </button>
                <button
                  onClick={remove}
                  className="rounded-md border border-red-200 px-3 py-1 text-xs text-red-700 hover:bg-red-50"
                >
                  Delete
                </button>
                <button
                  onClick={openCompose}
                  className="rounded-md bg-ink-900 px-3 py-1 text-xs font-medium text-white hover:bg-ink-800"
                >
                  New post
                </button>
              </>
            ) : (
              <button
                onClick={openCompose}
                className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800"
              >
                Post today&apos;s update
              </button>
            )}
          </div>
        )}
      </div>

      {composeOpen ? (
        <div className="mt-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            maxLength={10_000}
            className="input"
            placeholder="What's happening today? Markdown supported."
            autoFocus
          />

          {/* Staged attachments (pre-post). Files sit in local state
              until Save fires — Save creates/updates the post then
              uploads each file sequentially against the resulting id. */}
          {pendingFiles.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {pendingFiles.map((f, i) => (
                <div
                  key={i}
                  className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-ink-50 px-2 py-1 text-xs"
                >
                  {f.type.startsWith('image/') ? '📷' : '📎'} {f.name}
                  <button
                    type="button"
                    onClick={() =>
                      setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))
                    }
                    className="ml-1 text-ink-400 hover:text-red-700"
                    aria-label={`Remove ${f.name}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-700 hover:text-ink-900">
              <input
                type="file"
                multiple
                className="hidden"
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length === 0) return;
                  setPendingFiles((prev) => [...prev, ...files]);
                  e.target.value = '';
                }}
              />
              <span className="rounded-md border border-dashed border-ink-300 bg-white px-3 py-1.5 font-medium">
                + Attach image or file
              </span>
            </label>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setComposeOpen(false);
                  setDraft('');
                  setPendingFiles([]);
                }}
                className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={uploadBusy || draft.trim().length === 0}
                className="rounded-md bg-ink-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
              >
                {uploadBusy
                  ? 'Saving…'
                  : editing
                    ? 'Save changes'
                    : pendingFiles.length > 0
                      ? `Post + upload ${pendingFiles.length}`
                      : 'Post'}
              </button>
            </div>
          </div>
        </div>
      ) : isLoading ? (
        <p className="mt-4 text-sm text-ink-400">Loading…</p>
      ) : !data ? (
        <p className="mt-4 text-sm text-ink-500">
          No daily update yet.
          {canPost && ' Click "Post today\'s update" above to share one.'}
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {/* Preserve whitespace; the body is plain-ish markdown-ish text.
              Markdown is NOT rendered server-side — we'll show it as-is.
              Lightweight styling keeps it readable. */}
          <p className="whitespace-pre-wrap break-words text-sm text-ink-800">
            {data.body}
          </p>

          {data.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.attachments.map((a) => (
                <AttachmentChip
                  key={a.id}
                  attachment={a}
                  canDelete={canPost}
                />
              ))}
            </div>
          )}

          {canPost && (
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-600 hover:text-ink-900">
              <input
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadFile(f);
                  e.target.value = '';
                }}
              />
              <span className="rounded-md border border-dashed border-ink-300 px-3 py-1">
                + Attach file
              </span>
            </label>
          )}
        </div>
      )}

      {data && <CommentThread update={data} />}
    </div>
  );
}

function AttachmentChip({
  attachment,
  canDelete,
}: {
  attachment: DailyUpdateAttachment;
  canDelete: boolean;
}) {
  const qc = useQueryClient();
  const [src, setSrc] = useState<string | null>(null);

  // For images, fetch + blob so we keep the admin token in headers instead
  // of sticking it in a query string. Falls through to a plain "download"
  // chip for non-images.
  const isImage = attachment.mime.startsWith('image/');

  async function download() {
    const token = getAccessToken();
    const res = await fetch(
      `/api/v1/admin/daily-updates/attachments/${attachment.id}/file`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (isImage) {
      setSrc(url);
    } else {
      window.open(url, '_blank');
    }
  }

  async function remove() {
    if (!confirm(`Remove attachment "${attachment.filename}"?`)) return;
    try {
      await apiFetch(`/admin/daily-updates/attachments/${attachment.id}`, {
        method: 'DELETE',
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'daily-update'] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Remove failed');
    }
  }

  if (isImage && src) {
    return (
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={attachment.filename}
          className="max-h-48 rounded-md border border-ink-200 object-contain"
        />
        {canDelete && (
          <button
            onClick={remove}
            className="absolute right-1 top-1 rounded-full bg-ink-900/70 px-2 text-[10px] text-white hover:bg-ink-900"
            aria-label="Remove attachment"
          >
            ✕
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-ink-50 px-2 py-1 text-xs">
      <button onClick={download} className="hover:underline">
        {isImage ? '📷' : '📎'} {attachment.filename}
      </button>
      {canDelete && (
        <button
          onClick={remove}
          className="ml-1 text-ink-400 hover:text-red-700"
          aria-label="Remove attachment"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function CommentThread({ update }: { update: DailyUpdate }) {
  const qc = useQueryClient();
  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () =>
      apiFetch<{ id: string; role: string; email: string }>('/auth/me'),
    staleTime: 5 * 60_000,
  });

  const [draft, setDraft] = useState('');
  async function submit() {
    const body = draft.trim();
    if (!body) return;
    try {
      await apiFetch(`/admin/daily-updates/${update.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      setDraft('');
      await qc.invalidateQueries({ queryKey: ['admin', 'daily-update'] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Comment failed');
    }
  }

  return (
    <div className="mt-6 border-t border-ink-200 pt-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
        Comments ({update.comments.length})
      </div>
      <ul className="mt-3 space-y-3">
        {update.comments.map((c) => (
          <CommentRow key={c.id} comment={c} meId={me?.id} meRole={me?.role} />
        ))}
      </ul>
      <div className="mt-4">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          maxLength={4000}
          className="input text-sm"
          placeholder="Add a comment…"
        />
        <div className="mt-1 flex justify-end">
          <button
            onClick={submit}
            disabled={draft.trim().length === 0}
            className="rounded-md bg-ink-900 px-3 py-1 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-60"
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  meId,
  meRole,
}: {
  comment: DailyUpdateComment;
  meId?: string;
  meRole?: string;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  // Match server-side guard: owners + admins can edit/delete.
  const canEdit = meId === comment.author_user_id || meRole === 'admin';

  async function save() {
    try {
      await apiFetch(`/admin/daily-updates/comments/${comment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: draft.trim() }),
      });
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ['admin', 'daily-update'] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Save failed');
    }
  }

  async function remove() {
    if (!confirm('Delete this comment?')) return;
    try {
      await apiFetch(`/admin/daily-updates/comments/${comment.id}`, {
        method: 'DELETE',
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'daily-update'] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Delete failed');
    }
  }

  return (
    <li className="rounded-md border border-ink-100 bg-ink-50/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-500">
        <span className="font-medium text-ink-700">
          {comment.author_email ?? 'unknown'}
        </span>
        <span>
          {new Date(comment.created_at).toLocaleString()}
          {comment.updated_at !== comment.created_at && (
            <span className="italic"> · edited</span>
          )}
        </span>
      </div>
      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            className="input text-sm"
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              onClick={() => {
                setEditing(false);
                setDraft(comment.body);
              }}
              className="rounded-md border border-ink-200 px-2 py-0.5 text-xs hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="rounded-md bg-ink-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-ink-800"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-800">
            {comment.body}
          </p>
          {canEdit && (
            <div className="mt-1 flex gap-2 text-[11px]">
              <button
                onClick={() => setEditing(true)}
                className="text-ink-500 hover:text-ink-900"
              >
                Edit
              </button>
              <button
                onClick={remove}
                className="text-ink-500 hover:text-red-700"
              >
                Delete
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
}

// ─── Monthly totals chart ──────────────────────────────────────────────

function MonthlyTotalsChart() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'kpi', 'month-12'],
    queryFn: () =>
      apiFetch<{ period: string; buckets: MonthBucket[] }>(
        '/admin/kpi?period=month&buckets=12',
      ),
    staleTime: 60_000,
  });

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">
          Last 12 months
        </h2>
        <Link
          href="/admin/kpi"
          className="text-xs text-ink-600 hover:text-ink-900"
        >
          Open KPI →
        </Link>
      </div>
      <div className="mt-4 overflow-x-auto">
        <MonthlyBars
          buckets={data?.buckets ?? []}
          loading={isLoading}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-ink-500">
        <Legend color="#1f6b3e" label="Sales" />
        <Legend color="#1e3a78" label="Purchases" />
        <Legend color="#b08e4a" label="Wholesale" />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-3 rounded-sm"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

/** Tooltip-formatter for chart bars — dollars with commas, no decimals. */
/** Nice-ladder tick step picker — see /admin/kpi/page.tsx for details. */
function pickTickStep(max: number, desiredStep: number, maxTicks: number): number {
  const ladder = [50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000];
  const start = ladder.indexOf(desiredStep);
  for (let i = Math.max(0, start); i < ladder.length; i++) {
    const step = ladder[i];
    if (Math.ceil(max / step) <= maxTicks) return step;
  }
  return ladder[ladder.length - 1];
}

/** "$0", "$50k", "$1.2M" — compact axis label. */
function formatDollarTick(n: number): string {
  if (n === 0) return '$0';
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  return `$${n.toFixed(0)}`;
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function MonthlyBars({
  buckets,
  loading,
}: {
  buckets: MonthBucket[];
  loading: boolean;
}) {
  if (loading) {
    return <div className="py-12 text-center text-sm text-ink-400">Loading…</div>;
  }
  if (buckets.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-ink-400">No activity yet.</div>
    );
  }

  // Max across all three series so bars stay comparable across the chart.
  const rawMax = Math.max(
    1,
    ...buckets.flatMap((b) => [
      Number(b.sales),
      Number(b.purchases),
      Number(b.wholesale),
    ]),
  );
  // $50k ticks with nice-ladder auto-upgrade for larger charts — see
  // apps/web/src/app/admin/kpi/page.tsx for the original impl + docstring.
  const tickStep = pickTickStep(rawMax, 50_000, 8);
  const max = Math.max(tickStep, Math.ceil(rawMax / tickStep) * tickStep);
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += tickStep) ticks.push(v);

  const barWidth = 14;
  const barGap = 3;
  const groupWidth = barWidth * 3 + barGap * 2;
  const groupGap = 14;
  const chartH = 180;
  const yAxisWidth = 52;
  const chartW = buckets.length * (groupWidth + groupGap);
  const totalW = Math.max(chartW + yAxisWidth, 400);
  const paddingBottom = 28;

  return (
    <svg
      width={totalW}
      height={chartH + paddingBottom}
      className="min-w-full"
    >
      {ticks.map((v) => {
        const y = chartH - (v / max) * chartH;
        return (
          <g key={v}>
            <line
              x1={0}
              x2={totalW - yAxisWidth}
              y1={y}
              y2={y}
              stroke="#eeeef1"
              strokeWidth={1}
            />
            <text
              x={totalW - yAxisWidth + 8}
              y={y + 3}
              fontSize={9}
              fill="#8a8a92"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {formatDollarTick(v)}
            </text>
          </g>
        );
      })}
      {buckets.map((b, i) => {
        const sales = Number(b.sales);
        const purchases = Number(b.purchases);
        const wholesale = Number(b.wholesale);
        const x = i * (groupWidth + groupGap);
        // SVG <title> + full-bucket transparent hit rect: gives a
        // native tooltip with zero React state. Hovering anywhere in
        // the bucket column (not just on a bar) triggers the tooltip
        // — helpful in zero-value months where bars have no area.
        const monthLabel = new Date(b.bucket_start).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
        });
        const tip =
          `${monthLabel}\n` +
          `Sales:      ${fmtMoney(sales)}\n` +
          `Purchases:  ${fmtMoney(purchases)}\n` +
          `Wholesale:  ${fmtMoney(wholesale)}`;
        return (
          <g key={b.bucket_start}>
            <title>{tip}</title>
            <rect
              x={x}
              y={0}
              width={groupWidth}
              height={chartH}
              fill="transparent"
            />
            <rect
              x={x}
              y={chartH - (sales / max) * chartH}
              width={barWidth}
              height={(sales / max) * chartH}
              fill="#1f6b3e"
              rx={2}
            />
            <rect
              x={x + barWidth + barGap}
              y={chartH - (purchases / max) * chartH}
              width={barWidth}
              height={(purchases / max) * chartH}
              fill="#1e3a78"
              rx={2}
            />
            <rect
              x={x + (barWidth + barGap) * 2}
              y={chartH - (wholesale / max) * chartH}
              width={barWidth}
              height={(wholesale / max) * chartH}
              fill="#b08e4a"
              rx={2}
            />
            <text
              x={x + groupWidth / 2}
              y={chartH + 14}
              textAnchor="middle"
              fontSize={9}
              fill="#8a8a92"
            >
              {new Date(b.bucket_start).toLocaleDateString(undefined, {
                month: 'short',
              })}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
