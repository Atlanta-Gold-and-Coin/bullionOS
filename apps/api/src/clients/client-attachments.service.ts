import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB } from '../db/types';

export interface ClientAttachmentMeta {
  id: string;
  client_id: string;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
  uploaded_by_user_id: string | null;
  ocr_status: 'pending' | 'succeeded' | 'failed' | null;
  ocr_fields: unknown;
  created_at: Date;
}

/**
 * Client attachment storage (ID docs, receipts, photos). Bytes live
 * inline in the DB alongside a meta row. Upload cap enforced in the
 * service; the admin page surfaces a clear error when it's tripped.
 */
@Injectable()
export class ClientAttachmentsService {
  private static readonly MAX_BYTES = 15 * 1024 * 1024; // 15 MB

  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  async list(clientId: string): Promise<ClientAttachmentMeta[]> {
    const rows = await this.db
      .selectFrom('client_attachments')
      .select([
        'id',
        'client_id',
        'kind',
        'filename',
        'mime',
        'size_bytes',
        'uploaded_by_user_id',
        'ocr_status',
        'ocr_fields',
        'created_at',
      ])
      .where('client_id', '=', clientId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows as unknown as ClientAttachmentMeta[];
  }

  async create(input: {
    clientId: string;
    kind: string;
    filename: string;
    mime: string;
    bytes: Buffer;
    uploadedByUserId: string;
  }): Promise<ClientAttachmentMeta> {
    if (input.bytes.length > ClientAttachmentsService.MAX_BYTES) {
      throw new BadRequestException(
        `Attachment exceeds 15 MB limit (${(input.bytes.length / 1024 / 1024).toFixed(1)} MB)`,
      );
    }
    // Confirm the client exists; otherwise the bytea insert would
    // fail with a cryptic FK error.
    const client = await this.db
      .selectFrom('clients')
      .select('id')
      .where('id', '=', input.clientId)
      .executeTakeFirst();
    if (!client) throw new NotFoundException('Client not found');

    const inserted = await this.db
      .insertInto('client_attachments')
      .values({
        client_id: input.clientId,
        kind: input.kind || 'other',
        filename: input.filename.slice(0, 255),
        mime: input.mime.slice(0, 100),
        bytes: input.bytes,
        size_bytes: input.bytes.length,
        uploaded_by_user_id: input.uploadedByUserId,
      })
      .returning([
        'id',
        'client_id',
        'kind',
        'filename',
        'mime',
        'size_bytes',
        'uploaded_by_user_id',
        'ocr_status',
        'ocr_fields',
        'created_at',
      ])
      .executeTakeFirstOrThrow();
    return inserted as unknown as ClientAttachmentMeta;
  }

  /** Stream bytes out for a download/preview. */
  async getBytes(
    id: string,
  ): Promise<{ filename: string; mime: string; bytes: Buffer } | null> {
    const row = await this.db
      .selectFrom('client_attachments')
      .select(['filename', 'mime', 'bytes'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    return {
      filename: row.filename,
      mime: row.mime,
      bytes: row.bytes as unknown as Buffer,
    };
  }

  async delete(id: string): Promise<void> {
    const r = await this.db
      .deleteFrom('client_attachments')
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) {
      throw new NotFoundException('Attachment not found');
    }
  }
}
