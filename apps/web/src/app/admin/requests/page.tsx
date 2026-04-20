'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, getAccessToken } from '@/lib/api-client';
import { MessageThread } from '@/components/message-thread';

interface AdminDealRequest {
  id: string;
  type: 'buy' | 'sell';
  client_name: string;
  client_email: string | null;
  product_id: string | null;
  product_name: string | null;
  product_sku: string | null;
  product_description: string | null;
  metal: string | null;
  quantity: number | null;
  estimated_weight_troy_oz: string | null;
  notes: string | null;
  status: string;
  response_message: string | null;
  created_at: string;
  responded_at: string | null;
}

const TABS = ['pending', 'accepted', 'rejected', 'all'] as const;

export default function AdminRequestsPage() {
  const searchParams = useSearchParams();
  // Deep-link support: `/admin/requests/[id]` redirects here with
  //   ?status=<status>#req-<id>
  // so we open the right tab and can scroll/highlight the target card.
  // Fall back to 'pending' for fresh nav.
  const initialStatus = (searchParams.get('status') as (typeof TABS)[number] | null) ?? 'pending';
  const [tab, setTab] = useState<(typeof TABS)[number]>(
    TABS.includes(initialStatus as (typeof TABS)[number])
      ? (initialStatus as (typeof TABS)[number])
      : 'pending',
  );
  const { data } = useQuery({
    queryKey: ['admin', 'deal-requests', tab],
    queryFn: () =>
      apiFetch<AdminDealRequest[]>(
        `/admin/deal-requests${tab === 'all' ? '' : `?status=${tab}`}`,
      ),
    refetchInterval: 30_000,
  });

  // After the list renders, if the URL has #req-<id>, scroll to that
  // card and flash it briefly so the operator sees which one was the
  // notification target.
  useEffect(() => {
    if (!data) return;
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    if (!hash.startsWith('#req-')) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('ring-2', 'ring-amber-400');
    const t = setTimeout(() => el.classList.remove('ring-2', 'ring-amber-400'), 2000);
    return () => clearTimeout(t);
  }, [data]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Deal requests</h1>
      <p className="mt-1 text-sm text-ink-400">Client submissions awaiting a response.</p>

      <div className="mt-4 inline-flex rounded-md border border-ink-200 bg-white p-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 text-sm capitalize ${
              tab === t ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {(data ?? []).map((r) => (
          <RequestCard key={r.id} req={r} />
        ))}
        {(!data || data.length === 0) && (
          <div className="rounded-xl border border-ink-200 bg-white p-8 text-center text-sm text-ink-400">
            No {tab} requests.
          </div>
        )}
      </div>
    </div>
  );
}

function PhotoGallery({ requestId }: { requestId: string }) {
  const { data } = useQuery({
    queryKey: ['admin', 'deal-request', requestId, 'photos'],
    queryFn: () =>
      apiFetch<Array<{ id: string; url: string }>>(`/deal-requests/${requestId}/photos`),
  });
  if (!data || data.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {data.map((p) => (
        <AuthImage key={p.id} url={p.url} />
      ))}
    </div>
  );
}

function AuthImage({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const token = getAccessToken();
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('failed'))))
      .then((b) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  if (failed) {
    return (
      <div className="flex h-20 w-20 items-center justify-center rounded-md border border-ink-200 bg-ink-50 text-[10px] text-ink-400">
        ⚠
      </div>
    );
  }
  return (
    <a href={src ?? '#'} target="_blank" rel="noopener noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src ?? undefined}
        alt=""
        className="h-20 w-20 rounded-md border border-ink-200 object-cover transition hover:opacity-80"
      />
    </a>
  );
}

function RequestCard({ req }: { req: AdminDealRequest }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<null | 'accepted' | 'rejected'>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(decision: 'accepted' | 'rejected') {
    setError(null);
    setBusy(decision);
    try {
      await apiFetch(`/admin/deal-requests/${req.id}/respond`, {
        method: 'PATCH',
        body: JSON.stringify({ decision, message: message || undefined }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'deal-requests'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy(null);
    }
  }

  const isPending = req.status === 'pending';

  return (
    // id enables deep-link scroll-to from notifications
    // (see /admin/requests/[id] redirect + list useEffect).
    <div id={`req-${req.id}`} className="scroll-mt-4 rounded-xl border border-ink-200 bg-white p-5 transition">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              {req.type}
            </span>
            <span className="text-sm font-medium">{req.client_name}</span>
            {req.client_email && (
              <span className="text-xs text-ink-400">· {req.client_email}</span>
            )}
          </div>
          <div className="mt-1 text-sm">
            <strong>{req.quantity ?? '—'}×</strong>{' '}
            {req.product_name ?? req.product_description}
            {req.product_sku && (
              <span className="ml-2 font-mono text-xs text-ink-400">({req.product_sku})</span>
            )}
          </div>
          {req.notes && <p className="mt-1 text-xs text-ink-600">“{req.notes}”</p>}
          <p className="mt-1 text-[11px] text-ink-400">
            submitted {new Date(req.created_at).toLocaleString()}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            req.status === 'pending'
              ? 'bg-amber-100 text-amber-700'
              : req.status === 'accepted'
                ? 'bg-green-100 text-green-700'
                : 'bg-red-100 text-red-700'
          }`}
        >
          {req.status}
        </span>
      </div>

      <PhotoGallery requestId={req.id} />
      <MessageThread requestId={req.id} viewerRole="admin" />

      {!isPending && req.response_message && (
        <div className="mt-3 rounded-md bg-ink-50 p-3 text-xs text-ink-700">
          <span className="font-medium">Our response:</span> {req.response_message}
        </div>
      )}

      {isPending && (
        <div className="mt-4 border-t border-ink-200 pt-4">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            placeholder="Optional message to client"
            className="input"
          />
          {error && (
            <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => respond('rejected')}
              disabled={busy !== null}
              className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-red-50 hover:text-red-700 disabled:opacity-60"
            >
              {busy === 'rejected' ? 'Rejecting…' : 'Reject'}
            </button>
            <button
              onClick={() => respond('accepted')}
              disabled={busy !== null}
              className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
            >
              {busy === 'accepted' ? 'Accepting…' : 'Accept'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
