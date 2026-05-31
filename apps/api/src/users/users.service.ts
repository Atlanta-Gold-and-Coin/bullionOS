import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB } from '../db/types';
import type { UpdateUserDto } from './dto/update-user.dto';

/**
 * Team-member management behind /admin/users. Scope is intentionally
 * small: list the staff/admin accounts and flip a teammate's role +
 * per-user permission flags. Email/password changes are NOT handled
 * here (self-service change-password + the client-portal reset path
 * cover those).
 *
 * The `can_view_owner_private` flag (migration 038) used to be granted
 * by a hardcoded email UPDATE in the migration itself; that block was
 * removed so the schema ships tenant-neutral. Admins now grant it via
 * the checkbox that PATCHes through `update()` below.
 */
@Injectable()
export class UsersService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /**
   * List the internal team (admin + staff). 'client' users are portal
   * accounts managed on the client detail page, not team members, so
   * they're excluded here. Password hash + TOTP secret are never
   * selected.
   */
  async listTeam() {
    return this.db
      .selectFrom('users')
      .select([
        'id',
        'email',
        'role',
        'status',
        'is_2fa_enabled',
        'can_view_owner_private',
        'can_post_daily_update',
        'last_login_at',
        'created_at',
      ])
      .where('role', 'in', ['admin', 'staff'])
      .orderBy('email')
      .execute();
  }

  /**
   * Update a teammate's role / permission flags. Only the keys present
   * on the DTO are written, so an omitted field is left untouched
   * (preserving today's value). Returns the updated row in the same
   * shape as listTeam().
   */
  async update(id: string, dto: UpdateUserDto, actorUserId: string) {
    const patch: Record<string, unknown> = {};
    if (dto.role !== undefined) patch.role = dto.role;
    if (dto.can_view_owner_private !== undefined) {
      patch.can_view_owner_private = dto.can_view_owner_private;
    }
    if (dto.can_post_daily_update !== undefined) {
      patch.can_post_daily_update = dto.can_post_daily_update;
    }

    if (Object.keys(patch).length === 0) {
      return this.getTeamMember(id);
    }

    const updated = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('users')
        .set(patch)
        .where('id', '=', id)
        // Belt-and-suspenders: portal/client rows aren't team members and
        // shouldn't be editable through this admin surface.
        .where('role', 'in', ['admin', 'staff'])
        .returning([
          'id',
          'email',
          'role',
          'status',
          'is_2fa_enabled',
          'can_view_owner_private',
          'can_post_daily_update',
          'last_login_at',
          'created_at',
        ])
        .executeTakeFirst();
      if (!row) throw new NotFoundException('User not found');

      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: actorUserId,
          action: 'user.update',
          entity_type: 'user',
          entity_id: id,
          metadata: sql`${JSON.stringify(patch)}::jsonb`,
        })
        .execute();

      return row;
    });

    return updated;
  }

  private async getTeamMember(id: string) {
    const row = await this.db
      .selectFrom('users')
      .select([
        'id',
        'email',
        'role',
        'status',
        'is_2fa_enabled',
        'can_view_owner_private',
        'can_post_daily_update',
        'last_login_at',
        'created_at',
      ])
      .where('id', '=', id)
      .where('role', 'in', ['admin', 'staff'])
      .executeTakeFirst();
    if (!row) throw new NotFoundException('User not found');
    return row;
  }
}
