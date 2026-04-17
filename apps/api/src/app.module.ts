import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { loadEnv } from './config/env';
import { DatabaseModule } from './db/database.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { MetalsModule } from './metals/metals.module';
import { PricingModule } from './pricing/pricing.module';
import { ProductsModule } from './products/products.module';
import { InvoicesModule } from './invoices/invoices.module';
import { ClientsModule } from './clients/clients.module';
import { PublicModule } from './public/public.module';
import { ClientPortalModule } from './client-portal/client-portal.module';
import { SettingsModule } from './settings/settings.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DealRequestsModule } from './deal-requests/deal-requests.module';
import { ShipmentsModule } from './shipments/shipments.module';
import { EmailModule } from './email/email.module';
import { SmsModule } from './sms/sms.module';
import { PriceQuotesModule } from './price-quotes/price-quotes.module';
import { InventoryModule } from './inventory/inventory.module';
import { MessagesModule } from './messages/messages.module';
import { CryptoModule } from './crypto/crypto.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { KpiModule } from './kpi/kpi.module';
import { BackupsModule } from './backups/backups.module';
import { CalendarModule } from './calendar/calendar.module';
import { HealthController } from './health/health.controller';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // ConfigModule merges .env + process.env and hands us the result to validate.
      validate: (config) => loadEnv(config),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
            : undefined,
        // Never log auth headers or tokens.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.refresh_token',
            'req.body.totp',
          ],
          censor: '[REDACTED]',
        },
        level: process.env.LOG_LEVEL ?? 'info',
      },
    }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100 },
    ]),
    DatabaseModule,
    RedisModule,
    AuthModule,
    MetalsModule,
    PricingModule,
    ProductsModule,
    ClientsModule,
    InvoicesModule,
    PublicModule,
    EmailModule,
    NotificationsModule,
    DealRequestsModule,
    ShipmentsModule,
    PriceQuotesModule,
    InventoryModule,
    MessagesModule,
    SmsModule,
    CryptoModule,
    IntegrationsModule,
    KpiModule,
    BackupsModule,
    CalendarModule,
    ClientPortalModule,
    SettingsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order matters: rate-limit → auth → role check.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
