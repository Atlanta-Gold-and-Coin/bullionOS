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
  Query,
  Res,
} from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional } from 'class-validator';
import type { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import type { InvoiceStatus, InvoiceType } from '../db/types';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { UpdateInvoiceStatusDto } from './dto/update-invoice-status.dto';
import { InvoicesService } from './invoices.service';
import { InvoicePdfService } from './invoice-pdf.service';

/**
 * Declared BEFORE AdminInvoicesController because Nest's
 * `design:paramtypes` metadata reflection runs at class-decoration time.
 * When compiled to CommonJS by `nest build`, class declarations are not
 * hoisted the way TypeScript source makes them appear to be — a DTO
 * referenced as a parameter type must already be defined by the time
 * the controller's decorators run, or you get a temporal-dead-zone
 * ReferenceError on container startup. (tsx + dev hot-reload are more
 * forgiving, which is why typecheck + dev boot both passed while prod
 * crashed.)
 */
class EmailInvoiceDto {
  @IsEmail()
  to!: string;

  /**
   * If true and `to` is not already the client's primary email, append it
   * to their `secondary_emails` array. (INV-007 req.)
   */
  @IsOptional()
  @IsBoolean()
  save_to_client?: boolean;
}

@Controller('admin/invoices')
@Roles('admin', 'staff')
export class AdminInvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly pdf: InvoicePdfService,
  ) {}

  @Get()
  list(
    @Query('client_id') clientId?: string,
    @Query('status') status?: InvoiceStatus,
    @Query('type') type?: InvoiceType,
    @Query('client_type') client_type?: 'retail' | 'wholesaler',
  ) {
    return this.invoices.list({ clientId, status, type, client_type });
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.invoices.getById(id);
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: RequestUser) {
    return this.invoices.create(dto, { id: user.id, role: user.role });
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateInvoiceStatusDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.invoices.updateStatus(
      id,
      dto.status,
      { id: user.id, role: user.role },
      { forceOversell: dto.force_oversell },
    );
  }

  /**
   * Header-level edit on a closed invoice (or any invoice). Notes, tax,
   * shipping, payment method(s), and transaction timestamp only — line
   * items aren't touched. See InvoicesService.updateHeader() for the
   * rationale on keeping line edits out of this flow.
   */
  @Patch(':id')
  edit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateInvoiceDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.invoices.updateHeader(id, dto, { id: user.id, role: user.role });
  }

  @Get(':id/pdf')
  async downloadPdf(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ) {
    const invoice = await this.invoices.getById(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="invoice-${invoice.invoice_number}.pdf"`,
    );
    const stream = await this.pdf.render(invoice);
    stream.pipe(res);
  }

  /**
   * Hard-delete a draft invoice. Guarded in the service to `status='draft'`
   * only — the detail page's Cancel flow stays authoritative for anything
   * already finalized. Returns the invoice_number for a toast. (INV-005)
   */
  @Delete(':id')
  @HttpCode(200)
  deleteDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.invoices.deleteDraft(id, { id: user.id, role: user.role });
  }

  /**
   * Email the invoice PDF to a recipient. Optionally persist the address
   * on the client's `secondary_emails` list when it's not already the
   * primary. Never mutates invoice state — safe for drafts. (INV-007)
   */
  @Post(':id/email')
  @HttpCode(200)
  email(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: EmailInvoiceDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.invoices.emailInvoice(
      id,
      { to: dto.to, saveToClient: dto.save_to_client ?? false },
      { id: user.id, role: user.role },
    );
  }

  // Note: outstanding wholesale receivables live on the KPI controller
  // (`GET /admin/kpi/wholesale-owed`) rather than here. Keeping a second
  // copy on this controller would collide with `GET :id` (which uses
  // ParseUUIDPipe) at the routing layer since the slug `wholesale` is
  // not a UUID and Nest matches in declaration order.
}
