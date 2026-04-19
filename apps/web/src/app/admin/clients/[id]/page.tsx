'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { StatusPill } from '@/components/status-pill';

interface Client {
  id: string;
  first_name: string | null;
  last_name: string | null;
  /** Organization name (migration 020). Primary identity for wholesale. */
  company: string | null;
  email: string | null;
  /** Additional emails on file (migration 020). */
  secondary_emails: string[] | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  is_portal_enabled: boolean;
  user_id: string | null;
  notes: string | null;
  heard_from: string | null;
  client_type: 'retail' | 'wholesaler';
  created_at: string;
}

interface AppointmentBooking {
  id: string;
  google_event_id: string;
  service: string | null;
  starts_at: string;
  ends_at: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: string;
  source: string;
}

interface Timeline {
  invoices: Array<{
    id: string;
    invoice_number: string;
    type: 'buy' | 'sell';
    status: string;
    total: string;
    created_at: string;
  }>;
  quotes: Array<{
    id: string;
    side: 'buy' | 'sell';
    quantity: number;
    unit_price: string;
    line_total: string;
    expires_at: string;
    converted_invoice_id: string | null;
    created_at: string;
    product_name: string;
  }>;
  requests: Array<{
    id: string;
    type: 'buy' | 'sell';
    product_description: string | null;
    quantity: number | null;
    notes: string | null;
    status: string;
    created_at: string;
  }>;
  shipments: Array<{
    id: string;
    carrier: string;
    tracking_number: string | null;
    status: string;
    created_at: string;
    invoice_number: string;
  }>;
}

export default function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();

  const { data: client } = useQuery({
    queryKey: ['admin', 'client', id],
    queryFn: () => apiFetch<Client>(`/admin/clients/${id}`),
  });
  const { data: timeline } = useQuery({
    queryKey: ['admin', 'client', id, 'timeline'],
    queryFn: () => apiFetch<Timeline>(`/admin/clients/${id}/timeline`),
  });
  // Calendar bookings linked to this client (CAL-001).
  const { data: appointments } = useQuery({
    queryKey: ['admin', 'client', id, 'appointments'],
    queryFn: () =>
      apiFetch<AppointmentBooking[]>(`/admin/clients/${id}/appointments`),
  });

  const [portalResult, setPortalResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enablePortal() {
    setError(null);
    setBusy(true);
    try {
      const r = await apiFetch<{ temp_password: string }>(
        `/admin/clients/${id}/enable-portal`,
        { method: 'POST' },
      );
      setPortalResult(r.temp_password);
      await qc.invalidateQueries({ queryKey: ['admin', 'client', id] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }
  async function disablePortal() {
    if (!confirm('Disable portal access for this client?')) return;
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/admin/clients/${id}/disable-portal`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['admin', 'client', id] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }
  async function resetPassword() {
    setError(null);
    setBusy(true);
    try {
      const r = await apiFetch<{ temp_password: string }>(
        `/admin/clients/${id}/reset-password`,
        { method: 'POST' },
      );
      setPortalResult(r.temp_password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  if (!client) return <div className="text-sm text-ink-400">Loading…</div>;

  const address = [
    client.address_line1,
    client.address_line2,
    [client.city, client.region, client.postal_code].filter(Boolean).join(', '),
    client.country,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4">
        <Link href="/admin/clients" className="text-sm text-ink-600 hover:text-ink-900">
          ← All clients
        </Link>
      </div>

      <header className="flex flex-col items-start justify-between gap-3 md:flex-row">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">
              {[client.first_name, client.last_name].filter(Boolean).join(' ') ||
                client.company ||
                '(unnamed)'}
            </h1>
            {client.client_type === 'wholesaler' && (
              <span className="rounded-full bg-gold-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold-600">
                Wholesale
              </span>
            )}
          </div>
          {client.company &&
            (client.first_name || client.last_name) && (
              <p className="mt-0.5 text-sm text-ink-600">{client.company}</p>
            )}
          <p className="mt-1 text-sm text-ink-400">
            {client.email ?? 'no email'}
            {client.phone ? ` · ${client.phone}` : ''}
          </p>
          {client.secondary_emails && client.secondary_emails.length > 0 && (
            <p className="mt-0.5 text-xs text-ink-500">
              Also:{' '}
              {client.secondary_emails.join(', ')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push(`/admin/clients/${id}/edit`)}
            className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
          >
            Edit
          </button>
          <button
            onClick={() =>
              router.push(
                `/admin/invoices/new?client_id=${client.id}`,
              )
            }
            className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-ink-800"
          >
            New invoice
          </button>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-ink-200 bg-white p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Contact
          </h3>
          <p className="mt-2 whitespace-pre-line text-sm text-ink-800">
            {address || <span className="text-ink-400">No address</span>}
          </p>
        </div>

        <div className="rounded-xl border border-ink-200 bg-white p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Portal access
          </h3>
          <div className="mt-2 text-sm">
            {client.user_id ? (
              <>
                <div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      client.is_portal_enabled
                        ? 'bg-green-100 text-green-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {client.is_portal_enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {client.is_portal_enabled && (
                    <>
                      <button
                        onClick={resetPassword}
                        disabled={busy}
                        className="rounded-md border border-ink-200 px-2 py-1 text-xs hover:bg-ink-50"
                      >
                        Reset password
                      </button>
                      <button
                        onClick={disablePortal}
                        disabled={busy}
                        className="rounded-md border border-ink-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                      >
                        Disable access
                      </button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="text-ink-400">Walk-in client.</p>
                <button
                  onClick={enablePortal}
                  disabled={busy || !client.email}
                  className="mt-2 rounded-md bg-ink-900 px-2 py-1 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-60"
                >
                  {!client.email ? 'Needs email first' : 'Enable portal'}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-ink-200 bg-white p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            How they heard about us
          </h3>
          <p className="mt-2 text-sm text-ink-800">
            {client.heard_from ?? <span className="text-ink-400">—</span>}
          </p>
        </div>

        <div className="rounded-xl border border-ink-200 bg-white p-4 md:col-span-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Notes
          </h3>
          <p className="mt-2 whitespace-pre-wrap text-sm text-ink-800">
            {client.notes ?? <span className="text-ink-400">—</span>}
          </p>
        </div>
      </section>

      {portalResult && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Share this one-time password with the client:</p>
          <p className="mt-2 font-mono text-base">{portalResult}</p>
          <p className="mt-2 text-xs">
            This will not be shown again. They should change it after signing in.
          </p>
          <button
            onClick={() => setPortalResult(null)}
            className="mt-3 text-xs underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Timeline */}
      <section className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
        <TimelineBlock
          title="Invoices"
          empty="No invoices yet"
          count={timeline?.invoices.length}
        >
          {(timeline?.invoices ?? []).map((inv) => (
            <Link
              key={inv.id}
              href={`/admin/invoices/${inv.id}`}
              className="flex items-center justify-between py-2 text-sm hover:bg-ink-50"
            >
              <span className="font-mono">{inv.invoice_number}</span>
              <StatusPill status={inv.status} />
              <span className="font-mono text-ink-600">
                ${Number(inv.total).toFixed(2)}
              </span>
              <span className="text-xs text-ink-400">
                {new Date(inv.created_at).toLocaleDateString()}
              </span>
            </Link>
          ))}
        </TimelineBlock>

        <TimelineBlock
          title="Quotes"
          empty="No locked quotes"
          count={timeline?.quotes.length}
        >
          {(timeline?.quotes ?? []).map((q) => (
            <div key={q.id} className="flex items-center justify-between py-2 text-sm">
              <span className="truncate">{q.product_name}</span>
              <span className="uppercase text-ink-600">{q.side}</span>
              <span className="font-mono">{q.quantity}×</span>
              <span className="font-mono text-ink-600">
                ${Number(q.line_total).toFixed(2)}
              </span>
            </div>
          ))}
        </TimelineBlock>

        <TimelineBlock
          title="Deal requests"
          empty="No requests"
          count={timeline?.requests.length}
        >
          {(timeline?.requests ?? []).map((r) => (
            <div key={r.id} className="py-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="uppercase text-ink-600">{r.type}</span>
                <span className="text-xs text-ink-400">
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
              </div>
              <div className="text-xs text-ink-600">
                {r.quantity ?? '?'}× {r.product_description ?? 'catalog item'}
              </div>
            </div>
          ))}
        </TimelineBlock>

        <TimelineBlock
          title="Shipments"
          empty="No shipments"
          count={timeline?.shipments.length}
        >
          {(timeline?.shipments ?? []).map((s) => (
            <div key={s.id} className="flex items-center justify-between py-2 text-sm">
              <span className="font-mono">{s.invoice_number}</span>
              <span className="uppercase">{s.carrier}</span>
              <span className="font-mono text-xs text-ink-600">
                {s.tracking_number ?? '—'}
              </span>
              <span className="text-xs text-ink-400">
                {s.status.replace('_', ' ')}
              </span>
            </div>
          ))}
        </TimelineBlock>

        {/* Appointments (CAL-001). Pulled from the `calendar_bookings`
            mirror — the booking submitted to /book (or admin-linked from
            the pending tray) appears here regardless of whether it later
            produced an invoice. */}
        <TimelineBlock
          title="Appointments"
          empty="No appointments linked"
          count={appointments?.length}
        >
          {(appointments ?? []).map((a) => (
            <div key={a.id} className="py-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {a.service ?? '(untitled)'}
                </span>
                <span className="text-xs text-ink-400">
                  {formatLocalDateTime(a.starts_at)}
                </span>
              </div>
              {a.notes && (
                <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-ink-500">
                  {a.notes}
                </div>
              )}
              <div className="mt-0.5 flex items-center gap-2 text-[11px] uppercase text-ink-400">
                <span>{a.status}</span>
                <span>·</span>
                <span>{a.source.replace('_', ' ')}</span>
              </div>
            </div>
          ))}
        </TimelineBlock>
      </section>
    </div>
  );
}

function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

function TimelineBlock({
  title,
  empty,
  count,
  children,
}: {
  title: string;
  empty: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          {title}
        </h3>
        <span className="text-xs text-ink-400">{count ?? 0}</span>
      </div>
      <div className="mt-2 divide-y divide-ink-100">
        {count ? children : <p className="py-4 text-center text-xs text-ink-400">{empty}</p>}
      </div>
    </div>
  );
}
