'use client';

/**
 * Scrap Calculator — quick-quote tool for gold / silver / platinum
 * scrap. Multi-row by design: a real walk-in often brings 14K gold
 * jewelry + sterling silver + a platinum band, all priced separately.
 *
 * State is local to the page — calculations are throwaway unless the
 * operator clicks "Add to new invoice", which stashes the rows in
 * sessionStorage and routes to /admin/scrap/invoice (which hydrates
 * + clears the storage on mount).
 *
 * Defaults to BUY mode — sell-side scrap is rare (1% of usage), and
 * lives on the invoice page itself via the buy/sell toggle.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useLiveSpot } from '@/lib/use-live-spot';
import {
  ScrapRowBuilder,
  ScrapTotals,
} from '../_lib/scrap-row-builder';
import {
  blankScrapRow,
  SCRAP_HANDOFF_KEY,
  type ScrapRow,
} from '../_lib/scrap-types';

export default function ScrapCalculatorPage() {
  const router = useRouter();
  const { spot } = useLiveSpot();

  // Seed with one empty row so the page isn't a blank wall on first load.
  const [rows, setRows] = useState<ScrapRow[]>(() => [blankScrapRow()]);

  const spotPrices = spot
    ? {
        gold: spot.gold,
        silver: spot.silver,
        platinum: spot.platinum,
        palladium: spot.palladium,
      }
    : null;

  function addRow() {
    // Inherit metal + purity from the previous row so chained entries
    // don't force the operator to reselect everything per item.
    const prev = rows[rows.length - 1];
    const seed = blankScrapRow(spotPrices?.[prev?.metal ?? 'gold']);
    if (prev) {
      seed.metal = prev.metal;
      seed.purity = prev.purity;
      seed.weight_unit = prev.weight_unit;
      seed.percent_adjust = prev.percent_adjust;
      seed.spot_per_oz = spotPrices?.[prev.metal] ?? prev.spot_per_oz;
    } else if (spotPrices) {
      seed.spot_per_oz = spotPrices.gold;
    }
    setRows([...rows, seed]);
  }

  function clearAll() {
    if (rows.length === 0) return;
    if (rows.length === 1 && !rows[0].weight && !rows[0].spot_per_oz) {
      // Nothing meaningful to clear — no confirm needed.
      return;
    }
    if (
      window.confirm(
        'Clear all scrap rows? This cannot be undone — but rows are not saved anywhere yet.',
      )
    ) {
      setRows([blankScrapRow(spotPrices?.gold)]);
    }
  }

  function sendToInvoice() {
    // Drop empty rows so the invoice page doesn't surface blanks.
    const usable = rows.filter(
      (r) => parseFloat(r.weight) > 0 && parseFloat(r.spot_per_oz) > 0,
    );
    if (usable.length === 0) {
      alert('Add at least one row with a weight + spot price first.');
      return;
    }
    try {
      sessionStorage.setItem(SCRAP_HANDOFF_KEY, JSON.stringify(usable));
    } catch {
      // sessionStorage can fail in private-browsing edge cases — fall
      // through to navigation; the invoice page just starts blank.
    }
    router.push('/admin/scrap/invoice');
  }

  // Pre-fill spot on the seed row once live spot loads. Initial render
  // happens before useLiveSpot's query resolves, so this useEffect
  // backfills once the data lands. Guarded on (only one untouched
  // row) so we don't trample operator-edited spot prices.
  useEffect(() => {
    if (!spot) return;
    setRows((current) => {
      if (current.length !== 1) return current;
      const r = current[0];
      if (r.spot_per_oz || r.weight) return current;
      const seeded = spotPrices?.[r.metal] ?? '';
      if (!seeded) return current;
      return [{ ...r, spot_per_oz: seeded }];
    });
    // spotPrices is derived from spot, so spot in the dep list covers both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spot]);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Scrap Calculator</h1>
          <p className="mt-1 text-sm text-ink-500">
            Quick quotes for gold, silver, and platinum scrap. Multi-row
            — add one entry per item the customer brings in.
          </p>
        </div>
        <Link
          href="/admin/scrap/invoice"
          className="text-sm text-ink-500 underline-offset-2 hover:underline"
        >
          go to scrap invoice →
        </Link>
      </div>

      {/* Live spot ribbon — keeps the operator anchored on the prices
          driving each row's calculation. */}
      <div className="mt-4 flex flex-wrap items-center gap-4 rounded-md border border-ink-200 bg-ink-50/60 px-4 py-2 text-sm">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Live spot ($/troy oz)
        </span>
        {spot ? (
          <>
            <span className="font-mono">
              <span className="text-ink-400">Au</span> ${formatSpot(spot.gold)}
            </span>
            <span className="font-mono">
              <span className="text-ink-400">Ag</span> ${formatSpot(spot.silver)}
            </span>
            <span className="font-mono">
              <span className="text-ink-400">Pt</span>{' '}
              ${formatSpot(spot.platinum)}
            </span>
            <span className="font-mono">
              <span className="text-ink-400">Pd</span>{' '}
              ${formatSpot(spot.palladium)}
            </span>
          </>
        ) : (
          <span className="text-xs text-ink-400">Loading…</span>
        )}
      </div>

      <div className="mt-6">
        <ScrapRowBuilder
          rows={rows}
          onChange={setRows}
          spotPrices={spotPrices}
          mode="buy"
        />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={addRow}
          className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium hover:bg-ink-50"
        >
          + Add row
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-600 hover:bg-ink-50"
        >
          Clear all
        </button>
      </div>

      <ScrapTotals rows={rows} mode="buy" />

      <div className="mt-6 flex items-center justify-end gap-2 border-t border-ink-100 pt-4">
        <Link
          href="/admin"
          className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-600 hover:bg-ink-50"
        >
          Discard
        </Link>
        <button
          type="button"
          onClick={sendToInvoice}
          className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-ink-800"
        >
          Add to new invoice →
        </button>
      </div>
    </div>
  );
}

function formatSpot(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
