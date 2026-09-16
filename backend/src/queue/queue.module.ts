import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AgentModule } from '../agent/agent.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { ReceiptProcessingProcessor } from './receipt-processing.processor';
import { RECEIPT_PROCESSING_QUEUE } from './receipt-processing.types';

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
    AgentModule,
    ReceiptsModule,
  ],
  providers: [ReceiptProcessingProcessor],
  exports: [BullModule],
})
export class QueueModule {}
