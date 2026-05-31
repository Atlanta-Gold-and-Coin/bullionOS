import { Kysely, sql } from 'kysely';

/**
 * 039_custom_fields_jsonb
 *
 * Per-tenant custom fields for clients + products. Each tenant can
 * define its own extra fields (the schema lives in app_settings under
 * `custom_fields_schema`, owned by the settings slice); the *values*
 * are stored per-row in a free-form JSONB column on each entity.
 *
 * Both columns are `NOT NULL DEFAULT '{}'::jsonb` so existing rows get
 * an empty object and today's behaviour is byte-identical — nothing
 * reads or renders custom_fields until a tenant defines a schema and
 * the admin forms start writing into it.
 *
 * Values are stored as-is (passthrough) — no server-side validation
 * against the schema. The schema drives which inputs the UI renders;
 * the column just round-trips whatever object the form sends.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('clients')
    .addColumn('custom_fields', 'jsonb', (c) =>
      c.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();

  await db.schema
    .alterTable('products')
    .addColumn('custom_fields', 'jsonb', (c) =>
      c.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('products').dropColumn('custom_fields').execute();
  await db.schema.alterTable('clients').dropColumn('custom_fields').execute();
}
