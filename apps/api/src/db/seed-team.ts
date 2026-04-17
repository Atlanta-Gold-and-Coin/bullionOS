/* eslint-disable no-console */
/**
 * seed-team: one-shot creation of the AGC team accounts.
 *
 * Usage:
 *   DATABASE_URL=postgresql://...  npx tsx apps/api/src/db/seed-team.ts
 *
 * Idempotent: running twice is safe — rows that already exist are skipped,
 * not overwritten. Password is NEVER touched on re-run (use the admin UI's
 * reset-password flow or the client detail "Reset password" button).
 */
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB, UserRole } from './types';

const TEAM: Array<{ email: string; role: UserRole; first: string; last: string }> = [
  { email: 'hunter@atlantagoldandcoin.com',     role: 'admin', first: 'Hunter',     last: 'AGC' },
  { email: 'albert@atlantagoldandcoin.com',     role: 'admin', first: 'Albert',     last: 'AGC' },
  { email: 'collin@atlantagoldandcoin.com',     role: 'admin', first: 'Collin',     last: 'AGC' },
  { email: 'alyssa@atlantagoldandcoin.com',     role: 'admin', first: 'Alyssa',     last: 'AGC' },
  { email: 'accounting@atlantagoldandcoin.com', role: 'admin', first: 'Accounting', last: 'AGC' },
];

// Default password on creation. Deliberately chosen by the operator — we
// bypass our own 12-char validator here because that rule lives in the
// `POST /auth/register` DTO, not the DB. Everyone should change their
// password on first login; subsequent changes will be forced to 12+.
const DEFAULT_PASSWORD = 'Atlanta123!';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 2 }) }),
  });

  const cost = Number(process.env.BCRYPT_COST ?? 12);
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, cost);

  for (const member of TEAM) {
    const email = member.email.toLowerCase();
    const existing = await db
      .selectFrom('users')
      .select(['id', 'role'])
      .where('email', '=', email)
      .executeTakeFirst();

    if (existing) {
      console.log(`  • ${email.padEnd(44)}  exists (${existing.role}) — skipping`);
      continue;
    }

    await db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto('users')
        .values({
          email,
          password_hash: passwordHash,
          role: member.role,
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('clients')
        .values({
          user_id: user.id,
          first_name: member.first,
          last_name: member.last,
          email,
          is_portal_enabled: true,
        })
        .execute();
    });

    console.log(`  ✓ ${email.padEnd(44)}  created (${member.role})`);
  }

  await db.destroy();

  console.log('\nDefault password:', DEFAULT_PASSWORD);
  console.log('Everyone should:');
  console.log('  1. Sign in at /login');
  console.log('  2. Change their password at /dashboard/security');
  console.log('  3. Enable 2FA at /dashboard/security');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
