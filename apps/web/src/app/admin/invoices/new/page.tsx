'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { PageTint } from '@/components/page-tint';
import { ProductCombobox } from '@/components/product-combobox';

interface Client {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  client_type?: 'retail' | 'wholesaler';
}
interface Product {
  id: string;
  sku: string;
  name: string;
  metal: string;
}
interface Quote {
  buy_unit_price: string;
  sell_unit_price: string;
  spot_per_oz: string;
}

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

interface DraftLine {
  product_id: string;
  quantity: number;
  // Custom name for "New Item" walk-ins. Replaces the snapshot name.
  custom_name: string;
  // Operator-entered unit price override. Empty string = use the live quote.
  override_unit_price: string;
}

interface PaymentLeg {
  method: PaymentMethod | '';
  reference: string;
  amount: string;
}

function blankLine(defaultProduct?: string): DraftLine {
  return {
    product_id: defaultProduct ?? '',
    quantity: 1,
    custom_name: '',
    override_unit_price: '',
  };
}

function blankPayment(): PaymentLeg {
  return { method: '', reference: '', amount: '' };
}

/**
 * Marshal the two wizard inputs into an ISO-8601 string the server can
 * parse. Interprets the local wall clock — the operator types "5:30 PM
 * on 2026-04-17" and we send whatever UTC instant that corresponds to
 * for the viewer's machine. Returns undefined when nothing was entered
 * so the server falls back to NOW().
 *
 * If only a date was entered, we default to noon local so the invoice
 * lands squarely in the intended day regardless of tz conversion.
 */
function buildTransactedAt(date: string, time: string): string | undefined {
  if (!date && !time) return undefined;
  const d = date || new Date().toISOString().slice(0, 10);
  const t = time || '12:00';
  const local = new Date(`${d}T${t}:00`);
  if (Number.isNaN(local.getTime())) return undefined;
  return local.toISOString();
}

export default function NewInvoicePage() {
  const router = useRouter();
  const qc = useQueryClient();

  const [clientId, setClientId] = useState<string>('');
  const [clientSearch, setClientSearch] = useState('');
  const [type, setType] = useState<'sell' | 'buy'>('sell');
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [payments, setPayments] = useState<PaymentLeg[]>([blankPayment()]);
  const [notes, setNotes] = useState('');
  // Transaction date/time override. Empty = "now" at submit; operator can
  // backdate for walk-ins being written up later. Two inputs (date + time)
  // keep the wizard keyboard-friendly; we marshal to ISO on submit.
  const [txDate, setTxDate] = useState('');
  const [txTime, setTxTime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: clients } = useQuery({
    queryKey: ['admin', 'clients', clientSearch],
    queryFn: () =>
      apiFetch<Client[]>(
        `/admin/clients${clientSearch ? `?q=${encodeURIComponent(clientSearch)}` : ''}`,
      ),
  });
  const { data: products } = useQuery({
    queryKey: ['admin', 'products'],
    queryFn: () => apiFetch<Product[]>('/admin/products'),
  });

  const selectedClient = useMemo(
    () => (clients ?? []).find((c) => c.id === clientId),
    [clients, clientId],
  );

  // Auto-add a new blank line the moment the last existing line has both a
  // product selected and a non-zero quantity. Keeps the keyboard flow fast:
  // pick product → type qty → Tab straight onto the next row.
  useEffect(() => {
    if (lines.length === 0) return;
    const last = lines[lines.length - 1];
    if (last.product_id && last.quantity > 0) {
      setLines((ls) => [...ls, blankLine()]);
    }
    // Intentionally only runs when the last line's product/qty changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines[lines.length - 1]?.product_id, lines[lines.length - 1]?.quantity]);

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((l) => l.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }
  function removeLine(idx: number) {
    setLines((l) => (l.length === 1 ? [blankLine()] : l.filter((_, i) => i !== idx)));
  }

  function updatePayment(idx: number, patch: Partial<PaymentLeg>) {
    setPayments((p) => p.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }
  function addPayment() {
    setPayments((p) => (p.length >= 3 ? p : [...p, blankPayment()]));
  }
  function removePayment(idx: number) {
    setPayments((p) => (p.length === 1 ? [blankPayment()] : p.filter((_, i) => i !== idx)));
  }

  const filledLines = lines.filter((l) => l.product_id && l.quantity > 0);
  // Any line where the user clicked "New Item" but didn't also pick a
  // catalog product from the dropdown below. Catch these at submit-time
  // so the row doesn't silently get filtered out of the payload.
  const orphanedAdHoc = lines.filter(
    (l) => !l.product_id && l.custom_name.trim().length > 0,
  );
  const validPayments = payments
    .filter((p) => p.method && Number(p.amount) > 0)
    .map((p) => ({
      method: p.method as PaymentMethod,
      reference: p.reference || undefined,
      amount: Number(p.amount),
    }));

  async function submit() {
    setError(null);
    if (!clientId) return setError('Select a client');
    if (orphanedAdHoc.length > 0) {
      return setError(
        'For "New item" lines, also pick a catalog product so we can snapshot the metal and weight. The name you typed will still be shown.',
      );
    }
    if (filledLines.length === 0) return setError('Add at least one line item');
    if (validPayments.length === 0)
      return setError('Payment method is required (at least one leg with an amount).');

    setSubmitting(true);
    try {
      const body = {
        client_id: clientId,
        type,
        // Pass the first entry's method as legacy primary for back-compat;
        // server derives it the same way but being explicit keeps the PDF
        // header correct if the multi-payment array gets truncated.
        payment_method: validPayments[0].method,
        payment_methods: validPayments,
        notes: notes || undefined,
        transacted_at: buildTransactedAt(txDate, txTime),
        line_items: filledLines.map((l) => {
          const base: Record<string, unknown> = {
            product_id: l.product_id,
            quantity: l.quantity,
          };
          if (l.custom_name.trim()) base.custom_name = l.custom_name.trim();
          if (l.override_unit_price.trim()) {
            const n = Number(l.override_unit_price);
            if (Number.isFinite(n) && n >= 0) {
              base.override_unit_price = n;
              base.override_reason = l.custom_name.trim()
                ? `Manual entry: ${l.custom_name.trim()}`
                : 'Operator-entered price';
            }
          }
          return base;
        }),
      };
      const created = await apiFetch<{ id: string }>('/admin/invoices', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
      router.push(`/admin/invoices/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create invoice');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageTint side={type === 'buy' ? 'buy' : 'sell'}>
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold">New invoice</h1>
        <p className="mt-1 text-sm text-ink-400">
          Prices computed against live spot at submission time. Override any unit
          price inline if needed.
        </p>

        <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            1 · Client
          </h2>
          <div className="mt-3 flex flex-col gap-2 md:flex-row">
            <input
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              placeholder="Search name / email"
              className="input flex-1"
            />
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="input md:w-80"
            >
              <option value="">— select client —</option>
              {(clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.last_name}, {c.first_name}
                  {c.client_type === 'wholesaler' ? ' · wholesale' : ''}
                  {c.email ? ` · ${c.email}` : ''}
                </option>
              ))}
            </select>
          </div>
          {selectedClient && (
            <p className="mt-2 text-xs text-ink-400">
              Selected: {selectedClient.first_name} {selectedClient.last_name}
              {selectedClient.client_type === 'wholesaler' && (
                <span className="ml-2 rounded-full bg-gold-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold-600">
                  Wholesale
                </span>
              )}
            </p>
          )}
        </section>

        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            2 · Direction
          </h2>
          <div className="mt-3 inline-flex rounded-md border border-ink-200 bg-ink-50 p-1">
            <TypeToggle active={type === 'sell'} onClick={() => setType('sell')}>
              Sell (we sell to client)
            </TypeToggle>
            <TypeToggle active={type === 'buy'} onClick={() => setType('buy')}>
              Buy (we buy from client)
            </TypeToggle>
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              3 · Line items
            </h2>
            <span className="text-xs text-ink-400">
              New line auto-adds once the previous one is filled.
            </span>
          </div>

          <div className="mt-3 space-y-3">
            {lines.map((line, idx) => (
              <LineRow
                key={idx}
                line={line}
                products={products ?? []}
                type={type}
                onChange={(patch) => updateLine(idx, patch)}
                onRemove={() => removeLine(idx)}
              />
            ))}
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              4 · Payment <span className="text-red-600">*</span>
            </h2>
            <button
              onClick={addPayment}
              disabled={payments.length >= 3}
              className="rounded-md border border-ink-200 px-3 py-1 text-xs hover:bg-ink-50 disabled:opacity-60"
            >
              + Add split
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-400">
            Required. Add a second or third leg for split tenders (e.g. cash + check).
          </p>
          <div className="mt-3 space-y-2">
            {payments.map((p, idx) => (
              <PaymentRow
                key={idx}
                leg={p}
                onChange={(patch) => updatePayment(idx, patch)}
                onRemove={() => removePayment(idx)}
              />
            ))}
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Transaction date &amp; time
          </h2>
          <p className="mt-1 text-xs text-ink-400">
            Leave blank to use &ldquo;now&rdquo; when you click Create. Backdate for
            walk-ins being written up later.
          </p>
          <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center">
            <input
              type="date"
              value={txDate}
              onChange={(e) => setTxDate(e.target.value)}
              className="input font-mono md:w-44"
              aria-label="Transaction date"
            />
            <input
              type="time"
              value={txTime}
              onChange={(e) => setTxTime(e.target.value)}
              className="input font-mono md:w-32"
              aria-label="Transaction time"
              step={60}
            />
            {(txDate || txTime) && (
              <button
                type="button"
                onClick={() => {
                  setTxDate('');
                  setTxTime('');
                }}
                className="rounded-md border border-ink-200 px-3 py-1 text-xs text-ink-700 hover:bg-ink-50"
              >
                Clear
              </button>
            )}
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Notes
          </h2>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Anything that should print on the PDF under NOTES…"
            className="input mt-3"
          />
        </section>

        {error && (
          <div role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={() => router.back()}
            className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700 hover:bg-ink-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
          >
            {submitting ? 'Creating…' : 'Create invoice'}
          </button>
        </div>
      </div>
    </PageTint>
  );
}

function TypeToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-3 py-1.5 text-sm transition ${
        active ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600 hover:text-ink-900'
      }`}
    >
      {children}
    </button>
  );
}

function LineRow({
  line,
  products,
  type,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  products: Product[];
  type: 'buy' | 'sell';
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
}) {
  const isAdHoc = line.product_id === '' && !!line.custom_name;

  const { data: quote } = useQuery({
    queryKey: ['quote', line.product_id, line.quantity],
    queryFn: () =>
      apiFetch<Quote>(
        `/admin/products/${line.product_id}/quote?quantity=${line.quantity}`,
      ),
    enabled: Boolean(line.product_id && line.quantity > 0),
    // Quote is already live-priced server-side. No refetch — invoice wizard
    // locks prices at line-add time to avoid surprise changes mid-ticket.
    staleTime: Infinity,
    refetchInterval: false,
  });

  const liveUnit = type === 'sell' ? quote?.sell_unit_price : quote?.buy_unit_price;
  const effectiveUnit =
    line.override_unit_price.trim() !== ''
      ? Number(line.override_unit_price) || 0
      : liveUnit
        ? Number(liveUnit)
        : null;
  const lineTotal =
    effectiveUnit !== null ? effectiveUnit * line.quantity : undefined;

  return (
    <div className="rounded-md border border-ink-100 p-3">
      <div className="grid grid-cols-12 items-center gap-3">
        <div className="col-span-6">
          <ProductCombobox
            products={products}
            value={line.product_id}
            adHoc={isAdHoc}
            onChange={(productId) =>
              onChange({ product_id: productId, custom_name: '' })
            }
            onPickAdHoc={() =>
              onChange({
                product_id: '',
                custom_name: line.custom_name || 'Scrap / ad-hoc',
              })
            }
          />
        </div>
        <input
          type="number"
          min={1}
          value={line.quantity}
          onChange={(e) => onChange({ quantity: Math.max(1, Number(e.target.value)) })}
          className="input col-span-2 font-mono"
          aria-label="Quantity"
        />
        <input
          type="number"
          step="0.01"
          placeholder={liveUnit ? Number(liveUnit).toFixed(2) : 'unit $'}
          value={line.override_unit_price}
          onChange={(e) => onChange({ override_unit_price: e.target.value })}
          className="input col-span-2 font-mono"
          aria-label="Unit price (leave blank for live quote)"
        />
        <div className="col-span-1 text-right font-mono text-sm text-ink-600">
          {lineTotal !== undefined
            ? `$${lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : '—'}
        </div>
        <button
          onClick={onRemove}
          aria-label="Remove line"
          className="col-span-1 rounded-md border border-ink-200 px-2 py-1 text-xs hover:bg-red-50 hover:text-red-700"
        >
          ×
        </button>
      </div>
      {isAdHoc && (
        <div className="mt-2 flex items-center gap-2">
          <label className="text-xs text-ink-400">Item name</label>
          <input
            value={line.custom_name}
            onChange={(e) => onChange({ custom_name: e.target.value })}
            className="input flex-1 text-sm"
            placeholder="e.g. 14k broken chain, 8.2 g"
            maxLength={200}
          />
          {line.override_unit_price.trim() === '' && (
            <span className="text-xs text-red-600">
              Enter a unit price →
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function PaymentRow({
  leg,
  onChange,
  onRemove,
}: {
  leg: PaymentLeg;
  onChange: (patch: Partial<PaymentLeg>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-12 items-center gap-2">
      <select
        value={leg.method}
        onChange={(e) => onChange({ method: e.target.value as PaymentMethod | '' })}
        className="input col-span-3"
      >
        <option value="">— method —</option>
        {PAYMENT_METHODS.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <input
        value={leg.reference}
        onChange={(e) => onChange({ reference: e.target.value })}
        placeholder="Check #, Zelle memo, card last-4…"
        className="input col-span-6"
        maxLength={200}
      />
      <input
        type="number"
        step="0.01"
        value={leg.amount}
        onChange={(e) => onChange({ amount: e.target.value })}
        placeholder="amount"
        className="input col-span-2 font-mono"
      />
      <button
        onClick={onRemove}
        aria-label="Remove payment leg"
        className="col-span-1 rounded-md border border-ink-200 px-2 py-1 text-xs hover:bg-red-50 hover:text-red-700"
      >
        ×
      </button>
    </div>
  );
}
