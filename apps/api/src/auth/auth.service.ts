import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, User, UserRole } from '../db/types';
import { TokensService, type IssuedTokens } from './tokens.service';
import { TwoFactorService } from './twofa.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

interface ReqCtx {
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // Failed-login lockout policy.
  private readonly maxFailedAttempts = 10;
  private readonly lockoutMinutes = 15;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly tokens: TokensService,
    private readonly twofa: TwoFactorService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto, ctx: ReqCtx): Promise<{ user_id: string; tokens: IssuedTokens }> {
    if (!this.config.get<boolean>('ENABLE_SIGNUP', true)) {
      throw new ForbiddenException('Self-signup is disabled');
    }

    const emailNorm = dto.email.trim().toLowerCase();
    const cost = this.config.get<number>('BCRYPT_COST', 12);
    const password_hash = await bcrypt.hash(dto.password, cost);

    const result = await this.db.transaction().execute(async (trx) => {
      // Check first to return a clean error (citext unique would also catch this).
      const existing = await trx
        .selectFrom('users')
        .select('id')
        .where('email', '=', emailNorm)
        .executeTakeFirst();
      if (existing) {
        throw new BadRequestException('Email already registered');
      }

      const user = await trx
        .insertInto('users')
        .values({
          email: emailNorm,
          password_hash,
          role: 'client',
          status: 'active',
        })
        .returning(['id', 'email', 'role'])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('clients')
        .values({
          user_id: user.id,
          first_name: dto.first_name.trim(),
          last_name: dto.last_name.trim(),
          email: emailNorm,
          phone: dto.phone?.trim() ?? null,
          is_portal_enabled: true,
        })
        .execute();

      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: user.id,
          action: 'auth.register',
          entity_type: 'user',
          entity_id: user.id,
          metadata: sql`${JSON.stringify({ role: 'client' })}::jsonb`,
          ip_address: ctx.ip ?? null,
          user_agent: ctx.userAgent ?? null,
        })
        .execute();

      return user;
    });

    const tokens = await this.tokens.issueTokens(
      result.id,
      result.email,
      result.role,
      ctx,
    );

    return { user_id: result.id, tokens };
  }

  async login(dto: LoginDto, ctx: ReqCtx): Promise<IssuedTokens> {
    const emailNorm = dto.email.trim().toLowerCase();

    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', emailNorm)
      .executeTakeFirst();

    // Constant-time-ish: run a dummy bcrypt compare even when the user doesn't exist,
    // so timing doesn't leak account enumeration.
    if (!user) {
      await bcrypt.compare(dto.password, '$2b$12$invalidsaltinvalidsaltinvalid.DummyHashForTimingOnly');
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status === 'disabled') {
      throw new ForbiddenException('Account disabled');
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw new ForbiddenException('Account temporarily locked. Try again later.');
    }

    const ok = await bcrypt.compare(dto.password, user.password_hash);
    if (!ok) {
      await this.recordFailedLogin(user);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.is_2fa_enabled) {
      if (!dto.totp) throw new UnauthorizedException('TOTP code required');
      const ok2fa = await this.twofa.verify(user.id, dto.totp);
      if (!ok2fa) {
        await this.recordFailedLogin(user);
        throw new UnauthorizedException('Invalid TOTP code');
      }
    }

    // Reset counters + stamp last_login
    await this.db
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null, last_login_at: new Date() })
      .where('id', '=', user.id)
      .execute();

    await this.db
      .insertInto('audit_logs')
      .values({
        actor_user_id: user.id,
        action: 'auth.login',
        entity_type: 'user',
        entity_id: user.id,
        metadata: sql`'{}'::jsonb`,
        ip_address: ctx.ip ?? null,
        user_agent: ctx.userAgent ?? null,
      })
      .execute();

    return this.tokens.issueTokens(user.id, user.email, user.role, ctx);
  }

  private async recordFailedLogin(user: User): Promise<void> {
    const next = (user.failed_login_count ?? 0) + 1;
    const shouldLock = next >= this.maxFailedAttempts;
    await this.db
      .updateTable('users')
      .set({
        failed_login_count: next,
        locked_until: shouldLock
          ? new Date(Date.now() + this.lockoutMinutes * 60_000)
          : user.locked_until ?? null,
      })
      .where('id', '=', user.id)
      .execute();

    if (shouldLock) {
      this.logger.warn(`User ${user.id} locked after ${next} failed attempts`);
    }
  }

  async refresh(refreshToken: string, ctx: ReqCtx): Promise<IssuedTokens> {
    let payload: { sub: string };
    try {
      payload = await this.tokens.verifyRefreshToken(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'role', 'status'])
      .where('id', '=', payload.sub)
      .executeTakeFirst();

    if (!user || user.status === 'disabled') {
      throw new UnauthorizedException('Account not available');
    }

    try {
      return await this.tokens.rotate(
        refreshToken,
        { id: user.id, email: user.email, role: user.role as UserRole },
        ctx,
      );
    } catch (err) {
      this.logger.warn(`Refresh rejected for user ${user.id}: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }

  /**
   * Self-service password change. Requires re-entering the current password
   * (prevents drive-by change if the access token leaks), revokes every
   * existing refresh token for the user so all other sessions are booted,
   * and audits the event.
   *
   * Returns nothing — the caller's existing access token stays valid until
   * its next natural refresh, at which point it will fail (all refreshes
   * revoked) and the user will be signed out cleanly on every device.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ctx: ReqCtx,
  ): Promise<void> {
    if (currentPassword === newPassword) {
      throw new BadRequestException('New password must be different');
    }
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'password_hash', 'status'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new UnauthorizedException();
    if (user.status === 'disabled') throw new ForbiddenException('Account disabled');

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) {
      await this.db
        .insertInto('audit_logs')
        .values({
          actor_user_id: userId,
          action: 'auth.password_change.reject',
          entity_type: 'user',
          entity_id: userId,
          metadata: sql`'{}'::jsonb`,
          ip_address: ctx.ip ?? null,
          user_agent: ctx.userAgent ?? null,
        })
        .execute();
      throw new UnauthorizedException('Current password is incorrect');
    }

    const cost = this.config.get<number>('BCRYPT_COST', 12);
    const newHash = await bcrypt.hash(newPassword, cost);

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ password_hash: newHash, failed_login_count: 0, locked_until: null })
        .where('id', '=', userId)
        .execute();
      // Kill every outstanding refresh token — every other device is signed out.
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute();
      await trx
        .insertInto('audit_logs')
        .values({
          actor_user_id: userId,
          action: 'auth.password_change',
          entity_type: 'user',
          entity_id: userId,
          metadata: sql`'{}'::jsonb`,
          ip_address: ctx.ip ?? null,
          user_agent: ctx.userAgent ?? null,
        })
        .execute();
    });
  }

  async me(userId: string) {
    const row = await this.db
      .selectFrom('users as u')
      .leftJoin('clients as c', 'c.user_id', 'u.id')
      .select([
        'u.id',
        'u.email',
        'u.role',
        'u.status',
        'u.is_2fa_enabled',
        'u.last_login_at',
        // Migration 038: surfaced so the web UI can conditionally
        // render owner-privacy controls (the toggle on the client
        // form, etc.) without a separate roundtrip.
        'u.can_view_owner_private',
        'c.first_name',
        'c.last_name',
        'c.phone',
      ])
      .where('u.id', '=', userId)
      .executeTakeFirst();

    if (!row) throw new UnauthorizedException();
    return row;
  }
}
