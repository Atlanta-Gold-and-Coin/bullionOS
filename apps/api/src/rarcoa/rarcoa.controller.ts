import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RarcoaService } from './rarcoa.service';

/** 3 MB cap on PDF uploads — the daily RARCOA sheet is ~40 KB. */
const MAX_UPLOAD_BYTES = 3_000_000;

class IngestPasteDto {
  @IsString()
  @MinLength(50, { message: 'Paste the full RARCOA goldsheet text.' })
  text!: string;

  @IsOptional()
  @IsString()
  source_ref?: string;
}

/**
 * Admin-only RARCOA pricing surface.
 *
 *   POST   /admin/rarcoa/upload    — multipart PDF upload + ingest
 *   POST   /admin/rarcoa/paste     — raw-text ingest (fallback if PDF parsing fails)
 *   GET    /admin/rarcoa/latest    — most-recent snapshot + AGC markdowns
 *   GET    /admin/rarcoa/by-date   — ?date=YYYY-MM-DD, specific day
 *   GET    /admin/rarcoa           — list of recent sheets for the picker
 *   DELETE /admin/rarcoa/:id       — wipe a stored sheet
 *
 * Everything is admin-only — pricing data is back-office reference.
 */
@Controller('admin/rarcoa')
@Roles('admin', 'staff')
export class RarcoaController {
  constructor(private readonly rarcoa: RarcoaService) {}

  @Get()
  list() {
    return this.rarcoa.listSheets();
  }

  @Get('latest')
  async latest() {
    const snap = await this.rarcoa.getLatest();
    return snap ?? { cells: [], as_of_date: null };
  }

  @Get('by-date')
  async byDate(@Query('date') date?: string) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date query param must be YYYY-MM-DD');
    }
    const snap = await this.rarcoa.getByDate(date);
    return snap ?? { cells: [], as_of_date: date };
  }

  /**
   * Fetch a specific sheet by id. Used by the admin history picker
   * when the operator picks one of multiple same-day publications —
   * date+time combined isn't URL-friendly, but the UUID is.
   */
  @Get('by-id/:id')
  async byId(@Param('id', new ParseUUIDPipe()) id: string) {
    const snap = await this.rarcoa.getBySheetId(id);
    return snap ?? { cells: [], as_of_date: null };
  }

  @Post('upload')
  @Roles('admin')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    if (!file) {
      throw new BadRequestException('file is required (multipart/form-data field "file")');
    }
    if (
      file.mimetype !== 'application/pdf' &&
      !file.originalname.toLowerCase().endsWith('.pdf')
    ) {
      throw new BadRequestException('Upload must be a PDF file.');
    }
    return this.rarcoa.ingestPdf({
      pdfBuffer: file.buffer,
      filename: file.originalname ?? null,
      ingestedByUserId: user.id,
    });
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.rarcoa.deleteSheet(id);
  }
}
