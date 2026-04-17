import { Kysely } from 'kysely';

/**
 * 014_client_referral_source
 *
 * Add "How they heard about us" field on clients. Free-form text because
 * marketing sources evolve constantly (Google, Facebook ad campaigns,
 * radio spots, referrals from specific people) — enumerating is a losing
 * battle. The admin UI can offer suggested values as a datalist later.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('clients')
    .addColumn('heard_from', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('clients').dropColumn('heard_from').execute();
}
