'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { PageTint } from '@/components/page-tint';
import { ProductCombobox } from '@/components/product-combobox';
import { ClientCombobox, type ComboboxClient } from '@/components/client-combobox';

/**
 * Source invoice shape used by both:
 *   - void+recreate flow via ?from=<id>
 *   - resume-draft flow via ?draftId=<id>
 * Only the fields the wizard needs; the full admin detail response has more.
 */
interface SourceInvoice {
  id: string;
  invoice_number: string;
  type: 'buy' | 'sell';
  status: string;
  client_id: string;
  notes: string | null;
  payment_method: string | null;
  payment_methods: Array<{
    method: string;
    reference: string | null;
    amount: string;
  }>;
  tax: string;
  shipping: string;
  total: string;
  created_at: string;
  client_email: string | null;
  line_items: Array<{
    product_id: string | null;
    quantity: number;
    unit_price: string;
    product_name_snapshot: string;
    is_overridden: boolean;
  }>;
}

interface ClientRow extends ComboboxClient {
  secondary_emails?: string[] | null;
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
  custom_name: string;
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

function buildTransactedAt(date: string, time: string): string | undefined {
  if (!date && !time) return undefined;
  const d = date || new Date().toISOString().slice(0, 10);
  const t = time || '12:00';
  const local = new Date(`${d}T${t}:00`);
  if (Number.isNaN(local.getTime())) return undefined;
  return local.toISOString();
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function NewInvoicePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const searchParams = useSearchParams();
  const fromId = searchParams.get('from');
  const initialDraftId = searchParams.get('draftId');
  // `?client_id=<uuid>` — deep-link from the client detail page's
  // "New invoice" button. Pre-selects the client in the combobox so
  // the operator doesn't have to re-pick them. Ignored when `from` or
  // `draftId` is set because those flows already carry a client_id in
  // the source invoice payload.
  const initialClientId = searchParams.get('client_id') ?? '';

  const [clientId, setClientId] = useState<string>(initialClientId);
  const [type, setType] = useState<'sell' | 'buy'>('sell');
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [payments, setPayments] = useState<PaymentLeg[]>([blankPayment()]);
  const [notes, setNotes] = useState('');
  const [txDate, setTxDate] = useState('');
  const [txTime, setTxTime] = useState('');
  // Admin-only oversell override. When ticked on a sell invoice
  // create, the finalize PATCH goes out with force_oversell=true so
  // the reservation commits even if it takes inventory negative.
  // Server-side broadcasts an in-app notification to every admin so
  // someone reconciles stock later. Hidden entirely for non-admin
  // actors and for buy invoices (there's no oversell condition on
  // BUYs — those only ever add inventory).
  const [forceOversell, setForceOversell] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'create' | 'print' | 'email' | 'delete'>(
    null,
  );
  const [prefilled, setPrefilled] = useState(false);
  // Identity of the persisted draft backing this wizard (if any). Save
  // writes a new draft and updates this; subsequent Saves swap the row
  // (POST new, then DELETE old) so invoice_number stays pristine until
  // finalize. See INV-005 / INV-006 / INV-007.
  const [draftId, setDraftId] = useState<string | null>(initialDraftId);

  // Email controls (INV-007).
  const [emailTo, setEmailTo] = useState('');
  const [saveEmailToClient, setSaveEmailToClient] = useState(true);
  // Email popover visibility. Collapses the recipient/send controls
  // into an "Email" footer button that opens a compact form — keeps
  // Delete draft reachable on narrow viewports.
  const [emailOpen, setEmailOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Void+recreate lands here with ?from=<id>. Resume-draft lands with
  // ?draftId=<id>. Either way we fetch and seed the wizard state.
  const sourceQueryId = fromId ?? initialDraftId;
  const { data: source } = useQuery({
    queryKey: ['admin', 'invoice', sourceQueryId],
    queryFn: () => apiFetch<SourceInvoice>(`/admin/invoices/${sourceQueryId}`),
    enabled: Boolean(sourceQueryId),
  });

  useEffect(() => {
    if (!source || prefilled) return;
    setClientId(source.client_id);
    setType(source.type);
    setNotes(source.notes ?? '');
    if (source.created_at) {
      const d = new Date(source.created_at);
      if (!Number.isNaN(d.getTime())) {
        setTxDate(
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
            d.getDate(),
          ).padStart(2, '0')}`,
        );
        setTxTime(
          `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        );
      }
    }
    const seededLines: DraftLine[] = source.line_items.map((l) => ({
      product_id: l.product_id ?? '',
      quantity: l.quantity,
      custom_name: l.product_id ? '' : l.product_name_snapshot,
      override_unit_price: String(Number(l.unit_price).toFixed(2)),
    }));
    if (seededLines.length > 0) setLines([...seededLines, blankLine()]);
    if (source.payment_methods && source.payment_methods.length > 0) {
      setPayments(
        source.payment_methods.map((m) => ({
          method: (m.method || '') as PaymentMethod | '',
          reference: m.reference ?? '',
          amount: String(Number(m.amount)),
        })),
      );
    } else if (source.payment_method) {
      setPayments([
        { method: source.payment_method as PaymentMethod, reference: '', amount: '' },
      ]);
    }
    // If resuming a draft, track its id so subsequent Saves swap it.
    if (initialDraftId && source.status === 'draft') {
      setDraftId(source.id);
    }
    setPrefilled(true);
  }, [source, prefilled, initialDraftId]);

  // ---------- reference data ----------

  const { data: clients } = useQuery({
    queryKey: ['admin', 'clients', 'all'],
    queryFn: () => apiFetch<ClientRow[]>('/admin/clients'),
  });
  const { data: products } = useQuery({
    queryKey: ['admin', 'products'],
    queryFn: () => apiFetch<Product[]>('/admin/products'),
  });

  const selectedClient = useMemo(
    () => (clients ?? []).find((c) => c.id === clientId) ?? null,
    [clients, clientId],
  );

  // Prefill the email field when a client is selected (INV-007 req).
  useEffect(() => {
    if (selectedClient && !emailTo) {
      setEmailTo(selectedClient.email ?? '');
    }
    // When the client changes to one with a different primary, replace
    // the field — operator can still edit afterwards.
    if (selectedClient && emailTo && selectedClient.email && emailTo !== selectedClient.email) {
      // Only auto-replace when we haven't received custom input yet.
      // Heuristic: if the current value matches ANY known client email,
      // it's a prefill we can safely overwrite.
      const allKnown = new Set(
        (clients ?? []).flatMap((c) => [c.email, ...(c.secondary_emails ?? [])]).filter(Boolean),
      );
      if (allKnown.has(emailTo)) setEmailTo(selectedClient.email);
    }
  }, [selectedClient, clients, emailTo]);

  // ---------- quotes (hoisted) ----------

  // One query per distinct (product_id, quantity) pair used on the page.
  // Hoisting lets the parent component compute the running total, while
  // still letting each LineRow render the live unit price. Cached per-key
  // so editing other rows doesn't re-fetch.
  const quoteKeys = useMemo(
    () =>
      lines
        .filter((l) => l.product_id && l.quantity > 0)
        .map((l) => ({ pid: l.product_id, qty: l.quantity })),
    [lines],
  );
  const quoteResults = useQueries({
    queries: quoteKeys.map((k) => ({
      queryKey: ['quote', k.pid, k.qty] as const,
      queryFn: () =>
        apiFetch<Quote>(`/admin/products/${k.pid}/quote?quantity=${k.qty}`),
      staleTime: Infinity,
      refetchInterval: false as const,
    })),
  });
  const quoteMap = useMemo(() => {
    const m = new Map<string, Quote>();
    quoteKeys.forEach((k, i) => {
      const q = quoteResults[i]?.data;
      if (q) m.set(`${k.pid}:${k.qty}`, q);
    });
    return m;
  }, [quoteKeys, quoteResults]);

  // ---------- derived totals (INV-001) ----------

  const lineTotals = useMemo(
    () =>
      lines.map((l) => {
        if (!l.product_id || l.quantity <= 0) return 0;
        const q = quoteMap.get(`${l.product_id}:${l.quantity}`);
        const liveUnit = q
          ? Number(type === 'sell' ? q.sell_unit_price : q.buy_unit_price)
          : null;
        const override =
          l.override_unit_price.trim() !== '' ? Number(l.override_unit_price) : null;
        const unit = override ?? liveUnit ?? null;
        return unit === null ? 0 : unit * l.quantity;
      }),
    [lines, quoteMap, type],
  );
  const subtotal = useMemo(() => lineTotals.reduce((s, x) => s + x, 0), [lineTotals]);
  // tax/shipping are not editable in the wizard; default 0. Running total
  // == subtotal for now. The service recomputes on the server; this is
  // just a preview for the operator.
  const runningTotal = subtotal;

  // ---------- line/payment mutation helpers ----------

  useEffect(() => {
    if (lines.length === 0) return;
    const last = lines[lines.length - 1];
    if (last.product_id && last.quantity > 0) {
      setLines((ls) => [...ls, blankLine()]);
    }
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

  // Fill the most recent payment leg's amount with the running total
  // minus whatever the other legs already cover (INV-002). If all legs
  // have amounts, we target the last one regardless — operator clicked
  // the button; they want the total to land somewhere obvious.
  function fillTotalIntoPayment() {
    if (runningTotal <= 0) return;
    const covered = payments
      .slice(0, -1)
      .map((p) => Number(p.amount) || 0)
      .reduce((s, x) => s + x, 0);
    const remaining = Math.max(0, runningTotal - covered);
    setPayments((ps) => {
      const copy = [...ps];
      copy[copy.length - 1] = { ...copy[copy.length - 1], amount: remaining.toFixed(2) };
      return copy;
    });
  }

  // ---------- validation + payload ----------

  // A line is ready to submit when either:
  //   (a) a catalog product is picked, OR
  //   (b) it's "New Item" — has a custom_name AND an operator-entered
  //       override_unit_price (the price for ad-hoc lines is
  //       operator-priced since there's no product to quote).
  // Either way qty must be > 0.
  const filledLines = lines.filter((l) => {
    if (l.quantity <= 0) return false;
    if (l.product_id) return true;
    return (
      l.custom_name.trim().length > 0 && l.override_unit_price.trim().length > 0
    );
  });
  // Ad-hoc lines with a name but no price (or vice-versa) — surfaced
  // as a gentle validation hint, not a hard block since the operator
  // may still be typing.
  const orphanedAdHoc = lines.filter(
    (l) =>
      !l.product_id &&
      (l.custom_name.trim().length > 0 ||
        l.override_unit_price.trim().length > 0) &&
      !(
        l.custom_name.trim().length > 0 && l.override_unit_price.trim().length > 0
      ),
  );
  const validPayments = payments
    .filter((p) => p.method && Number(p.amount) > 0)
    .map((p) => ({
      method: p.method as PaymentMethod,
      reference: p.reference || undefined,
      amount: Number(p.amount),
    }));

  function buildPayload() {
    return {
      client_id: clientId,
      type,
      payment_method: validPayments[0]?.method,
      payment_methods: validPayments,
      notes: notes || undefined,
      transacted_at: buildTransactedAt(txDate, txTime),
      line_items: filledLines.map((l) => {
        const base: Record<string, unknown> = {
          quantity: l.quantity,
        };
        // Only include product_id when it's a real UUID — the DTO
        // validates as @IsOptional @IsUUID, so an empty string would
        // fail even though "not set" is legal.
        if (l.product_id) base.product_id = l.product_id;
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
  }

  function validate(forSave: boolean): string | null {
    if (!clientId) return 'Select a client';
    if (orphanedAdHoc.length > 0) {
      return 'Each "New item" line needs both a name and a unit price.';
    }
    if (filledLines.length === 0) return 'Add at least one line item';
    // Saving a draft is allowed with an empty payment section (operator
    // may still be choosing). Create requires at least one leg.
    if (!forSave && validPayments.length === 0) {
      return 'Payment method is required (at least one leg with an amount).';
    }
    return null;
  }

  /**
   * Persist the current wizard state as a draft. If there is already a
   * draft backing this wizard (draftId set), we POST the new one FIRST
   * and then DELETE the old — that way a POST failure doesn't lose work,
   * and an orphaned old draft is the worst-case outcome. Returns the new
   * draft's id so the caller can chain Print/Email on it.
   */
  async function persistDraft(): Promise<string> {
    const payload = buildPayload();
    const created = await apiFetch<{ id: string; invoice_number: string }>(
      '/admin/invoices',
      { method: 'POST', body: JSON.stringify(payload) },
    );
    const previousDraft = draftId;
    setDraftId(created.id);
    // Sync the URL so ?draftId reflects reality, but don't cause a
    // server-side navigation — replaceState keeps the client state.
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('draftId', created.id);
      u.searchParams.delete('from'); // void+recreate flow ends at first save
      window.history.replaceState({}, '', u.toString());
    } catch {
      /* noop in non-browser test envs */
    }
    if (previousDraft && previousDraft !== created.id) {
      try {
        await apiFetch(`/admin/invoices/${previousDraft}`, { method: 'DELETE' });
      } catch {
        // Orphan is harmless — it's a draft. Do not surface to user.
      }
    }
    await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
    return created.id;
  }

  // ---------- action handlers ----------

  async function handleSave() {
    setError(null);
    setFlash(null);
    const v = validate(true);
    if (v) return setError(v);
    setBusy('save');
    try {
      await persistDraft();
      setFlash('Draft saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save draft');
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate() {
    setError(null);
    setFlash(null);
    const v = validate(false);
    if (v) return setError(v);
    setBusy('create');
    try {
      // Always POST a fresh invoice (no reuse of existing draft row) so
      // the finalize transaction is atomic and audits cleanly.
      const payload = buildPayload();
      const created = await apiFetch<{ id: string }>('/admin/invoices', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      // Draft → finalized. The service handles inventory reservation.
      // force_oversell=true bypasses the on-hand guard (admin + sell
      // only; backend ignores otherwise). Triggers an in-app
      // notification to every admin so someone reconciles stock later.
      await apiFetch(`/admin/invoices/${created.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'finalized',
          force_oversell: forceOversell && isAdmin && type === 'sell'
            ? true
            : undefined,
        }),
      });
      // If we were backing a draft, clean it up.
      if (draftId && draftId !== created.id) {
        try {
          await apiFetch(`/admin/invoices/${draftId}`, { method: 'DELETE' });
        } catch {
          /* ignore orphan */
        }
      }
      await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
      router.push(`/admin/invoices/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create invoice');
    } finally {
      setBusy(null);
    }
  }

  async function handlePrint() {
    setError(null);
    setFlash(null);
    const v = validate(true);
    if (v) return setError(v);
    setBusy('print');
    try {
      const id = await persistDraft();
      // Open the PDF in a new tab — does NOT finalize (INV-006).
      window.open(`/api/v1/admin/invoices/${id}/pdf`, '_blank', 'noopener');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to open print view');
    } finally {
      setBusy(null);
    }
  }

  async function handleEmail() {
    setError(null);
    setFlash(null);
    const v = validate(true);
    if (v) return setError(v);
    const to = emailTo.trim().toLowerCase();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return setError('Enter a valid email address.');
    }
    setBusy('email');
    try {
      const id = await persistDraft();
      const result = await apiFetch<{ sent_to: string; saved_to_client: boolean }>(
        `/admin/invoices/${id}/email`,
        {
          method: 'POST',
          body: JSON.stringify({ to, save_to_client: saveEmailToClient }),
        },
      );
      setFlash(
        result.saved_to_client
          ? `Emailed to ${result.sent_to}. Saved as a secondary address on the client.`
          : `Emailed to ${result.sent_to}.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to email invoice');
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!draftId) return;
    const ok = window.confirm('Delete this draft? This cannot be undone.');
    if (!ok) return;
    setError(null);
    setBusy('delete');
    try {
      await apiFetch(`/admin/invoices/${draftId}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['admin', 'invoices'] });
      router.push('/admin/invoices?status=draft');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete draft');
      setBusy(null);
    }
  }

  // ---------- render ----------

  return (
    <PageTint side={type === 'buy' ? 'buy' : 'sell'}>
      <div className="mx-auto max-w-4xl pb-32">
        {/* Hero card — same visual language as /admin/invoices and
            /admin/invoices/[id]. Side-colored accent rail (buy/sell),
            big mode label ("New invoice" / "Edit draft" / "Recreate
            invoice"), subtitle explains what clicking Create will do. */}
        <section className="relative overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
          <div
            aria-hidden
            className={`absolute inset-y-0 left-0 w-1 ${
              type === 'buy' ? 'bg-buy-600' : 'bg-sell-600'
            }`}
          />
          <div className="p-5 md:p-6">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
              {fromId ? 'Recreate invoice' : draftId ? 'Edit draft' : 'Create invoice'}
            </div>
            <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink-900">
              {fromId ? 'Recreate invoice' : draftId ? 'Edit draft' : 'New invoice'}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-ink-500">
              {fromId
                ? `Fields pre-filled from ${source?.invoice_number ?? 'a prior invoice'} (now canceled). Make your edits, then submit to create a new ticket. The old invoice stays in history as CANCELED.`
                : draftId
                  ? 'Editing an existing draft. Save updates it; Create finalizes; Delete removes it.'
                  : 'Prices computed against live spot at submission time. Override any unit price inline if needed.'}
            </p>
          </div>
        </section>

        {fromId && source && source.status !== 'canceled' && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            The source invoice isn&rsquo;t canceled yet — submitting will leave two open
            tickets. Go back to the original and void it first.
          </div>
        )}

        {/* 1 · Client (INV-004 unified combobox) */}
        <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
          <SectionHeader step={1} title="Client" />

          <div className="mt-3">
            <ClientCombobox
              clients={clients ?? []}
              value={clientId}
              onChange={setClientId}
            />
          </div>
          {selectedClient && (
            <p className="mt-2 text-xs text-ink-400">
              Selected:{' '}
              {[selectedClient.first_name, selectedClient.last_name]
                .filter(Boolean)
                .join(' ') ||
                selectedClient.company ||
                '(unnamed)'}
              {selectedClient.company &&
                (selectedClient.first_name || selectedClient.last_name) &&
                ` · ${selectedClient.company}`}
              {selectedClient.client_type === 'wholesaler' && (
                <span className="ml-2 rounded-full bg-gold-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold-600">
                  Wholesale
                </span>
              )}
            </p>
          )}
        </section>

        {/* 2 · Direction */}
        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
          <SectionHeader step={2} title="Direction" />

          <div className="mt-3 inline-flex rounded-md border border-ink-200 bg-ink-50 p-1">
            <TypeToggle active={type === 'sell'} onClick={() => setType('sell')}>
              Sell (we sell to client)
            </TypeToggle>
            <TypeToggle active={type === 'buy'} onClick={() => setType('buy')}>
              Buy (we buy from client)
            </TypeToggle>
          </div>
        </section>

        {/* 3 · Line items */}
        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionHeader step={3} title="Line items" />
            {/* Live running-total badge — updates as each line's qty /
                unit / product changes. Same figure the sticky bottom
                rail shows, surfaced here so operators see the total
                grow while they're typing without having to glance
                down. Side-tinted (buy=red, sell=green) so the badge
                also reinforces the direction they're in. */}
            <div
              className={`inline-flex items-baseline gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ${
                type === 'buy'
                  ? 'bg-buy-600/10 text-buy-700'
                  : 'bg-sell-600/10 text-sell-700'
              }`}
              aria-live="polite"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider opacity-70">
                Running total
              </span>
              <span className="font-mono tabular-nums">
                {money(runningTotal)}
              </span>
              {filledLines.length > 0 && (
                <span className="text-[11px] font-normal opacity-70">
                  · {filledLines.length} line{filledLines.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
          <p className="mt-2 hidden text-xs text-ink-400 md:block">
            New line auto-adds once the previous one is filled.
          </p>

          {/* Mobile scroll wrapper (MOB-001). On narrow viewports the wide
              line row would otherwise clip at the edges.
              md:overflow-visible is critical: `overflow-x: auto` implicitly
              clamps overflow-y too, which clips the ProductCombobox dropdown
              when it extends below the row. Desktop is always wider than
              640px so we don't need scroll there anyway. */}
          <div className="mt-3 -mx-2 overflow-x-auto px-2 md:mx-0 md:overflow-visible md:px-0">
            <div className="min-w-[640px] space-y-3 md:min-w-0">
              {lines.map((line, idx) => (
                <LineRow
                  key={idx}
                  line={line}
                  products={products ?? []}
                  type={type}
                  quote={
                    line.product_id && line.quantity > 0
                      ? quoteMap.get(`${line.product_id}:${line.quantity}`) ?? null
                      : null
                  }
                  onChange={(patch) => updateLine(idx, patch)}
                  onRemove={() => removeLine(idx)}
                />
              ))}
            </div>
          </div>
        </section>

        {/* 4 · Payment */}
        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionHeader step={4} title="Payment" required />

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={fillTotalIntoPayment}
                disabled={runningTotal <= 0}
                title="Fill the last payment leg with the current invoice total"
                className="rounded-md border border-ink-200 px-3 py-1 text-xs hover:bg-ink-50 disabled:opacity-60"
              >
                Total
              </button>
              <button
                type="button"
                onClick={addPayment}
                disabled={payments.length >= 3}
                className="rounded-md border border-ink-200 px-3 py-1 text-xs hover:bg-ink-50 disabled:opacity-60"
              >
                + Add split
              </button>
            </div>
          </div>
          <p className="mt-1 text-xs text-ink-400">
            Required. Add a second or third leg for split tenders (e.g. cash + check).
            Click <strong>Total</strong> to fill the remaining balance into the last
            leg.
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

        {/* Tx date/time */}
        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
          <SectionHeader title="Transaction date & time" />

          <p className="mt-1 text-xs text-ink-400">
            Leave blank to use &ldquo;now&rdquo; when you click Create. Backdate for
            retail tickets being written up later.
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
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                setTxDate(
                  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
                    now.getDate(),
                  ).padStart(2, '0')}`,
                );
                setTxTime(
                  `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
                );
              }}
              className="rounded-md bg-ink-900 px-3 py-1 text-xs font-medium text-white hover:bg-ink-800"
            >
              Now
            </button>
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

        {/* Notes — whitespace-pre-wrap preserves line breaks the operator
            types (INV-009). The textarea itself already wraps; the
            surrounding container now won't clip when notes go long. */}
        <section className="mt-4 rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
          <SectionHeader title="Notes" />

          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Anything that should print on the PDF under NOTES…"
            className="input mt-3 w-full whitespace-pre-wrap break-words"
          />
        </section>

        {/* Oversell override — admin-only, sell invoices only. Bypasses
            the on-hand guard when Create is clicked so the finalize
            transaction commits even if inventory goes negative. The
            backend broadcasts a bell-icon notification to every admin
            so someone remembers to adjust stock later. Hidden for
            staff + for buy invoices (no oversell exposure on BUYs —
            those only ever add inventory). */}
        {isAdmin && type === 'sell' && (
          <section className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={forceOversell}
                onChange={(e) => setForceOversell(e.target.checked)}
                className="mt-0.5"
              />
              <div className="text-sm">
                <div className="font-semibold text-amber-900">
                  Override stock check (admin only)
                </div>
                <p className="mt-0.5 text-xs text-amber-800">
                  Allow this invoice to reserve more than is on hand
                  — useful for pre-sales against incoming stock or
                  when counts are behind. Inventory will go negative
                  at finalize time; a bell-icon notification goes to
                  every admin so someone reconciles after. Every
                  movement stays audit-logged.
                </p>
              </div>
            </label>
          </section>
        )}

        {/* Flash / error */}
        {flash && (
          <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
            {flash}
          </div>
        )}
        {error && (
          <div role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>

      {/* Sticky action rail — running total above bottom buttons (INV-001,
          INV-005, INV-008). Padding-bottom on the main column above keeps
          the last field from hiding under the rail.
          Apr 2026 polish: three visual tiers in the button cluster —
            · Cancel is a quiet text link (leave without committing)
            · Save / Print / Email share a subtle grouped style (secondary)
            · Create is the single hero primary
            · Delete draft is visually separated when present (destructive)
          Running total is given its own block with a larger mono figure so
          operators can keep an eye on the number while typing line items. */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-ink-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-baseline gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                Running total
              </div>
              <div className="font-mono text-2xl font-semibold tabular-nums text-ink-900">
                {money(runningTotal)}
              </div>
            </div>
            {filledLines.length > 0 && (
              <div className="text-xs text-ink-400">
                {filledLines.length} line{filledLines.length === 1 ? '' : 's'}
              </div>
            )}
          </div>

          {/* Order left→right: Cancel (quiet) · Save · Print · Email ·
              Create (primary) · Delete (destructive, only when a draft
              exists). Email popover positioned relative to its button
              container; closes on outside click or Close. */}
          <div className="relative flex flex-wrap items-center gap-2">
            <button
              onClick={() => router.back()}
              className="rounded-md px-2 py-2 text-sm text-ink-500 hover:text-ink-900"
            >
              Cancel
            </button>
            <div className="inline-flex rounded-md border border-ink-200 bg-ink-50/50 p-0.5">
              <button
                onClick={handleSave}
                disabled={!!busy}
                title="Save this as a draft"
                className="rounded px-3 py-1.5 text-sm text-ink-700 hover:bg-white hover:text-ink-900 disabled:opacity-60"
              >
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={handlePrint}
                disabled={!!busy}
                title="Save + open the PDF in a new tab (does not finalize)"
                className="rounded px-3 py-1.5 text-sm text-ink-700 hover:bg-white hover:text-ink-900 disabled:opacity-60"
              >
                {busy === 'print' ? 'Opening…' : 'Print'}
              </button>
              <button
                onClick={() => setEmailOpen((v) => !v)}
                disabled={!!busy}
                aria-expanded={emailOpen}
                title="Save + email the PDF to a recipient"
                className="inline-flex items-center gap-1 rounded px-3 py-1.5 text-sm text-ink-700 hover:bg-white hover:text-ink-900 disabled:opacity-60"
              >
                {busy === 'email' ? 'Sending…' : 'Email'}
                <span className="text-[10px] text-ink-400">▾</span>
              </button>
            </div>
            <button
              onClick={handleCreate}
              disabled={!!busy}
              className="rounded-md bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-ink-800 disabled:opacity-60"
            >
              {busy === 'create' ? 'Creating…' : 'Create invoice'}
            </button>
            {draftId && (
              <>
                <span aria-hidden className="mx-1 h-6 w-px bg-ink-200" />
                <button
                  onClick={handleDelete}
                  disabled={!!busy}
                  title="Permanently delete this draft"
                  className="rounded-md px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
                >
                  {busy === 'delete' ? 'Deleting…' : 'Delete draft'}
                </button>
              </>
            )}

            {emailOpen && (
              <div className="absolute bottom-full right-0 z-20 mb-2 w-[320px] max-w-[calc(100vw-1rem)] rounded-md border border-ink-200 bg-white p-3 shadow-lg">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                    Send PDF to
                  </span>
                  <input
                    type="email"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="recipient@example.com"
                    className="input mt-1 w-full"
                    aria-label="Email recipient"
                    autoFocus
                  />
                </label>
                <label className="mt-2 flex items-start gap-2 text-xs text-ink-600">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={saveEmailToClient}
                    onChange={(e) => setSaveEmailToClient(e.target.checked)}
                  />
                  Save to client record if this address is new
                </label>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    onClick={() => setEmailOpen(false)}
                    className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
                  >
                    Close
                  </button>
                  <button
                    onClick={async () => {
                      await handleEmail();
                      // leave popover open only on error so flash is
                      // visible; success path resets it.
                      if (!error) setEmailOpen(false);
                    }}
                    disabled={!emailTo || !!busy}
                    className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
                  >
                    {busy === 'email' ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </PageTint>
  );
}

// ---------- subcomponents ----------

/**
 * Numbered / plain section header for the wizard cards. A small dark
 * circular chip holds the step number; the label sits next to it.
 * `required` adds a subtle red asterisk. Used across every card on
 * this page for consistent visual rhythm.
 */
function SectionHeader({
  step,
  title,
  required,
}: {
  step?: number;
  title: string;
  required?: boolean;
}) {
  return (
    <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-600">
      {step !== undefined && (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ink-900 text-[10px] font-bold text-white">
          {step}
        </span>
      )}
      <span>{title}</span>
      {required && <span className="text-red-600">*</span>}
    </h2>
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
  quote,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  products: Product[];
  type: 'buy' | 'sell';
  /** Current live quote for (product_id, quantity). Lifted to parent. */
  quote: Quote | null;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
}) {
  const isAdHoc = line.product_id === '' && !!line.custom_name;
  const liveUnit = type === 'sell' ? quote?.sell_unit_price : quote?.buy_unit_price;
  const effectiveUnit =
    line.override_unit_price.trim() !== ''
      ? Number(line.override_unit_price) || 0
      : liveUnit
        ? Number(liveUnit)
        : null;
  const lineTotal =
    effectiveUnit !== null ? effectiveUnit * line.quantity : undefined;

  // Grid: wider Total column, separated × button (INV-003 fix).
  // 5 · product  /  2 · qty  /  2 · unit  /  2 · total  /  1 · ×
  return (
    <div className="rounded-md border border-ink-100 p-3">
      <div className="grid grid-cols-12 items-center gap-3">
        <div className="col-span-5">
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
          min={0}
          // Allow the input to be fully cleared — operators type fresh
          // numbers without backspacing the default "1" first. Empty
          // state stores quantity=0 (displayed as empty); submit-time
          // validate() already blocks qty <= 0, so an unfilled line
          // can't accidentally ship. Typing any real number re-populates.
          value={line.quantity === 0 ? '' : line.quantity}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange({ quantity: 0 });
              return;
            }
            const n = Number(raw);
            onChange({ quantity: Number.isFinite(n) && n >= 0 ? n : 0 });
          }}
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
        <div className="col-span-2 pr-2 text-right font-mono text-sm text-ink-600">
          {lineTotal !== undefined
            ? `$${lineTotal.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}`
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
            <span className="text-xs text-red-600">Enter a unit price →</span>
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
