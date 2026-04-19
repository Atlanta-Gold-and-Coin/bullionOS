'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { ShipmentStatusBadge } from '@/components/status-pill';

interface AdminShipment {
  id: string;
  invoice_id: string;
  invoice_number: string;
  client_name: string;
  carrier: 'ups' | 'fedex' | 'usps' | 'other';
  tracking_number: string | null;
  /** Carrier-specific service level (migration 021, ticket SHIP-001). */
  delivery_speed: string | null;
  tracking_url: string | null;
  status: string;
  shipped_at: string | null;
  delivered_at: string | null;
}

type Carrier = AdminShipment['carrier'];

const STATUS_OPTIONS = [
  { value: 'label_created', label: 'Label created' },
  { value: 'in_transit', label: 'In transit' },
  { value: 'out_for_delivery', label: 'Out for delivery' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'exception', label: 'Exception' },
  { value: 'returned', label: 'Returned' },
] as const;

export default function AdminShipmentsPage() {
  const { data } = useQuery({
    queryKey: ['admin', 'shipments'],
    queryFn: () => apiFetch<AdminShipment[]>('/admin/shipments'),
    refetchInterval: 30_000,
  });

  // Delivery-speed whitelist — single fetch, shared across rows (SHIP-001).
  const { data: speeds } = useQuery({
    queryKey: ['admin', 'shipments', 'delivery-speeds'],
    queryFn: () =>
      apiFetch<Record<Carrier, string[]>>('/admin/shipments/delivery-speeds'),
    staleTime: Infinity,
  });

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-semibold">Shipments</h1>
      <p className="mt-1 text-sm text-ink-400">
        Shipments are created from the invoice detail page.
      </p>

      {/* MOB-002: wide table scrolls horizontally on narrow viewports
          instead of clipping. min-w keeps columns legible. */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full min-w-[780px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Invoice</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Carrier</th>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3">Tracking</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((s) => (
              <ShipmentRow key={s.id} s={s} speeds={speeds ?? null} />
            ))}
            {(!data || data.length === 0) && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-ink-400">
                  No shipments yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ShipmentRow({
  s,
  speeds,
}: {
  s: AdminShipment;
  speeds: Record<Carrier, string[]> | null;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [tracking, setTracking] = useState(s.tracking_number ?? '');
  const [deliverySpeed, setDeliverySpeed] = useState(s.delivery_speed ?? '');
  const [status, setStatus] = useState(s.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const carrierSpeeds = speeds?.[s.carrier] ?? [];
  // If the saved speed isn't in the current whitelist (e.g. the whitelist
  // changed after the row was created), still render it in the dropdown
  // so the operator sees what's stored rather than an empty-looking row.
  const dropdownSpeeds =
    deliverySpeed && !carrierSpeeds.includes(deliverySpeed)
      ? [deliverySpeed, ...carrierSpeeds]
      : carrierSpeeds;

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {
        tracking_number: tracking || undefined,
        status: status !== s.status ? status : undefined,
      };
      // Only send delivery_speed when it actually changed — sending the
      // same value is a no-op server-side but costs a round-trip on the
      // validator. Empty string means "clear it".
      if ((s.delivery_speed ?? '') !== deliverySpeed) {
        patch.delivery_speed = deliverySpeed || undefined;
      }
      await apiFetch(`/admin/shipments/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'shipments'] });
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-t border-ink-200 align-top">
      <td className="px-4 py-3 font-mono">
        <Link href={`/admin/invoices/${s.invoice_id}`} className="hover:underline">
          {s.invoice_number}
        </Link>
      </td>
      <td className="px-4 py-3">{s.client_name}</td>
      <td className="px-4 py-3 uppercase">{s.carrier}</td>
      <td className="px-4 py-3 text-xs">
        {editing ? (
          <select
            value={deliverySpeed}
            onChange={(e) => setDeliverySpeed(e.target.value)}
            disabled={carrierSpeeds.length === 0}
            className="input w-44 text-xs"
          >
            <option value="">
              {carrierSpeeds.length === 0 ? '— n/a —' : '— service —'}
            </option>
            {dropdownSpeeds.map((speed) => (
              <option key={speed} value={speed}>
                {speed}
              </option>
            ))}
          </select>
        ) : s.delivery_speed ? (
          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-700">
            {s.delivery_speed}
          </span>
        ) : (
          <span className="text-ink-400">—</span>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs">
        {editing ? (
          <input
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            className="input w-40 font-mono text-xs"
            placeholder="1Z..."
          />
        ) : s.tracking_url ? (
          <a
            href={s.tracking_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink-900 underline-offset-2 hover:underline"
          >
            {s.tracking_number ?? '—'}
          </a>
        ) : (
          s.tracking_number ?? <span className="text-ink-400">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        {editing ? (
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="input text-xs"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <ShipmentStatusBadge status={s.status} />
        )}
        {error && <div className="mt-1 text-xs text-red-700">{error}</div>}
      </td>
      <td className="px-4 py-3 text-right">
        {editing ? (
          <div className="flex justify-end gap-1">
            <button
              onClick={() => setEditing(false)}
              className="rounded-md border border-ink-200 px-2 py-1 text-xs"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="rounded-md bg-ink-900 px-2 py-1 text-xs text-white"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="rounded-md border border-ink-200 px-2 py-1 text-xs hover:bg-ink-50"
          >
            Edit
          </button>
        )}
      </td>
    </tr>
  );
}
