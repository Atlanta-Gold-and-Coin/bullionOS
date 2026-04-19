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
 * signed totals:
 *
 *   purchases  — buy  invoices from retail clients (walk-ins / in-office)
 *   sales      — sell invoices to retail clients  (walk-ins / in-office)
 *   wholesale  — any invoice against a wholesaler client
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
          i.total::numeric AS total
        FROM invoices i
        INNER JOIN clients c ON c.id = i.client_id
        WHERE i.status IN ('paid','shipped')
      )
      SELECT
        s.bucket_start,
        COALESCE(SUM(
          CASE WHEN e.type = 'buy' AND e.client_type = 'retail' THEN e.total END
        ), 0)::text AS purchases,
        COALESCE(SUM(
          CASE WHEN e.type = 'sell' AND e.client_type = 'retail' THEN e.total END
        ), 0)::text AS sales,
        COALESCE(SUM(
          CASE WHEN e.client_type = 'wholesaler' THEN e.total END
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
