import { Kysely } from 'kysely';

/**
 * 038_owner_private_invoices
 *
 * Per-client privacy fence for owner / accounting personal accounts
 * (Hunter, Tim). When an admin or staff member who is NOT on the
 * `users.can_view_owner_private` allowlist hits any surface that
 * would leak details of an `is_owner_private` client, the row is
 * fully hidden — invoice list, client list, client detail, timeline,
 * wholesale AR, all of it. Server returns 404 (not 403) on direct
 * URL access so the existence of the record is itself confidential.
 *
 * KPI / EOD / dashboard totals deliberately do NOT filter — the
 * dollars still roll up so reconciliation matches reality. The
 * only thing hidden is "who" / "what" — the aggregate "how much"
 * stays accurate.
 *
 * This is intentionally separate from `clients.exclude_from_reports`
 * which has the opposite semantics (those clients are skipped by KPI/
 * EOD entirely — used for test accounts that should never count).
 *
 * Allowlisting: `can_view_owner_private` defaults to false for every
 * user. Admins grant it per-user via the /admin/users checkbox (no
 * hardcoded tenant emails — this product is shipped per-tenant and
 * must not bake AGC-specific accounts into the schema history).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('clients')
    .addColumn('is_owner_private', 'boolean', (c) =>
      c.notNull().defaultTo(false),
    )
    .execute();

  await db.schema
    .alterTable('users')
    .addColumn('can_view_owner_private', 'boolean', (c) =>
      c.notNull().defaultTo(false),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('can_view_owner_private').execute();
  await db.schema.alterTable('clients').dropColumn('is_owner_private').execute();
}
