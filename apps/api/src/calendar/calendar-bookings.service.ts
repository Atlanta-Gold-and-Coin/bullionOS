import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { CalendarBooking, DB } from '../db/types';
import { ClientsService } from '../clients/clients.service';

/**
 * CRM-side mirror of Google Calendar bookings (ticket CAL-001).
 *
 * Why split this out from CalendarService? CalendarService is Google-only
 * and doesn't touch the DB. Calendar → CRM linking is a DB concern, and
 * it pulls in ClientsService as a dependency. Keeping the mirror in its
 * own service avoids entangling the Google client with clients/DB.
 *
 * Responsibilities:
 *   1. Persist every public booking to `calendar_bookings`.
 *   2. Link each booking to a client record via
 *      `ClientsService.findOrCreateByContact()` — email/secondary/phone
 *      match; auto-create on miss.
 *   3. Surface per-client appointment history for the admin client detail
 *      page.
 *
 * Failures here are logged but MUST NOT roll back a successful Google
 * calendar event — the event is the authoritative booking. If the mirror
 * write fails (duplicate event id from a replay, FK issue), we log it and
 * expect the admin to reconcile via the pending-bookings screen.
 */
@Injectable()
export class CalendarBookingsService {
  private readonly logger = new Logger(CalendarBookingsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly clients: ClientsService,
  ) {}

  /**
   * Called after a public booking lands successfully on Google Calendar.
   * Writes the local row and attempts to match a client. Idempotent via
   * the UNIQUE constraint on `google_event_id` — if we've already mirrored
   * this event, we update the existing row instead of erroring.
   */
  async recordPublicBooking(args: {
    googleEventId: string;
    service: string;
    startsAt: Date;
    endsAt: Date;
    name: string;
    email: string;
    phone?: string | null;
    notes?: string | null;
  }): Promise<{ bookingId: string; clientId: string | null; clientCreated: boolean }> {
    // 1. Match-or-create the client first, so we can write the FK inline.
    //    If this call itself fails (constraint, bad data), we still want to
    //    mirror the booking WITHOUT a client link — admins can resolve it
    //    from the pending list. Guard with a try/catch.
    let clientId: string | null = null;
    let clientCreated = false;
    try {
      const match = await this.clients.findOrCreateByContact({
        name: args.name,
        email: args.email,
        phone: args.phone ?? null,
      });
      clientId = match.id;
      clientCreated = match.created;
    } catch (err) {
      this.logger.warn(
        `Client match failed for booking ${args.googleEventId}: ${(err as Error).message}`,
      );
    }

    // 2. UPSERT on google_event_id. ON CONFLICT DO UPDATE lets a retried
    //    webhook / replay succeed idempotently. We pull in the fresh
    //    client_id on conflict too so a deferred match catches up.
    const row = await this.db
      .insertInto('calendar_bookings')
      .values({
        google_event_id: args.googleEventId,
        client_id: clientId,
        service: args.service,
        starts_at: args.startsAt,
        ends_at: args.endsAt,
        name: args.name,
        email: args.email,
        phone: args.phone ?? null,
        notes: args.notes ?? null,
        status: 'confirmed',
        source: 'public_booking',
      })
      .onConflict((oc) =>
        oc.column('google_event_id').doUpdateSet({
          client_id: clientId,
          service: args.service,
          starts_at: args.startsAt,
          ends_at: args.endsAt,
          name: args.name,
          email: args.email,
          phone: args.phone ?? null,
          notes: args.notes ?? null,
          updated_at: new Date(),
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    return { bookingId: row.id, clientId, clientCreated };
  }

  /**
   * List a client's appointment history for the /admin/clients/:id page.
   * Ordered most-recent first. Limit 100 — matches the timeline patterns
   * used elsewhere on the page (invoices, quotes, requests, shipments).
   */
  async listForClient(clientId: string): Promise<CalendarBooking[]> {
    return this.db
      .selectFrom('calendar_bookings')
      .selectAll()
      .where('client_id', '=', clientId)
      .orderBy('starts_at', 'desc')
      .limit(100)
      .execute();
  }

  /**
   * Every booking that failed to auto-link (client_id IS NULL). Admin
   * resolves these by assigning to an existing client or creating a new
   * one manually via the UI.
   */
  async listPending(): Promise<CalendarBooking[]> {
    return this.db
      .selectFrom('calendar_bookings')
      .selectAll()
      .where('client_id', 'is', null)
      .orderBy('starts_at', 'desc')
      .limit(200)
      .execute();
  }

  /**
   * Manual link: admin picks a client for a pending booking. Returns the
   * updated row. If clientId is null, the link is cleared (send back to
   * pending).
   */
  async linkToClient(
    bookingId: string,
    clientId: string | null,
    actorUserId: string,
  ): Promise<CalendarBooking> {
    const row = await this.db
      .updateTable('calendar_bookings')
      .set({ client_id: clientId, updated_at: new Date() })
      .where('id', '=', bookingId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.db
      .insertInto('audit_logs')
      .values({
        actor_user_id: actorUserId,
        action: clientId ? 'calendar_booking.link' : 'calendar_booking.unlink',
        entity_type: 'calendar_booking',
        entity_id: bookingId,
        metadata: sql`${JSON.stringify({
          client_id: clientId,
          google_event_id: row.google_event_id,
        })}::jsonb`,
      })
      .execute();

    return row;
  }
}
