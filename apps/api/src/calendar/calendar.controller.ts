import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { IntegrationsService } from '../integrations/integrations.service';
import type { CredentialsFor } from '../integrations/integrations.registry';
import { CalendarService } from './calendar.service';

class EventAttendeeDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

class CreateAdminEventDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsISO8601()
  start!: string;

  @IsISO8601()
  end!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => EventAttendeeDto)
  attendees?: EventAttendeeDto[];

  /** 'all' (default) emails attendees; 'none' creates silently (OoO block). */
  @IsOptional()
  @IsIn(['all', 'externalOnly', 'none'])
  sendUpdates?: 'all' | 'externalOnly' | 'none';
}

class CreateBookingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  service!: string;

  @IsISO8601()
  start!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/**
 * Calendar endpoints.
 *
 * Public:
 *   GET  /public/calendar/config        — services, tz, window, slot size
 *   GET  /public/calendar/slots?date=…  — array of { start, end }
 *   POST /public/calendar/book          — creates the event
 *
 * Admin (OAuth plumbing — one-time setup):
 *   GET  /admin/integrations/google_calendar/authorize?return_to=…
 *        — returns { url } to Google's consent screen
 *   GET  /admin/integrations/google_calendar/callback?code=…&state=…
 *        — exchanges the code for a refresh_token and writes it onto
 *          the integration row. Redirect lands here via the URL we
 *          registered at Google Cloud Console.
 */
@Controller()
export class CalendarController {
  // In-memory CSRF state store. OAuth consent round-trips in seconds, so
  // a process-local map with TTL is enough for one-admin-at-a-time.
  // Also carries the initiating admin's user_id so the callback — which
  // runs un-authenticated (Google redirect) — can still attribute the
  // credential write in the audit log.
  private readonly pending = new Map<
    string,
    { redirectUri: string; expiresAt: number; actorUserId: string }
  >();

  constructor(
    private readonly calendar: CalendarService,
    private readonly integrations: IntegrationsService,
  ) {}

  // ---------- Public booking ----------

  @Public()
  @Get('public/calendar/config')
  async publicConfig() {
    const cfg = await this.calendar.getPublicConfig();
    if (!cfg || !cfg.configured) {
      return { configured: false };
    }
    return cfg;
  }

  @Public()
  @Get('public/calendar/slots')
  async publicSlots(@Query('date') date?: string) {
    if (!date) throw new BadRequestException('date (YYYY-MM-DD) is required');
    return this.calendar.getSlots(date);
  }

  @Public()
  @Post('public/calendar/book')
  async publicBook(@Body() dto: CreateBookingDto) {
    const cfg = await this.calendar.getPublicConfig();
    if (!cfg) throw new BadRequestException('Calendar not configured');
    // Validate service against the configured list — prevents someone
    // hand-crafting a weird service name into the calendar.
    if (!cfg.services.some((s) => s.toLowerCase() === dto.service.toLowerCase())) {
      throw new BadRequestException(`Unknown service "${dto.service}"`);
    }
    const normalized = cfg.services.find(
      (s) => s.toLowerCase() === dto.service.toLowerCase(),
    )!;
    const r = await this.calendar.createBooking({
      serviceLabel: normalized,
      startIso: dto.start,
      name: dto.name.trim(),
      email: dto.email.trim().toLowerCase(),
      phone: dto.phone?.trim(),
      notes: dto.notes?.trim(),
    });
    return { ok: true, eventId: r.eventId, htmlLink: r.htmlLink };
  }

  // ---------- Admin event CRUD ----------

  /**
   * List events on the Sales calendar between two ISO instants. Defaults
   * to now → 30 days out. Used by /admin/calendar agenda view.
   */
  @Get('admin/calendar/events')
  @Roles('admin', 'staff')
  async adminListEvents(
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ) {
    const now = new Date();
    const from = fromRaw ?? now.toISOString();
    const to = toRaw ?? new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString();
    return {
      events: await this.calendar.listEvents(from, to),
    };
  }

  @Post('admin/calendar/events')
  @Roles('admin', 'staff')
  async adminCreateEvent(@Body() dto: CreateAdminEventDto) {
    const r = await this.calendar.createAdminEvent({
      title: dto.title.trim(),
      startIso: dto.start,
      endIso: dto.end,
      location: dto.location?.trim(),
      description: dto.description?.trim(),
      attendees: dto.attendees?.map((a) => ({
        email: a.email.trim().toLowerCase(),
        name: a.name?.trim(),
      })),
      sendUpdates: dto.sendUpdates,
    });
    return { ok: true, eventId: r.eventId, htmlLink: r.htmlLink };
  }

  @Delete('admin/calendar/events/:id')
  @Roles('admin', 'staff')
  @HttpCode(204)
  async adminCancelEvent(
    @Param('id') id: string,
    @Query('notify') notify?: string,
  ) {
    const sendUpdates = notify === 'false' ? 'none' : 'all';
    await this.calendar.cancelEvent(id, sendUpdates);
  }

  // ---------- Admin OAuth flow ----------

  @Get('admin/integrations/google_calendar/authorize')
  @Roles('admin')
  async authorize(
    @Req() req: Request,
    @CurrentUser() user: RequestUser,
    @Query('return_to') returnTo?: string,
  ) {
    const origin = deriveOrigin(req);
    const redirectUri = `${origin}/api/v1/admin/integrations/google_calendar/callback`;

    const state = randomBytes(24).toString('hex');
    this.sweep();
    this.pending.set(state, {
      redirectUri,
      expiresAt: Date.now() + 5 * 60 * 1000,
      actorUserId: user.id,
    });
    const encodedState = `${state}.${Buffer.from(returnTo ?? '/admin/integrations').toString('base64url')}`;
    const url = await this.calendar.buildAuthorizeUrl(redirectUri, encodedState);
    return { url, redirect_uri: redirectUri };
  }

  /**
   * OAuth callback. Google hits this directly via our registered
   * redirect URI, so we can't assume a JWT — the endpoint is marked
   * @Public. We still verify the `state` param we issued.
   */
  @Public()
  @Get('admin/integrations/google_calendar/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    if (error) {
      this.sendHtml(
        res,
        `<h2>Google refused authorization</h2><p>${escapeHtml(error)}</p>
         <p><a href="/admin/integrations">← back to integrations</a></p>`,
      );
      return;
    }
    if (!code || !state) {
      this.sendHtml(res, `<h2>Missing code or state</h2>`, 400);
      return;
    }
    const [nonce, returnB64] = state.split('.');
    const pending = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (!pending || pending.expiresAt < Date.now()) {
      this.sendHtml(
        res,
        `<h2>Authorization expired</h2>
         <p>Please restart the flow from /admin/integrations.</p>`,
        400,
      );
      return;
    }
    const returnTo = returnB64
      ? Buffer.from(returnB64, 'base64url').toString('utf8')
      : '/admin/integrations';

    try {
      const { refreshToken } = await this.calendar.completeAuthorization(
        code,
        pending.redirectUri,
      );

      // Merge refresh_token into the existing integration row (keeps
      // whatever business hours / services the admin already saved).
      const current = (await this.integrations.getCredentials(
        'google_calendar',
      )) as CredentialsFor<'google_calendar'> | null;
      if (!current) {
        this.sendHtml(
          res,
          `<h2>Integration row disappeared</h2>
           <p>Save the google_calendar credentials first, then reauthorize.</p>`,
          400,
        );
        return;
      }
      await this.integrations.set(
        'google_calendar',
        { ...current, refresh_token: refreshToken },
        pending.actorUserId,
      );

      this.sendHtml(
        res,
        `<!doctype html><meta charset="utf-8">
         <title>Authorized</title>
         <script>location.replace(${JSON.stringify(returnTo)})</script>
         <p>Authorized — redirecting…</p>`,
      );
    } catch (err) {
      this.sendHtml(
        res,
        `<h2>Authorization failed</h2>
         <pre>${escapeHtml((err as Error).message)}</pre>
         <p><a href="/admin/integrations">← back to integrations</a></p>`,
        500,
      );
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending.entries()) {
      if (v.expiresAt < now) this.pending.delete(k);
    }
  }

  private sendHtml(res: Response, body: string, status = 200) {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(body);
  }
}

function deriveOrigin(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
  const host =
    (req.headers['x-forwarded-host'] as string) ?? (req.headers.host as string);
  return `${proto}://${host}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
