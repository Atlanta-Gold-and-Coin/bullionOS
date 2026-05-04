import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Defer logger until pino is ready; we replace it immediately below.
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  // If deployed behind a reverse proxy (Cloudflare, Railway LB, AWS ALB),
  // we need req.ip to reflect the real client so rate limiting works.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(cookieParser());

  app.use(
    helmet({
      // API-only service; no inline scripts to worry about.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // CORS allowlist: the admin web app (WEB_ORIGIN) plus any additional
  // public consumers listed in PUBLIC_ORIGINS (comma-separated). The
  // latter covers the WordPress plugin on atlantagoldandcoin.com —
  // without it, the browser was blocking the restock-notify POST and
  // similar @Public() endpoints with no Access-Control-Allow-Origin
  // header on the preflight response. Dev leaves PUBLIC_ORIGINS empty
  // and CORS falls back to WEB_ORIGIN only.
  const corsOrigins = [
    config.getOrThrow<string>('WEB_ORIGIN'),
    ...config
      .get<string>('PUBLIC_ORIGINS', '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ];
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,        // strip unknown properties
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      // Don't leak validation internals to attackers.
      disableErrorMessages: config.get('NODE_ENV') === 'production' ? false : false,
    }),
  );

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 4000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`\n🚀 BullionOS API listening on http://localhost:${port}/api/v1`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error:', err);
  process.exit(1);
});
