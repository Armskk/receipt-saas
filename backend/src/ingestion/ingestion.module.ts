import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { QueueModule } from '../queue/queue.module';
import { WebUploadController } from './web-upload.controller';
import { LineController } from './line.controller';
import { TelegramController } from './telegram.controller';

@Module({
  imports: [WorkspacesModule, ReceiptsModule, QueueModule],
  controllers: [WebUploadController, LineController, TelegramController],
})
export class IngestionModule {}
