import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RECEIPT_PROCESSING_QUEUE } from './receipt-processing.types';

// Queue plumbing shared by both processes: the API enqueues through it, the
// worker consumes through it. The consumer itself (ReceiptProcessingProcessor)
// is deliberately NOT provided here — it lives in WorkerModule, so the API
// process never starts a BullMQ worker or reaches the Claude client.
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    BullModule.registerQueue({
      name: RECEIPT_PROCESSING_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
