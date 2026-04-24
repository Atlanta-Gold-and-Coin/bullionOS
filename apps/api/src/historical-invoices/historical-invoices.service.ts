import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, HistoricalInvoice } from '../db/types';
import { toDbString } from '../common/money';

/**
 * Historical invoices — backfill of transactions written in a prior
 * system, booked one-per-row at day granularity. Feeds KPI rollups
 * without touching `invoices`, `products`, or `inventory`.
 */
export interface HistoricalInvoiceRow extends Omit<HistoricalInvoice, 'date' | 'amount'> {
  date: string;
  amount: string;
  client_display_name: string | null;
}

export interface HistoricalInvoiceInput {
  date: string;
  type: 'buy' | 'sell';
  amount: number;
  is_wholesale?: boolean;
  client_id?: string | null;
  client_name?: string | null;
  reference?: string | null;
  notes?: string | null;
}

@Injectable()
export class HistoricalInvoicesService {
  private readonly logger = new Logger(HistoricalInvoicesService.name);
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /**
   * Translate common Postgres errors into actionable BadRequestException
   * messages so the admin UI shows "Client not found" or "Invalid date"
   * instead of a generic 500. Admin-only endpoint — leaking the exact
   * error text is fine here. Pass through HttpException untouched so
   * NotFoundException etc. surface cleanly.
   */
  private translateError(err: unknown, action: string): never {
    if (err instanceof HttpException) throw err;
    const msg = (err as Error).message ?? '';
    this.logger.error(`${action} failed: ${msg}`, (err as Error).stack);
    if (/foreign key constraint|violates foreign key/i.test(msg)) {
      throw new BadRequestException(
        `Client reference is invalid. Clear the client selection or pick an existing client and retry.`,
      );
    }
    if (/invalid input syntax for type date/i.test(msg)) {
      throw new BadRequestException(
        `Invalid date. Use the YYYY-MM-DD format.`,
      );
    }
    if (/value out of range|numeric field overflow/i.test(msg)) {
      throw new BadRequestException(
        `Amount is outside the allowed range (0 – 10,000,000).`,
      );
    }
    if (/invalid input syntax for type uuid/i.test(msg)) {
      throw new BadRequestException(
        `Client selection looks malformed. Re-pick the client and retry.`,
      );
    }
    if (/relation .* does not exist/i.test(msg)) {
      throw new BadRequestException(
        `Database schema missing. Migrations may not have run on this environment.`,
      );
    }
    if (/check constraint/i.test(msg)) {
      throw new BadRequestException(
        `Row failed a data-validation check: ${msg.slice(0, 300)}`,
      );
    }
    if (/not-null constraint/i.test(msg)) {
      throw new BadRequestException(
        `A required field was empty: ${msg.slice(0, 300)}`,
      );
    }
    throw new BadRequestException(
      `Save failed: ${msg.slice(0, 400) || 'unknown error'}`,
    );
  }

  /**
   * List historical invoices, newest-day first. Optional from/to filter
   * clips the range so a UI day-picker can cheaply request a single
   * day's entries.
   */
  async list(opts: { from?: string; to?: string; limit?: number } = {}): Promise<HistoricalInvoiceRow[]> {
    let q = this.db
      .selectFrom('historical_invoices as h')
      .leftJoin('clients as c', 'c.id', 'h.client_id')
      .selectAll('h')
      .select((eb) =>
        // Prefer the linked client's name if present, else fall back
        // to the free-text client_name the accountant typed in. Keeps
        // display consistent whether a row was linked or orphaned.
        eb
          .case()
          .when('h.client_id', 'is not', null)
          .then(
            eb.fn.coalesce(
              eb.fn('nullif', [
                eb.fn('trim', [
                  eb.fn('concat', [
                    eb.fn.coalesce(eb.ref('c.first_name'), eb.val('')),
                    eb.val(' '),
                    eb.fn.coalesce(eb.ref('c.last_name'), eb.val('')),
                  ]),
                ]),
                eb.val(''),
              ]),
              eb.ref('c.company'),
              eb.ref('h.client_name'),
            ),
          )
          .else(eb.ref('h.client_name'))
          .end()
          .as('client_display_name'),
      )
      .orderBy('h.date', 'desc')
      .orderBy('h.created_at', 'desc');
    // Kysely types the `date` column as Date on selects, so string
    // where-clauses fail the typecheck. Use raw SQL with explicit ::date
    // casts — same pattern kpi_manual_entries uses for bucket_month.
    if (opts.from) q = q.where(sql<boolean>`h.date >= ${opts.from}::date`);
    if (opts.to) q = q.where(sql<boolean>`h.date <= ${opts.to}::date`);
    q = q.limit(opts.limit ?? 500);
    return (await q.execute()) as unknown as HistoricalInvoiceRow[];
  }

  async create(input: HistoricalInvoiceInput, actorId: string): Promise<HistoricalInvoiceRow> {
    try {
      const row = await this.db
        .insertInto('historical_invoices')
        .values({
          date: input.date,
          type: input.type,
          amount: toDbString(input.amount),
          is_wholesale: input.is_wholesale ?? false,
          client_id: input.client_id ?? null,
          client_name: input.client_name?.trim() || null,
          reference: input.reference?.trim() || null,
          notes: input.notes?.trim() || null,
          created_by_user_id: actorId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // Fetch with the display-name join so the client gets a
      // fully-populated row back immediately.
      const fresh = await this.list({
        from: String(row.date),
        to: String(row.date),
        limit: 500,
      });
      return fresh.find((r) => r.id === row.id) ?? (row as unknown as HistoricalInvoiceRow);
    } catch (err) {
      this.translateError(err, 'create');
    }
  }

  async update(
    id: string,
    patch: Partial<HistoricalInvoiceInput>,
  ): Promise<HistoricalInvoiceRow> {
    try {
      const set: Record<string, unknown> = {};
      if (patch.date !== undefined) set.date = patch.date;
      if (patch.type !== undefined) set.type = patch.type;
      if (patch.amount !== undefined) set.amount = toDbString(patch.amount);
      if (patch.is_wholesale !== undefined) set.is_wholesale = patch.is_wholesale;
      if (patch.client_id !== undefined) set.client_id = patch.client_id;
      if (patch.client_name !== undefined) set.client_name = patch.client_name?.trim() || null;
      if (patch.reference !== undefined) set.reference = patch.reference?.trim() || null;
      if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
      const r = await this.db
        .updateTable('historical_invoices')
        .set(set)
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) {
        throw new NotFoundException('Historical invoice not found');
      }
      const rows = await this.list({ limit: 1 });
      const fresh = await this.db
        .selectFrom('historical_invoices')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return {
        ...(fresh as unknown as HistoricalInvoiceRow),
        client_display_name: rows.find((r) => r.id === id)?.client_display_name ?? null,
      };
    } catch (err) {
      this.translateError(err, 'update');
    }
  }

  async delete(id: string): Promise<void> {
    const r = await this.db
      .deleteFrom('historical_invoices')
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) {
      throw new NotFoundException('Historical invoice not found');
    }
  }

  /**
   * Bulk-insert from a parsed CSV payload. Each row is independently
   * validated; valid rows insert in a single transaction, invalid rows
   * come back with a per-row error message so the accountant can fix
   * and re-upload only the failures.
   *
   * Column mapping (case-insensitive, dashes and underscores interchangeable):
   *   date           YYYY-MM-DD (required)
   *   type           buy | sell (required)
   *   amount         dollars, may include $ and commas (required)
   *   wholesale      yes/no/true/false/1/0 (optional, default no)
   *   client_name    free text (optional)
   *   reference      external invoice id (optional)
   *   notes          free text (optional)
   */
  async bulkImport(
    rows: Array<Record<string, string>>,
    actorId: string,
  ): Promise<{ inserted: number; errors: Array<{ row: number; message: string }> }> {
    const errors: Array<{ row: number; message: string }> = [];
    const toInsert: Array<{
      date: string;
      type: 'buy' | 'sell';
      amount: string;
      is_wholesale: boolean;
      client_name: string | null;
      reference: string | null;
      notes: string | null;
      created_by_user_id: string;
    }> = [];

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const yes = new Set(['yes', 'y', 'true', '1', 'wholesale', 'wholesaler']);

    // Normalize header keys: 'Client Name' → 'client_name' etc.
    const norm = (k: string) => k.toLowerCase().trim().replace(/[\s-]+/g, '_');

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const r: Record<string, string> = {};
      for (const k of Object.keys(raw)) r[norm(k)] = (raw[k] ?? '').trim();

      // Skip completely blank rows silently — common when a CSV has
      // trailing newlines or a mid-file separator.
      if (Object.values(r).every((v) => v === '')) continue;

      const rowNum = i + 2; // +1 for header, +1 for 1-based user display
      if (!r.date || !dateRe.test(r.date)) {
        errors.push({ row: rowNum, message: `Invalid date "${r.date}" (expected YYYY-MM-DD)` });
        continue;
      }
      const typeLower = (r.type || '').toLowerCase();
      if (typeLower !== 'buy' && typeLower !== 'sell') {
        errors.push({ row: rowNum, message: `Type must be "buy" or "sell", got "${r.type}"` });
        continue;
      }
      const amountNum = Number(String(r.amount || '').replace(/[$,]/g, ''));
      if (!isFinite(amountNum) || amountNum < 0) {
        errors.push({ row: rowNum, message: `Invalid amount "${r.amount}"` });
        continue;
      }
      const isWholesale = yes.has((r.wholesale || r.is_wholesale || '').toLowerCase());
      toInsert.push({
        date: r.date,
        type: typeLower as 'buy' | 'sell',
        amount: toDbString(amountNum),
        is_wholesale: isWholesale,
        client_name: r.client_name?.trim() || r.client?.trim() || null,
        reference: r.reference?.trim() || null,
        notes: r.notes?.trim() || null,
        created_by_user_id: actorId,
      });
    }

    let inserted = 0;
    if (toInsert.length > 0) {
      await this.db.transaction().execute(async (trx) => {
        // Single batched insert — Postgres handles 10k-row arrays in
        // one round trip without breaking a sweat. Switch to chunking
        // if the accountant ever actually pastes 100k rows.
        const r = await trx
          .insertInto('historical_invoices')
          .values(toInsert)
          .executeTakeFirst();
        inserted = Number(r.numInsertedOrUpdatedRows ?? toInsert.length);
      });
    }
    return { inserted, errors };
  }

  /**
   * Summary stats for a date range — totals per type plus the
   * wholesale subset. Used by the admin page to render a running
   * tally ("April 2025: 47 entries, $125,400 sales") at a glance.
   */
  async summary(opts: { from?: string; to?: string } = {}): Promise<{
    count: number;
    sales: string;
    purchases: string;
    wholesale: string;
  }> {
    let q = this.db
      .selectFrom('historical_invoices')
      .select((eb) => [
        eb.fn.count<number>('id').as('count'),
        eb.fn
          .sum<string>(
            eb
              .case()
              .when('type', '=', 'sell')
              .then(eb.ref('amount'))
              .else(eb.val('0'))
              .end(),
          )
          .as('sales'),
        eb.fn
          .sum<string>(
            eb
              .case()
              .when('type', '=', 'buy')
              .then(eb.ref('amount'))
              .else(eb.val('0'))
              .end(),
          )
          .as('purchases'),
        eb.fn
          .sum<string>(
            eb
              .case()
              .when('is_wholesale', '=', true)
              .then(eb.ref('amount'))
              .else(eb.val('0'))
              .end(),
          )
          .as('wholesale'),
      ]);
    if (opts.from) q = q.where(sql<boolean>`date >= ${opts.from}::date`);
    if (opts.to) q = q.where(sql<boolean>`date <= ${opts.to}::date`);
    const r = await q.executeTakeFirstOrThrow();
    return {
      count: Number(r.count ?? 0),
      sales: String(r.sales ?? '0'),
      purchases: String(r.purchases ?? '0'),
      wholesale: String(r.wholesale ?? '0'),
    };
  }
}
