import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { EodReportsService } from './eod-reports.service';

/**
 * Admin-only EOD report controls.
 *
 *   POST /admin/eod-reports/send-now      → fire the email blast
 *   GET  /admin/eod-reports/preview?date= → inspect the data + HTML
 *                                            without sending
 */
@Controller('admin/eod-reports')
@Roles('admin')
export class EodReportsController {
  constructor(private readonly eod: EodReportsService) {}

  @Post('send-now')
  @HttpCode(200)
  sendNow(@Body() body: { date?: string }) {
    if (body?.date && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      throw new BadRequestException('date must be YYYY-MM-DD when provided');
    }
    return this.eod.send(body?.date);
  }

  @Get('preview')
  async preview(@Query('date') date?: string) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    const data = await this.eod.buildReport(date);
    return {
      data,
      html: this.eod.renderHtml(data),
      text: this.eod.renderPlaintext(data),
    };
  }
}
