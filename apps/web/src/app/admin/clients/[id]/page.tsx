'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, getAccessToken } from '@/lib/api-client';
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

/**
 * One audit_logs row written by the GReminders webhook receiver.
 * `change_type` is the bit after the `greminders_booking.` prefix on
 * the action name — typically `created`, `updated`, `canceled`,
 * `confirmed`, or `declined` (whatever GReminders emits).
 */
interface GremindersEntry {
  id: string;
  change_type: string;
  at: string;
  greminders_event_id: string | null;
  service: string | null;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  attendee_email: string | null;
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
  // GReminders activity — audit_logs entries for reminder / confirmation
  // SMSes that GReminders fired for this client. Populated by the public
  // webhook receiver (apps/api/src/integrations/greminders-webhook...).
  const { data: greminders } = useQuery({
    queryKey: ['admin', 'client', id, 'greminders'],
    queryFn: () =>
      apiFetch<GremindersEntry[]>(`/admin/clients/${id}/greminders-activity`),
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
                <p className="text-ink-400">Retail client.</p>
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

        {/* Reminder / confirmation activity from GReminders. One row per
            webhook event — most useful for answering "did they confirm?"
            right before an appointment without opening the GReminders
            dashboard. Hidden entirely when there's no activity yet so
            the timeline doesn't show an empty card for clients who
            predate the integration. */}
        {(greminders?.length ?? 0) > 0 && (
          <TimelineBlock
            title="Reminders &amp; confirmations"
            empty="No GReminders activity"
            count={greminders?.length}
          >
            {(greminders ?? []).map((g) => (
              <div key={g.id} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {g.service ?? 'Appointment'}
                  </span>
                  <GremindersStatusChip changeType={g.change_type} />
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-500">
                  {g.start_time && (
                    <span>{formatLocalDateTime(g.start_time)}</span>
                  )}
                  <span className="text-ink-400">·</span>
                  <span>Logged {formatLocalDateTime(g.at)}</span>
                </div>
              </div>
            ))}
          </TimelineBlock>
        )}
      </section>

      {/* Attachments — driver's license, passport, other ID/KYC docs.
          Lives on the client record and is admin/staff-only. */}
      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">
          Files &amp; ID documents
        </h2>
        <ClientAttachmentsPanel clientId={id} />
      </section>
    </div>
  );
}

interface AttachmentMeta {
  id: string;
  client_id: string;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
  uploaded_by_user_id: string | null;
  ocr_status: 'pending' | 'succeeded' | 'failed' | null;
  ocr_fields: unknown;
  created_at: string;
}

const ATTACHMENT_KINDS: Array<{ id: string; label: string }> = [
  { id: 'drivers_license', label: "Driver's license" },
  { id: 'passport', label: 'Passport' },
  { id: 'id_other', label: 'Other ID' },
  { id: 'receipt', label: 'Receipt' },
  { id: 'contract', label: 'Contract' },
  { id: 'photo', label: 'Photo' },
  { id: 'other', label: 'Other' },
];

function ClientAttachmentsPanel({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const { data: files, isLoading } = useQuery({
    queryKey: ['admin', 'client', clientId, 'attachments'],
    queryFn: () =>
      apiFetch<AttachmentMeta[]>(`/admin/clients/${clientId}/attachments`),
  });
  const [kind, setKind] = useState<string>('drivers_license');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function uploadOne(file: File) {
    setErr(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiFetch(
        `/admin/clients/${clientId}/attachments?kind=${encodeURIComponent(kind)}`,
        {
          method: 'POST',
          body: fd,
        },
      );
      await qc.invalidateQueries({
        queryKey: ['admin', 'client', clientId, 'attachments'],
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(att: AttachmentMeta) {
    if (!confirm(`Delete "${att.filename}"? This cannot be undone.`)) return;
    try {
      await apiFetch(`/admin/client-attachments/${att.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({
        queryKey: ['admin', 'client', clientId, 'attachments'],
      });
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Delete failed');
    }
  }

  return (
    <div className="mt-3 space-y-4">
      {/* Uploader */}
      <div className="rounded-xl border border-ink-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Document type
            </span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="input mt-1 md:w-52"
            >
              {ATTACHMENT_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="file"
              multiple
              className="hidden"
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                for (const f of files) {
                  await uploadOne(f);
                }
              }}
            />
            <span
              className={`rounded-md border border-dashed border-ink-300 bg-white px-3 py-1.5 text-sm font-medium ${
                busy ? 'opacity-60' : 'hover:bg-ink-50'
              }`}
            >
              {busy ? 'Uploading…' : '+ Upload file'}
            </span>
          </label>
          <span className="text-xs text-ink-400">15 MB max per file.</span>
        </div>
        {err && (
          <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-1.5 text-xs text-red-700">
            {err}
          </p>
        )}
      </div>

      {/* File list */}
      {isLoading ? (
        <p className="text-sm text-ink-400">Loading…</p>
      ) : (files ?? []).length === 0 ? (
        <p className="text-sm text-ink-500">
          No files yet. Upload a driver&apos;s license or other ID doc above.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {(files ?? []).map((f) => (
            <AttachmentCard
              key={f.id}
              attachment={f}
              clientId={clientId}
              onDelete={remove}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface OcrFields {
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  suffix?: string;
  address_line1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  date_of_birth?: string;
  expiration_date?: string;
  issue_date?: string;
  document_number?: string;
  min_confidence?: number;
}

function AttachmentCard({
  attachment,
  clientId,
  onDelete,
}: {
  attachment: AttachmentMeta;
  clientId: string;
  onDelete: (att: AttachmentMeta) => void;
}) {
  const qc = useQueryClient();
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const isImage = attachment.mime.startsWith('image/');
  const kindLabel =
    ATTACHMENT_KINDS.find((k) => k.id === attachment.kind)?.label ??
    attachment.kind;

  async function openFile() {
    const token = getAccessToken();
    const res = await fetch(
      `/api/v1/admin/client-attachments/${attachment.id}/file`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (isImage) {
      setPreviewSrc(url);
    } else {
      window.open(url, '_blank');
    }
  }

  // OCR status badge. 'succeeded' also unlocks the Fill-from-ID
  // button; 'failed' stays visible so operators know the attempt
  // happened and can re-upload if needed.
  const ocrBadge =
    attachment.ocr_status === 'succeeded'
      ? { text: 'OCR ✓', cls: 'bg-green-50 text-green-700' }
      : attachment.ocr_status === 'failed'
        ? { text: 'OCR failed', cls: 'bg-red-50 text-red-700' }
        : attachment.ocr_status === 'pending'
          ? { text: 'OCR…', cls: 'bg-ink-100 text-ink-600' }
          : null;

  return (
    <li className="rounded-xl border border-ink-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
              {kindLabel}
            </span>
            {ocrBadge && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${ocrBadge.cls}`}
              >
                {ocrBadge.text}
              </span>
            )}
          </div>
          <button
            onClick={openFile}
            className="mt-0.5 block truncate text-sm font-medium text-ink-900 hover:underline"
            title="Open"
          >
            {isImage ? '📷' : '📎'} {attachment.filename}
          </button>
          <div className="mt-0.5 text-[11px] text-ink-400">
            {(attachment.size_bytes / 1024).toFixed(0)} KB ·{' '}
            {new Date(attachment.created_at).toLocaleDateString()}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {attachment.ocr_status === 'succeeded' && (
            <button
              onClick={() => setApplyOpen(true)}
              className="rounded-md border border-gold-500 bg-gold-500/10 px-2 py-0.5 text-xs font-medium text-gold-700 hover:bg-gold-500/20"
              title="Pre-fill this client's record with fields extracted from the ID"
            >
              Fill from ID
            </button>
          )}
          <button
            onClick={() => onDelete(attachment)}
            aria-label="Delete attachment"
            className="rounded-md border border-red-200 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
          >
            Delete
          </button>
        </div>
      </div>
      {previewSrc && (
        <div className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewSrc}
            alt={attachment.filename}
            className="max-h-64 w-full rounded-md border border-ink-200 object-contain"
          />
        </div>
      )}
      {applyOpen && (
        <ApplyFromIdPanel
          attachmentId={attachment.id}
          clientId={clientId}
          onClose={() => setApplyOpen(false)}
          onApplied={async () => {
            await qc.invalidateQueries({ queryKey: ['admin', 'client', clientId] });
            setApplyOpen(false);
          }}
        />
      )}
    </li>
  );
}

/**
 * Panel: fetches OCR fields, previews each, lets the operator check
 * which fields to apply, then PATCHes the client record. Intentional
 * opt-in per field — Textract confidence is usually high but operators
 * should see what's being written.
 */
function ApplyFromIdPanel({
  attachmentId,
  clientId,
  onClose,
  onApplied,
}: {
  attachmentId: string;
  clientId: string;
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}) {
  const { data } = useQuery({
    queryKey: ['admin', 'client-attachment', attachmentId, 'ocr'],
    queryFn: () =>
      apiFetch<{ status: string | null; fields: OcrFields | null; text: string | null }>(
        `/admin/client-attachments/${attachmentId}/ocr`,
      ),
    staleTime: 30_000,
  });

  // Pull the current client row so we can compare "current → new" and
  // default each checkbox sensibly: empty fields auto-check (safe
  // fill), existing values auto-uncheck (overwrite requires explicit
  // opt-in). Staff seats aren't restricted here — the outer Fill
  // button only renders when the attachment OCR succeeded.
  const { data: client } = useQuery({
    queryKey: ['admin', 'client', clientId],
    queryFn: () => apiFetch<Client>(`/admin/clients/${clientId}`),
  });

  const [picks, setPicks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fields = data?.fields ?? {};
  // Candidate list — only fields that have an extracted value AND map
  // to a column on the clients table. date_of_birth etc. are
  // extracted for audit but we don't store them on the client row.
  const candidates: Array<{
    key: keyof OcrFields;
    label: string;
    patchKey: keyof Client;
  }> = (
    [
      { key: 'first_name', label: 'First name', patchKey: 'first_name' },
      { key: 'last_name', label: 'Last name', patchKey: 'last_name' },
      { key: 'address_line1', label: 'Address', patchKey: 'address_line1' },
      { key: 'city', label: 'City', patchKey: 'city' },
      { key: 'state', label: 'State', patchKey: 'region' },
      { key: 'postal_code', label: 'Postal code', patchKey: 'postal_code' },
    ] as const
  ).filter((c) => {
    const v = fields[c.key];
    return typeof v === 'string' && v.length > 0;
  }) as Array<{ key: keyof OcrFields; label: string; patchKey: keyof Client }>;

  // `picks[key]` semantics:
  //   undefined → use the default rule for this field (checked iff
  //               current value is empty)
  //   true/false → operator explicitly toggled it
  function isChecked(c: { key: keyof OcrFields; patchKey: keyof Client }): boolean {
    if (picks[c.key] !== undefined) return picks[c.key];
    const currentVal = client
      ? (client[c.patchKey] as string | null | undefined)
      : undefined;
    const currentIsEmpty = !currentVal || String(currentVal).trim().length === 0;
    return currentIsEmpty; // default-check only when empty
  }

  async function apply() {
    setErr(null);
    setBusy(true);
    try {
      const patch: Record<string, string> = {};
      for (const c of candidates) {
        if (isChecked(c)) {
          patch[c.patchKey as string] = String(fields[c.key]);
        }
      }
      if (Object.keys(patch).length === 0) {
        setErr('Nothing selected. Tick a field to fill or overwrite.');
        setBusy(false);
        return;
      }
      await apiFetch(`/admin/clients/${clientId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await onApplied();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Apply failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-gold-500/40 bg-gold-500/5 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-gold-700">
          Fill from ID · preview
        </span>
        <button
          onClick={onClose}
          className="text-xs text-ink-500 hover:text-ink-900"
        >
          Close
        </button>
      </div>
      {!data ? (
        <p className="mt-2 text-xs text-ink-500">Loading OCR fields…</p>
      ) : candidates.length === 0 ? (
        <p className="mt-2 text-xs text-ink-500">
          No applicable fields were extracted.
        </p>
      ) : (
        <>
          <p className="mt-1 text-[11px] text-ink-500">
            Fields with existing values are unchecked by default —
            tick them to overwrite.
          </p>
          <ul className="mt-2 space-y-2 text-xs">
            {candidates.map((c) => {
              const currentVal = client
                ? (client[c.patchKey] as string | null | undefined)
                : undefined;
              const currentIsEmpty =
                !currentVal || String(currentVal).trim().length === 0;
              const newVal = String(fields[c.key]);
              const checked = isChecked(c);
              const willOverwrite = !currentIsEmpty && newVal !== currentVal;
              const identical = !currentIsEmpty && newVal === currentVal;
              return (
                <li
                  key={c.key}
                  className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${
                    willOverwrite && checked
                      ? 'bg-red-50'
                      : currentIsEmpty && checked
                        ? 'bg-green-50'
                        : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    id={`ocr-${c.key}`}
                    className="mt-0.5"
                    checked={checked}
                    disabled={identical}
                    onChange={(e) =>
                      setPicks((p) => ({ ...p, [c.key]: e.target.checked }))
                    }
                  />
                  <label
                    htmlFor={`ocr-${c.key}`}
                    className="flex-1 cursor-pointer"
                  >
                    <div className="font-semibold text-ink-700">{c.label}</div>
                    {identical ? (
                      <div className="text-ink-500">
                        Matches current value: {newVal}
                      </div>
                    ) : currentIsEmpty ? (
                      <div>
                        <span className="text-ink-400 italic">currently empty</span>
                        <span className="mx-1 text-ink-400">→</span>
                        <span className="font-mono text-green-800">{newVal}</span>
                      </div>
                    ) : (
                      <div>
                        <span className="font-mono text-ink-700 line-through">
                          {currentVal}
                        </span>
                        <span className="mx-1 text-ink-400">→</span>
                        <span className="font-mono text-red-800">{newVal}</span>
                        {checked && (
                          <span className="ml-2 rounded-full bg-red-200 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-red-800">
                            will overwrite
                          </span>
                        )}
                      </div>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          {fields.min_confidence !== undefined && (
            <p className="mt-2 text-[10px] text-ink-500">
              Textract confidence: {fields.min_confidence.toFixed(1)}% (lowest
              field). Double-check any values with unusual characters.
            </p>
          )}
          {err && (
            <p role="alert" className="mt-2 rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
              {err}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-1">
            <button
              onClick={onClose}
              className="rounded-md border border-ink-200 px-2 py-0.5 text-xs hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={busy}
              className="rounded-md bg-gold-600 px-3 py-0.5 text-xs font-medium text-white hover:bg-gold-700 disabled:opacity-60"
            >
              {busy ? 'Applying…' : 'Apply to client'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Small colored pill summarizing a single GReminders webhook event.
 * Maps the `change_type` to one of four visual buckets:
 *   confirmed    → green  (client replied YES to the reminder SMS)
 *   declined     → red    (client replied NO — consider rescheduling)
 *   canceled     → red    (booking nuked on GReminders' side)
 *   updated      → amber  (rescheduled / rescoped — operator should look)
 *   created / other → ink (neutral "booking landed" marker)
 * The GReminders API doesn't fix the exact change_type names in its
 * public docs, so this is deliberately a switch with a fallback —
 * any unexpected value renders in the neutral style without breaking.
 */
function GremindersStatusChip({ changeType }: { changeType: string }) {
  const ct = (changeType ?? '').toLowerCase();
  let cls = 'bg-ink-100 text-ink-700';
  let label = ct || 'updated';
  if (ct.includes('confirm')) {
    cls = 'bg-green-100 text-green-700';
    label = 'Confirmed';
  } else if (ct.includes('decline')) {
    cls = 'bg-red-100 text-red-700';
    label = 'Declined';
  } else if (ct.includes('cancel')) {
    cls = 'bg-red-100 text-red-700';
    label = 'Canceled';
  } else if (ct.includes('update') || ct.includes('reschedul')) {
    cls = 'bg-amber-100 text-amber-700';
    label = 'Rescheduled';
  } else if (ct.includes('create') || ct.includes('book')) {
    cls = 'bg-ink-100 text-ink-700';
    label = 'Booked';
  }
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${cls}`}
      title={`GReminders · ${ct}`}
    >
      {label}
    </span>
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
