import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkspaceGuard } from './workspace.guard';
import { ChannelLinkService } from './channel-link.service';

const CHANNELS: Record<string, ChannelType> = { line: 'LINE', telegram: 'TELEGRAM' };

function parseChannel(param: string): ChannelType {
  const channel = CHANNELS[param.toLowerCase()];
  if (!channel) throw new BadRequestException('Unknown channel (expected "line" or "telegram")');
  return channel;
}

// Connecting a chat lets whoever controls it add receipts to the workspace, so
// it's limited to owners/admins, not every member.
function requireManager(req: any) {
  const role: string | undefined = req.workspaceMembership?.role;
  if (role !== 'OWNER' && role !== 'ADMIN') {
    throw new ForbiddenException('Only workspace owners and admins can connect chat channels');
  }
}

@Controller('workspaces/:workspaceId/channels')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class WorkspaceChannelsController {
  constructor(private readonly links: ChannelLinkService) {}

  /** Which channels are linked. Never returns the LINE user id / chat id itself. */
  @Get()
  status(@Param('workspaceId') workspaceId: string) {
    return this.links.status(workspaceId);
  }

  /** One-time code to send to the bot; replaces any earlier unused code for this channel. */
  @Post(':channel/link-code')
  linkCode(@Param('workspaceId') workspaceId: string, @Param('channel') channel: string, @Req() req: any) {
    requireManager(req);
    return this.links.createCode(workspaceId, parseChannel(channel));
  }

  @Delete(':channel')
  unlink(@Param('workspaceId') workspaceId: string, @Param('channel') channel: string, @Req() req: any) {
    requireManager(req);
    return this.links.unlink(workspaceId, parseChannel(channel));
  }
}
