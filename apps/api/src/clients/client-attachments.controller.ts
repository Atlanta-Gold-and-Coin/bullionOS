import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ClientAttachmentsService } from './client-attachments.service';

/**
 * Client attachment CRUD — admin + staff. Clients do NOT see this
 * through the portal (different path entirely); this is back-office
 * only.
 *
 *   GET    /admin/clients/:clientId/attachments        list
 *   POST   /admin/clients/:clientId/attachments        upload (multipart)
 *   GET    /admin/client-attachments/:id/file          stream bytes
 *   DELETE /admin/client-attachments/:id               remove
 *
 * The upload + list routes are nested under the client for
 * discoverability; the download + delete routes are flat because the
 * UI has the attachment id but not always the client id in context
 * (e.g. an inline image tag rendered from the meta list).
 */
@Controller()
@Roles('admin', 'staff')
export class ClientAttachmentsController {
  constructor(private readonly service: ClientAttachmentsService) {}

  @Get('admin/clients/:clientId/attachments')
  list(@Param('clientId', new ParseUUIDPipe()) clientId: string) {
    return this.service.list(clientId);
  }

  @Post('admin/clients/:clientId/attachments')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
    @UploadedFile() file: Express.Multer.File,
    @Query('kind') kind: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create({
      clientId,
      kind: kind || 'other',
      filename: file.originalname,
      mime: file.mimetype,
      bytes: file.buffer,
      uploadedByUserId: user.id,
    });
  }

  @Get('admin/client-attachments/:id/file')
  async download(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ) {
    const data = await this.service.getBytes(id);
    if (!data) throw new NotFoundException('Attachment not found');
    res.setHeader('Content-Type', data.mime);
    // Inline so images/pdfs render in-page; non-inline-friendly mimes
    // fall through to the browser's default download path.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(data.filename)}"`,
    );
    // Short private cache so repeated thumbnails don't re-hit the DB;
    // short enough that a delete reflects within a minute.
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.end(data.bytes);
  }

  @Delete('admin/client-attachments/:id')
  @HttpCode(204)
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.service.delete(id);
  }
}
