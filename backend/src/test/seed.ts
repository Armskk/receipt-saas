import { PrismaClient } from '@prisma/client';

export interface SeededWorkspace {
  workspaceId: string;
  categoryId: string;
  receiptId: string;
  itemId: string;
  usageLogId: string;
}

// Seeds one workspace with a category, a PARSED receipt (with one item) and a
// usage log. Uses the owner client, which bypasses RLS.
export async function seedWorkspace(
  owner: PrismaClient,
  label: string,
  opts: { total?: number; purchaseDate?: Date } = {},
): Promise<SeededWorkspace> {
  const total = opts.total ?? 100;
  const workspace = await owner.workspace.create({
    data: { name: `rls-test-${label}-${Math.random().toString(36).slice(2, 8)}` },
  });
  const category = await owner.category.create({
    data: { workspaceId: workspace.id, name: 'Food' },
  });
  const receipt = await owner.receipt.create({
    data: {
      workspaceId: workspace.id,
      source: 'WEB',
      imageKeys: ['test-key'],
      status: 'PARSED',
      merchantName: `Merchant ${label}`,
      purchaseDate: opts.purchaseDate,
      total,
      items: { create: [{ description: `Item ${label}`, amount: total, categoryId: category.id }] },
    },
    include: { items: true },
  });
  const usageLog = await owner.usageLog.create({
    data: { workspaceId: workspace.id, receiptId: receipt.id, inputTokens: 1, outputTokens: 1 },
  });
  return {
    workspaceId: workspace.id,
    categoryId: category.id,
    receiptId: receipt.id,
    itemId: receipt.items[0].id,
    usageLogId: usageLog.id,
  };
}

// Deleting the workspace cascades to categories, receipts, items and usage logs.
export async function cleanupWorkspaces(owner: PrismaClient, ids: string[]) {
  await owner.workspace.deleteMany({ where: { id: { in: ids } } });
}
