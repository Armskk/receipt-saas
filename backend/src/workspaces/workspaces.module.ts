import { Module } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceGuard } from './workspace.guard';

@Module({
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceGuard],
  exports: [WorkspacesService, WorkspaceGuard],
})
export class WorkspacesModule {}
