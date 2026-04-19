import { Kysely, sql } from 'kysely';

/**
 * 020_client_company_and_emails
 *
 * Extends the client model for the wholesale + secondary-email use cases:
 *
 *   1. `company TEXT NULL` — wholesale records frequently identify primarily
 *      by company name, not a personal name. Today the app shoehorns the
 *      company into last_name which produces "" first-names and misleading
 *      display. With a real column we can render wholesale records as
 *      "Acme Coin Co. (Jane Doe)" while retail stays "Jane Doe".
 *
 *   2. `secondary_emails JSONB NOT NULL DEFAULT '[]'` — a client can have
 *      multiple email addresses on file (spouse, accountant, etc.). We use
 *      JSONB (array of strings) rather than a separate table to match the
 *      existing `invoices.payment_methods` pattern and avoid a join on every
 *      client read.
 *
 *   3. Wholesale records can legitimately lack a first_name/last_name (they
 *      are a company). Relax NOT NULL on those columns, then enforce a
 *      CHECK that says: every row must have *either* a personal name or a
 *      company name, so we never wind up with a totally anonymous client.
 *
 *   4. Rebuild the GENERATED `search_text` column so fuzzy search now covers
 *      company as well. Postgres does not allow altering a GENERATED
 *      expression in-place — we DROP the column (which also drops the GIN
 *      index on it) and recreate both. Clients table is ~600 rows so this
 *      is instant.
 *
 * Rollback: reverses every change. Column drops are destructive for any data
 * written between up() and down(), which is acceptable for local rollback
 * during development. In prod we'd forward-fix instead of running down().
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. company + secondary_emails
  await db.schema
    .alterTable('clients')
    .addColumn('company', 'text')
    .execute();

  await sql`
    ALTER TABLE clients
    ADD COLUMN secondary_emails jsonb NOT NULL DEFAULT '[]'::jsonb
  `.execute(db);

  // 2. Relax name-required invariant for wholesale-company records.
  await sql`ALTER TABLE clients ALTER COLUMN first_name DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE clients ALTER COLUMN last_name DROP NOT NULL`.execute(db);

  await sql`
    ALTER TABLE clients
    ADD CONSTRAINT clients_has_identity CHECK (
      (first_name IS NOT NULL AND length(trim(first_name)) > 0)
      OR (last_name  IS NOT NULL AND length(trim(last_name))  > 0)
      OR (company    IS NOT NULL AND length(trim(company))    > 0)
    )
  `.execute(db);

  // 3. Rebuild search_text to include company. Drop index first (it depends
  //    on the column), then the column, then recreate both.
  await sql`DROP INDEX IF EXISTS clients_search_trgm_idx`.execute(db);
  await sql`ALTER TABLE clients DROP COLUMN IF EXISTS search_text`.execute(db);

  await sql`
    ALTER TABLE clients
    ADD COLUMN search_text text
      GENERATED ALWAYS AS (
        lower(
          coalesce(first_name,'') || ' ' ||
          coalesce(last_name,'')  || ' ' ||
          coalesce(company,'')    || ' ' ||
          coalesce(email::text,'') || ' ' ||
          coalesce(phone,'')      || ' ' ||
          coalesce(city,'')       || ' ' ||
          coalesce(region,'')
        )
      ) STORED
  `.execute(db);

  await sql`
    CREATE INDEX clients_search_trgm_idx
      ON clients USING gin (search_text gin_trgm_ops)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse search_text rebuild (restore original shape from migration 006).
  await sql`DROP INDEX IF EXISTS clients_search_trgm_idx`.execute(db);
  await sql`ALTER TABLE clients DROP COLUMN IF EXISTS search_text`.execute(db);

  await sql`
    ALTER TABLE clients
    ADD COLUMN search_text text
      GENERATED ALWAYS AS (
        lower(coalesce(first_name,'') || ' ' ||
              coalesce(last_name,'') || ' ' ||
              coalesce(email::text,'') || ' ' ||
              coalesce(phone,'') || ' ' ||
              coalesce(city,'') || ' ' ||
              coalesce(region,''))
      ) STORED
  `.execute(db);
  await sql`
    CREATE INDEX clients_search_trgm_idx
      ON clients USING gin (search_text gin_trgm_ops)
  `.execute(db);

  // Reverse name/company changes.
  await sql`ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_has_identity`.execute(db);
  // Restoring NOT NULL requires all rows to have a value. Forward-fix in prod.
  await sql`UPDATE clients SET first_name = '' WHERE first_name IS NULL`.execute(db);
  await sql`UPDATE clients SET last_name  = '' WHERE last_name  IS NULL`.execute(db);
  await sql`ALTER TABLE clients ALTER COLUMN first_name SET NOT NULL`.execute(db);
  await sql`ALTER TABLE clients ALTER COLUMN last_name SET NOT NULL`.execute(db);

  await db.schema.alterTable('clients').dropColumn('secondary_emails').execute();
  await db.schema.alterTable('clients').dropColumn('company').execute();
}
