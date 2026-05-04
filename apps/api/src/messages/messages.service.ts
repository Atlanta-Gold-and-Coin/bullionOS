import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, Message, MessageAuthorRole, UserRole } from '../db/types';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';

export interface MessageView extends Message {
  author_name: string;
}

@Injectable()
export class MessagesService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Authorize access: clients can only read/write on their own request;
   * admin/staff can always access.
   */
  private async assertAccess(
    requestId: string,
    userId: string,
    role: UserRole,
  ): Promise<{ client_id: string; client_user_id: string | null }> {
    const row = await this.db
      .selectFrom('deal_requests as dr')
      .innerJoin('clients as c', 'c.id', 'dr.client_id')
      .select(['dr.client_id', 'c.user_id as client_user_id'])
      .where('dr.id', '=', requestId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Request not found');

    if (role === 'client' && row.client_user_id !== userId) {
      throw new ForbiddenException('Not your request');
    }
    return { client_id: row.client_id, client_user_id: row.client_user_id };
  }

  async list(
    requestId: string,
    userId: string,
    role: UserRole,
  ): Promise<MessageView[]> {
    await this.assertAccess(requestId, userId, role);

    const rows = await this.db
      .selectFrom('messages as m')
      .innerJoin('users as u', 'u.id', 'm.author_user_id')
      .leftJoin('clients as c', 'c.user_id', 'u.id')
      .selectAll('m')
      .select(
        sql<string>`coalesce(c.first_name || ' ' || c.last_name, u.email)`.as('author_name'),
      )
      .where('m.deal_request_id', '=', requestId)
      .orderBy('m.created_at')
      .execute();

    // Mark the OTHER side's messages as read on read. Clients reading → mark
    // staff/admin posts read; staff reading → mark client posts read.
    const shouldMark =
      role === 'client' ? ['admin', 'staff'] : ['client'];
    await this.db
      .updateTable('messages')
      .set({ read_at: new Date() })
      .where('deal_request_id', '=', requestId)
      .where('author_role', 'in', shouldMark as MessageAuthorRole[])
      .where('read_at', 'is', null)
      .execute();

    return rows as unknown as MessageView[];
  }

  async post(
    requestId: string,
    author: { id: string; role: UserRole },
    body: string,
  ): Promise<Message> {
    const trimmed = body.trim();
    if (!trimmed) throw new BadRequestException('Body required');
    if (trimmed.length > 4000) {
      throw new BadRequestException('Message too long (max 4000 chars)');
    }

    const { client_id, client_user_id } = await this.assertAccess(
      requestId,
      author.id,
      author.role,
    );

    const inserted = await this.db
      .insertInto('messages')
      .values({
        deal_request_id: requestId,
        author_user_id: author.id,
        author_role: author.role as MessageAuthorRole,
        body: trimmed,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Notify the opposite side.
    if (author.role === 'client') {
      // Fan out to admin/staff queue.
      await this.notifications.notifyRoles(['admin', 'staff'], {
        type: 'message.new',
        title: 'New client message',
        body: trimmed.slice(0, 140),
        link: `/admin/requests`,
        metadata: { deal_request_id: requestId, message_id: inserted.id },
      });
    } else if (client_user_id) {
      const branding = await this.settings.getBranding();
      await this.notifications.create({
        user_id: client_user_id,
        type: 'message.new',
        title: `New message from ${branding.company_name}`,
        body: trimmed.slice(0, 140),
        link: `/dashboard/requests`,
        metadata: { deal_request_id: requestId, message_id: inserted.id },
      });
    }

    // Touch the deal_request so list views re-order by recent activity.
    await this.db
      .updateTable('deal_requests')
      .set({ updated_at: new Date() })
      .where('id', '=', requestId)
      .execute();

    void client_id; // reserved for Phase 5 SMS integration
    return inserted;
  }

  /** Unread count of messages authored by the opposite side. */
  async unreadCountForRequest(
    requestId: string,
    userId: string,
    role: UserRole,
  ): Promise<number> {
    await this.assertAccess(requestId, userId, role);
    const opposites: MessageAuthorRole[] =
      role === 'client' ? ['admin', 'staff'] : ['client'];
    const r = await this.db
      .selectFrom('messages')
      .select(({ fn }) => fn.countAll<string>().as('c'))
      .where('deal_request_id', '=', requestId)
      .where('author_role', 'in', opposites)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(r.c);
  }
}
