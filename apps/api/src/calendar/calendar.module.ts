import { forwardRef, Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ClientsModule } from '../clients/clients.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CalendarBookingsService } from './calendar-bookings.service';

@Module({
  imports: [forwardRef(() => IntegrationsModule), ClientsModule],
  controllers: [CalendarController],
  providers: [CalendarService, CalendarBookingsService],
  exports: [CalendarService, CalendarBookingsService],
})
export class CalendarModule {}
