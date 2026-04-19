import { Kysely, sql } from 'kysely';

/**
 * 022_wholesale_paid_audit
 *
 * Wholesale invoices are often finalized at sale time but not paid until
 * the wholesaler remits later (net-30 style). We already have `paid_at` on
 * invoices from migration 001, but no record of *who* clicked the Paid
 * button. That's the minimum audit trail AGC wants for wholesale AR.
 *
 *   - paid_by_user_id uuid NULL — actor that marked the invoice paid.
 *     FK to users(id) with ON DELETE SET NULL so deleting a user does not
 *     cascade into invoices.
 *
 * Also adds a partial index tuned for the reconciliation query — "all
 * finalized (not-yet-paid) wholesale invoices grouped by client". Having a
 * `(status, client_id) WHERE status='finalized'` partial keeps the index
 * small since the vast majority of rows are `paid`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('invoices')
    .addColumn('paid_by_user_id', 'uuid', (c) =>
      c.references('users.id').onDelete('set null'),
    )
    .execute();

  await sql`
    CREATE INDEX invoices_outstanding_by_client_idx
      ON invoices (client_id)
      WHERE status = 'finalized'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS invoices_outstanding_by_client_idx`.execute(db);
  await db.schema
    .alterTable('invoices')
    .dropColumn('paid_by_user_id')
    .execute();
}
