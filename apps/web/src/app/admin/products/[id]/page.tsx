'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { useDisplayCategories } from '@/lib/use-display-categories';
import { deriveDisplayCategory } from '@/lib/product-category';

interface Product {
  id: string;
  sku: string;
  name: string;
  metal: string;
  category: string;
  weight_troy_oz: string;
  purity: string;
  metal_content_troy_oz: string;
  description: string | null;
  image_url: string | null;
  is_active: boolean;
  show_on_website: boolean;
  display_category_override: string | null;
  created_at: string;
  updated_at: string;
}

interface PricingRule {
  product_id: string;
  product_metal: string;
  source: 'metal' | 'product' | 'none';
  rule_id: string | null;
  buy_premium_type: 'percent' | 'flat';
  buy_premium_value: string;
  sell_premium_type: 'percent' | 'flat';
  sell_premium_value: string;
}

interface LiveQuote {
  spot_per_oz: string;
  melt_value_per_unit: string;
  buy_unit_price: string;
  sell_unit_price: string;
}

export default function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const { data: product } = useQuery({
    queryKey: ['admin', 'product', id],
    queryFn: () => apiFetch<Product>(`/admin/products/${id}`),
  });
  const { data: rule } = useQuery({
    queryKey: ['admin', 'product', id, 'rule'],
    queryFn: () => apiFetch<PricingRule>(`/admin/products/${id}/pricing-rule`),
  });
  const { data: quote } = useQuery({
    queryKey: ['admin', 'product', id, 'quote'],
    queryFn: () => apiFetch<LiveQuote>(`/admin/products/${id}/quote?quantity=1`),
    refetchInterval: 60_000,
  });

  if (!product || !rule) {
    return <div className="text-sm text-ink-400">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4">
        <Link href="/admin/products" className="text-sm text-ink-600 hover:text-ink-900">
          ← All products
        </Link>
      </div>

      <header className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <InlineNameEditor product={product} />
          <p className="mt-1 font-mono text-sm text-ink-400">{product.sku}</p>
          <p className="mt-1 text-sm capitalize text-ink-600">
            {product.metal} · {product.category} ·{' '}
            {Number(product.weight_troy_oz).toFixed(4)} oz ·{' '}
            {Number(product.purity).toFixed(4)} fine
          </p>
        </div>
        <div className="flex items-center gap-2">
          {product.is_active ? (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
              active
            </span>
          ) : (
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500">
              inactive
            </span>
          )}
          {product.show_on_website && (
            <span className="rounded-full bg-gold-500/10 px-2 py-0.5 text-[11px] font-medium text-gold-600">
              on website
            </span>
          )}
        </div>
      </header>

      {/* Live prices panel */}
      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat label="Spot / oz" value={quote ? `$${Number(quote.spot_per_oz).toFixed(2)}` : '—'} />
        <Stat label="We pay" value={quote ? `$${Number(quote.buy_unit_price).toFixed(2)}` : '—'} highlight />
        <Stat label="We sell" value={quote ? `$${Number(quote.sell_unit_price).toFixed(2)}` : '—'} highlight />
      </section>

      {/* Pricing rule editor */}
      <PricingRuleEditor productId={id} rule={rule} />

      {/* Display category override */}
      <DisplayCategoryPicker product={product} />
    </div>
  );
}

function DisplayCategoryPicker({ product }: { product: Product }) {
  const qc = useQueryClient();
  const { sections } = useDisplayCategories();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const auto = deriveDisplayCategory(product);
  const current = product.display_category_override ?? '';

  async function save(next: string) {
    setPending(next);
    setError(null);
    setOk(null);
    try {
      await apiFetch(`/admin/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          display_category_override: next, // '' signals clear
        }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'product', product.id] });
      await qc.invalidateQueries({ queryKey: ['admin', 'products', 'sheet'] });
      await qc.invalidateQueries({ queryKey: ['admin', 'inventory'] });
      setOk(next ? 'Pinned.' : 'Override cleared — using automatic routing.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
      <h2 className="text-base font-semibold">Display category</h2>
      <p className="mt-1 text-xs text-ink-400">
        Which section this product appears under on the Products page,
        In-stock sheet, What we pay, and Catalog. Leave on{' '}
        <span className="font-semibold">Automatic</span> to use name-based
        routing (<span className="font-mono">{auto}</span> for this product).
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <select
          value={current}
          onChange={(e) => save(e.target.value)}
          disabled={pending !== null}
          className="input md:w-80"
        >
          <option value="">Automatic ({auto})</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {pending !== null && <span className="text-xs text-ink-400">Saving…</span>}
      </div>
      {ok && (
        <p className="mt-2 rounded-md bg-green-50 px-3 py-1 text-xs text-green-700">{ok}</p>
      )}
      {error && (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-1 text-xs text-red-700">{error}</p>
      )}
    </section>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className={`rounded-xl border p-5 ${
        highlight ? 'border-ink-200 bg-white' : 'border-ink-200 bg-ink-50'
      }`}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-2 font-mono text-2xl font-semibold text-ink-900">{value}</div>
    </div>
  );
}

function PricingRuleEditor({
  productId,
  rule,
}: {
  productId: string;
  rule: PricingRule;
}) {
  const qc = useQueryClient();
  const [buyType, setBuyType] = useState<'percent' | 'flat'>(rule.buy_premium_type);
  const [buyValue, setBuyValue] = useState(String(Number(rule.buy_premium_value)));
  const [sellType, setSellType] = useState<'percent' | 'flat'>(rule.sell_premium_type);
  const [sellValue, setSellValue] = useState(String(Number(rule.sell_premium_value)));
  const [busy, setBusy] = useState<null | 'save' | 'reset'>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const inherits = rule.source !== 'product';

  async function save() {
    setStatus(null);
    setBusy('save');
    try {
      await apiFetch(`/admin/products/${productId}/pricing-override`, {
        method: 'PUT',
        body: JSON.stringify({
          buy_premium_type: buyType,
          buy_premium_value: Number(buyValue),
          sell_premium_type: sellType,
          sell_premium_value: Number(sellValue),
        }),
      });
      setStatus({ kind: 'ok', msg: 'Override saved. This product now uses its own rule.' });
      await qc.invalidateQueries({ queryKey: ['admin', 'product', productId] });
    } catch (err) {
      setStatus({
        kind: 'err',
        msg: err instanceof ApiError ? err.message : 'Save failed',
      });
    } finally {
      setBusy(null);
    }
  }

  async function resetToMetalDefault() {
    if (!confirm('Clear this override and fall back to the metal default?')) return;
    setStatus(null);
    setBusy('reset');
    try {
      await apiFetch(`/admin/products/${productId}/pricing-override`, {
        method: 'DELETE',
      });
      setStatus({ kind: 'ok', msg: 'Override cleared. Inheriting the metal default.' });
      await qc.invalidateQueries({ queryKey: ['admin', 'product', productId] });
    } catch (err) {
      setStatus({
        kind: 'err',
        msg: err instanceof ApiError ? err.message : 'Reset failed',
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-ink-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Pricing rule</h2>
          <p className="mt-1 text-sm text-ink-400">
            {inherits ? (
              <>
                Currently inheriting the <span className="font-medium capitalize">{rule.product_metal}</span>{' '}
                metal default. Save below to create a product-specific override.
              </>
            ) : (
              <>
                Product-specific override is active. Save to update; reset to inherit the{' '}
                <span className="capitalize">{rule.product_metal}</span> metal default again.
              </>
            )}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            inherits ? 'bg-ink-100 text-ink-600' : 'bg-gold-500/10 text-gold-600'
          }`}
        >
          {rule.source === 'product' ? 'override' : rule.source === 'metal' ? 'metal default' : 'no rule'}
        </span>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <PremiumInput
          label="What we pay (buy)"
          hint="Negative = discount below spot. Use flat for $/oz of metal content."
          type={buyType}
          value={buyValue}
          onTypeChange={setBuyType}
          onValueChange={setBuyValue}
        />
        <PremiumInput
          label="What we sell for"
          hint="Positive = premium over spot."
          type={sellType}
          value={sellValue}
          onTypeChange={setSellType}
          onValueChange={setSellValue}
        />
      </div>

      {status && (
        <div
          role={status.kind === 'err' ? 'alert' : undefined}
          className={`mt-4 rounded-md px-3 py-2 text-sm ${
            status.kind === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}
        >
          {status.msg}
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-2">
        {!inherits && (
          <button
            onClick={resetToMetalDefault}
            disabled={busy !== null}
            className="rounded-md border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-red-50 hover:text-red-700 disabled:opacity-60"
          >
            {busy === 'reset' ? 'Clearing…' : 'Reset to metal default'}
          </button>
        )}
        <button
          onClick={save}
          disabled={busy !== null}
          className="rounded-md bg-ink-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {busy === 'save' ? 'Saving…' : inherits ? 'Create override' : 'Save override'}
        </button>
      </div>
    </section>
  );
}

function PremiumInput({
  label,
  hint,
  type,
  value,
  onTypeChange,
  onValueChange,
}: {
  label: string;
  hint: string;
  type: 'percent' | 'flat';
  value: string;
  onTypeChange: (t: 'percent' | 'flat') => void;
  onValueChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
        {label}
      </div>
      <div className="mt-2 flex gap-2">
        <select
          value={type}
          onChange={(e) => onTypeChange(e.target.value as 'percent' | 'flat')}
          className="input w-24"
        >
          <option value="percent">%</option>
          <option value="flat">$/oz</option>
        </select>
        <input
          type="number"
          step="0.0001"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className="input flex-1 font-mono"
        />
      </div>
      <p className="mt-1 text-xs text-ink-400">{hint}</p>
    </div>
  );
}

/**
 * In-place name editor on the product detail header. Click the pencil →
 * input appears; Save persists via PATCH /admin/products/:id and
 * invalidates every list query that renders a product name so
 * Catalog / Products / In-stock / Buy-sheet / Invoices (new invoice
 * wizard) all refresh with the updated text on their next render.
 *
 * Historical invoices keep their old name — `product_name_snapshot` was
 * captured at invoice-create time (see migration 009 + invoices.service
 * line-item insert). Changing the product name here never rewrites that
 * snapshot, which is the correct audit behavior.
 */
function InlineNameEditor({ product }: { product: Product }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(product.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = value.trim();
    if (!next) {
      setError('Name is required.');
      return;
    }
    if (next === product.name) {
      setEditing(false);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/admin/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: next }),
      });
      // Invalidate every query that renders this name. React Query will
      // refetch on next mount; we also update the cached detail response
      // optimistically so the h1 reads correctly without waiting.
      qc.setQueryData(['admin', 'product', product.id], {
        ...product,
        name: next,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['admin', 'products'] }),
        qc.invalidateQueries({ queryKey: ['admin', 'products', 'sheet'] }),
        qc.invalidateQueries({ queryKey: ['admin', 'inventory'] }),
        qc.invalidateQueries({ queryKey: ['admin', 'product', product.id] }),
        qc.invalidateQueries({ queryKey: ['client', 'prices'] }),
        qc.invalidateQueries({ queryKey: ['client', 'in-stock'] }),
      ]);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setValue(product.name);
    setError(null);
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="flex items-start gap-2">
        <h1 className="text-2xl font-semibold leading-tight">{product.name}</h1>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-md border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600 hover:bg-ink-50"
          aria-label="Edit product name"
          title="Edit name"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            cancel();
          }
        }}
        autoFocus
        maxLength={200}
        className="input w-full text-lg font-semibold"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-ink-900 px-3 py-1 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700 hover:bg-ink-50"
        >
          Cancel
        </button>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
      <p className="text-[11px] text-ink-400">
        Past invoices keep whatever name was in effect the day they were
        created — renaming only affects future tickets and every live list.
      </p>
    </div>
  );
}
