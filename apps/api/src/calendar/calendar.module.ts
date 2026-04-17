import { forwardRef, Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

@Module({
  imports: [forwardRef(() => IntegrationsModule)],
  controllers: [CalendarController],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
