import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import type { InvoiceStatus, InvoiceType } from '../db/types';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { UpdateInvoiceStatusDto } from './dto/update-invoice-status.dto';
import { InvoicesService } from './invoices.service';
import { InvoicePdfService } from './invoice-pdf.service';

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
    return this.invoices.updateStatus(id, dto.status, { id: user.id, role: user.role });
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
}
