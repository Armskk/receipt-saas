import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { QueueModule } from '../queue/queue.module';
import { WebUploadController } from './web-upload.controller';
import { LineController } from './line.controller';
import { TelegramController } from './telegram.controller';
import { ChannelMessenger } from './channel-messenger.service';

@Module({
  imports: [WorkspacesModule, ReceiptsModule, QueueModule],
  controllers: [WebUploadController, LineController, TelegramController],
  providers: [ChannelMessenger],
})
export class IngestionModule {}
