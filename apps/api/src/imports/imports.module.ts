import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/**
 * CSV imports — products, clients, historical invoices.
 *
 * Self-contained: relies only on the global @Database module.
 * Stays tenant-neutral; per-tenant defaults live in app_settings
 * and don't influence import behavior.
 */
@Module({
  controllers: [ImportsController],
  providers: [ImportsService],
  exports: [ImportsService],
})
export class ImportsModule {}
