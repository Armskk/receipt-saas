import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // The app connects as the non-superuser `receipts_app` role so RLS applies;
    // DATABASE_URL (the owner role) is for `prisma migrate` only. The fallback
    // keeps a bare dev setup booting, and assertRlsEnforced() flags it.
    super({ datasourceUrl: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL });
  }

  async onModuleInit() {
    await this.$connect();
    await this.assertRlsEnforced();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Superusers and BYPASSRLS roles skip every RLS policy, which would make
   * tenant isolation silently do nothing. Refuse to run that way in production
   * (`strict`) and warn loudly elsewhere.
   */
  async assertRlsEnforced(strict = process.env.NODE_ENV === 'production'): Promise<void> {
    const [row] = await this.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    if (!row?.bypass) return;

    const message =
      'Connected to Postgres as a role that bypasses Row-Level Security (superuser/BYPASSRLS). ' +
      'Set APP_DATABASE_URL to the non-privileged `receipts_app` role.';
    if (strict) {
      throw new Error(message);
    }
    this.logger.warn(message);
  }

  /**
   * Runs `fn` with the Postgres session variable RLS policies check
   * (see the enable_rls migration) set to `workspaceId`, inside a transaction
   * so the setting is transaction-local and can't leak to a pooled connection
   * reused by a different request. Every workspace-scoped read/write must go
   * through this — outside it, RLS returns zero rows.
   */
  async withWorkspace<T>(
    workspaceId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
      return fn(tx);
    });
  }
}
