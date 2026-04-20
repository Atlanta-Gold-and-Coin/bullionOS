import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { DailyUpdatesService } from './daily-updates.service';
import {
  CreateDailyUpdateDto,
  UpdateDailyUpdateDto,
} from './dto/create-daily-update.dto';
import {
  CreateDailyUpdateCommentDto,
  UpdateDailyUpdateCommentDto,
} from './dto/create-comment.dto';

/**
 * Admin/staff-only Daily Updates surface.
 *
 * Route layout:
 *   GET    /admin/daily-updates/latest           → latest post + comments
 *   POST   /admin/daily-updates                  → create (poster-gated)
 *   PATCH  /admin/daily-updates/:id              → edit body (poster-gated)
 *   DELETE /admin/daily-updates/:id              → delete (poster-gated)
 *
 *   POST   /admin/daily-updates/:id/comments     → add comment
 *   PATCH  /admin/daily-updates/comments/:id     → edit own comment
 *   DELETE /admin/daily-updates/comments/:id     → delete own comment
 *
 *   POST   /admin/daily-updates/:id/attachments  → multipart upload (poster)
 *   GET    /admin/daily-updates/attachments/:id/file   → download
 *   DELETE /admin/daily-updates/attachments/:id  → remove (poster)
 *
 *   GET    /admin/daily-updates/me/can-post      → "is this user the poster?"
 *                                                  — drives the UI affordances.
 */
@Controller('admin/daily-updates')
@Roles('admin', 'staff')
export class DailyUpdatesController {
  constructor(private readonly service: DailyUpdatesService) {}

  @Get('latest')
  getLatest() {
    return this.service.getLatest();
  }

  /**
   * Cheap permission probe the dashboard calls on mount so it knows
   * whether to render the compose/edit buttons. Separate from the
   * user profile endpoint to keep that one stable.
   */
  @Get('me/can-post')
  async canPost(@CurrentUser() user: RequestUser) {
    return { can_post: await this.service.canPost(user.id) };
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateDailyUpdateDto, @CurrentUser() user: RequestUser) {
    return this.service.create(dto.body, user.id);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDailyUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(id, dto.body, user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.delete(id, user.id);
  }

  // ─── Comments ───────────────────────────────────────────────────────

  @Post(':id/comments')
  @HttpCode(201)
  createComment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateDailyUpdateCommentDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.createComment(id, dto.body, user.id);
  }

  @Patch('comments/:id')
  updateComment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDailyUpdateCommentDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.updateComment(id, dto.body, { id: user.id, role: user.role });
  }

  @Delete('comments/:id')
  @HttpCode(204)
  async deleteComment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.deleteComment(id, { id: user.id, role: user.role });
  }

  // ─── Attachments ────────────────────────────────────────────────────

  /**
   * Multipart upload. File field must be named "file". Runs through
   * @nestjs/platform-express's in-memory interceptor so the service
   * sees the Buffer directly — same shape as the branding logo
   * upload in SettingsController.
   */
  @Post(':id/attachments')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file'))
  async addAttachment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.addAttachment(
      id,
      file.originalname,
      file.mimetype,
      file.buffer,
      user.id,
    );
  }

  /**
   * Stream the raw bytes back. Separate from the JSON post endpoint
   * so the response can carry the correct mime type + a sensible
   * Content-Disposition header.
   */
  @Get('attachments/:id/file')
  async downloadAttachment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ) {
    const { filename, mime, bytes } = await this.service.getAttachmentBytes(id);
    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      // Inline so images render in the feed; the browser handles the
      // download path for non-image mimes automatically.
      `inline; filename="${encodeURIComponent(filename)}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(bytes);
  }

  @Delete('attachments/:id')
  @HttpCode(204)
  async deleteAttachment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.deleteAttachment(id, user.id);
  }
}
