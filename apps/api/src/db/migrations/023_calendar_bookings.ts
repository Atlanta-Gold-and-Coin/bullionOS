import { Kysely, sql } from 'kysely';

/**
 * 023_calendar_bookings
 *
 * Creates a local mirror of Google Calendar bookings so they can be tied
 * to clients. Today `calendar.service.ts → createBooking()` only writes
 * to Google; the event exists on Google's API with no link back to our
 * clients table. This means admins can't see a client's appointment
 * history on /admin/clients/:id.
 *
 * The booking captures name + email + phone + notes on creation; we use
 * those to find or create a matching client (logic lives in
 * calendar.service.ts, not the schema).
 *
 *   - google_event_id TEXT UNIQUE — de-dupes ingest if a booking is
 *     re-inserted (webhook retries, import jobs, etc.).
 *   - client_id uuid NULL FK → clients(id) ON DELETE SET NULL — deleting
 *     a client preserves the booking history (keeps calendar record) but
 *     detaches the link. Admin can re-match later.
 *   - status TEXT DEFAULT 'confirmed' — 'confirmed' | 'canceled' |
 *     'completed'. Enforced app-side for now; no CHECK so we can extend.
 *   - source TEXT DEFAULT 'public_booking' — 'public_booking' |
 *     'admin_created' | 'google_import'. Useful for analytics / filters.
 *
 * Indexes:
 *   - (client_id) for the /admin/clients/:id timeline
 *   - (starts_at DESC) for the agenda view
 *   - UNIQUE(google_event_id) doubles as a lookup index for webhook ingest
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('calendar_bookings')
    .addColumn('id', 'uuid', (c) =>
      c.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('google_event_id', 'text', (c) => c.notNull().unique())
    .addColumn('client_id', 'uuid', (c) =>
      c.references('clients.id').onDelete('set null'),
    )
    .addColumn('service', 'text')
    .addColumn('starts_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ends_at', 'timestamptz', (c) => c.notNull())
    .addColumn('name', 'text')
    .addColumn('email', 'text')
    .addColumn('phone', 'text')
    .addColumn('notes', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('confirmed'))
    .addColumn('source', 'text', (c) => c.notNull().defaultTo('public_booking'))
    .addColumn('created_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('calendar_bookings_client_idx')
    .on('calendar_bookings')
    .column('client_id')
    .execute();

  await sql`
    CREATE INDEX calendar_bookings_starts_at_idx
      ON calendar_bookings (starts_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('calendar_bookings').ifExists().execute();
}
