/**
 * Shared types + constants for the Scrap Calculator and Scrap Invoice
 * pages. Keeping the data shape + industry constants here means the
 * two pages stay in sync — when you edit a row on the invoice page,
 * the calculation matches what the calculator showed.
 */

export type ScrapMetal = 'gold' | 'silver' | 'platinum' | 'palladium';
export type ScrapWeightUnit = 'dwt' | 'g' | 'toz';

export interface PurityOption {
  /** Decimal fraction 0–1, e.g. 0.583 for 14K. */
  value: number;
  /** Display label, e.g. "14K (.583)". */
  label: string;
  /** Short label for line-item snapshot, e.g. "14K". */
  short: string;
}

/**
 * Standard scrap purities per metal. Karat values use the FTC-approved
 * decimal equivalents (10K = .417, 14K = .583, 18K = .750, etc.).
 * Silver "coin" is the .900 used by pre-1965 US coins; sterling is
 * .925. Platinum jewelry standard is .950 (the legal "PLAT" stamp);
 * .999 is industrial-grade. Palladium jewelry is almost always .950
 * — .500 covers older industrial alloys and pre-2010 sub-quality
 * jewelry occasionally seen at the counter.
 */
export const PURITY_OPTIONS: Record<ScrapMetal, PurityOption[]> = {
  gold: [
    { value: 0.375, label: '9K (.375)', short: '9K' },
    { value: 0.417, label: '10K (.417)', short: '10K' },
    { value: 0.5, label: '12K (.500)', short: '12K' },
    { value: 0.583, label: '14K (.583)', short: '14K' },
    { value: 0.667, label: '16K (.667)', short: '16K' },
    { value: 0.75, label: '18K (.750)', short: '18K' },
    { value: 0.833, label: '20K (.833)', short: '20K' },
    { value: 0.875, label: '21K (.875)', short: '21K' },
    { value: 0.917, label: '22K (.917)', short: '22K' },
    { value: 0.999, label: '24K (.999)', short: '24K' },
  ],
  silver: [
    { value: 0.8, label: '.800', short: '.800' },
    { value: 0.835, label: '.835', short: '.835' },
    { value: 0.875, label: '.875', short: '.875' },
    { value: 0.9, label: '.900 (coin)', short: '.900 coin' },
    { value: 0.925, label: '.925 (sterling)', short: 'Sterling .925' },
    { value: 0.958, label: '.958 (Britannia)', short: 'Britannia .958' },
    { value: 0.999, label: '.999 (fine)', short: '.999 fine' },
  ],
  platinum: [
    { value: 0.585, label: '.585', short: 'Pt .585' },
    { value: 0.6, label: '.600', short: 'Pt .600' },
    { value: 0.8, label: '.800', short: 'Pt .800' },
    { value: 0.85, label: '.850', short: 'Pt .850' },
    { value: 0.9, label: '.900', short: 'Pt .900' },
    { value: 0.95, label: '.950', short: 'Pt .950' },
    { value: 0.999, label: '.999', short: 'Pt .999' },
  ],
  palladium: [
    { value: 0.5, label: '.500', short: 'Pd .500' },
    { value: 0.95, label: '.950', short: 'Pd .950' },
    { value: 0.999, label: '.999', short: 'Pd .999' },
  ],
};

/**
 * Conversion factors from each unit → troy ounces.
 *   1 troy oz = 20 dwt = 31.1034768 g
 * The constant mirrors the long form so anyone reading it can verify
 * the numbers without external reference.
 */
export const UNIT_TO_TROY_OZ: Record<ScrapWeightUnit, number> = {
  dwt: 1 / 20,
  g: 1 / 31.1034768,
  toz: 1,
};

export const UNIT_LABEL: Record<ScrapWeightUnit, string> = {
  dwt: 'dwt (pennyweight)',
  g: 'grams',
  toz: 'troy oz',
};

export const METAL_LABEL: Record<ScrapMetal, string> = {
  gold: 'Gold',
  silver: 'Silver',
  platinum: 'Platinum',
  palladium: 'Palladium',
};

/** All metals the scrap UIs surface, in display order. */
export const SCRAP_METALS: readonly ScrapMetal[] = [
  'gold',
  'silver',
  'platinum',
  'palladium',
] as const;

/**
 * One scrap line — covers both the calculator and the invoice editor.
 *
 * String types on numeric fields keep input controls cooperative
 * (avoids the "controlled-input flicker" when binding raw numbers).
 * Derived values (spot value, final price) are recomputed on every
 * render via {@link computeScrapRow} — single source of truth, no
 * stale derived state.
 */
export interface ScrapRow {
  /** Local-only id used for React keys; not persisted. */
  id: string;
  metal: ScrapMetal;
  purity: number;
  weight: string;
  weight_unit: ScrapWeightUnit;
  /** $/troy oz. Pre-filled from the live spot feed; operator can override. */
  spot_per_oz: string;
  /**
   * "% off spot" in buy mode (operator's discount), or "% over spot"
   * in sell mode (operator's markup). The label flips on the invoice
   * page; calculator always treats it as buy-side discount.
   */
  percent_adjust: string;
}

export interface ScrapRowComputed {
  weight_troy_oz: number;
  pure_troy_oz: number;
  spot_value: number;
  final_price: number;
}

/** Pure math — derives the computed fields from a ScrapRow. */
export function computeScrapRow(
  row: ScrapRow,
  mode: 'buy' | 'sell' = 'buy',
): ScrapRowComputed {
  const weight = parseFloat(row.weight) || 0;
  const factor = UNIT_TO_TROY_OZ[row.weight_unit];
  const weight_troy_oz = weight * factor;
  const pure_troy_oz = weight_troy_oz * row.purity;
  const spot = parseFloat(row.spot_per_oz) || 0;
  const spot_value = pure_troy_oz * spot;
  const pct = parseFloat(row.percent_adjust) || 0;
  const adjustFactor = mode === 'buy' ? 1 - pct / 100 : 1 + pct / 100;
  const final_price = spot_value * adjustFactor;
  return { weight_troy_oz, pure_troy_oz, spot_value, final_price };
}

/**
 * Render a row as a free-form line-item snapshot suitable for an
 * ad-hoc invoice line. Format: "Gold scrap · 14K · 5.2 dwt".
 * Goes into invoice_line_items.product_name_snapshot.
 */
export function snapshotName(row: ScrapRow): string {
  const purity =
    PURITY_OPTIONS[row.metal].find((p) => p.value === row.purity)?.short ??
    row.purity.toFixed(3);
  const unit =
    row.weight_unit === 'toz' ? 'toz' : row.weight_unit;
  return `${METAL_LABEL[row.metal]} scrap · ${purity} · ${row.weight} ${unit}`;
}

/** Empty starter row, defaulting to gold/14K/dwt with 0% off. */
export function blankScrapRow(spotPerOz?: string): ScrapRow {
  return {
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2),
    metal: 'gold',
    purity: 0.583,
    weight: '',
    weight_unit: 'dwt',
    spot_per_oz: spotPerOz ?? '',
    percent_adjust: '0',
  };
}

export const SCRAP_HANDOFF_KEY = 'agc-scrap-pending-rows';
