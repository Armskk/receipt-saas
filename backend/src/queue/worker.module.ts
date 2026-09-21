import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { AgentModule } from '../agent/agent.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { QueueModule } from './queue.module';
import { ReceiptProcessingProcessor } from './receipt-processing.processor';

// Root module of the worker process (src/worker.ts). The only place the
// processor is registered, so only this process consumes jobs and calls Claude.
// The API's AppModule must not import this module or AgentModule —
// worker-module.spec.ts enforces that.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    CommonModule,
    QueueModule,
    AgentModule,
    ReceiptsModule,
  ],
  providers: [ReceiptProcessingProcessor],
})
export class WorkerModule {}
