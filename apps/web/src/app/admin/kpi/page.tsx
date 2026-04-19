'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

type Period = 'day' | 'week' | 'month' | 'quarter' | 'year';

interface Bucket {
  bucket_start: string;
  purchases: string;
  sales: string;
  wholesale: string;
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

  const totals = useMemo(() => {
    const init = { sales: 0, purchases: 0, wholesale: 0 };
    for (const b of data?.buckets ?? []) {
      init.sales += Number(b.sales);
      init.purchases += Number(b.purchases);
      init.wholesale += Number(b.wholesale);
    }
    return init;
  }, [data]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">KPI</h1>
          <p className="mt-1 text-sm text-ink-400">
            Money in vs money out, bucketed by period. Only paid / shipped
            invoices count — drafts and canceled are excluded.
          </p>
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
            label={`${s.label} · last ${buckets} ${period}${buckets === 1 ? '' : 's'}`}
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
          <BarChart buckets={data?.buckets ?? []} period={period} loading={isLoading} />
        </div>
      </section>

      {/* MOB-002: rollup table scrolls horizontally on narrow screens. */}
      <section className="mt-4 overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full min-w-[680px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-3">Bucket</th>
              <th className="px-4 py-3 text-right">Sales</th>
              <th className="px-4 py-3 text-right">Purchases</th>
              <th className="px-4 py-3 text-right">Wholesale</th>
              <th className="px-4 py-3 text-right">Net (Sales − Purchases)</th>
            </tr>
          </thead>
          <tbody>
            {(data?.buckets ?? []).slice().reverse().map((b) => {
              const net = Number(b.sales) - Number(b.purchases);
              return (
                <tr key={b.bucket_start} className="border-t border-ink-200">
                  <td className="px-4 py-3">{formatBucket(b.bucket_start, period)}</td>
                  <td className="px-4 py-3 text-right font-mono">
                    {money(b.sales)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {money(b.purchases)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {money(b.wholesale)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-mono ${
                      net >= 0 ? 'text-sell-700' : 'text-red-700'
                    }`}
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
            {isLoading ? '…' : `$${money(Number(data?.total_owed ?? 0))}`}
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
                ${money(Number(c.owed))}
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
  const max = Math.max(
    1,
    ...buckets.flatMap((b) => [
      Number(b.sales),
      Number(b.purchases),
      Number(b.wholesale),
    ]),
  );

  const barWidth = 14;
  const barGap = 3;
  const groupWidth = barWidth * 3 + barGap * 2;
  const groupGap = 10;
  const chartH = 220;
  const chartW = buckets.length * (groupWidth + groupGap);
  const paddingBottom = 30;

  return (
    <svg
      width={Math.max(chartW, 400)}
      height={chartH + paddingBottom}
      className="min-w-full"
    >
      {/* Y gridlines at 0/25/50/75/100% */}
      {[0, 0.25, 0.5, 0.75, 1].map((frac) => (
        <line
          key={frac}
          x1={0}
          x2={Math.max(chartW, 400)}
          y1={chartH - chartH * frac}
          y2={chartH - chartH * frac}
          stroke="#eeeef1"
          strokeWidth={1}
        />
      ))}
      {buckets.map((b, i) => {
        const sales = Number(b.sales);
        const purchases = Number(b.purchases);
        const wholesale = Number(b.wholesale);
        const x = i * (groupWidth + groupGap);
        return (
          <g key={b.bucket_start}>
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
