import { Kysely, sql } from 'kysely';

/**
 * 033_supplier_prices_multi_sheet
 *
 * RARCOA sometimes publishes multiple goldsheets per day — a morning
 * snapshot, a midday revision, and occasionally an afternoon update
 * when spot moves hard. The original 032 schema used
 * UNIQUE(supplier, as_of_date), which meant a second same-day sheet
 * UPSERTed onto the first and we lost the intra-day history.
 *
 * This migration widens the natural key to
 * (supplier, as_of_date, as_of_time). Postgres 15+'s
 * `NULLS NOT DISTINCT` ensures a null-time sheet (e.g. parser couldn't
 * pull the HH:MM out) still behaves idempotently — two null-time
 * uploads for the same date collapse to one row instead of piling up.
 *
 * Railway runs Postgres 16, so NULLS NOT DISTINCT is available.
 *
 * No data backfill needed: the existing supplier_prices rows key on
 * sheet_id (a UUID that doesn't change), so the dependent rows stay
 * bound to their original header even after the constraint swap.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE supplier_price_sheets
    DROP CONSTRAINT IF EXISTS supplier_price_sheets_supplier_date_uq
  `.execute(db);

  await sql`
    ALTER TABLE supplier_price_sheets
    ADD CONSTRAINT supplier_price_sheets_supplier_date_time_uq
    UNIQUE NULLS NOT DISTINCT (supplier, as_of_date, as_of_time)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE supplier_price_sheets
    DROP CONSTRAINT IF EXISTS supplier_price_sheets_supplier_date_time_uq
  `.execute(db);

  // Recreating the old constraint may fail if multiple sheets exist
  // for the same date — that's acceptable for a rollback (down()
  // should be called before any multi-sheet data accumulates).
  await sql`
    ALTER TABLE supplier_price_sheets
    ADD CONSTRAINT supplier_price_sheets_supplier_date_uq
    UNIQUE (supplier, as_of_date)
  `.execute(db);
}
