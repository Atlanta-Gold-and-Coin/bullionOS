import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { EodReportsService } from './eod-reports.service';
import { SettingsService } from '../settings/settings.service';

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
  constructor(
    private readonly eod: EodReportsService,
    private readonly settings: SettingsService,
  ) {}

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
    const [data, branding] = await Promise.all([
      this.eod.buildReport(date),
      this.settings.getBranding(),
    ]);
    const appUrl = process.env.WEB_ORIGIN ?? '';
    return {
      data,
      html: this.eod.renderHtml(data, {
        companyName: branding.company_name,
        appUrl,
      }),
      text: this.eod.renderPlaintext(data, {
        companyName: branding.company_name,
      }),
    };
  }
}
