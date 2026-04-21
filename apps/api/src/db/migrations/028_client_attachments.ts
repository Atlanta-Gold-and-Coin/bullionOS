import { Kysely, sql } from 'kysely';

/**
 * 028_client_attachments
 *
 * On-client document storage — driver's license, passport, other
 * ID/KYC docs. Same inline-bytea pattern as branding_assets (mig 016)
 * and daily_update_attachments (mig 026); Railway Postgres handles
 * moderate blob volume fine and the alternative (S3) is over-engineered
 * for this single-tenant CRM.
 *
 * Columns
 *   - client_id: FK, cascade delete. Removing the client wipes their
 *     attachments — no orphan ID docs lingering after a relationship
 *     ends.
 *   - kind: free-text tag ('drivers_license', 'passport', 'other',
 *     etc.). Kept open so operators can name new types without a
 *     migration. OCR can dispatch off this later.
 *   - filename / mime / bytes: stored as-uploaded.
 *   - uploaded_by_user_id: audit. ON DELETE SET NULL so deleting a
 *     user doesn't cascade into client files.
 *   - ocr_* fields reserved for a later OCR pass:
 *       ocr_status (null | pending | succeeded | failed),
 *       ocr_text   (raw extracted text),
 *       ocr_fields (jsonb — structured fields like first_name, DOB).
 *     All nullable; feature can ship in a follow-up without another
 *     migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('client_attachments')
    .addColumn('id', 'uuid', (c) =>
      c.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('client_id', 'uuid', (c) =>
      c.notNull().references('clients.id').onDelete('cascade'),
    )
    .addColumn('kind', 'text', (c) => c.notNull().defaultTo('other'))
    .addColumn('filename', 'text', (c) => c.notNull())
    .addColumn('mime', 'text', (c) => c.notNull())
    .addColumn('bytes', 'bytea', (c) => c.notNull())
    .addColumn('size_bytes', 'integer', (c) => c.notNull())
    .addColumn('uploaded_by_user_id', 'uuid', (c) =>
      c.references('users.id').onDelete('set null'),
    )
    .addColumn('ocr_status', 'text')
    .addColumn('ocr_text', 'text')
    .addColumn('ocr_fields', 'jsonb')
    .addColumn('created_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Lookups are always "give me attachments for client X". Composite
  // on (client_id, created_at DESC) keeps the attachment card render
  // a single index scan.
  await sql`
    CREATE INDEX client_attachments_client_created_idx
      ON client_attachments (client_id, created_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('client_attachments').ifExists().execute();
}
