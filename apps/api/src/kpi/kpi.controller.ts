import { Controller, Get, Query } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import { Roles } from '../common/decorators/roles.decorator';
import { InvoicesService } from '../invoices/invoices.service';
import type { DB } from '../db/types';

type Period = 'day' | 'week' | 'month' | 'quarter' | 'year';

const ALLOWED_PERIODS: Record<Period, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
  quarter: 'quarter',
  year: 'year',
};

/**
 * Roll-up totals for the KPI dashboard.
 *
 * Bucketing uses PG's `date_trunc(period, created_at AT TIME ZONE 'America/New_York')`
 * so the financial day matches the shop's wall clock. Each row carries three
 * totals:
 *
 *   purchases  — ALL buy  invoices (retail + wholesale). Money out the door.
 *   sales      — RETAIL sell invoices ONLY. Wholesaler sell invoices are
 *                excluded here and rolled into `wholesale` instead, so
 *                Sales + Wholesale is disjoint (no double-count on the chart).
 *                Operator spec Apr 2026: "Sales column should only show sales
 *                to clients." Previously this included wholesale and visually
 *                double-counted alongside the wholesale subtotal.
 *   wholesale  — Wholesaler-client flows (buy + sell combined). Prior to the
 *                April 2026 change this was a SUBSET of the Sales / Purchases
 *                totals; it's now DISJOINT from Sales (still overlaps with
 *                Purchases — that column retains the full all-client total).
 *
 * Only invoices in status IN ('paid','shipped') count. Drafts and canceled
 * don't move money. Callers pass:
 *   period = day|week|month|quarter|year
 *   buckets = how many back from "now" to include (default 30 for day,
 *             24 for week, 12 for month, 8 for quarter, 5 for year)
 */
@Controller('admin/kpi')
@Roles('admin', 'staff')
export class KpiController {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly invoices: InvoicesService,
  ) {}

  /**
   * Wholesale-owed KPI (ticket WH-003).
   *
   * Shape:
   *   {
   *     total_owed: "12345.67",
   *     by_client: [{ client_id, client_name, client_email, invoice_count, owed, invoices: [...] }, ...]
   *   }
   *
   * Delegates to `InvoicesService.listOutstandingWholesale()` so the KPI
   * card and the /admin/wholesale/reconciliation page share one source of
   * truth. The total is the sum across all rows; the per-client list is
   * what the supporting drill-down table renders.
   */
  @Get('wholesale-owed')
  wholesaleOwed() {
    return this.invoices.listOutstandingWholesale();
  }

  /**
   * Per-wholesaler breakdown over time. Returns one series per
   * wholesaler client, each with per-bucket amounts, so the KPI page
   * can render a stacked-by-wholesaler chart distinct from the
   * aggregate Wholesale bar on the existing timeline.
   *
   * Data sources unioned, matching the main rollup:
   *   - live invoices: client_type='wholesaler' rows, status
   *     IN ('paid','shipped'), sum i.total.
   *   - historical_invoices: is_wholesale=true, sum h.amount.
   *   - kpi_manual_entries: category='wholesale' + non-null client_id
   *     (manual entries without a client are rolled into "(no client)"
   *     so they still show up — surfacing the gap helps the
   *     accountant clean up legacy data).
   *
   * Response shape (frontend-friendly):
   *   {
   *     period, bucket_starts: [Date, ...],
   *     wholesalers: [{ client_id, client_name, totals: [amt, ...] }]
   *   }
   *
   * The totals array is aligned index-wise to bucket_starts. Sorted by
   * grand total desc so legend order = top-contributors-first.
   */
  @Get('wholesale-breakdown')
  async wholesaleBreakdown(
    @Query('period') periodRaw?: string,
    @Query('buckets') bucketsRaw?: string,
  ) {
    const period: Period = (periodRaw && ALLOWED_PERIODS[periodRaw as Period]
      ? (periodRaw as Period)
      : 'month') as Period;
    const bucketsDefault = { day: 30, week: 24, month: 12, quarter: 8, year: 5 }[period];
    const buckets = Math.min(
      240,
      Math.max(1, Number(bucketsRaw ?? bucketsDefault)),
    );

    // Monthly+ zoom includes kpi_manual_entries; day/week skips them
    // (see the main rollup for the same reasoning — month-granular
    // rows would spike the first-of-month unfairly on a daily chart).
    const includeManual = period === 'month' || period === 'quarter' || period === 'year';

    const rows = await sql<{
      bucket_start: Date;
      client_id: string | null;
      client_name: string | null;
      total: string;
    }>`
      WITH series AS (
        SELECT (generate_series(
          date_trunc(${period}, (now() AT TIME ZONE 'America/New_York'))
            - (${sql.raw(`interval '1 ${period}'`)} * (${buckets} - 1)),
          date_trunc(${period}, (now() AT TIME ZONE 'America/New_York')),
          ${sql.raw(`interval '1 ${period}'`)}
        ))::date AS bucket_start
      ),
      eligible AS (
        -- Live wholesale invoices
        SELECT
          date_trunc(${period}, (i.created_at AT TIME ZONE 'America/New_York'))::date AS bucket_start,
          i.client_id,
          COALESCE(
            NULLIF(TRIM(COALESCE(cl.first_name,'') || ' ' || COALESCE(cl.last_name,'')), ''),
            cl.company
          ) AS client_name,
          i.total::numeric AS total
        FROM invoices i
        INNER JOIN clients cl ON cl.id = i.client_id
        WHERE i.status IN ('paid','shipped')
          AND cl.client_type = 'wholesaler'
          AND cl.exclude_from_reports = false

        UNION ALL

        -- Historical invoices tagged wholesale
        SELECT
          date_trunc(${period}, h.date)::date AS bucket_start,
          h.client_id,
          COALESCE(
            NULLIF(TRIM(COALESCE(hcl.first_name,'') || ' ' || COALESCE(hcl.last_name,'')), ''),
            hcl.company,
            h.client_name
          ) AS client_name,
          h.amount::numeric AS total
        FROM historical_invoices h
        LEFT JOIN clients hcl ON hcl.id = h.client_id
        WHERE h.is_wholesale = true

        ${includeManual
          ? sql`
              UNION ALL
              SELECT
                date_trunc(${period}, m.bucket_month)::date AS bucket_start,
                m.client_id,
                COALESCE(
                  NULLIF(TRIM(COALESCE(mcl.first_name,'') || ' ' || COALESCE(mcl.last_name,'')), ''),
                  mcl.company
                ) AS client_name,
                m.amount::numeric AS total
              FROM kpi_manual_entries m
              LEFT JOIN clients mcl ON mcl.id = m.client_id
              WHERE m.category = 'wholesale'
            `
          : sql``}
      )
      SELECT
        s.bucket_start,
        e.client_id,
        e.client_name,
        COALESCE(SUM(e.total), 0)::text AS total
      FROM series s
      LEFT JOIN eligible e ON e.bucket_start = s.bucket_start
      GROUP BY s.bucket_start, e.client_id, e.client_name
      ORDER BY s.bucket_start ASC, e.client_id NULLS LAST
    `.execute(this.db);

    // Pivot rows into { wholesaler → bucket → total }. `client_id=null`
    // rows are rolled under a synthetic "(unassigned)" bucket so legacy
    // historical entries without a CRM link still surface — the
    // accountant can then go clean them up.
    const bucketStarts = new Map<string, Date>();
    const byClient = new Map<
      string,
      { client_id: string | null; client_name: string; perBucket: Map<string, number> }
    >();
    for (const r of rows.rows) {
      const bucketKey = r.bucket_start.toISOString();
      bucketStarts.set(bucketKey, r.bucket_start);
      if (!r.client_id && Number(r.total) === 0) continue; // empty bucket rows
      const key = r.client_id ?? '__unassigned__';
      const name = r.client_name ?? (r.client_id ? 'Unnamed wholesaler' : '(unassigned)');
      if (!byClient.has(key)) {
        byClient.set(key, {
          client_id: r.client_id,
          client_name: name,
          perBucket: new Map(),
        });
      }
      const cur = byClient.get(key)!.perBucket.get(bucketKey) ?? 0;
      byClient.get(key)!.perBucket.set(bucketKey, cur + Number(r.total));
    }

    // Emit buckets in chronological order and wholesalers in
    // grand-total-desc so the legend reads top-contributor-first.
    const orderedBuckets = [...bucketStarts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, d]) => d);
    const wholesalers = [...byClient.values()]
      .map((w) => ({
        client_id: w.client_id,
        client_name: w.client_name,
        totals: orderedBuckets.map(
          (d) => w.perBucket.get(d.toISOString()) ?? 0,
        ),
        grand_total: [...w.perBucket.values()].reduce((s, v) => s + v, 0),
      }))
      .sort((a, b) => b.grand_total - a.grand_total);

    return {
      period,
      bucket_starts: orderedBuckets,
      wholesalers,
    };
  }

  @Get()
  async rollup(
    @Query('period') periodRaw?: string,
    @Query('buckets') bucketsRaw?: string,
  ) {
    const period: Period = (periodRaw && ALLOWED_PERIODS[periodRaw as Period]
      ? (periodRaw as Period)
      : 'day') as Period;
    const bucketsDefault = { day: 30, week: 24, month: 12, quarter: 8, year: 5 }[period];
    const buckets = Math.min(
      240,
      Math.max(1, Number(bucketsRaw ?? bucketsDefault)),
    );

    // Build the bucket series server-side so empty periods still render as
    // zero-height bars on the chart. `generate_series` is the right tool —
    // keeps the response a dense N-row array regardless of data density.
    //
    // Manual KPI entries (migration 027) are merged in as a second
    // row-source for the period bucket. We only include them when the
    // requested period is monthly-or-coarser: manual entries are
    // stored at month granularity (bucket_month = first-of-month),
    // so surfacing them at day/week level would make the numbers
    // appear to spike on the first of each month and read as bugs.
    // Daily/weekly views stay strictly live-data to avoid that.
    const includeManual = period === 'month' || period === 'quarter' || period === 'year';
    // DATE columns (kpi_manual_entries.bucket_month) have no time
    // component — they name a specific calendar day. Applying
    // `AT TIME ZONE 'America/New_York'` on top turned a '2025-01-01'
    // entry into '2024-12-31' at UTC, which then date_trunc'd back
    // to '2024-12-01' on the session tz — i.e., January rows
    // surfaced in December's bucket (operator-reported Apr 2026).
    //
    // Fix: run date_trunc directly on the DATE, then cast to ::date.
    // No tz math needed since the source is already calendar-local.
    const manualCte = includeManual
      ? sql`
          UNION ALL
          SELECT
            date_trunc(${period}, m.bucket_month)::date AS bucket_start,
            NULL::text AS type,
            (
              CASE
                WHEN m.category = 'wholesale' THEN 'wholesaler'
                ELSE 'retail'
              END
            )::text AS client_type,
            m.amount::numeric AS total,
            m.category AS manual_category
          FROM kpi_manual_entries m
        `
      : sql``;

    // Historical invoices (migration 031) are DAY-granular so they
    // surface correctly at every zoom — day, week, month, quarter,
    // year. Type is 'buy' / 'sell' same as live invoices; is_wholesale
    // drives the wholesale subtotal (we synthesize client_type as
    // 'wholesaler' when it's set so the CASE-arms downstream treat
    // it the same as a live wholesale invoice).
    // Same DATE-column fix as manualCte above — historical_invoices.
    // date is a DATE, no tz conversion needed. The old AT TIME ZONE
    // cast was shifting e.g. January 1 entries into December's
    // bucket when the PG session tz didn't match ET.
    const historicalCte = sql`
      UNION ALL
      SELECT
        date_trunc(${period}, h.date)::date AS bucket_start,
        h.type,
        (CASE WHEN h.is_wholesale THEN 'wholesaler' ELSE 'retail' END)::text AS client_type,
        h.amount::numeric AS total,
        NULL::text AS manual_category
      FROM historical_invoices h
    `;

    const rows = await sql<{
      bucket_start: Date;
      purchases: string;
      sales: string;
      wholesale: string;
      wholesale_sales: string;
    }>`
      -- Series + eligible both cast bucket_start to ::date so the
      -- LEFT JOIN compares calendar-local dates to calendar-local
      -- dates — no implicit timestamp/timestamptz coercion, no
      -- off-by-one tz surprises. The manual + historical CTEs
      -- already emit ::date (see above).
      WITH series AS (
        SELECT (generate_series(
          date_trunc(${period}, (now() AT TIME ZONE 'America/New_York'))
            - (${sql.raw(`interval '1 ${period}'`)} * (${buckets} - 1)),
          date_trunc(${period}, (now() AT TIME ZONE 'America/New_York')),
          ${sql.raw(`interval '1 ${period}'`)}
        ))::date AS bucket_start
      ),
      eligible AS (
        SELECT
          date_trunc(${period}, (i.created_at AT TIME ZONE 'America/New_York'))::date AS bucket_start,
          i.type,
          c.client_type,
          i.total::numeric AS total,
          NULL::text AS manual_category
        FROM invoices i
        INNER JOIN clients c ON c.id = i.client_id
        WHERE i.status IN ('paid','shipped')
          -- Exclude invoices against reports-opted-out clients (owner
          -- test accounts, internal transfers). Flag lives on clients;
          -- see migration 030.
          AND c.exclude_from_reports = false
        ${manualCte}
        ${historicalCte}
      )
      SELECT
        s.bucket_start,
        -- Purchases = ALL buy invoices (retail + wholesale). Previously this
        -- excluded wholesale, which hid ~the single largest weekly movement
        -- for a shop that does 30-day-net wholesale buys alongside walk-ins.
        COALESCE(SUM(
          CASE
            WHEN e.manual_category = 'purchases' THEN e.total
            WHEN e.type = 'buy' THEN e.total
          END
        ), 0)::text AS purchases,
        -- Sales = RETAIL sell invoices only. Wholesaler sell invoices get
        -- accounted under the wholesale column below, so Sales + Wholesale
        -- is disjoint (no double-count on the stacked-bar chart).
        -- manual_category='sales' entries are tagged retail in the CTE
        -- (see manualCte above), so the first arm is automatically retail-
        -- only without an explicit client_type filter.
        COALESCE(SUM(
          CASE
            WHEN e.manual_category = 'sales' THEN e.total
            WHEN e.type = 'sell' AND e.client_type <> 'wholesaler' THEN e.total
          END
        ), 0)::text AS sales,
        -- Wholesaler-client flows (buy + sell combined). Disjoint from
        -- Sales; still overlaps with Purchases (that column is
        -- intentionally all-client; see header doc).
        COALESCE(SUM(
          CASE
            WHEN e.manual_category = 'wholesale' THEN e.total
            WHEN e.client_type = 'wholesaler' AND e.manual_category IS NULL THEN e.total
          END
        ), 0)::text AS wholesale,
        -- Wholesale sales only (type='sell' wholesaler invoices +
        -- manual_category='wholesale' rows — manual wholesale entries
        -- are conceptually revenue, not purchases). Split out from
        -- the combined wholesale column above so the frontend's
        -- Net-sales total can include wholesale revenue without
        -- also subtracting the wholesale-buy side twice.
        COALESCE(SUM(
          CASE
            WHEN e.manual_category = 'wholesale' THEN e.total
            WHEN e.client_type = 'wholesaler' AND e.type = 'sell' AND e.manual_category IS NULL THEN e.total
          END
        ), 0)::text AS wholesale_sales
      FROM series s
      LEFT JOIN eligible e ON e.bucket_start = s.bucket_start
      GROUP BY s.bucket_start
      ORDER BY s.bucket_start ASC
    `.execute(this.db);

    return {
      period,
      buckets: rows.rows.map((r) => ({
        bucket_start: r.bucket_start,
        purchases: r.purchases,
        sales: r.sales,
        wholesale: r.wholesale,
        wholesale_sales: r.wholesale_sales,
      })),
    };
  }
}
