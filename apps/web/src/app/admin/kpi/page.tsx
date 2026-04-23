'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

type Period = 'day' | 'week' | 'month' | 'quarter' | 'year';

interface Bucket {
  bucket_start: string;
  purchases: string;
  /** RETAIL sales only — disjoint from `wholesale`. */
  sales: string;
  /** Wholesaler-client flows (buy + sell combined). */
  wholesale: string;
  /** SELL-side portion of `wholesale`. Used by the Net-sales total
   *  so wholesale revenue is included without also subtracting the
   *  wholesale-buy side. */
  wholesale_sales: string;
}

interface KpiResponse {
  period: Period;
  buckets: Bucket[];
}

const PERIODS: Array<{ id: Period; label: string; default: number }> = [
  { id: 'day', label: 'Daily', default: 30 },
  { id: 'week', label: 'Weekly', default: 24 },
  { id: 'month', label: 'Monthly', default: 12 },
  { id: 'quarter', label: 'Quarterly', default: 8 },
  { id: 'year', label: 'Yearly', default: 5 },
];

const SERIES = [
  {
    key: 'sales' as const,
    label: 'In-office sales',
    color: '#1f6b3e', // sell-600
    dotBg: 'bg-sell-600',
  },
  {
    key: 'purchases' as const,
    label: 'In-office purchases',
    color: '#1e3a78', // buy-600
    dotBg: 'bg-buy-600',
  },
  {
    key: 'wholesale' as const,
    label: 'Wholesale',
    color: '#b08e4a', // gold-600
    dotBg: 'bg-gold-600',
  },
] as const;

export default function KpiPage() {
  const [period, setPeriod] = useState<Period>('day');
  const buckets = PERIODS.find((p) => p.id === period)?.default ?? 30;

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'kpi', period, buckets],
    queryFn: () =>
      apiFetch<KpiResponse>(`/admin/kpi?period=${period}&buckets=${buckets}`),
    // Refresh every minute so the dashboard shows today's activity live.
    refetchInterval: 60_000,
  });

  // Top running totals reflect the CURRENT period only — today for
  // `day`, this-week for `week`, etc. The server always emits buckets
  // ending at date_trunc(period, now() AT TIME ZONE 'America/New_York'),
  // so the last row in the array is the active period. Previously we
  // summed every bucket, which made "Daily" show a 30-day running
  // total instead of just today.
  //
  // Rollover is automatic: once the wall-clock passes midnight US/
  // Eastern, the next 60-second refetch returns a new "last bucket"
  // whose bucket_start is the new day, and these cards reset.
  const totals = useMemo(() => {
    const rows = data?.buckets ?? [];
    if (rows.length === 0) return { sales: 0, purchases: 0, wholesale: 0 };
    const current = rows[rows.length - 1];
    return {
      sales: Number(current.sales),
      purchases: Number(current.purchases),
      wholesale: Number(current.wholesale),
    };
  }, [data]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">KPI</h1>
        </div>
        <nav className="flex gap-1 rounded-md border border-ink-200 bg-white p-1 text-sm">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className={`rounded px-3 py-1.5 transition ${
                period === p.id
                  ? 'bg-ink-900 text-white'
                  : 'text-ink-600 hover:text-ink-900'
              }`}
            >
              {p.label}
            </button>
          ))}
        </nav>
      </div>

      <section className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
        {SERIES.map((s) => (
          <TotalCard
            key={s.key}
            // Card label reflects the SINGLE current bucket rather than
            // the whole window — "Today", "This week", etc. The
            // timeline chart below still shows the N-bucket history.
            label={`${s.label} · ${currentPeriodLabel(period)}`}
            value={totals[s.key]}
            color={s.color}
          />
        ))}
      </section>

      {/* Wholesale receivables KPI (WH-003). Independent of the period
          selector — it's a real-time snapshot of outstanding AR, not a
          historical rollup. Drills down to /admin/wholesale/reconciliation. */}
      <WholesaleOwedCard />

      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Timeline</h2>
          <div className="flex items-center gap-4 text-xs text-ink-600">
            {SERIES.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.dotBg}`} />
                {s.label}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          {/* Reverse so the most recent bucket sits at x=0 (leftmost).
              Operators scan "what happened today" first and drill backward
              into history; matches the reversed rollup table below. */}
          <BarChart
            buckets={(data?.buckets ?? []).slice().reverse()}
            period={period}
            loading={isLoading}
          />
        </div>
      </section>

      {/* Per-wholesaler breakdown — stacked bars so each wholesaler's
          contribution to the combined "Wholesale" line above is
          visible at a glance. Same period selector drives both charts.
          Covers live wholesale invoices + historical_invoices where
          is_wholesale=true + kpi_manual_entries category='wholesale'
          (monthly+). Separate component so the fetch is independent
          of the main rollup. */}
      <WholesaleBreakdownCard period={period} />


      {/* MOB-002: rollup table scrolls horizontally on narrow screens. */}
      <section className="mt-4 overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full min-w-[680px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Bucket</th>
              <th className="px-4 py-3 text-right">Sales</th>
              <th className="px-4 py-3 text-right">Wholesale</th>
              <th className="px-4 py-3 text-right">Purchases</th>
              <th
                className="px-4 py-3 text-right"
                title="All sales (retail + wholesale sells) minus all purchases"
              >
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {(data?.buckets ?? []).slice().reverse().map((b) => {
              // Net = all sales − all purchases. Include wholesale
              // SELLS only (wholesale_sales is the sell portion of
              // the combined wholesale column), so we don't subtract
              // wholesale-buy twice (it's already in purchases).
              const totalSales = Number(b.sales) + Number(b.wholesale_sales || 0);
              const net = totalSales - Number(b.purchases);
              return (
                <tr key={b.bucket_start} className="border-t border-ink-200">
                  <td className="px-4 py-3">{formatBucket(b.bucket_start, period)}</td>
                  <td className="px-4 py-3 text-right font-mono">
                    {money(b.sales)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {money(b.wholesale)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {money(b.purchases)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-mono font-semibold ${
                      net >= 0 ? 'text-sell-700' : 'text-red-700'
                    }`}
                    title={`${money(totalSales)} − ${money(b.purchases)}`}
                  >
                    {money(net)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/**
 * Real-time wholesale AR card (WH-003). Shows:
 *   1. Grand total owed by all wholesalers
 *   2. Top 5 wholesalers by outstanding balance
 *   3. Link to the full reconciliation page
 *
 * Refreshes every 30s so "Mark paid" on the reconciliation page is
 * reflected here within a half-minute without a manual refresh.
 */
/**
 * Stacked-bar chart of per-wholesaler activity over time. Each
 * wholesaler gets a deterministic color hashed from their client_id
 * so the same wholesaler keeps the same color across re-renders +
 * across period changes.
 *
 * Data source: GET /admin/kpi/wholesale-breakdown. Backed by the
 * same three-table UNION as the main rollup (live invoices +
 * historical_invoices + kpi_manual_entries) so numbers line up with
 * the combined "Wholesale" bar above.
 *
 * Empty state: renders a subdued "No wholesale activity in this
 * range" card — the operator might land here during their first
 * viewing of a historical period.
 */
function WholesaleBreakdownCard({ period }: { period: Period }) {
  const bucketsCount = PERIODS.find((p) => p.id === period)?.default ?? 12;
  const { data, isLoading } = useQuery<{
    period: Period;
    bucket_starts: string[];
    wholesalers: Array<{
      client_id: string | null;
      client_name: string;
      totals: number[];
      grand_total: number;
    }>;
  }>({
    queryKey: ['admin', 'kpi', 'wholesale-breakdown', period, bucketsCount],
    queryFn: () =>
      apiFetch(
        `/admin/kpi/wholesale-breakdown?period=${period}&buckets=${bucketsCount}`,
      ),
    refetchInterval: 60_000,
  });

  const hasData = (data?.wholesalers ?? []).some((w) => w.grand_total > 0);
  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Wholesalers · per-client breakdown</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Contribution of each wholesaler to the combined Wholesale
            bar above. Buy + sell invoices combined.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-ink-400">Loading…</div>
      ) : !hasData ? (
        <div className="py-12 text-center text-sm text-ink-400">
          No wholesale activity in this range.
        </div>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <WholesaleStackedChart
              bucketStarts={(data?.bucket_starts ?? []).slice().reverse()}
              wholesalers={(data?.wholesalers ?? []).map((w) => ({
                ...w,
                // Mirror the bucket reversal so totals line up with
                // the reversed bucket_starts.
                totals: w.totals.slice().reverse(),
              }))}
              period={period}
            />
          </div>
          {/* Legend — colored swatch + name + grand total. Clipping to
              top 12 so an account with a long tail of tiny wholesalers
              doesn't turn the legend into a wall of text; everything
              beyond rolls into an "Other (N)" row at the bottom. */}
          <WholesaleLegend wholesalers={data?.wholesalers ?? []} />
        </>
      )}
    </section>
  );
}

function WholesaleStackedChart({
  bucketStarts,
  wholesalers,
  period,
}: {
  bucketStarts: string[];
  wholesalers: Array<{
    client_id: string | null;
    client_name: string;
    totals: number[];
    grand_total: number;
  }>;
  period: Period;
}) {
  // Max of per-bucket STACKED totals so the chart scale reflects the
  // tallest stack, not the tallest individual wholesaler bar.
  const rawMax = Math.max(
    1,
    ...bucketStarts.map((_, i) =>
      wholesalers.reduce((s, w) => s + (w.totals[i] ?? 0), 0),
    ),
  );
  const tickStep = pickTickStep(rawMax, 50_000, 8);
  const max = Math.max(tickStep, Math.ceil(rawMax / tickStep) * tickStep);
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += tickStep) ticks.push(v);

  const barWidth = 28;
  const groupGap = 14;
  const chartH = 240;
  const yAxisWidth = 52;
  const chartW = bucketStarts.length * (barWidth + groupGap);
  const totalW = Math.max(chartW + yAxisWidth, 400);
  const paddingBottom = 30;

  return (
    <svg width={totalW} height={chartH + paddingBottom} className="min-w-full">
      {ticks.map((v) => {
        const y = chartH - (v / max) * chartH;
        return (
          <g key={v}>
            <line
              x1={0}
              x2={totalW - yAxisWidth}
              y1={y}
              y2={y}
              stroke="#eeeef1"
              strokeWidth={1}
            />
            <text
              x={totalW - yAxisWidth + 8}
              y={y + 3}
              fontSize={9}
              fill="#8a8a92"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {formatDollarTick(v)}
            </text>
          </g>
        );
      })}
      {bucketStarts.map((iso, i) => {
        const x = i * (barWidth + groupGap);
        let yCursor = chartH;
        const stackForTooltip: string[] = [];
        const rects: React.ReactNode[] = [];
        for (const w of wholesalers) {
          const v = w.totals[i] ?? 0;
          if (v <= 0) continue;
          const h = (v / max) * chartH;
          const y = yCursor - h;
          yCursor = y;
          rects.push(
            <rect
              key={w.client_id ?? '__u__'}
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(1, h)}
              fill={colorForWholesaler(w.client_id, w.client_name)}
              rx={2}
            />,
          );
          stackForTooltip.push(`${w.client_name}: ${money(v)}`);
        }
        const tip =
          `${formatBucket(iso, period)}\n` +
          stackForTooltip.slice(0, 15).join('\n') +
          (stackForTooltip.length > 15 ? `\n…and ${stackForTooltip.length - 15} more` : '');
        return (
          <g key={iso}>
            <title>{tip}</title>
            <rect x={x} y={0} width={barWidth} height={chartH} fill="transparent" />
            {rects}
            <text
              x={x + barWidth / 2}
              y={chartH + 14}
              textAnchor="middle"
              fontSize={9}
              fill="#8a8a92"
            >
              {formatBucketShort(iso, period)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function WholesaleLegend({
  wholesalers,
}: {
  wholesalers: Array<{
    client_id: string | null;
    client_name: string;
    grand_total: number;
  }>;
}) {
  const shown = wholesalers.slice(0, 12);
  const hidden = wholesalers.slice(12);
  const hiddenTotal = hidden.reduce((s, w) => s + w.grand_total, 0);
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      {shown.map((w) => (
        <span
          key={w.client_id ?? '__u__'}
          className="flex items-center gap-1.5 text-ink-600"
          title={money(w.grand_total)}
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: colorForWholesaler(w.client_id, w.client_name) }}
          />
          <span>{w.client_name}</span>
          <span className="font-mono tabular-nums text-ink-400">
            {money(w.grand_total)}
          </span>
        </span>
      ))}
      {hidden.length > 0 && (
        <span className="text-ink-400">
          + {hidden.length} more ({money(hiddenTotal)})
        </span>
      )}
    </div>
  );
}

/**
 * Deterministic color per wholesaler. Hash client_id (or name as
 * fallback) into an HSL hue so the same wholesaler always lands on
 * the same color across renders + across period switches, without
 * needing a central color map.
 */
function colorForWholesaler(clientId: string | null, clientName: string): string {
  const seed = clientId ?? clientName ?? '__';
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  const hue = Math.abs(hash) % 360;
  // Mid-saturation + mid-lightness keeps colors readable on the
  // white card background while giving distinguishable bands when
  // stacked. Pinned saturation/lightness so colors don't look
  // washed out at some hues and neon at others.
  return `hsl(${hue} 62% 48%)`;
}

function WholesaleOwedCard() {
  const { data, isLoading } = useQuery<{
    total_owed: string;
    by_client: Array<{
      client_id: string;
      client_name: string;
      client_email: string | null;
      invoice_count: number;
      owed: string;
    }>;
  }>({
    queryKey: ['admin', 'kpi', 'wholesale-owed'],
    queryFn: () =>
      apiFetch('/admin/kpi/wholesale-owed'),
    refetchInterval: 30_000,
  });

  const top = (data?.by_client ?? [])
    .slice()
    .sort((a, b) => Number(b.owed) - Number(a.owed))
    .slice(0, 5);

  return (
    <section className="mt-4 rounded-xl border border-gold-500/40 bg-gold-500/5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gold-700">
            Total owed by all wholesalers
          </h2>
          <div className="mt-1 font-mono text-3xl font-semibold text-ink-900">
            {/* money() already prepends "$" — an extra literal "$"
                here was producing "$$1,234". */}
            {isLoading ? '…' : money(Number(data?.total_owed ?? 0))}
          </div>
          <div className="mt-0.5 text-xs text-ink-500">
            {data?.by_client.length ?? 0} wholesaler
            {(data?.by_client.length ?? 0) === 1 ? '' : 's'} with open balances
          </div>
        </div>
        <Link
          href="/admin/wholesale/reconciliation"
          className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800"
        >
          Open reconciliation →
        </Link>
      </div>

      {top.length > 0 && (
        <ul className="mt-4 divide-y divide-gold-500/20">
          {top.map((c) => (
            <li
              key={c.client_id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <Link
                href={`/admin/clients/${c.client_id}`}
                className="font-medium hover:underline"
              >
                {c.client_name}
              </Link>
              <span className="text-xs text-ink-500">
                {c.invoice_count} invoice{c.invoice_count === 1 ? '' : 's'}
              </span>
              <span className="ml-auto font-mono text-ink-900">
                {/* money() already prepends "$" — drop the literal. */}
                {money(Number(c.owed))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TotalCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-ink-400">
        {label}
      </div>
      <div
        className="mt-1 font-mono text-2xl font-semibold tabular-nums"
        style={{ color }}
      >
        {money(value)}
      </div>
    </div>
  );
}

function BarChart({
  buckets,
  period,
  loading,
}: {
  buckets: Bucket[];
  period: Period;
  loading: boolean;
}) {
  if (loading) {
    return <div className="py-16 text-center text-sm text-ink-400">Loading…</div>;
  }
  if (buckets.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-ink-400">No data in this range.</div>
    );
  }

  // Compute max across all three series to keep bars comparable.
  const rawMax = Math.max(
    1,
    ...buckets.flatMap((b) => [
      Number(b.sales),
      Number(b.purchases),
      Number(b.wholesale),
    ]),
  );
  // Operator spec (Apr 2026): y-axis ticks in $50k increments.
  // For small charts that'd flood with labels if max is >~$350k, so
  // auto-double the step until we have ≤ 8 ticks. Keep `max` at the
  // next tick-boundary above rawMax so the top label matches the
  // top of the chart.
  const tickStep = pickTickStep(rawMax, 50_000, 8);
  const max = Math.max(tickStep, Math.ceil(rawMax / tickStep) * tickStep);
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += tickStep) ticks.push(v);

  const barWidth = 14;
  const barGap = 3;
  const groupWidth = barWidth * 3 + barGap * 2;
  const groupGap = 10;
  const chartH = 220;
  // Reserve space on the RIGHT for y-axis labels (operator spec —
  // dollars printed to the right of the chart, not left).
  const yAxisWidth = 52;
  const chartW = buckets.length * (groupWidth + groupGap);
  const totalW = Math.max(chartW + yAxisWidth, 400);
  const paddingBottom = 30;

  return (
    <svg
      width={totalW}
      height={chartH + paddingBottom}
      className="min-w-full"
    >
      {/* Y gridlines at each tick + $ label on the right. Gridlines
          span the full bar-chart width but stop before the axis
          column so they don't crash into the labels. */}
      {ticks.map((v) => {
        const y = chartH - (v / max) * chartH;
        return (
          <g key={v}>
            <line
              x1={0}
              x2={totalW - yAxisWidth}
              y1={y}
              y2={y}
              stroke="#eeeef1"
              strokeWidth={1}
            />
            <text
              x={totalW - yAxisWidth + 8}
              y={y + 3}
              fontSize={9}
              fill="#8a8a92"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {formatDollarTick(v)}
            </text>
          </g>
        );
      })}
      {buckets.map((b, i) => {
        const sales = Number(b.sales);
        const purchases = Number(b.purchases);
        const wholesale = Number(b.wholesale);
        const x = i * (groupWidth + groupGap);
        // SVG <title> gives us native browser tooltips with zero
        // React state. The invisible hit rect below it spans the
        // full bucket area so hovering between bars still shows the
        // tooltip — without it, hovering in the gaps does nothing.
        const tip =
          `${formatBucket(b.bucket_start, period)}\n` +
          `Sales:      ${money(sales)}\n` +
          `Purchases:  ${money(purchases)}\n` +
          `Wholesale:  ${money(wholesale)}`;
        return (
          <g key={b.bucket_start}>
            <title>{tip}</title>
            <rect
              x={x}
              y={0}
              width={groupWidth}
              height={chartH}
              fill="transparent"
            />
            <Bar x={x} y={chartH} h={(sales / max) * chartH} w={barWidth} color="#1f6b3e" />
            <Bar
              x={x + barWidth + barGap}
              y={chartH}
              h={(purchases / max) * chartH}
              w={barWidth}
              color="#1e3a78"
            />
            <Bar
              x={x + (barWidth + barGap) * 2}
              y={chartH}
              h={(wholesale / max) * chartH}
              w={barWidth}
              color="#b08e4a"
            />
            <text
              x={x + groupWidth / 2}
              y={chartH + 14}
              textAnchor="middle"
              fontSize={9}
              fill="#8a8a92"
            >
              {formatBucketShort(b.bucket_start, period)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Bar({
  x,
  y,
  h,
  w,
  color,
}: {
  x: number;
  y: number;
  h: number;
  w: number;
  color: string;
}) {
  return (
    <rect
      x={x}
      y={y - h}
      width={w}
      height={h}
      fill={color}
      rx={2}
    />
  );
}

function money(v: string | number) {
  const n = typeof v === 'string' ? Number(v) : v;
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/**
 * Natural-language label for the CURRENT bucket a TotalCard covers.
 * Used in the top-totals copy; the timeline chart formats its own
 * x-axis labels via formatBucketShort/formatBucket.
 */
function currentPeriodLabel(period: Period): string {
  switch (period) {
    case 'day':
      return 'Today';
    case 'week':
      return 'This week';
    case 'month':
      return 'This month';
    case 'quarter':
      return 'This quarter';
    case 'year':
      return 'This year';
  }
}

function formatBucket(iso: string, period: Period): string {
  const d = new Date(iso);
  switch (period) {
    case 'day':
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    case 'week': {
      const end = new Date(d);
      end.setDate(d.getDate() + 6);
      return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    }
    case 'month':
      return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    case 'quarter': {
      const q = Math.floor(d.getMonth() / 3) + 1;
      return `Q${q} ${d.getFullYear()}`;
    }
    case 'year':
      return String(d.getFullYear());
  }
}

/**
 * Pick a y-axis tick step. Starts at `desiredStep` (operator spec =
 * $50k) and doubles up the nice-number ladder (50 → 100 → 250 → 500)
 * until the number of ticks fits under `maxTicks`. Keeps the axis
 * readable on both small monthly charts and multi-million-dollar
 * yearly views.
 */
function pickTickStep(max: number, desiredStep: number, maxTicks: number): number {
  const ladder = [50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000];
  const start = ladder.indexOf(desiredStep);
  for (let i = Math.max(0, start); i < ladder.length; i++) {
    const step = ladder[i];
    if (Math.ceil(max / step) <= maxTicks) return step;
  }
  return ladder[ladder.length - 1];
}

/** "$0", "$50k", "$1.2M" — compact axis label format. */
function formatDollarTick(n: number): string {
  if (n === 0) return '$0';
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  return `$${n.toFixed(0)}`;
}

function formatBucketShort(iso: string, period: Period): string {
  const d = new Date(iso);
  switch (period) {
    case 'day':
      return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    case 'week':
      return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    case 'month':
      return d.toLocaleDateString(undefined, { month: 'short' });
    case 'quarter': {
      const q = Math.floor(d.getMonth() / 3) + 1;
      return `Q${q}`;
    }
    case 'year':
      return String(d.getFullYear() % 100).padStart(2, '0');
  }
}
