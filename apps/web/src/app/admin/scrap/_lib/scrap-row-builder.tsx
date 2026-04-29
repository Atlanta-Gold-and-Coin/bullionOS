'use client';

/**
 * Shared row-builder used by both /admin/scrap/calculator and
 * /admin/scrap/invoice. Renders one editable scrap row + the
 * derived totals on the right. The parent owns the rows[] state;
 * this component is purely presentational.
 *
 * Mode prop flips the percent-adjust label between "% off spot"
 * (buy — operator's discount) and "% over spot" (sell — markup),
 * and the math in computeScrapRow does the same flip.
 */

import {
  PURITY_OPTIONS,
  SCRAP_METALS,
  UNIT_LABEL,
  METAL_LABEL,
  computeScrapRow,
  type ScrapMetal,
  type ScrapRow,
  type ScrapWeightUnit,
} from './scrap-types';

export type SpotPriceMap = Record<ScrapMetal, string>;

interface Props {
  rows: ScrapRow[];
  onChange: (rows: ScrapRow[]) => void;
  /** Live spot prices in $/troy oz. Used to pre-fill new rows. */
  spotPrices?: SpotPriceMap | null;
  mode?: 'buy' | 'sell';
}

export function ScrapRowBuilder({
  rows,
  onChange,
  spotPrices,
  mode = 'buy',
}: Props) {
  function update(id: string, patch: Partial<ScrapRow>) {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function remove(id: string) {
    onChange(rows.filter((r) => r.id !== id));
  }

  return (
    <div className="space-y-3">
      {rows.map((row, idx) => (
        <ScrapRowCard
          key={row.id}
          row={row}
          index={idx}
          mode={mode}
          onPatch={(p) => update(row.id, p)}
          onRemove={() => remove(row.id)}
          onMetalChange={(metal) => {
            // When metal changes, snap purity to the first valid option
            // for the new metal AND re-suggest the spot price for that
            // metal (operator can still override).
            const firstPurity = PURITY_OPTIONS[metal][0].value;
            const suggestedSpot =
              spotPrices?.[metal] ?? row.spot_per_oz;
            update(row.id, {
              metal,
              purity: firstPurity,
              spot_per_oz: suggestedSpot,
            });
          }}
        />
      ))}
    </div>
  );
}

function ScrapRowCard({
  row,
  index,
  mode,
  onPatch,
  onRemove,
  onMetalChange,
}: {
  row: ScrapRow;
  index: number;
  mode: 'buy' | 'sell';
  onPatch: (p: Partial<ScrapRow>) => void;
  onRemove: () => void;
  onMetalChange: (m: ScrapMetal) => void;
}) {
  const computed = computeScrapRow(row, mode);
  const adjustLabel = mode === 'buy' ? '% off spot' : '% over spot';
  const adjustHelp =
    mode === 'buy'
      ? 'Discount applied to spot value (your margin).'
      : 'Markup applied to spot value (your premium).';

  return (
    <div className="rounded-lg border border-ink-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-900 text-[10px] font-semibold text-white">
          {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-ink-400 hover:text-red-700"
          title="Remove this row"
        >
          ✕ Remove
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Metal">
          <select
            className="input"
            value={row.metal}
            onChange={(e) => onMetalChange(e.target.value as ScrapMetal)}
          >
            {SCRAP_METALS.map((m) => (
              <option key={m} value={m}>
                {METAL_LABEL[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Purity">
          <select
            className="input"
            value={String(row.purity)}
            onChange={(e) => onPatch({ purity: parseFloat(e.target.value) })}
          >
            {PURITY_OPTIONS[row.metal].map((p) => (
              <option key={p.label} value={String(p.value)}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Weight">
          <input
            className="input"
            type="number"
            min={0}
            step="0.001"
            value={row.weight}
            onChange={(e) => onPatch({ weight: e.target.value })}
            placeholder="0.000"
          />
        </Field>
        <Field label="Unit">
          <select
            className="input"
            value={row.weight_unit}
            onChange={(e) =>
              onPatch({ weight_unit: e.target.value as ScrapWeightUnit })
            }
          >
            {(['dwt', 'g', 'toz'] as ScrapWeightUnit[]).map((u) => (
              <option key={u} value={u}>
                {UNIT_LABEL[u]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Spot $/troy oz">
          <input
            className="input font-mono"
            type="number"
            min={0}
            step="0.01"
            value={row.spot_per_oz}
            onChange={(e) => onPatch({ spot_per_oz: e.target.value })}
            placeholder="0.00"
          />
        </Field>
        <Field label="Pure metal (toz)">
          <output className="block rounded-md border border-ink-200 bg-ink-50 px-3 py-1.5 text-sm font-mono text-ink-600">
            {computed.pure_troy_oz.toFixed(4)}
          </output>
        </Field>
        <Field label="Spot value">
          <output className="block rounded-md border border-ink-200 bg-ink-50 px-3 py-1.5 text-sm font-mono text-ink-700">
            {money(computed.spot_value)}
          </output>
        </Field>
        <Field label={adjustLabel} help={adjustHelp}>
          <input
            className="input"
            type="number"
            min={0}
            step="0.1"
            value={row.percent_adjust}
            onChange={(e) => onPatch({ percent_adjust: e.target.value })}
            placeholder="0"
          />
        </Field>
      </div>

      <div className="mt-3 flex items-center justify-end border-t border-ink-100 pt-3">
        <span className="text-xs uppercase tracking-wide text-ink-400">
          {mode === 'buy' ? 'You pay' : 'You charge'}
        </span>
        <span className="ml-3 font-mono text-lg font-semibold text-ink-900">
          {money(computed.final_price)}
        </span>
      </div>
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wide text-ink-400">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {help && <p className="mt-1 text-[10px] text-ink-400">{help}</p>}
    </div>
  );
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function ScrapTotals({
  rows,
  mode = 'buy',
}: {
  rows: ScrapRow[];
  mode?: 'buy' | 'sell';
}) {
  let spotTotal = 0;
  let finalTotal = 0;
  for (const row of rows) {
    const c = computeScrapRow(row, mode);
    spotTotal += c.spot_value;
    finalTotal += c.final_price;
  }
  return (
    <div className="mt-6 rounded-xl border border-ink-200 bg-ink-50/40 p-5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Total spot value
        </span>
        <span className="font-mono text-base text-ink-700">
          {money(spotTotal)}
        </span>
      </div>
      <div className="mt-2 flex items-baseline justify-between border-t border-ink-200 pt-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-700">
          {mode === 'buy' ? 'Total to pay' : 'Total to charge'}
        </span>
        <span className="font-mono text-2xl font-semibold text-ink-900">
          {money(finalTotal)}
        </span>
      </div>
    </div>
  );
}
