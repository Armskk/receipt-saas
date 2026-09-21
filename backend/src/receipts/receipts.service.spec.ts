import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from './receipts.service';
import { AgentExtractionResult } from '../agent/agent.service';
import { testUrls } from '../test/db';
import { cleanupWorkspaces, seedWorkspace, SeededWorkspace } from '../test/seed';

// Same-month purchase dates so both tenants would land in one summary if isolation failed.
const PURCHASE_DATE = new Date(Date.UTC(2026, 0, 15));

describe('ReceiptsService tenant isolation (integration)', () => {
  const { ownerUrl, appUrl } = testUrls();
  let owner: PrismaClient;
  let prisma: PrismaService;
  let service: ReceiptsService;
  let a: SeededWorkspace;
  let b: SeededWorkspace;
  const savedAppUrl = process.env.APP_DATABASE_URL;

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    process.env.APP_DATABASE_URL = appUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ReceiptsService(prisma);

    a = await seedWorkspace(owner, 'a', { total: 100, purchaseDate: PURCHASE_DATE });
    b = await seedWorkspace(owner, 'b', { total: 999, purchaseDate: PURCHASE_DATE });
  });

  afterAll(async () => {
    await cleanupWorkspaces(owner, [a.workspaceId, b.workspaceId]);
    await prisma.$disconnect();
    await owner.$disconnect();
    if (savedAppUrl === undefined) delete process.env.APP_DATABASE_URL;
    else process.env.APP_DATABASE_URL = savedAppUrl;
  });

  it('get returns own receipt with items', async () => {
    const receipt = await service.get(a.workspaceId, a.receiptId);
    expect(receipt.id).toBe(a.receiptId);
    expect(receipt.items).toHaveLength(1);
  });

  it("get 404s on another workspace's receipt", async () => {
    await expect(service.get(a.workspaceId, b.receiptId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("confirm 404s on another workspace's receipt and leaves it unchanged", async () => {
    await expect(service.confirm(a.workspaceId, b.receiptId)).rejects.toBeInstanceOf(NotFoundException);
    const untouched = await owner.receipt.findUniqueOrThrow({ where: { id: b.receiptId } });
    expect(untouched.status).toBe('PARSED');
  });

  it('markProcessing and markFailed 404 on another workspace\'s receipt', async () => {
    await expect(service.markProcessing(a.workspaceId, b.receiptId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.markFailed(a.workspaceId, b.receiptId, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listForWorkspace only lists own receipts', async () => {
    const receipts = await service.listForWorkspace(a.workspaceId);
    expect(receipts.map((r) => r.id)).toEqual([a.receiptId]);
  });

  it('monthlySummary and availableMonths exclude other workspaces', async () => {
    const summary = await service.monthlySummary(a.workspaceId, '2026-01');
    expect(summary.receiptCount).toBe(1);
    expect(summary.total).toBe('100.00');
    expect(await service.availableMonths(a.workspaceId)).toEqual(['2026-01']);
  });

  it('createPending is scoped to the workspace it was created in', async () => {
    const created = await service.createPending({
      workspaceId: a.workspaceId,
      imageKeys: ['k1'],
      source: 'WEB',
    });
    expect(created.status).toBe('PENDING');
    expect((await service.get(a.workspaceId, created.id)).workspaceId).toBe(a.workspaceId);
    await expect(service.get(b.workspaceId, created.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('applyParsedResult', () => {
    const result: AgentExtractionResult = {
      inputTokens: 1000,
      outputTokens: 200,
      parsed: {
        merchantName: 'Cafe',
        total: 75,
        items: [{ description: 'Latte', suggestedCategory: 'Coffee-RLS-Test', amount: 75 }],
      },
    };

    it('writes header, items, category and usage log under the right workspace', async () => {
      const pending = await service.createPending({
        workspaceId: a.workspaceId,
        imageKeys: ['k2'],
        source: 'WEB',
      });
      await service.applyParsedResult(a.workspaceId, pending.id, result);

      const receipt = await service.get(a.workspaceId, pending.id);
      expect(receipt.status).toBe('PARSED');
      expect(receipt.items[0].category?.name).toBe('Coffee-RLS-Test');
      expect(receipt.items[0].category?.workspaceId).toBe(a.workspaceId);

      const log = await owner.usageLog.findFirstOrThrow({ where: { receiptId: pending.id } });
      expect(log.workspaceId).toBe(a.workspaceId);
    });

    it("can't write results onto another workspace's receipt, and rolls back everything", async () => {
      await expect(service.applyParsedResult(a.workspaceId, b.receiptId, result)).rejects.toBeDefined();

      const untouched = await owner.receipt.findUniqueOrThrow({
        where: { id: b.receiptId },
        include: { items: true },
      });
      expect(untouched.merchantName).toBe('Merchant b');
      expect(untouched.items).toHaveLength(1);
      expect(await owner.usageLog.count({ where: { receiptId: b.receiptId } })).toBe(1); // only the seeded one
    });
  });
});
