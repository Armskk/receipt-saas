import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ReceiptsModule } from './receipts/receipts.module';
import { QueueModule } from './queue/queue.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { BillingModule } from './billing/billing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    CommonModule,
    AuthModule,
    WorkspacesModule,
    ReceiptsModule,
    QueueModule,
    IngestionModule,
    BillingModule,
  ],
})
export class AppModule {}
