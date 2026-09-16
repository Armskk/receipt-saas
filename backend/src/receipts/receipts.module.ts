import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [ReceiptsController],
  providers: [ReceiptsService],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
