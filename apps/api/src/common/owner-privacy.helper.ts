import type { Kysely } from 'kysely';
import type { DB } from '../db/types';

/**
 * Owner-privacy allowlist check (migration 038).
 *
 * Single-row lookup against `users.can_view_owner_private`. Used by
 * any service that filters out `clients.is_owner_private` records
 * for non-allowlisted requesters. Returns true only when the user
 * row exists AND has the flag set — an unknown user id is treated
 * as "not allowed."
 *
 * Cost is one indexed lookup per request that hits a privacy-fenced
 * endpoint (~1 ms). Cheap enough to keep inline rather than caching
 * — the alternative (baking the flag into the JWT) requires a token
 * refresh whenever the allowlist changes, which is worse UX for the
 * rare case where someone is added.
 */
export async function canViewOwnerPrivate(
  db: Kysely<DB>,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('can_view_owner_private')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.can_view_owner_private === true;
}
