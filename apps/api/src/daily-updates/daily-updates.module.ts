import { Module } from '@nestjs/common';
import { DailyUpdatesController } from './daily-updates.controller';
import { DailyUpdatesService } from './daily-updates.service';

/**
 * Daily Updates module (migration 026).
 *
 * NotificationsModule is @Global() so it's injected without an
 * explicit import here. Post creation fans out an in-app alert to
 * every active admin/staff via
 * NotificationsService.notifyRoles(['admin', 'staff'], ...).
 */
@Module({
  controllers: [DailyUpdatesController],
  providers: [DailyUpdatesService],
  exports: [DailyUpdatesService],
})
export class DailyUpdatesModule {}
