/**
 * One-shot admin recovery: clear a user's 2FA so they can log in with only
 * email + password. Use when an admin loses their authenticator device.
 *
 * Usage (from repo root):
 *   pnpm --filter @agc/api exec tsx src/db/disable-2fa.ts hunter@atlantagoldandcoin.com
 *
 * Against Railway:
 *   railway run --service agc-api pnpm --filter @agc/api exec tsx src/db/disable-2fa.ts hunter@atlantagoldandcoin.com
 *
 * What it does:
 *   1. Finds the user by email
 *   2. Unsets is_2fa_enabled + totp_secret
 *   3. Deletes any un-used recovery codes
 *   4. Reports rows affected
 *
 * What it does NOT do:
 *   - Change the password (use /auth/change-password for that)
 *   - Revoke refresh tokens (the user will be logged out automatically if
 *     the password was just rotated, otherwise existing sessions stay)
 */

import 'dotenv/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './types';

async function main() {
  const arg = process.argv[2]?.trim().toLowerCase();

  const connectionString =
    process.env.DATABASE_URL ?? process.env.DATABASE_PUBLIC_URL;
  if (!connectionString) {
    console.error('Set DATABASE_URL (or DATABASE_PUBLIC_URL).');
    process.exit(2);
  }

  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, ssl: { rejectUnauthorized: false } }),
    }),
  });

  // No arg, or --list → just print every user that currently has 2FA on.
  if (!arg || arg === '--list' || arg === 'list') {
    try {
      const rows = await db
        .selectFrom('users')
        .select(['email', 'role', 'is_2fa_enabled'])
        .where('is_2fa_enabled', '=', true)
        .orderBy('email')
        .execute();
      if (rows.length === 0) {
        console.log('No users currently have 2FA enabled.');
      } else {
        console.log('Users with 2FA enabled:');
        for (const r of rows) console.log(`  ${r.email}  (${r.role})`);
        console.log('\nRe-run with an email to clear: tsx disable-2fa.ts <email>');
      }
      await db.destroy();
      return;
    } catch (err) {
      console.error(err);
      await db.destroy();
      process.exit(1);
    }
  }

  const email = arg;
  try {
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'is_2fa_enabled'])
      .where('email', '=', email)
      .executeTakeFirst();

    if (!user) {
      console.error(`No user with email ${email}`);
      process.exit(1);
    }

    if (!user.is_2fa_enabled) {
      console.log(`${email} already has 2FA disabled. Nothing to do.`);
      process.exit(0);
    }

    await db
      .updateTable('users')
      .where('id', '=', user.id)
      .set({ is_2fa_enabled: false, totp_secret: null })
      .execute();

    const deleted = await db
      .deleteFrom('totp_recovery_codes')
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    console.log(
      `✓ Cleared 2FA for ${email} (user_id=${user.id}) — deleted ${Number(
        deleted.numDeletedRows ?? 0,
      )} recovery code(s). Log in with email + password; re-enroll 2FA from /dashboard/security afterwards.`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
