'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, getAccessToken } from '@/lib/api-client';
import { MessageThread } from '@/components/message-thread';
import { useAppSettings } from '@/lib/use-app-settings';

interface Product {
  id: string;
  sku: string;
  name: string;
  metal: string;
}

interface DealRequest {
  id: string;
  type: 'buy' | 'sell';
  product_id: string | null;
  product_description: string | null;
  metal: string | null;
  quantity: number | null;
  notes: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'converted';
  response_message: string | null;
  created_at: string;
  responded_at: string | null;
}

export default function ClientRequests() {
  const qc = useQueryClient();
  const { data: appSettings } = useAppSettings();
  const brand = appSettings?.branding.company_name ?? 'us';
  const { data: products } = useQuery({
    queryKey: ['client', 'products'],
    queryFn: () => apiFetch<Product[]>('/public/products'),
  });
  const { data: requests } = useQuery({
    queryKey: ['client', 'deal-requests'],
    queryFn: () => apiFetch<DealRequest[]>('/client/deal-requests'),
  });

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold">Requests</h1>
      <p className="mt-1 text-sm text-ink-400">
        Submit a request to buy from or sell to {brand}. Attach photos for pre-evaluation.
      </p>

      <RequestForm
        products={products ?? []}
        onCreated={() => qc.invalidateQueries({ queryKey: ['client', 'deal-requests'] })}
      />

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">History</h2>
        <div className="mt-3 space-y-3">
          {(requests ?? []).map((r) => (
            <RequestRow key={r.id} req={r} products={products ?? []} />
          ))}
          {(!requests || requests.length === 0) && (
            <div className="rounded-xl border border-ink-200 bg-white p-8 text-center text-sm text-ink-400">
              No requests yet.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RequestForm({
  products,
  onCreated,
}: {
  products: Product[];
  onCreated: () => void;
}) {
  const [type, setType] = useState<'sell' | 'buy'>('sell');
  const [productId, setProductId] = useState('');
  const [customDesc, setCustomDesc] = useState('');
  const [qty, setQty] = useState('1');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRequestId, setCreatedRequestId] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!productId && !customDesc.trim()) {
      setError('Pick a product or describe it');
      return;
    }
    setSubmitting(true);
    try {
      const created = await apiFetch<{ id: string }>('/client/deal-requests', {
        method: 'POST',
        body: JSON.stringify({
          type,
          product_id: productId || undefined,
          product_description: !productId ? customDesc.trim() : undefined,
          quantity: qty ? Number(qty) : undefined,
          notes: notes || undefined,
        }),
      });
      setCreatedRequestId(created.id);
      setCustomDesc('');
      setNotes('');
      setQty('1');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (createdRequestId) {
    return (
      <div className="mt-6 rounded-xl border border-green-200 bg-green-50 p-5">
        <h3 className="text-sm font-semibold text-green-900">Request submitted</h3>
        <p className="mt-1 text-xs text-green-800">
          We'll respond shortly. Add photos below for pre-evaluation (up to 4, 5 MB each).
        </p>
        <PhotoUploader requestId={createdRequestId} />
        <button
          onClick={() => setCreatedRequestId(null)}
          className="mt-3 text-xs text-green-900 underline"
        >
          Submit another request
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
      <div className="mb-4 inline-flex rounded-md border border-ink-200 bg-ink-50 p-1">
        <button
          type="button"
          onClick={() => setType('sell')}
          className={`rounded px-3 py-1.5 text-sm ${
            type === 'sell' ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600'
          }`}
        >
          I want to sell
        </button>
        <button
          type="button"
          onClick={() => setType('buy')}
          className={`rounded px-3 py-1.5 text-sm ${
            type === 'buy' ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600'
          }`}
        >
          I want to buy
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-ink-800">Item (from catalog)</span>
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            className="input mt-1"
          >
            <option value="">— or describe below —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} · {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-800">Quantity</span>
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="input mt-1 font-mono"
          />
        </label>
      </div>

      <label className="mt-4 block">
        <span className="text-sm font-medium text-ink-800">Or describe the item</span>
        <input
          value={customDesc}
          onChange={(e) => setCustomDesc(e.target.value)}
          placeholder="e.g., 1960 Kennedy silver half, quantity ~20"
          className="input mt-1"
          disabled={Boolean(productId)}
          maxLength={500}
        />
      </label>

      <label className="mt-4 block">
        <span className="text-sm font-medium text-ink-800">Notes (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="input mt-1"
          maxLength={2000}
        />
      </label>

      {error && (
        <div role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {submitting ? 'Submitting…' : 'Submit request'}
        </button>
      </div>
    </form>
  );
}

function PhotoUploader({ requestId }: { requestId: string }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: photos } = useQuery({
    queryKey: ['deal-request', requestId, 'photos'],
    queryFn: () =>
      apiFetch<Array<{ id: string; url: string }>>(`/deal-requests/${requestId}/photos`),
  });

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    const token = getAccessToken();
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(`/api/v1/deal-requests/${requestId}/photos`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? `Upload failed (${res.status})`);
        }
      }
      qc.invalidateQueries({ queryKey: ['deal-request', requestId, 'photos'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-3">
        {(photos ?? []).map((p) => (
          <AuthImage key={p.id} url={p.url} />
        ))}
        {(photos?.length ?? 0) < 4 && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              id={`photo-${requestId}`}
              onChange={(e) => upload(e.target.files)}
            />
            <label
              htmlFor={`photo-${requestId}`}
              className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-md border border-dashed border-ink-300 bg-white text-xs text-ink-400 hover:border-ink-500 hover:text-ink-600"
            >
              {busy ? '…' : '+ add'}
            </label>
          </>
        )}
      </div>
      {error && (
        <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}
    </div>
  );
}

/**
 * Renders an auth-gated image by fetching it with a bearer token once,
 * then revoking the object URL on unmount.
 */
function AuthImage({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const token = getAccessToken();
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fetch failed'))))
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
      <div className="flex h-16 w-16 items-center justify-center rounded-md border border-ink-200 bg-ink-50 text-[10px] text-ink-400">
        ⚠
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src ?? undefined}
      alt=""
      className="h-16 w-16 rounded-md border border-ink-200 object-cover"
    />
  );
}

function RequestRow({ req, products }: { req: DealRequest; products: Product[] }) {
  const { data: appSettings } = useAppSettings();
  const brand = appSettings?.branding.company_name ?? 'Staff';
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
              {req.type}
            </span>
            <span className="text-xs text-ink-400">
              {new Date(req.created_at).toLocaleDateString()}
            </span>
          </div>
          <div className="mt-1 text-sm">
            <strong>{req.quantity ?? '—'}×</strong>{' '}
            {req.product_description ??
              products.find((p) => p.id === req.product_id)?.name ??
              '—'}
          </div>
          {req.notes && <p className="mt-1 text-xs text-ink-600">“{req.notes}”</p>}
          {req.response_message && (
            <div className="mt-2 rounded bg-ink-50 px-2 py-1 text-xs text-ink-700">
              <span className="font-medium">{brand}:</span> {req.response_message}
            </div>
          )}
        </div>
        <StatusBadge status={req.status} />
      </div>
      {req.status === 'pending' && <PhotoUploader requestId={req.id} />}
      <MessageThread requestId={req.id} viewerRole="client" />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700',
    accepted: 'bg-green-100 text-green-700',
    rejected: 'bg-red-100 text-red-700',
    expired: 'bg-ink-100 text-ink-600',
    converted: 'bg-blue-100 text-blue-700',
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
        styles[status] ?? 'bg-ink-100 text-ink-600'
      }`}
    >
      {status}
    </span>
  );
}
