import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string) {
    return this.prisma.workspace.findMany({
      where: { members: { some: { userId } } },
    });
  }

  get(workspaceId: string) {
    return this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  }
}
