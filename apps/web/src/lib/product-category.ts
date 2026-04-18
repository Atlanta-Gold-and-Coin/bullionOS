/**
 * Shared derivation of display categories for the inventory + in-stock sheets.
 *
 * The DB-level `category` column is intentionally coarse (coin/bar/round/…).
 * For the counter-facing views the operator thinks in 9 buckets (gold
 * coins vs gold bars vs pre-1933 gold vs …), so we compute those from
 * metal + category + name. Keeping this out of the DB avoids a migration
 * every time the taxonomy shifts and lets the same SKU land in whichever
 * bucket best fits the display.
 *
 * Exact ordering of SECTIONS controls the on-page section order. Within
 * each section, products keep whatever sort the caller applies (typically
 * name, or by size using preferredSortKey below).
 */

export type DisplayCategory =
  | 'gold_coins'
  | 'gold_bars'
  | 'pre_1933_gold'
  | 'silver_coins'
  | 'silver_junk'
  | 'silver_generic'
  | 'silver_mint_sets'
  | 'platinum_coins'
  | 'platinum_bars'
  | 'palladium_coins'
  | 'palladium_bars'
  | 'other';

export type MetalGroup = 'gold' | 'silver' | 'platinum' | 'palladium' | 'other';

export interface DisplaySection {
  id: DisplayCategory;
  label: string;
  /** Metal this section rolls up under for the top-level header strip. */
  metal: MetalGroup;
}

export const SECTIONS: DisplaySection[] = [
  { id: 'gold_coins', label: 'Gold Coins', metal: 'gold' },
  { id: 'gold_bars', label: 'Gold Bars', metal: 'gold' },
  { id: 'pre_1933_gold', label: 'Pre-1933 U.S. Gold Coins', metal: 'gold' },
  { id: 'silver_coins', label: 'Silver Coins', metal: 'silver' },
  { id: 'silver_junk', label: 'Junk Silver (90%)', metal: 'silver' },
  { id: 'silver_generic', label: 'Silver Rounds / Bars (Generic)', metal: 'silver' },
  { id: 'silver_mint_sets', label: 'Silver U.S. Mint Sets', metal: 'silver' },
  { id: 'platinum_coins', label: 'Platinum Coins', metal: 'platinum' },
  { id: 'platinum_bars', label: 'Platinum Bars', metal: 'platinum' },
  { id: 'palladium_coins', label: 'Palladium Coins', metal: 'palladium' },
  { id: 'palladium_bars', label: 'Palladium Bars', metal: 'palladium' },
  { id: 'other', label: 'Other', metal: 'other' },
];

/** Display label + visual accent for each metal group. */
export const METAL_GROUPS: Record<
  MetalGroup,
  { label: string; accentClass: string }
> = {
  gold: { label: 'Gold', accentClass: 'text-amber-700 border-amber-300 bg-amber-50' },
  silver: { label: 'Silver', accentClass: 'text-slate-700 border-slate-300 bg-slate-50' },
  platinum: { label: 'Platinum', accentClass: 'text-sky-700 border-sky-300 bg-sky-50' },
  palladium: {
    label: 'Palladium',
    accentClass: 'text-violet-700 border-violet-300 bg-violet-50',
  },
  other: { label: 'Other', accentClass: 'text-ink-600 border-ink-200 bg-ink-50' },
};

/**
 * Partition a list of sections into metal groups, preserving order.
 * Used by every view that renders the metal → section → items structure.
 */
export function groupSectionsByMetal(
  sections: DisplaySection[],
): Array<{ metal: MetalGroup; sections: DisplaySection[] }> {
  const out: Array<{ metal: MetalGroup; sections: DisplaySection[] }> = [];
  for (const s of sections) {
    const tail = out[out.length - 1];
    if (tail && tail.metal === s.metal) {
      tail.sections.push(s);
    } else {
      out.push({ metal: s.metal, sections: [s] });
    }
  }
  return out;
}

export function deriveDisplayCategory(p: {
  metal: string;
  category: string;
  name: string;
}): DisplayCategory {
  const n = p.name.toLowerCase();
  const m = p.metal.toLowerCase();
  const c = p.category.toLowerCase();

  // Pre-1933: US legal-tender gold with a year in 1800s–1932, or a known
  // design name. Saint-Gaudens and Indian Head are the giveaways when the
  // item_name doesn't explicitly spell out "Pre-1933".
  if (m === 'gold') {
    if (
      /pre.?1933|saint.?gaudens|indian.head|liberty head/.test(n) ||
      /\b18\d{2}\b|\b19[0-2]\d\b|\b193[0-2]\b/.test(n)
    ) {
      return 'pre_1933_gold';
    }
    if (c === 'bar' || /\bbar\b/.test(n)) return 'gold_bars';
    return 'gold_coins';
  }
  if (m === 'silver') {
    // Mint sets first — names like "Silver Proof Set", "Premier", "Prestige",
    // "Uncirculated Mint Set". These are dated multi-coin sets with AGW
    // already totalled on the CSV.
    if (
      /\bprestige\b|\bpremier\b|\bproof\s+set\b|\buncirculated\s+mint\s+set\b/.test(n)
    ) {
      return 'silver_mint_sets';
    }
    // Junk silver: 90% US coinage (Morgan / Peace dollars, pre-'65 US
    // Half / Quarter / Dime). The price tag on these is driven by silver
    // content, not numismatics, so they live in their own bucket.
    if (
      /\bmorgan\b|\bpeace\b|\bus\s+dollar\b|\bsilver\s+dollar\b|\bus\s+half\b|\bus\s+quarter\b|\bus\s+dime\b|\bhalf\s+dollar\b|\b90%\b/.test(n)
    ) {
      return 'silver_junk';
    }
    if (c === 'bar' || c === 'round' || /\bgeneric\b|\bround\b|\bbar\b/.test(n)) {
      return 'silver_generic';
    }
    return 'silver_coins';
  }
  if (m === 'platinum') {
    if (c === 'bar' || /\bbar\b/.test(n)) return 'platinum_bars';
    return 'platinum_coins';
  }
  if (m === 'palladium') {
    if (c === 'bar' || /\bbar\b/.test(n)) return 'palladium_bars';
    return 'palladium_coins';
  }
  return 'other';
}

/**
 * Sort key that keeps sized variants of a family together in the natural
 * size order. "1 oz American Gold Eagle - Any Year" → ["American Gold
 * Eagle - Any Year", 1.0] so the 1 oz, 1/2 oz, 1/4 oz, 1/10 oz Eagles
 * cluster and sort largest → smallest within the cluster.
 *
 * Returns a [family, -sizeOz, originalName] triple for stable sorting.
 * Falls back to the whole name if no leading size is detected.
 */
export function familySortKey(p: {
  name: string;
  weight_troy_oz: string;
}): [string, number, string] {
  const m = /^\s*(\d+(?:\.\d+)?|\d+\/\d+)\s*oz\s+(.*)$/i.exec(p.name);
  if (m) {
    const sizeStr = m[1];
    let size: number;
    if (sizeStr.includes('/')) {
      const [num, den] = sizeStr.split('/').map(Number);
      size = num / den;
    } else {
      size = Number(sizeStr);
    }
    const family = m[2].trim().toLowerCase();
    // Negative size → largest first inside the family group.
    return [family, -size, p.name];
  }
  // Fallback: use weight_troy_oz for size and whole name as family.
  const size = Number(p.weight_troy_oz) || 0;
  return [p.name.toLowerCase(), -size, p.name];
}

export function compareByFamily(
  a: { name: string; weight_troy_oz: string },
  b: { name: string; weight_troy_oz: string },
): number {
  const [af, asSize, an] = familySortKey(a);
  const [bf, bsSize, bn] = familySortKey(b);
  if (af !== bf) return af.localeCompare(bf);
  if (asSize !== bsSize) return asSize - bsSize;
  return an.localeCompare(bn);
}
