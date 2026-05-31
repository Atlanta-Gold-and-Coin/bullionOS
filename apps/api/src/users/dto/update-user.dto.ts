import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { UserRole } from '../../db/types';

/**
 * Admin-update DTO for team members at /admin/users.
 *
 * Deliberately narrow: an admin can adjust a teammate's role and the
 * per-user permission flags, but NOT email/password (self-service
 * change-password + portal reset live elsewhere). Every field is
 * optional — the service only writes the keys that are present, so a
 * PATCH that omits a field leaves it untouched (today's behaviour for
 * any flag the caller doesn't send).
 */
export class UpdateUserDto {
  /** Promote/demote between admin and staff. 'client' is managed via the portal flow, not here. */
  @IsOptional()
  @IsIn(['admin', 'staff'])
  role?: Extract<UserRole, 'admin' | 'staff'>;

  /**
   * Migration 038: allowlist for viewing owner-private clients/invoices.
   * Admins grant this per-user here (replaces the old hardcoded email
   * bootstrap in migration 038). Defaults to false on every new user.
   */
  @IsOptional()
  @IsBoolean()
  can_view_owner_private?: boolean;

  /** Migration 026: gate for posting Daily Updates. */
  @IsOptional()
  @IsBoolean()
  can_post_daily_update?: boolean;
}
