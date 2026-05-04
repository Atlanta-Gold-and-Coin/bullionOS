/* eslint-disable no-console */
/**
 * seed-team: one-shot creation of the FIRST admin account on a fresh
 * tenant DB. Reads identity from environment so this script ships
 * tenant-neutral.
 *
 * Required env:
 *   SEED_ADMIN_EMAIL       e.g. owner@yourcoin.com
 *   SEED_ADMIN_PASSWORD    initial password (must satisfy 12-char rule)
 * Optional env:
 *   SEED_ADMIN_FIRST       default "Owner"
 *   SEED_ADMIN_LAST        default ""
 *
 * Usage:
 *   SEED_ADMIN_EMAIL=owner@yourcoin.com \
 *   SEED_ADMIN_PASSWORD='ChangeMe!2026' \
 *   DATABASE_URL=postgresql://... \
 *     npx tsx apps/api/src/db/seed-team.ts
 *
 * Idempotent: existing user with the same email is skipped. The
 * password is NEVER overwritten on re-run — use the admin UI to reset.
 *
 * After seeding the first admin, additional team members should be
 * created via /admin/users in the UI rather than this script.
 */
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './types';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminEmail) {
    throw new Error('SEED_ADMIN_EMAIL is required (e.g. owner@yourcoin.com)');
  }
  if (!adminPassword || adminPassword.length < 12) {
    throw new Error(
      'SEED_ADMIN_PASSWORD is required and must be at least 12 characters',
    );
  }
  const adminFirst = process.env.SEED_ADMIN_FIRST?.trim() || 'Owner';
  const adminLast = process.env.SEED_ADMIN_LAST?.trim() || '';

  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url, max: 2 }),
    }),
  });

  try {
    const existing = await db
      .selectFrom('users')
      .select(['id', 'role'])
      .where('email', '=', adminEmail)
      .executeTakeFirst();

    if (existing) {
      console.log(
        `  • ${adminEmail.padEnd(44)}  exists (${existing.role}) — skipping`,
      );
    } else {
      const cost = Number(process.env.BCRYPT_COST ?? 12);
      const passwordHash = await bcrypt.hash(adminPassword, cost);

      await db.transaction().execute(async (trx) => {
        const user = await trx
          .insertInto('users')
          .values({
            email: adminEmail,
            password_hash: passwordHash,
            role: 'admin',
            status: 'active',
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('clients')
          .values({
            user_id: user.id,
            first_name: adminFirst,
            last_name: adminLast,
            email: adminEmail,
            is_portal_enabled: true,
          })
          .execute();
      });

      console.log(`  ✓ ${adminEmail.padEnd(44)}  created (admin)`);
    }

    console.log('\nFirst-admin seed complete.');
    console.log('Sign in at /login, then:');
    console.log('  1. Configure branding at /admin/settings');
    console.log('  2. Add team members at /admin/users');
    console.log('  3. Enable 2FA at /dashboard/security');
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
