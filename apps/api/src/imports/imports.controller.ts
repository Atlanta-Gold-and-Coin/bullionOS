import {
  BadRequestException,
  Controller,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  type RequestUser,
} from '../common/decorators/current-user.decorator';
import { ImportsService } from './imports.service';

const CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
]);
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Admin-only CSV imports.
 *
 *   POST /admin/imports/products?dry_run=true|false
 *   POST /admin/imports/inventory?dry_run=true|false
 *   POST /admin/imports/clients?dry_run=true|false
 *   POST /admin/imports/historical-invoices?dry_run=true|false
 *
 * Each accepts a multipart form-data POST with a `file` field
 * (CSV up to 10 MB). The dry_run query param defaults to true so
 * a casual call shows preview-only output; set ?dry_run=false to
 * actually commit. Frontend wraps this in a two-step UI: upload →
 * preview → confirm.
 */
@Controller('admin/imports')
@Roles('admin')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post('products')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_BYTES, files: 1 },
    }),
  )
  async products(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('dry_run') dryRunQ: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    return this.imports.importProducts(this.read(file), {
      dryRun: parseDryRun(dryRunQ),
      actorUserId: user.id,
    });
  }

  @Post('inventory')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_BYTES, files: 1 },
    }),
  )
  async inventory(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('dry_run') dryRunQ: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    return this.imports.importInventory(this.read(file), {
      dryRun: parseDryRun(dryRunQ),
      actorUserId: user.id,
    });
  }

  @Post('clients')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_BYTES, files: 1 },
    }),
  )
  async clients(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('dry_run') dryRunQ: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    return this.imports.importClients(this.read(file), {
      dryRun: parseDryRun(dryRunQ),
      actorUserId: user.id,
    });
  }

  @Post('historical-invoices')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_BYTES, files: 1 },
    }),
  )
  async historicalInvoices(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('dry_run') dryRunQ: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    return this.imports.importHistoricalInvoices(this.read(file), {
      dryRun: parseDryRun(dryRunQ),
      actorUserId: user.id,
    });
  }

  private read(file: Express.Multer.File | undefined): string {
    if (!file) {
      throw new BadRequestException('file is required (multipart/form-data)');
    }
    if (!CSV_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `unsupported mime type: ${file.mimetype} (expected text/csv)`,
      );
    }
    return file.buffer.toString('utf8');
  }
}

function parseDryRun(q: string | undefined): boolean {
  if (q === undefined) return true;
  const s = q.toLowerCase();
  return !(s === 'false' || s === '0' || s === 'no');
}
