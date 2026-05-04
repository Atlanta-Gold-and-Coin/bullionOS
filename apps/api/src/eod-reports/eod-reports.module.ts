import { Module } from '@nestjs/common';
import { EodReportsController } from './eod-reports.controller';
import { EodReportsService } from './eod-reports.service';
import { SettingsModule } from '../settings/settings.module';

/**
 * End-of-day business report module. Pulls SettingsService for the
 * tenant branding (subject prefix) + From override; relies on the
 * global @Database / @Email modules for everything else. Cron
 * registered via the @Cron decorator on EodReportsService.scheduledSend.
 */
@Module({
  imports: [SettingsModule],
  controllers: [EodReportsController],
  providers: [EodReportsService],
  exports: [EodReportsService],
})
export class EodReportsModule {}
