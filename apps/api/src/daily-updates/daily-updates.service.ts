import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB } from '../db/types';
import { NotificationsService } from '../notifications/notifications.service';

export interface DailyUpdateAttachmentMeta {
  id: string;
  filename: string;
  mime: string;
  created_at: Date;
}

export interface DailyUpdateCommentDto {
  id: string;
  body: string;
  author_user_id: string;
  author_email: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DailyUpdateDto {
  id: string;
  body: string;
  author_user_id: string;
  author_email: string | null;
  created_at: Date;
  updated_at: Date;
  attachments: DailyUpdateAttachmentMeta[];
  comments: DailyUpdateCommentDto[];
}

/**
 * Daily Updates feed (migration 026).
 *
 * One author (anyone with `users.can_post_daily_update = TRUE`) posts a
 * short update. Every admin + staff user gets notified in-app. Team
 * members can comment on the post and edit their own comments. The
 * dashboard always shows the LATEST post; older ones stay in the table
 * for history but aren't surfaced unless we build an archive view.
 *
 * Why a boolean column and not a role?
 *   - Role is a coarse permission that gates a whole slice of the app.
 *     Posting daily updates is an editorial permission owned by one
 *     person today (Hunter). If Hunter delegates tomorrow, it's a DB
 *     flip, not a code change. Roles would require a new 'editor' tier
 *     and a rewrite of every guard that references role strings.
 */
@Injectable()
export class DailyUpdatesService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Enforce that the actor has the posting permission. Used by
   * create/update/delete paths. Returns void on success; throws
   * ForbiddenException otherwise.
   */
  private async assertCanPost(actorUserId: string): Promise<void> {
    const row = await this.db
      .selectFrom('users')
      .select(['can_post_daily_update'])
      .where('id', '=', actorUserId)
      .executeTakeFirst();
    if (!row || !row.can_post_daily_update) {
      throw new ForbiddenException('Not authorized to post Daily Updates');
    }
  }

  /**
   * Returns the single latest post (with comments + attachment metadata),
   * or null if none exist. The dashboard calls this on every render.
   */
  async getLatest(): Promise<DailyUpdateDto | null> {
    const post = await this.db
      .selectFrom('daily_updates')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!post) return null;
    return this.hydrate(post.id);
  }

  /**
   * Fetch a specific post (after create/update) with full nested data.
   * Private-ish helper; public callers go through getLatest().
   */
  private async hydrate(id: string): Promise<DailyUpdateDto> {
    const post = await this.db
      .selectFrom('daily_updates as du')
      .leftJoin('users as u', 'u.id', 'du.author_user_id')
      .select([
        'du.id',
        'du.body',
        'du.author_user_id',
        'du.created_at',
        'du.updated_at',
        'u.email as author_email',
      ])
      .where('du.id', '=', id)
      .executeTakeFirstOrThrow();

    const comments = await this.db
      .selectFrom('daily_update_comments as c')
      .leftJoin('users as u', 'u.id', 'c.author_user_id')
      .select([
        'c.id',
        'c.body',
        'c.author_user_id',
        'c.created_at',
        'c.updated_at',
        'u.email as author_email',
      ])
      .where('c.daily_update_id', '=', id)
      .orderBy('c.created_at', 'asc')
      .execute();

    // Only attachment metadata here — bytes are streamed via a
    // dedicated endpoint so we don't roundtrip megabytes of binary
    // through the JSON response.
    const attachments = await this.db
      .selectFrom('daily_update_attachments')
      .select(['id', 'filename', 'mime', 'created_at'])
      .where('daily_update_id', '=', id)
      .orderBy('created_at', 'asc')
      .execute();

    return {
      id: post.id,
      body: post.body,
      author_user_id: post.author_user_id,
      author_email: post.author_email,
      created_at: post.created_at as Date,
      updated_at: post.updated_at as Date,
      attachments: attachments as DailyUpdateAttachmentMeta[],
      comments: comments as DailyUpdateCommentDto[],
    };
  }

  async create(body: string, actorUserId: string): Promise<DailyUpdateDto> {
    await this.assertCanPost(actorUserId);
    const inserted = await this.db
      .insertInto('daily_updates')
      .values({ body, author_user_id: actorUserId })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    // Fan-out notification to every active admin/staff user. Author
    // gets one too — harmless and simpler than excluding them; they'll
    // see it as "you posted" in the bell dropdown.
    await this.notifications.notifyRoles(['admin', 'staff'], {
      type: 'daily_update.created',
      title: 'New daily update',
      body: body.slice(0, 140),
      link: '/admin',
      metadata: { daily_update_id: inserted.id },
    });

    return this.hydrate(inserted.id);
  }

  async update(
    id: string,
    body: string,
    actorUserId: string,
  ): Promise<DailyUpdateDto> {
    await this.assertCanPost(actorUserId);
    const row = await this.db
      .selectFrom('daily_updates')
      .select(['id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Daily update not found');
    await this.db
      .updateTable('daily_updates')
      .set({ body, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
    return this.hydrate(id);
  }

  async delete(id: string, actorUserId: string): Promise<void> {
    await this.assertCanPost(actorUserId);
    const r = await this.db
      .deleteFrom('daily_updates')
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) {
      throw new NotFoundException('Daily update not found');
    }
    // Cascade takes care of comments + attachments via the FK ON DELETE
    // CASCADE from migration 026.
  }

  // ─── Comments ───────────────────────────────────────────────────────

  async createComment(
    dailyUpdateId: string,
    body: string,
    actorUserId: string,
  ): Promise<DailyUpdateCommentDto> {
    // Verify the parent post exists so we give a 404 instead of a raw
    // FK violation.
    const parent = await this.db
      .selectFrom('daily_updates')
      .select(['id'])
      .where('id', '=', dailyUpdateId)
      .executeTakeFirst();
    if (!parent) throw new NotFoundException('Daily update not found');

    const inserted = await this.db
      .insertInto('daily_update_comments')
      .values({
        daily_update_id: dailyUpdateId,
        author_user_id: actorUserId,
        body,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const row = await this.db
      .selectFrom('daily_update_comments as c')
      .leftJoin('users as u', 'u.id', 'c.author_user_id')
      .select([
        'c.id',
        'c.body',
        'c.author_user_id',
        'c.created_at',
        'c.updated_at',
        'u.email as author_email',
      ])
      .where('c.id', '=', inserted.id)
      .executeTakeFirstOrThrow();

    return row as DailyUpdateCommentDto;
  }

  /**
   * Edit a comment. Admins can edit anyone's; everyone else can only
   * edit their own. The UI only shows the edit button on owned rows
   * anyway, so this guard is the hard backstop.
   */
  async updateComment(
    commentId: string,
    body: string,
    actor: { id: string; role: string },
  ): Promise<DailyUpdateCommentDto> {
    const existing = await this.db
      .selectFrom('daily_update_comments')
      .select(['id', 'author_user_id'])
      .where('id', '=', commentId)
      .executeTakeFirst();
    if (!existing) throw new NotFoundException('Comment not found');
    if (existing.author_user_id !== actor.id && actor.role !== 'admin') {
      throw new ForbiddenException('Can only edit your own comments');
    }
    await this.db
      .updateTable('daily_update_comments')
      .set({ body, updated_at: new Date() })
      .where('id', '=', commentId)
      .execute();

    const row = await this.db
      .selectFrom('daily_update_comments as c')
      .leftJoin('users as u', 'u.id', 'c.author_user_id')
      .select([
        'c.id',
        'c.body',
        'c.author_user_id',
        'c.created_at',
        'c.updated_at',
        'u.email as author_email',
      ])
      .where('c.id', '=', commentId)
      .executeTakeFirstOrThrow();

    return row as DailyUpdateCommentDto;
  }

  async deleteComment(
    commentId: string,
    actor: { id: string; role: string },
  ): Promise<void> {
    const existing = await this.db
      .selectFrom('daily_update_comments')
      .select(['id', 'author_user_id'])
      .where('id', '=', commentId)
      .executeTakeFirst();
    if (!existing) throw new NotFoundException('Comment not found');
    if (existing.author_user_id !== actor.id && actor.role !== 'admin') {
      throw new ForbiddenException('Can only delete your own comments');
    }
    await this.db
      .deleteFrom('daily_update_comments')
      .where('id', '=', commentId)
      .execute();
  }

  // ─── Attachments ────────────────────────────────────────────────────

  async addAttachment(
    dailyUpdateId: string,
    filename: string,
    mime: string,
    bytes: Buffer,
    actorUserId: string,
  ): Promise<DailyUpdateAttachmentMeta> {
    await this.assertCanPost(actorUserId);

    const parent = await this.db
      .selectFrom('daily_updates')
      .select(['id'])
      .where('id', '=', dailyUpdateId)
      .executeTakeFirst();
    if (!parent) throw new NotFoundException('Daily update not found');

    // Clamp uploads. Railway Postgres handles large bytea but the
    // dashboard UX isn't tuned for multi-MB attachments, so we hard-cap
    // at 10 MB per file.
    if (bytes.length > 10 * 1024 * 1024) {
      throw new BadRequestException('Attachment exceeds 10 MB limit');
    }

    const inserted = await this.db
      .insertInto('daily_update_attachments')
      .values({
        daily_update_id: dailyUpdateId,
        filename: filename.slice(0, 255),
        mime: mime.slice(0, 100),
        bytes,
      })
      .returning(['id', 'filename', 'mime', 'created_at'])
      .executeTakeFirstOrThrow();

    return inserted as DailyUpdateAttachmentMeta;
  }

  /** Returns the raw bytes + mime/filename for streaming to the client. */
  async getAttachmentBytes(
    attachmentId: string,
  ): Promise<{ filename: string; mime: string; bytes: Buffer }> {
    const row = await this.db
      .selectFrom('daily_update_attachments')
      .select(['filename', 'mime', 'bytes'])
      .where('id', '=', attachmentId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Attachment not found');
    return {
      filename: row.filename,
      mime: row.mime,
      // node-postgres returns bytea as Buffer. Cast through unknown so
      // the downstream controller gets a real Node Buffer it can pipe.
      bytes: row.bytes as unknown as Buffer,
    };
  }

  async deleteAttachment(
    attachmentId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.assertCanPost(actorUserId);
    const r = await this.db
      .deleteFrom('daily_update_attachments')
      .where('id', '=', attachmentId)
      .executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) {
      throw new NotFoundException('Attachment not found');
    }
  }

  /**
   * One-shot read for the permission flag so the UI can render the
   * compose/edit/delete affordances only when the user is allowed.
   */
  async canPost(actorUserId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('users')
      .select(['can_post_daily_update'])
      .where('id', '=', actorUserId)
      .executeTakeFirst();
    return row?.can_post_daily_update === true;
  }
}

// Re-export so callers can import both helpers from the service module.
export { sql };
