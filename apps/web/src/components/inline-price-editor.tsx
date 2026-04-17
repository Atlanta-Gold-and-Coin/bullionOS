'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

export interface PricingRule {
  product_id: string;
  product_metal: string;
  source: 'metal' | 'product' | 'none';
  rule_id: string | null;
  buy_premium_type: 'percent' | 'flat';
  buy_premium_value: string;
  sell_premium_type: 'percent' | 'flat';
  sell_premium_value: string;
}

/**
 * Compact row-level pricing editor for the In-stock and Buy sheets.
 *
 * Shows a single "Edit" button that expands into an inline buy/sell
 * premium form. Writes via PUT /admin/products/:id/pricing-override —
 * same endpoint the product detail page uses — so there's only one source
 * of truth for product pricing. A 'Reset' button clears the override and
 * falls back to the metal default.
 */
export function InlinePriceEditor({
  productId,
  rule,
  onChanged,
}: {
  productId: string;
  rule: PricingRule;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [buyType, setBuyType] = useState(rule.buy_premium_type);
  const [buyValue, setBuyValue] = useState(String(Number(rule.buy_premium_value)));
  const [sellType, setSellType] = useState(rule.sell_premium_type);
  const [sellValue, setSellValue] = useState(String(Number(rule.sell_premium_value)));
  const [busy, setBusy] = useState<null | 'save' | 'reset'>(null);
  const [error, setError] = useState<string | null>(null);

  const inherits = rule.source !== 'product';

  async function save() {
    setError(null);
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
      await qc.invalidateQueries({ queryKey: ['admin', 'product', productId, 'rule'] });
      onChanged();
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function resetOverride() {
    if (!confirm(`Clear override and inherit the ${rule.product_metal} metal default?`)) return;
    setError(null);
    setBusy('reset');
    try {
      await apiFetch(`/admin/products/${productId}/pricing-override`, {
        method: 'DELETE',
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'product', productId, 'rule'] });
      onChanged();
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed');
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => setOpen(true)}
          className="rounded-md border border-ink-200 px-2 py-1 text-xs hover:bg-ink-50"
        >
          Edit
        </button>
        <span
          className={`text-[10px] ${inherits ? 'text-ink-400' : 'text-gold-600'}`}
        >
          {inherits ? 'metal default' : 'override'}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2 text-xs">
      <div className="flex items-center gap-1">
        <span className="text-ink-400">Buy</span>
        <input
          value={buyValue}
          onChange={(e) => setBuyValue(e.target.value)}
          className="w-14 rounded border border-ink-200 px-1 py-0.5 text-right font-mono"
          placeholder="0"
        />
        <select
          value={buyType}
          onChange={(e) => setBuyType(e.target.value as 'percent' | 'flat')}
          className="rounded border border-ink-200 px-1 py-0.5"
        >
          <option value="percent">%</option>
          <option value="flat">$</option>
        </select>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-ink-400">Sell</span>
        <input
          value={sellValue}
          onChange={(e) => setSellValue(e.target.value)}
          className="w-14 rounded border border-ink-200 px-1 py-0.5 text-right font-mono"
          placeholder="0"
        />
        <select
          value={sellType}
          onChange={(e) => setSellType(e.target.value as 'percent' | 'flat')}
          className="rounded border border-ink-200 px-1 py-0.5"
        >
          <option value="percent">%</option>
          <option value="flat">$</option>
        </select>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={save}
          disabled={busy !== null}
          className="rounded bg-ink-900 px-2 py-0.5 text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {busy === 'save' ? '…' : 'Save'}
        </button>
        {!inherits && (
          <button
            onClick={resetOverride}
            disabled={busy !== null}
            className="rounded border border-ink-200 px-2 py-0.5 hover:bg-red-50 hover:text-red-700"
          >
            {busy === 'reset' ? '…' : 'Reset'}
          </button>
        )}
        <button
          onClick={() => setOpen(false)}
          className="rounded border border-ink-200 px-2 py-0.5 hover:bg-ink-50"
        >
          ×
        </button>
      </div>
      {error && <div className="text-red-700">{error}</div>}
    </div>
  );
}
