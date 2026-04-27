import { Module } from '@nestjs/common';
import { EodReportsController } from './eod-reports.controller';
import { EodReportsService } from './eod-reports.service';

/**
 * End-of-day business report module. Self-contained — relies on
 * the global @Database, @Email modules. Cron registered via the
 * @Cron decorator on EodReportsService.scheduledSend.
 */
@Module({
  controllers: [EodReportsController],
  providers: [EodReportsService],
  exports: [EodReportsService],
})
export class EodReportsModule {}
