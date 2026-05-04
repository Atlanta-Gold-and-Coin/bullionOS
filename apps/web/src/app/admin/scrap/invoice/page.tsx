'use client';

/**
 * Scrap Invoice — buy or sell scrap to/from a client. Submits as a
 * regular invoice via POST /admin/invoices with type='buy' (default)
 * or 'sell', and ad-hoc line items only — no products, no inventory
 * impact. The buy/sell toggle flips the percent-adjust math (off
 * spot vs. over spot).
 *
 * Hydrates rows from sessionStorage (set by the Scrap Calculator's
 * "Add to new invoice" button), or starts blank when entered direct.
 *
 * Behavior intentionally mirrors /admin/invoices/new for client +
 * payment + notes UX so operators don't have to learn a second flow.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { useLiveSpot } from '@/lib/use-live-spot';
import { ClientCombobox, type ComboboxClient } from '@/components/client-combobox';
import { QuickAddClient } from '@/components/quick-add-client';
import {
  ScrapRowBuilder,
  ScrapTotals,
} from '../_lib/scrap-row-builder';
import {
  blankScrapRow,
  computeScrapRow,
  SCRAP_HANDOFF_KEY,
  snapshotName,
  type ScrapRow,
} from '../_lib/scrap-types';
import { PhotoCapture, type PendingPhoto } from '../_lib/photo-capture';

type PaymentMethod =
  | 'wire'
  | 'check'
  | 'ach'
  | 'cash'
  | 'crypto'
  | 'card'
  | 'zelle'
  | 'venmo';

const PAYMENT_METHODS: Array<{ value: PaymentMethod; label: string }> = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'venmo', label: 'Venmo' },
  { value: 'wire', label: 'Wire' },
  { value: 'ach', label: 'ACH' },
  { value: 'card', label: 'Card' },
  { value: 'crypto', label: 'Crypto' },
];

interface PaymentLeg {
  method: PaymentMethod | '';
  reference: string;
  amount: string;
}

function blankPayment(): PaymentLeg {
  return { method: '', reference: '', amount: '' };
}

interface ClientRow extends ComboboxClient {
  secondary_emails?: string[] | null;
}

export default function ScrapInvoicePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { spot } = useLiveSpot();

  const [type, setType] = useState<'buy' | 'sell'>('buy');
  const [rows, setRows] = useState<ScrapRow[]>(() => [blankScrapRow()]);
  const [clientId, setClientId] = useState('');
  const [payments, setPayments] = useState<PaymentLeg[]>([blankPayment()]);
  const [notes, setNotes] = useState('');
  const [txDate, setTxDate] = useState(localDateInput());
  const [txTime, setTxTime] = useState(localTimeInput());
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Compliance photos held in memory until the invoice POST returns
  // an id; then each is uploaded to the new invoice in a follow-up
  // pass. Three buckets so the operator's mental model maps 1:1 to
  // the UI labels (ID, Client photo, Items).
  const [idPhotos, setIdPhotos] = useState<PendingPhoto[]>([]);
  const [clientPhotos, setClientPhotos] = useState<PendingPhoto[]>([]);
  const [itemPhotos, setItemPhotos] = useState<PendingPhoto[]>([]);

  // ----- Hydration: from calculator sessionStorage if present -----
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SCRAP_HANDOFF_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ScrapRow[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Re-issue ids to avoid React-key collisions if anything else
        // is using the same crypto.randomUUID stream.
        setRows(
          parsed.map((r) => ({
            ...r,
            id:
              typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : Math.random().toString(36).slice(2),
          })),
        );
      }
      sessionStorage.removeItem(SCRAP_HANDOFF_KEY);
    } catch {
      /* invalid storage data — start blank */
    }
  }, []);

  // ----- Load clients for the combobox -----
  const { data: clients } = useQuery<ClientRow[]>({
    queryKey: ['admin', 'clients'],
    queryFn: () => apiFetch<ClientRow[]>('/admin/clients'),
    staleTime: 30 * 1000,
  });

  // ----- Spot pre-fill on metal change handled by row builder -----
  const spotPrices = spot
    ? {
        gold: spot.gold,
        silver: spot.silver,
        platinum: spot.platinum,
        palladium: spot.palladium,
      }
    : null;

  // ----- Derived: total + per-leg validation -----
  const subtotal = useMemo(() => {
    let sum = 0;
    for (const row of rows) {
      sum += computeScrapRow(row, type).final_price;
    }
    return sum;
  }, [rows, type]);

  function addRow() {
    const prev = rows[rows.length - 1];
    const seed = blankScrapRow(spotPrices?.[prev?.metal ?? 'gold']);
    if (prev) {
      seed.metal = prev.metal;
      seed.purity = prev.purity;
      seed.weight_unit = prev.weight_unit;
      seed.percent_adjust = prev.percent_adjust;
      seed.spot_per_oz = spotPrices?.[prev.metal] ?? prev.spot_per_oz;
    }
    setRows([...rows, seed]);
  }

  function patchPayment(idx: number, p: Partial<PaymentLeg>) {
    setPayments(payments.map((leg, i) => (i === idx ? { ...leg, ...p } : leg)));
  }
  function addPayment() {
    if (payments.length >= 3) return;
    setPayments([...payments, blankPayment()]);
  }
  function removePayment(idx: number) {
    if (payments.length === 1) {
      setPayments([blankPayment()]);
      return;
    }
    setPayments(payments.filter((_, i) => i !== idx));
  }

  // Sum + balance helpers for the payment leg UI.
  const paymentSum = payments.reduce(
    (acc, leg) => acc + (Number(leg.amount) || 0),
    0,
  );
  const paymentBalance = subtotal - paymentSum;

  function validate(): string | null {
    if (!clientId) return 'Select a client.';
    const usableRows = rows.filter(
      (r) => parseFloat(r.weight) > 0 && parseFloat(r.spot_per_oz) > 0,
    );
    if (usableRows.length === 0) {
      return 'Add at least one row with a weight + spot price.';
    }
    const validPayments = payments.filter(
      (p) => p.method && p.amount && Number(p.amount) > 0,
    );
    if (validPayments.length === 0) {
      return 'At least one payment leg is required.';
    }
    return null;
  }

  async function submit() {
    setError(null);
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setSubmitting(true);
    setSubmitProgress('Creating invoice…');
    try {
      const usableRows = rows.filter(
        (r) => parseFloat(r.weight) > 0 && parseFloat(r.spot_per_oz) > 0,
      );
      const validPayments = payments
        .filter((p) => p.method && p.amount && Number(p.amount) > 0)
        .map((p) => ({
          method: p.method as PaymentMethod,
          reference: p.reference || undefined,
          amount: Number(p.amount),
        }));
      const payload = {
        client_id: clientId,
        type,
        payment_method: validPayments[0]?.method,
        payment_methods: validPayments,
        notes: notes || undefined,
        transacted_at: buildTransactedAt(txDate, txTime),
        line_items: usableRows.map((r) => {
          const computed = computeScrapRow(r, type);
          return {
            quantity: 1,
            custom_name: snapshotName(r),
            override_unit_price: Number(computed.final_price.toFixed(2)),
            override_reason: `Scrap ${type} · ${snapshotName(r)} · spot $${parseFloat(r.spot_per_oz).toFixed(2)}/oz · ${r.percent_adjust}% ${type === 'buy' ? 'off' : 'over'}`,
          };
        }),
      };
      const created = await apiFetch<{ id: string; invoice_number: string }>(
        '/admin/invoices',
        { method: 'POST', body: JSON.stringify(payload) },
      );

      // Upload compliance photos (if any) to the freshly-created
      // invoice. Done sequentially per kind so the progress UI can
      // report which bucket is active. Failures here don't roll back
      // the invoice — the operator can retry uploads from the invoice
      // detail page (which surfaces an attachments section). Surface
      // the failure as an inline error so they see it before nav.
      const buckets: Array<{ kind: 'id' | 'client_photo' | 'item'; files: PendingPhoto[]; label: string }> = [
        { kind: 'id', files: idPhotos, label: 'ID' },
        { kind: 'client_photo', files: clientPhotos, label: 'client photo' },
        { kind: 'item', files: itemPhotos, label: 'item' },
      ];
      const failed: string[] = [];
      for (const bucket of buckets) {
        for (let i = 0; i < bucket.files.length; i++) {
          const photo = bucket.files[i];
          setSubmitProgress(
            `Uploading ${bucket.label} (${i + 1}/${bucket.files.length})…`,
          );
          try {
            const fd = new FormData();
            fd.append('file', photo.file, photo.file.name);
            await apiFetch(
              `/admin/invoices/${created.id}/attachments?kind=${bucket.kind}`,
              { method: 'POST', body: fd },
            );
          } catch (err) {
            failed.push(
              `${bucket.label}: ${err instanceof ApiError ? err.message : 'upload failed'}`,
            );
          }
        }
      }

      await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });

      if (failed.length > 0) {
        setError(
          `Invoice created, but some uploads failed: ${failed.join('; ')}. Retry from the invoice detail page.`,
        );
        setSubmitProgress(null);
        // Still navigate — the invoice exists, attachments can be
        // re-added from /admin/invoices/[id].
      }
      router.push(`/admin/invoices/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create invoice');
      setSubmitProgress(null);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Scrap Invoice</h1>
          <p className="mt-1 text-sm text-ink-500">
            Buy or sell precious-metal scrap. Submits as an ad-hoc invoice
            (no inventory impact, doesn't appear on the catalog price
            sheets).
          </p>
        </div>
        <Link
          href="/admin/scrap/calculator"
          className="text-sm text-ink-500 underline-offset-2 hover:underline"
        >
          ← back to calculator
        </Link>
      </div>

      {/* Buy/Sell toggle */}
      <div className="mt-4 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Type
        </span>
        <div className="inline-flex rounded-md border border-ink-200 bg-white p-0.5">
          <button
            type="button"
            onClick={() => setType('buy')}
            className={
              'rounded px-3 py-1 text-sm font-medium transition ' +
              (type === 'buy'
                ? 'bg-ink-900 text-white'
                : 'text-ink-600 hover:text-ink-900')
            }
          >
            Buy from client
          </button>
          <button
            type="button"
            onClick={() => setType('sell')}
            className={
              'rounded px-3 py-1 text-sm font-medium transition ' +
              (type === 'sell'
                ? 'bg-ink-900 text-white'
                : 'text-ink-600 hover:text-ink-900')
            }
          >
            Sell to client
          </button>
        </div>
        <span className="text-[11px] text-ink-400">
          {type === 'buy'
            ? 'Default — you purchase scrap from the client.'
            : 'Rare — you sell scrap to the client.'}
        </span>
      </div>

      {/* Client picker */}
      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Client
        </h2>
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            {clients ? (
              <ClientCombobox
                clients={clients}
                value={clientId}
                onChange={setClientId}
                placeholder="Search by name, company, email, phone…"
              />
            ) : (
              <div className="text-sm text-ink-400">Loading clients…</div>
            )}
          </div>
          <QuickAddClient onCreated={(c) => setClientId(c.id)} />
        </div>
        <p className="mt-2 text-xs text-ink-400">
          Inline new-client form keeps your rows. Full client editing
          available later on the client detail page.
        </p>
      </section>

      {/* Rows */}
      <section className="mt-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Items
        </h2>
        <ScrapRowBuilder
          rows={rows}
          onChange={setRows}
          spotPrices={spotPrices}
          mode={type}
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={addRow}
            className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium hover:bg-ink-50"
          >
            + Add row
          </button>
        </div>
        <ScrapTotals rows={rows} mode={type} />
      </section>

      {/* Date override */}
      <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Transaction time
        </h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-[11px] uppercase tracking-wide text-ink-400">
            Date
            <input
              type="date"
              className="input mt-1"
              value={txDate}
              onChange={(e) => setTxDate(e.target.value)}
            />
          </label>
          <label className="flex flex-col text-[11px] uppercase tracking-wide text-ink-400">
            Time
            <input
              type="time"
              className="input mt-1"
              value={txTime}
              onChange={(e) => setTxTime(e.target.value)}
            />
          </label>
          <p className="ml-2 max-w-md text-xs text-ink-400">
            Defaults to right now. Backdate for walk-ins you're writing
            up after the fact — the invoice will appear in that day's
            KPI/EOD bucket once finalized.
          </p>
        </div>
      </section>

      {/* Payments */}
      <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Payment{payments.length > 1 ? ' (split)' : ''}
          </h2>
          <span className="font-mono text-sm text-ink-700">
            Sum: {money(paymentSum)} ·{' '}
            <span
              className={
                Math.abs(paymentBalance) < 0.005
                  ? 'text-emerald-700'
                  : 'text-amber-700'
              }
            >
              Balance: {money(paymentBalance)}
            </span>
          </span>
        </div>
        <div className="mt-3 space-y-2">
          {payments.map((leg, idx) => (
            <div
              key={idx}
              className="flex flex-wrap items-center gap-2 rounded-md border border-ink-100 bg-ink-50/40 p-3"
            >
              <select
                className="input md:w-32"
                value={leg.method}
                onChange={(e) =>
                  patchPayment(idx, { method: e.target.value as PaymentMethod | '' })
                }
              >
                <option value="">— method —</option>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <input
                className="input flex-1 md:min-w-[160px]"
                placeholder="Reference (check #, memo…)"
                value={leg.reference}
                onChange={(e) => patchPayment(idx, { reference: e.target.value })}
              />
              <input
                className="input md:w-32 font-mono"
                type="number"
                min={0}
                step="0.01"
                placeholder="Amount"
                value={leg.amount}
                onChange={(e) => patchPayment(idx, { amount: e.target.value })}
              />
              <button
                type="button"
                onClick={() => removePayment(idx)}
                className="text-xs text-ink-400 hover:text-red-700"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          {payments.length < 3 && (
            <button
              type="button"
              onClick={addPayment}
              className="rounded-md border border-ink-200 bg-white px-3 py-1 text-xs font-medium hover:bg-ink-50"
            >
              + Add split
            </button>
          )}
          {Math.abs(paymentBalance) > 0.005 && payments[0].method && (
            <button
              type="button"
              onClick={() =>
                patchPayment(payments.length - 1, {
                  amount: (
                    (Number(payments[payments.length - 1].amount) || 0) +
                    paymentBalance
                  ).toFixed(2),
                })
              }
              className="rounded-md border border-ink-200 bg-white px-3 py-1 text-xs font-medium hover:bg-ink-50"
              title="Apply remaining balance to last leg"
            >
              Fill balance ({money(paymentBalance)})
            </button>
          )}
        </div>
      </section>

      {/* Notes */}
      <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Notes (optional)
        </h2>
        <textarea
          className="input mt-3 w-full"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Internal notes — visible on the invoice detail page."
        />
      </section>

      {/* Compliance photos.
          These three buckets cover Georgia's precious-metal-dealer
          requirements + general fraud-prevention practice. All three
          are operator-only — they DO NOT appear on the printed
          invoice or the client-portal view. Stored against the
          invoice via /admin/invoices/:id/attachments after the
          invoice POST returns its id. */}
      <div className="mt-4 space-y-3">
        <p className="text-[11px] uppercase tracking-wide text-ink-400">
          Compliance photos · operator-only · not shown on printed or digital invoice
        </p>
        <PhotoCapture
          label="Attach ID"
          help="Customer's driver's license, passport, or government-issued photo ID. Front + back if needed."
          files={idPhotos}
          onChange={setIdPhotos}
        />
        <PhotoCapture
          label="Client Photo"
          help="Customer themselves, ideally with the items they're selling."
          single
          files={clientPhotos}
          onChange={setClientPhotos}
        />
        <PhotoCapture
          label="Item(s)"
          help="Each piece of scrap or a wide shot covering all of it. Multiple photos OK."
          files={itemPhotos}
          onChange={setItemPhotos}
        />
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-2 border-t border-ink-100 pt-4">
        <Link
          href="/admin"
          className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-600 hover:bg-ink-50"
        >
          Cancel
        </Link>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {submitting
            ? submitProgress ?? 'Working…'
            : `Create ${type} invoice →`}
        </button>
      </div>
    </div>
  );
}

// ===== Helpers =====

function money(n: number): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function localDateInput(): string {
  const d = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function localTimeInput(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function buildTransactedAt(date: string, time: string): string | undefined {
  if (!date && !time) return undefined;
  const d = date || new Date().toISOString().slice(0, 10);
  const t = time || '12:00';
  const local = new Date(`${d}T${t}:00`);
  if (Number.isNaN(local.getTime())) return undefined;
  return local.toISOString();
}
