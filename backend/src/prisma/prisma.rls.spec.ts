import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { testUrls, withParam } from '../test/db';
import { cleanupWorkspaces, seedWorkspace, SeededWorkspace } from '../test/seed';

describe('Row-Level Security (integration)', () => {
  const { ownerUrl, appUrl } = testUrls();
  let owner: PrismaClient;
  let app: PrismaService;
  let a: SeededWorkspace;
  let b: SeededWorkspace;
  const savedAppUrl = process.env.APP_DATABASE_URL;

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    // One pooled connection makes the "setting doesn't leak" test meaningful:
    // every query below reuses the same session.
    process.env.APP_DATABASE_URL = withParam(appUrl, 'connection_limit', '1');
    app = new PrismaService();
    await app.$connect();

    a = await seedWorkspace(owner, 'a');
    b = await seedWorkspace(owner, 'b');
  });

  afterAll(async () => {
    await cleanupWorkspaces(owner, [a.workspaceId, b.workspaceId]);
    await app.$disconnect();
    await owner.$disconnect();
    if (savedAppUrl === undefined) delete process.env.APP_DATABASE_URL;
    else process.env.APP_DATABASE_URL = savedAppUrl;
  });

  it("only returns the current workspace's rows from every tenant table", async () => {
    const rows = await app.withWorkspace(a.workspaceId, async (tx) => ({
      categories: await tx.category.findMany(),
      receipts: await tx.receipt.findMany(),
      items: await tx.receiptItem.findMany(),
      usageLogs: await tx.usageLog.findMany(),
    }));

    expect(rows.categories.map((r) => r.id)).toEqual([a.categoryId]);
    expect(rows.receipts.map((r) => r.id)).toEqual([a.receiptId]);
    expect(rows.items.map((r) => r.id)).toEqual([a.itemId]);
    expect(rows.usageLogs.map((r) => r.id)).toEqual([a.usageLogId]);
  });

  it("can't look up another workspace's receipt by id", async () => {
    const found = await app.withWorkspace(a.workspaceId, (tx) =>
      tx.receipt.findUnique({ where: { id: b.receiptId } }),
    );
    expect(found).toBeNull();
  });

  it("can't see another workspace's items even when querying by their receiptId", async () => {
    const items = await app.withWorkspace(a.workspaceId, (tx) =>
      tx.receiptItem.findMany({ where: { receiptId: b.receiptId } }),
    );
    expect(items).toEqual([]);
  });

  it("can't update another workspace's receipt", async () => {
    await expect(
      app.withWorkspace(a.workspaceId, (tx) =>
        tx.receipt.update({ where: { id: b.receiptId }, data: { status: 'CONFIRMED' } }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });

    const untouched = await owner.receipt.findUniqueOrThrow({ where: { id: b.receiptId } });
    expect(untouched.status).toBe('PARSED');
  });

  it("can't insert a receipt into another workspace", async () => {
    await expect(
      app.withWorkspace(a.workspaceId, (tx) =>
        tx.receipt.create({
          data: { workspaceId: b.workspaceId, source: 'WEB', imageKeys: ['x'] },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("can't attach an item to another workspace's receipt", async () => {
    await expect(
      app.withWorkspace(a.workspaceId, (tx) =>
        tx.receiptItem.create({
          data: { receiptId: b.receiptId, description: 'sneaky', amount: 1 },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('returns nothing when a query runs outside withWorkspace', async () => {
    expect(await app.receipt.count()).toBe(0);
    expect(await app.category.count()).toBe(0);
    expect(await app.receiptItem.count()).toBe(0);
    expect(await app.usageLog.count()).toBe(0);
  });

  it('does not leak the workspace setting to the next use of the same connection', async () => {
    await app.withWorkspace(a.workspaceId, (tx) => tx.receipt.count());
    expect(await app.receipt.count()).toBe(0);
  });

  describe('assertRlsEnforced', () => {
    it('passes for the non-privileged app role', async () => {
      await expect(app.assertRlsEnforced(true)).resolves.toBeUndefined();
    });

    it('rejects a role that bypasses RLS when strict', async () => {
      const [{ bypass }] = await owner.$queryRaw<{ bypass: boolean }[]>`
        SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
      if (!bypass) return; // owner role isn't privileged in this setup; nothing to assert

      process.env.APP_DATABASE_URL = ownerUrl;
      const privileged = new PrismaService();
      try {
        await expect(privileged.assertRlsEnforced(true)).rejects.toThrow(/bypasses Row-Level Security/);
      } finally {
        await privileged.$disconnect();
        process.env.APP_DATABASE_URL = withParam(appUrl, 'connection_limit', '1');
      }
    });
  });
});
