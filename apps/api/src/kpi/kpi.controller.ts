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
    const manualCte = includeManual
      ? sql`
          UNION ALL
          SELECT
            date_trunc(${period}, m.bucket_month::timestamp AT TIME ZONE 'America/New_York')
              AS bucket_start,
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
    const historicalCte = sql`
      UNION ALL
      SELECT
        date_trunc(${period}, h.date::timestamp AT TIME ZONE 'America/New_York')
          AS bucket_start,
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
    }>`
      WITH series AS (
        SELECT generate_series(
          date_trunc(${period}, (now() AT TIME ZONE 'America/New_York'))
            - (${sql.raw(`interval '1 ${period}'`)} * (${buckets} - 1)),
          date_trunc(${period}, (now() AT TIME ZONE 'America/New_York')),
          ${sql.raw(`interval '1 ${period}'`)}
        ) AS bucket_start
      ),
      eligible AS (
        SELECT
          date_trunc(${period}, (i.created_at AT TIME ZONE 'America/New_York')) AS bucket_start,
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
        ), 0)::text AS wholesale
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
      })),
    };
  }
}
