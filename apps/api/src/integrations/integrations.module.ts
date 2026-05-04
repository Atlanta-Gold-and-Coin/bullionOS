import { forwardRef, Global, Module } from '@nestjs/common';
import { EasyPostAdapter } from './adapters/easypost.adapter';
import { FedexAdapter } from './adapters/fedex.adapter';
import { UpsAdapter } from './adapters/ups.adapter';
import { UspsAdapter } from './adapters/usps.adapter';
import { CarrierService } from './carrier.service';
import { DocuSignService } from './docusign.service';
import { GremindersService } from './greminders.service';
import { GremindersWebhookController } from './greminders-webhook.controller';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { ShipmentIngestService } from './shipment-ingest.service';
import { ShipmentPollService } from './shipment-poll.service';
import { CarrierWebhooksController } from './webhooks.controller';
import { MetalsModule } from '../metals/metals.module';
import { CalendarModule } from '../calendar/calendar.module';
import { ClientsModule } from '../clients/clients.module';
import { GmailModule } from '../gmail/gmail.module';
import { AurbitrageModule } from '../aurbitrage/aurbitrage.module';
import { IfsModule } from '../ifs/ifs.module';
import { SettingsModule } from '../settings/settings.module';

// Global: many feature modules will inject CarrierService/DocuSignService.
// Imports MetalsModule because IntegrationsController needs MetalsService
// for the admin "Test connection" button on the metals provider. The reverse
// dependency (MetalsService needs IntegrationsService) is satisfied by this
// module's @Global export.
@Global()
@Module({
  // forwardRef breaks the cycle: CalendarModule imports this one to read
  // integration credentials, and this controller needs CalendarService for
  // the per-provider "Test connection" button.
  //
  // ScheduleModule.forRoot() lives in AppModule — calling it here would
  // create a duplicate scheduler registry and the @Cron decorator on
  // ShipmentPollService silently wouldn't fire.
  imports: [
    MetalsModule,
    forwardRef(() => CalendarModule),
    ClientsModule,
    // forwardRef on GmailModule: IntegrationsController injects
    // GmailService for the admin "Test connection" button, and
    // GmailService itself injects IntegrationsService. Same shape as
    // the CalendarModule relationship above.
    forwardRef(() => GmailModule),
    forwardRef(() => AurbitrageModule),
    forwardRef(() => IfsModule),
    SettingsModule,
  ],
  controllers: [
    IntegrationsController,
    CarrierWebhooksController,
    GremindersWebhookController,
  ],
  providers: [
    IntegrationsService,
    CarrierService,
    DocuSignService,
    GremindersService,
    ShipmentIngestService,
    ShipmentPollService,
    // Carrier adapters — one per provider.
    UpsAdapter,
    FedexAdapter,
    UspsAdapter,
    EasyPostAdapter,
  ],
  exports: [
    IntegrationsService,
    CarrierService,
    DocuSignService,
    GremindersService,
    ShipmentIngestService,
    ShipmentPollService,
  ],
})
export class IntegrationsModule {}
