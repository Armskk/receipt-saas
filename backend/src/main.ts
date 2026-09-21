import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { resolveCorsOrigins } from './common/cors';

async function bootstrap() {
  // rawBody: true — the LINE webhook needs the exact unparsed request body
  // to verify its HMAC signature (req.rawBody), see ingestion/line.controller.ts.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Strip unknown fields and reject payloads that don't match a DTO's shape.
  // This matters most for agent.service.ts's output — Claude's JSON response
  // is validated through the same pipe before anything touches the DB.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Only the dashboard's origin(s) — see resolveCorsOrigins (CORS_ORIGINS; required in production).
  app.enableCors({ origin: resolveCorsOrigins() });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Backend listening on :${port}`);
}

bootstrap();
