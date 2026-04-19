import { Kysely } from 'kysely';

/**
 * 021_shipment_delivery_speed
 *
 * Adds a carrier-specific service level to shipments. Value is the
 * human-readable label from the UI dropdown (e.g. "Priority Express",
 * "2nd Day Air - Saturday Delivery"). The allowed values depend on which
 * carrier is selected — we enforce that pairing in the shipments service,
 * not in a CHECK constraint, so the whitelist stays in one place (the
 * typescript registry) and can be edited without a migration.
 *
 * Column is nullable: existing shipment rows pre-dating this change have
 * no recorded service level and readers fall back to "—".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('shipments')
    .addColumn('delivery_speed', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('shipments')
    .dropColumn('delivery_speed')
    .execute();
}
