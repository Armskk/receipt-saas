import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkspaceGuard } from './workspace.guard';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get()
  list(@Req() req: any) {
    return this.workspacesService.listForUser(req.user.userId);
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceGuard)
  get(@Param('workspaceId') workspaceId: string) {
    return this.workspacesService.get(workspaceId);
  }
}
