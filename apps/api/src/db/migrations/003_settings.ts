import { Kysely, sql } from 'kysely';

/**
 * 003_settings: app_settings key/value store.
 *
 * Used for branding (invoice logo path, company name), default tax rate,
 * and other settings that don't warrant their own table. Value is jsonb
 * so we don't need a migration per new setting.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('app_settings')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'jsonb', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_by_user_id', 'uuid', (c) =>
      c.references('users.id').onDelete('set null'),
    )
    .execute();

  await sql`
    CREATE TRIGGER app_settings_set_updated_at
    BEFORE UPDATE ON app_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `.execute(db);

  // No seed values — `SettingsService.getBranding()` returns neutral
  // placeholders when keys are absent. Each tenant fills branding via
  // the admin UI on first run.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('app_settings').ifExists().execute();
}
