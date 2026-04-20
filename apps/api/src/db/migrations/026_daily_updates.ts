import { Kysely, sql } from 'kysely';

/**
 * 026_daily_updates
 *
 * "Daily Updates" feature — a single-author social-feed post on the
 * admin dashboard, with commenting open to every team member.
 *
 * Scope decisions baked into this schema:
 *   - There can be many posts historically, but the dashboard always
 *     shows the LATEST one (ORDER BY created_at DESC LIMIT 1). No
 *     explicit "active" flag; that simplifies edit/delete.
 *   - Only users with `users.can_post_daily_update = TRUE` can create,
 *     edit, or delete posts. Comments are open to any admin/staff.
 *   - Attachments live in a companion table carrying inline bytea blobs
 *     (same pattern as branding_assets from migration 016). The CRM
 *     runs on Railway with ephemeral disk, so DB-embedded is the only
 *     durable option without bolting on S3.
 *
 * Tables created:
 *   - daily_updates:
 *       id, body (markdown), author_user_id, created_at, updated_at
 *   - daily_update_comments:
 *       id, daily_update_id, author_user_id, body, created_at, updated_at
 *   - daily_update_attachments:
 *       id, daily_update_id, filename, mime, bytes, created_at
 *
 * Column added:
 *   - users.can_post_daily_update BOOLEAN NOT NULL DEFAULT FALSE
 *     Flipped to TRUE per-seat for the small number of operators who
 *     should be able to post. Intentionally NOT tied to the user's
 *     email so delegation later is a boolean flip, not a code change.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('can_post_daily_update', 'boolean', (c) =>
      c.notNull().defaultTo(false),
    )
    .execute();

  await db.schema
    .createTable('daily_updates')
    .addColumn('id', 'uuid', (c) =>
      c.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('author_user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // Latest-first lookups on the dashboard.
  await sql`
    CREATE INDEX daily_updates_created_at_idx
      ON daily_updates (created_at DESC)
  `.execute(db);

  await db.schema
    .createTable('daily_update_comments')
    .addColumn('id', 'uuid', (c) =>
      c.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('daily_update_id', 'uuid', (c) =>
      c.notNull().references('daily_updates.id').onDelete('cascade'),
    )
    .addColumn('author_user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    CREATE INDEX daily_update_comments_update_id_idx
      ON daily_update_comments (daily_update_id, created_at)
  `.execute(db);

  await db.schema
    .createTable('daily_update_attachments')
    .addColumn('id', 'uuid', (c) =>
      c.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('daily_update_id', 'uuid', (c) =>
      c.notNull().references('daily_updates.id').onDelete('cascade'),
    )
    .addColumn('filename', 'text', (c) => c.notNull())
    .addColumn('mime', 'text', (c) => c.notNull())
    .addColumn('bytes', 'bytea', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    CREATE INDEX daily_update_attachments_update_id_idx
      ON daily_update_attachments (daily_update_id, created_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('daily_update_attachments').ifExists().execute();
  await db.schema.dropTable('daily_update_comments').ifExists().execute();
  await db.schema.dropTable('daily_updates').ifExists().execute();
  await db.schema
    .alterTable('users')
    .dropColumn('can_post_daily_update')
    .execute();
}
