import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import type { IssuedTokens } from './tokens.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/**
 * Cookie layout:
 *   - `agc_refresh`: the refresh token. httpOnly, Secure (in prod), SameSite=Lax.
 *     Scoped to /api/v1/auth so it isn't sent on unrelated requests.
 *   - Access tokens stay in memory in the browser — never in a cookie.
 *
 * CSRF: we rely on SameSite=Lax + CORS locked to WEB_ORIGIN. Cross-origin
 * attackers can't read any response due to CORS, and SameSite blocks the
 * refresh cookie from being sent on forged requests. If the threat model
 * later expands to include subdomain takeover, we can add a double-submit
 * token without touching the access-token flow.
 */
const REFRESH_COOKIE = 'agc_refresh';
const REFRESH_PATH = '/api/v1/auth';

function ctxFromRequest(req: Request) {
  const ip = (req.ip ?? null) as string | null;
  const userAgent = (req.headers['user-agent'] ?? null) as string | null;
  return { ip, userAgent };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private cookieOpts(ttlMs?: number): CookieOptions {
    const isProd = this.config.get('NODE_ENV') === 'production';
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: REFRESH_PATH,
      ...(ttlMs !== undefined ? { maxAge: ttlMs } : {}),
    };
  }

  /** Set the refresh cookie + strip it from the response body. */
  private writeTokenResponse(
    res: Response,
    tokens: IssuedTokens,
  ): {
    access_token: string;
    access_expires_in: number;
  } {
    // 30d in ms — same horizon as JWT_REFRESH_TTL. If you change the TTL in env,
    // the cookie lifetime auto-tracks through the Set-Cookie Max-Age we compute
    // from the token's exp claim.
    const refreshMs = this.parseTtlMs(this.config.get<string>('JWT_REFRESH_TTL', '30d'));
    res.cookie(REFRESH_COOKIE, tokens.refresh_token, this.cookieOpts(refreshMs));
    return {
      access_token: tokens.access_token,
      access_expires_in: tokens.access_expires_in,
    };
  }

  private parseTtlMs(ttl: string): number {
    const m = /^(\d+)([smhd])$/.exec(ttl.trim());
    if (!m) return 30 * 86_400_000;
    const n = Number(m[1]);
    const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      m[2] as 's' | 'm' | 'h' | 'd'
    ];
    return n * mult;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @HttpCode(201)
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user_id, tokens } = await this.auth.register(dto, ctxFromRequest(req));
    return { user_id, tokens: this.writeTokenResponse(res, tokens) };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.login(dto, ctxFromRequest(req));
    return this.writeTokenResponse(res, tokens);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[
      REFRESH_COOKIE
    ];
    if (!raw) throw new UnauthorizedException('No refresh cookie');
    const tokens = await this.auth.refresh(raw, ctxFromRequest(req));
    return this.writeTokenResponse(res, tokens);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[
      REFRESH_COOKIE
    ];
    if (raw) await this.auth.logout(raw);
    // Always clear the cookie — even if the token was invalid.
    res.clearCookie(REFRESH_COOKIE, this.cookieOpts());
  }

  @Get('me')
  async me(@CurrentUser() user: RequestUser) {
    return this.auth.me(user.id);
  }

  /**
   * Self-service password change. Requires a valid access token (inherited
   * JwtAuthGuard) + the current password in the body. On success, every
   * other session for this user is revoked — the caller's access token
   * stays valid until its natural expiry (~15 min) and will then fail to
   * refresh, signing them out cleanly.
   */
  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    await this.auth.changePassword(
      user.id,
      dto.current_password,
      dto.new_password,
      ctxFromRequest(req),
    );
  }
}
