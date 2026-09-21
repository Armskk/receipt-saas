import { Module } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceGuard } from './workspace.guard';
import { WorkspaceChannelsController } from './workspace-channels.controller';
import { ChannelLinkService } from './channel-link.service';

@Module({
  controllers: [WorkspacesController, WorkspaceChannelsController],
  providers: [WorkspacesService, WorkspaceGuard, ChannelLinkService],
  exports: [WorkspacesService, WorkspaceGuard, ChannelLinkService],
})
export class WorkspacesModule {}
