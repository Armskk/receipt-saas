import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Runs `fn` with the Postgres session variable RLS policies check
   * (see prisma/rls.sql) set to `workspaceId`, inside a transaction so the
   * setting can't leak to a connection reused by a different request.
   * Every workspace-scoped read/write should go through this.
   */
  async withWorkspace<T>(workspaceId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    // workspaceId is a Prisma cuid (our own ids, never user-supplied SQL) —
    // still validate the shape before string-interpolating it into raw SQL,
    // since $executeRawUnsafe doesn't parameterize SET LOCAL.
    if (!/^[a-z0-9]+$/i.test(workspaceId)) {
      throw new Error(`Invalid workspaceId: ${workspaceId}`);
    }
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_workspace_id = '${workspaceId}'`);
      return fn(tx as PrismaClient);
    });
  }
}
