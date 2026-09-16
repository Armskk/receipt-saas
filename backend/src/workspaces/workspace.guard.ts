import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Every route that touches workspace-scoped data (receipts, categories,
 * usage logs) should carry a `:workspaceId` route param and be guarded by
 * this. It checks the JWT-authenticated user is actually a member of that
 * workspace before the handler runs — this is the application-level half
 * of tenant isolation; prisma/rls.sql is the database-level half.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.userId;
    const workspaceId: string | undefined = req.params?.workspaceId;

    if (!userId || !workspaceId) {
      throw new ForbiddenException('Missing user or workspace context');
    }

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });

    if (!membership) {
      throw new ForbiddenException('Not a member of this workspace');
    }

    req.workspaceMembership = membership;
    return true;
  }
}
