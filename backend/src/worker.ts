// Separate entrypoint for the BullMQ worker process (see docker-compose.yml
// `worker` service). Boots WorkerModule — not AppModule — with no HTTP
// listener: it only pulls jobs off the queue and processes them. Keeping
// this as its own process, not a thread inside the API server, is what lets
// the API stay responsive to webhooks while Claude is processing an image
// (see CLAUDE.md "Why there's a separate worker process").

import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './queue/worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // eslint-disable-next-line no-console
  console.log('Receipt-processing worker started, waiting for jobs...');
  // The BullMQ processor registers itself via @Processor decorator in
  // queue/receipt-processing.processor.ts (provided by WorkerModule) — just
  // keeping the app context alive is enough for it to start consuming jobs.
  await app.init();
}

bootstrap();
