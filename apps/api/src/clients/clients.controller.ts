import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ClientsService } from './clients.service';
import { CreateClientDto, UpdateClientDto } from './dto/upsert-client.dto';

class BulkDeleteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  ids!: string[];
}

class MergeClientsDto {
  @IsUUID()
  keeper_id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true })
  loser_ids!: string[];
}

const CLIENT_EXPORT_HISTORY_FILTERS = [
  'all',
  'bought_from_us',
  'sold_to_us',
  'bought_or_sold',
  'bought_and_sold',
  'no_history',
] as const;

type ClientExportHistoryFilter = (typeof CLIENT_EXPORT_HISTORY_FILTERS)[number];

class BulkExportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @IsUUID(undefined, { each: true })
  ids!: string[];

  @IsOptional()
  @IsIn(CLIENT_EXPORT_HISTORY_FILTERS)
  history_filter?: ClientExportHistoryFilter;
}

@Controller('admin/clients')
@Roles('admin', 'staff')
export class AdminClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query('q') search?: string,
    @Query('client_type') client_type?: 'retail' | 'wholesaler',
  ) {
    return this.clients.list(search, {
      ...(client_type ? { client_type } : {}),
      actorUserId: user.id,
    });
  }

  @Get(':id')
  getById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.clients.getById(id, { actorUserId: user.id });
  }

  @Get(':id/timeline')
  timeline(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.clients.getTimeline(id, { actorUserId: user.id });
  }

  /**
   * Latest GReminders activity for this client — appointment
   * confirmations/declines/creates that the webhook handler
   * (apps/api/src/integrations/greminders-webhook.controller.ts)
   * has ingested into audit_logs. Used by:
   *   - /admin/clients/[id] — shows a per-client confirmation panel
   *   - /admin/calendar — AttendeeChip renders a small confirmation
   *     pill when this endpoint returns any entries for the attendee's
   *     linked client id.
   */
  @Get(':id/greminders-activity')
  gremindersActivity(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(50, Math.max(1, Number(limitRaw ?? 10) || 10));
    return this.clients.getGremindersActivity(id, limit);
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateClientDto) {
    return this.clients.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateClientDto,
  ) {
    return this.clients.update(id, dto);
  }

  // Portal-admin actions are admin-only (not staff). Password reset reveals a
  // temp password; restrict that to the most trusted role.
  @Post(':id/enable-portal')
  @Roles('admin')
  enablePortal(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.clients.enablePortal(id, user.id);
  }

  @Post(':id/disable-portal')
  @Roles('admin')
  @HttpCode(204)
  async disablePortal(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.clients.disablePortal(id, user.id);
  }

  @Post(':id/reset-password')
  @Roles('admin')
  resetPassword(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.clients.resetPassword(id, user.id);
  }

  /**
   * Single delete. Only allowed when the client has no invoices — otherwise
   * you'd orphan totals + the audit trail. Callers get a clean error.
   */
  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.clients.delete(id, user.id);
  }

  @Post('export')
  async exportSelected(
    @Body() dto: BulkExportDto,
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
  ) {
    const out = await this.clients.exportSelected(dto.ids, {
      actorUserId: user.id,
      historyFilter: dto.history_filter ?? 'all',
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${out.filename}"`,
    );
    res.send(out.csv);
  }

  /**
   * Bulk delete: returns { deleted, skipped } so the UI can show per-row
   * outcomes. IDs that still have invoices attached are skipped, not
   * errored — the caller might have selected 500 rows and we don't want
   * one dirty row to fail the whole batch.
   */
  @Post('bulk-delete')
  @Roles('admin')
  async bulkDelete(
    @Body() dto: BulkDeleteDto,
    @CurrentUser() user: RequestUser,
  ) {
    if (dto.ids.length === 0) throw new BadRequestException('ids required');
    return this.clients.bulkDelete(dto.ids, user.id);
  }

  /**
   * Merge duplicates into a single canonical record. Re-points invoices,
   * quotes, shipments, deal-requests, and audit logs from every loser onto
   * the keeper; then deletes the losers. One transaction — if anything
   * fails the whole operation rolls back.
   */
  @Post('merge')
  @Roles('admin')
  async merge(
    @Body() dto: MergeClientsDto,
    @CurrentUser() user: RequestUser,
  ) {
    if (dto.loser_ids.includes(dto.keeper_id)) {
      throw new BadRequestException('keeper_id cannot appear in loser_ids');
    }
    return this.clients.merge(dto.keeper_id, dto.loser_ids, user.id);
  }
}
