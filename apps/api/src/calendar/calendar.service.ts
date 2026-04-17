import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { IntegrationsService } from '../integrations/integrations.service';
import type { CredentialsFor } from '../integrations/integrations.registry';

export interface Slot {
  /** RFC3339 start, inclusive. */
  start: string;
  /** RFC3339 end, exclusive. */
  end: string;
}

export interface BookingRequest {
  serviceLabel: string;
  startIso: string;
  name: string;
  email: string;
  phone?: string;
  notes?: string;
}

type Creds = CredentialsFor<'google_calendar'>;

/**
 * Google Calendar booking integration.
 *
 * Responsibilities:
 *   - Hold the OAuth2 client bound to the Sales mailbox's refresh token.
 *   - Compute bookable slots by intersecting business hours with
 *     Google's freeBusy response.
 *   - Create events on the target calendar when the public form submits.
 *
 * All credentials come from the admin-managed integrations row
 * (provider='google_calendar'), so rotation is a paste-and-save in
 * /admin/integrations — no redeploy.
 */
@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private readonly integrations: IntegrationsService) {}

  /** Whether the Sales mailbox has been authorized (refresh token stored). */
  async isConfigured(): Promise<boolean> {
    const creds = await this.resolveCreds();
    return Boolean(creds && creds.refresh_token);
  }

  /**
   * Public-facing form payload: tells the web page which services we
   * offer, the booking window, and the slot size. Redacts the secrets.
   */
  async getPublicConfig(): Promise<{
    configured: boolean;
    services: string[];
    timezone: string;
    bookingWindowDays: number;
    slotMinutes: number;
  } | null> {
    const creds = await this.resolveCreds();
    if (!creds) return null;
    return {
      configured: Boolean(creds.refresh_token),
      services: creds.services
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
      timezone: creds.timezone,
      bookingWindowDays: creds.booking_window_days,
      slotMinutes: creds.slot_minutes,
    };
  }

  /**
   * Return a redirect URL the admin's browser visits to consent. `state`
   * is a CSRF nonce we re-check at the callback. The caller provides
   * redirect_uri — same one registered in Google Cloud Console.
   */
  async buildAuthorizeUrl(redirectUri: string, state: string): Promise<string> {
    const creds = await this.resolveCreds();
    if (!creds) {
      throw new BadRequestException(
        'Google Calendar not configured yet. Save client_id and client_secret first, then authorize.',
      );
    }
    if (!creds.client_id || !creds.client_secret) {
      throw new BadRequestException(
        'client_id and client_secret must be saved before authorizing.',
      );
    }
    const oauth = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      redirectUri,
    );
    return oauth.generateAuthUrl({
      access_type: 'offline',
      // Must include prompt=consent to get a refresh_token on re-auth,
      // otherwise Google only returns one the first time.
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.readonly',
      ],
      state,
      // Keeps the UX clean — Google shows "choose the account" even if
      // the admin is already signed in as their personal Google.
      include_granted_scopes: true,
    });
  }

  /**
   * Exchange an OAuth code for a refresh token and persist it on the
   * integration row. Called from the admin-only /callback endpoint.
   */
  async completeAuthorization(
    code: string,
    redirectUri: string,
  ): Promise<{ refreshToken: string }> {
    const creds = await this.resolveCreds();
    if (!creds) throw new BadRequestException('Calendar creds missing');

    const oauth = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      redirectUri,
    );
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      throw new BadRequestException(
        'Google did not return a refresh token. Remove app access at https://myaccount.google.com/permissions and retry.',
      );
    }
    return { refreshToken: tokens.refresh_token };
  }

  /**
   * Compute available slots for a given day. Intersects business hours
   * (per-weekday, from integration config) with Google's freeBusy report
   * so already-booked time is hidden.
   */
  async getSlots(dateIso: string): Promise<{ slots: Slot[]; timezone: string }> {
    const creds = await this.requireReadyCreds();
    const calendar = this.calendar(creds);

    const dayStart = parseIsoDate(dateIso); // local noon of that day in UTC
    const { windowStart, windowEnd } = this.businessHoursForDate(creds, dayStart);
    if (!windowStart || !windowEnd) {
      return { slots: [], timezone: creds.timezone }; // closed that day
    }

    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        timeZone: creds.timezone,
        items: [{ id: creds.calendar_id }],
      },
    });
    const busy = (fb.data.calendars?.[creds.calendar_id]?.busy ?? []).map(
      (b) => ({
        start: new Date(b.start as string),
        end: new Date(b.end as string),
      }),
    );

    const slots: Slot[] = [];
    const slotMs = creds.slot_minutes * 60 * 1000;
    for (
      let t = windowStart.getTime();
      t + slotMs <= windowEnd.getTime();
      t += slotMs
    ) {
      const start = new Date(t);
      const end = new Date(t + slotMs);
      // Drop any slot that overlaps a busy range.
      const overlaps = busy.some((b) => start < b.end && end > b.start);
      if (overlaps) continue;
      // Don't offer slots in the past.
      if (start.getTime() <= Date.now()) continue;
      slots.push({ start: start.toISOString(), end: end.toISOString() });
    }

    return { slots, timezone: creds.timezone };
  }

  /**
   * Admin-initiated event creation. Unlike createBooking, this bypasses
   * the services whitelist and the business-hours window — operators
   * can block any time slot for any reason (coin show, out of office,
   * private appointment with a VIP).
   *
   * Still uses the same credentials + target calendar as the public
   * booking flow, so admin-created events share the queue with public
   * bookings and slot availability is consistent across both surfaces.
   */
  async createAdminEvent(args: {
    title: string;
    startIso: string;
    endIso: string;
    location?: string;
    description?: string;
    attendees?: Array<{ email: string; name?: string }>;
    sendUpdates?: 'all' | 'externalOnly' | 'none';
  }): Promise<{ eventId: string; htmlLink: string | null }> {
    const creds = await this.requireReadyCreds();
    const calendar = this.calendar(creds);

    const start = new Date(args.startIso);
    const end = new Date(args.endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid start/end');
    }
    if (end <= start) {
      throw new BadRequestException('End must be after start');
    }

    const event: calendar_v3.Schema$Event = {
      summary: args.title,
      description: args.description ?? undefined,
      location: args.location ?? undefined,
      start: { dateTime: start.toISOString(), timeZone: creds.timezone },
      end: { dateTime: end.toISOString(), timeZone: creds.timezone },
      attendees: args.attendees?.length
        ? args.attendees.map((a) => ({ email: a.email, displayName: a.name }))
        : undefined,
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 60 * 24 },
          { method: 'popup', minutes: 30 },
        ],
      },
    };

    const res = await calendar.events.insert({
      calendarId: creds.calendar_id,
      requestBody: event,
      // 'all' emails everyone; 'externalOnly' skips the Sales mailbox
      // itself; 'none' creates silently. Default 'all' for the normal
      // "book with this client" UX; 'none' is useful for OoO blocks.
      sendUpdates: args.sendUpdates ?? 'all',
    });
    return { eventId: res.data.id ?? '', htmlLink: res.data.htmlLink ?? null };
  }

  /**
   * List events on the target calendar between two ISO instants,
   * ordered by start. Used by the /admin/calendar agenda view. Caps at
   * 250 per call — anything more and the UI should paginate. Maps to a
   * lean row shape rather than returning the whole Google payload.
   */
  async listEvents(
    timeMinIso: string,
    timeMaxIso: string,
  ): Promise<
    Array<{
      id: string;
      summary: string;
      location: string | null;
      htmlLink: string | null;
      start: string;
      end: string;
      attendees: Array<{ email: string; name: string | null; responseStatus: string | null }>;
      status: string;
    }>
  > {
    const creds = await this.requireReadyCreds();
    const calendar = this.calendar(creds);
    const res = await calendar.events.list({
      calendarId: creds.calendar_id,
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });
    return (res.data.items ?? []).map((ev) => ({
      id: ev.id ?? '',
      summary: ev.summary ?? '(no title)',
      location: ev.location ?? null,
      htmlLink: ev.htmlLink ?? null,
      start: (ev.start?.dateTime ?? ev.start?.date) ?? '',
      end: (ev.end?.dateTime ?? ev.end?.date) ?? '',
      status: ev.status ?? 'confirmed',
      attendees:
        ev.attendees?.map((a) => ({
          email: a.email ?? '',
          name: a.displayName ?? null,
          responseStatus: a.responseStatus ?? null,
        })) ?? [],
    }));
  }

  /** Admin: cancel an event on the target calendar. */
  async cancelEvent(eventId: string, sendUpdates: 'all' | 'none' = 'all'): Promise<void> {
    const creds = await this.requireReadyCreds();
    const calendar = this.calendar(creds);
    await calendar.events.delete({
      calendarId: creds.calendar_id,
      eventId,
      sendUpdates,
    });
  }

  async createBooking(req: BookingRequest): Promise<{ eventId: string; htmlLink: string | null }> {
    const creds = await this.requireReadyCreds();
    const calendar = this.calendar(creds);
    const slotMs = creds.slot_minutes * 60 * 1000;
    const start = new Date(req.startIso);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Invalid start time');
    const end = new Date(start.getTime() + slotMs);

    // Re-verify the slot is actually free to guard against two people
    // racing the same time. freeBusy is authoritative here.
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: creds.timezone,
        items: [{ id: creds.calendar_id }],
      },
    });
    const busy = fb.data.calendars?.[creds.calendar_id]?.busy ?? [];
    if (busy.length > 0) {
      throw new BadRequestException(
        'That slot was just booked. Pick a different time.',
      );
    }

    const descriptionLines = [
      `Booked via AGC Desk`,
      `Name:  ${req.name}`,
      `Email: ${req.email}`,
      req.phone ? `Phone: ${req.phone}` : null,
      req.notes ? `\nNotes:\n${req.notes}` : null,
    ].filter(Boolean);

    const event: calendar_v3.Schema$Event = {
      summary: `${req.serviceLabel} — ${req.name}`,
      description: descriptionLines.join('\n'),
      start: { dateTime: start.toISOString(), timeZone: creds.timezone },
      end: { dateTime: end.toISOString(), timeZone: creds.timezone },
      attendees: [{ email: req.email, displayName: req.name }],
      // Email reminders at 24h and 1h keep no-shows down.
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 60 * 24 },
          { method: 'popup', minutes: 60 },
        ],
      },
    };

    const res = await calendar.events.insert({
      calendarId: creds.calendar_id,
      requestBody: event,
      sendUpdates: 'all',
    });
    return { eventId: res.data.id ?? '', htmlLink: res.data.htmlLink ?? null };
  }

  /** Admin "Test connection" — pings FreeBusy for the next hour. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const creds = await this.resolveCreds();
      if (!creds) return { ok: false, message: 'Not configured' };
      if (!creds.refresh_token) return { ok: false, message: 'Not authorized (no refresh token)' };
      const calendar = this.calendar(creds);
      const now = new Date();
      const soon = new Date(now.getTime() + 60 * 60 * 1000);
      await calendar.freebusy.query({
        requestBody: {
          timeMin: now.toISOString(),
          timeMax: soon.toISOString(),
          items: [{ id: creds.calendar_id }],
        },
      });
      return { ok: true, message: `OK · calendar ${creds.calendar_id}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message.slice(0, 500) };
    }
  }

  // --- internals ---

  private async resolveCreds(): Promise<Creds | null> {
    const creds = await this.integrations.getCredentials('google_calendar');
    if (!creds) return null;
    return creds as Creds;
  }

  private async requireReadyCreds(): Promise<Creds> {
    const creds = await this.resolveCreds();
    if (!creds) throw new BadRequestException('Google Calendar not configured');
    if (!creds.refresh_token) {
      throw new BadRequestException('Google Calendar not authorized yet');
    }
    return creds;
  }

  private calendar(creds: Creds): calendar_v3.Calendar {
    const oauth = new OAuth2Client(creds.client_id, creds.client_secret);
    oauth.setCredentials({ refresh_token: creds.refresh_token });
    return google.calendar({ version: 'v3', auth: oauth });
  }

  /**
   * Resolve the business-hours window for a given date based on the
   * hours_{mon..sun} strings. Returns a Date pair in UTC. Day-of-week is
   * computed in the configured timezone so a late-night click in California
   * still bounds to the correct Eastern day.
   */
  private businessHoursForDate(
    creds: Creds,
    localDay: Date,
  ): { windowStart: Date | null; windowEnd: Date | null } {
    // Work out the ET weekday for this date. We format a date-only string
    // in the configured TZ and re-parse so DST boundaries don't skew.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: creds.timezone,
      weekday: 'short',
    });
    const weekday = fmt.format(localDay).toLowerCase();
    const key =
      {
        mon: creds.hours_mon,
        tue: creds.hours_tue,
        wed: creds.hours_wed,
        thu: creds.hours_thu,
        fri: creds.hours_fri,
        sat: creds.hours_sat,
        sun: creds.hours_sun,
      }[weekday] ?? '';
    if (!key) return { windowStart: null, windowEnd: null };
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(key.trim());
    if (!m) return { windowStart: null, windowEnd: null };
    const [, sH, sM, eH, eM] = m;

    // Build wall-clock timestamps in the configured timezone. Node's
    // Intl + Date doesn't natively construct "a date at 10:00 in ET", so
    // we round-trip through the date parts for the localDay in that tz.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: creds.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(localDay);
    const y = parts.find((p) => p.type === 'year')!.value;
    const mo = parts.find((p) => p.type === 'month')!.value;
    const d = parts.find((p) => p.type === 'day')!.value;
    // Use an offset-aware ISO string. Computing the TZ offset on the fly:
    const offsetMin = tzOffsetMinutes(creds.timezone, localDay);
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    const off = `${sign}${hh}:${mm}`;
    const windowStart = new Date(`${y}-${mo}-${d}T${sH.padStart(2, '0')}:${sM}:00${off}`);
    const windowEnd = new Date(`${y}-${mo}-${d}T${eH.padStart(2, '0')}:${eM}:00${off}`);
    return { windowStart, windowEnd };
  }
}

/** YYYY-MM-DD → Date at noon UTC so tz offset math is stable across DST. */
function parseIsoDate(dateIso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!m) throw new BadRequestException('date must be YYYY-MM-DD');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

/**
 * Offset of `tz` from UTC at `when`, in minutes. Positive for zones east
 * of UTC. Uses a stable formatter trick — locale 'en-CA' returns the
 * GMT+HH:MM shortOffset.
 */
function tzOffsetMinutes(tz: string, when: Date): number {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    timeZoneName: 'shortOffset',
  }).formatToParts(when);
  const name = s.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const h = Number(m[2]);
  const mm = Number(m[3] ?? '0');
  return sign * (h * 60 + mm);
}
