import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReceiptSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentExtractionResult } from '../agent/agent.service';

const UNCATEGORIZED = 'Uncategorized';

// Only receipts the agent successfully read count toward spend.
const COUNTED_STATUSES: Prisma.EnumReceiptStatusFilter = {
  in: ['PARSED', 'CONFIRMED'],
};

function monthRange(month: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) {
    throw new BadRequestException('month must be in YYYY-MM format');
  }
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new BadRequestException('month is out of range');
  }
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// A row hidden by RLS (another tenant's, or a bad id) surfaces as P2025 on update.
function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

@Injectable()
export class ReceiptsService {
  constructor(private readonly prisma: PrismaService) {}

  createPending(params: {
    workspaceId: string;
    imageKeys: string[];
    source: ReceiptSource;
    sourceRef?: string;
    createdByUserId?: string;
  }) {
    return this.prisma.withWorkspace(params.workspaceId, (tx) =>
      tx.receipt.create({
        data: {
          workspaceId: params.workspaceId,
          imageKeys: params.imageKeys,
          source: params.source,
          sourceRef: params.sourceRef,
          createdByUserId: params.createdByUserId,
          status: 'PENDING',
        },
      }),
    );
  }

  markProcessing(workspaceId: string, receiptId: string) {
    return this.updateStatus(workspaceId, receiptId, { status: 'PROCESSING' });
  }

  markFailed(workspaceId: string, receiptId: string, reason: string) {
    return this.updateStatus(workspaceId, receiptId, { status: 'FAILED', failureReason: reason });
  }

  confirm(workspaceId: string, receiptId: string) {
    return this.updateStatus(workspaceId, receiptId, { status: 'CONFIRMED' });
  }

  private async updateStatus(
    workspaceId: string,
    receiptId: string,
    data: Prisma.ReceiptUpdateInput,
  ) {
    try {
      return await this.prisma.withWorkspace(workspaceId, (tx) =>
        tx.receipt.update({ where: { id: receiptId }, data }),
      );
    } catch (err) {
      if (isRecordNotFound(err)) throw new NotFoundException('Receipt not found');
      throw err;
    }
  }

  /**
   * Persists the agent's output: updates the receipt header fields, creates
   * one ReceiptItem per line item (resolving/creating categories by name
   * within the workspace), and logs token usage for cost metering.
   */
  async applyParsedResult(
    workspaceId: string,
    receiptId: string,
    result: AgentExtractionResult,
    imageCount = 1,
  ) {
    const { parsed, inputTokens, outputTokens } = result;

    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      const categoryNames = [
        ...new Set(
          parsed.items
            .map((i) => i.suggestedCategory)
            .filter((c): c is string => Boolean(c)),
        ),
      ];

      const categoryByName = new Map<string, string>();
      for (const name of categoryNames) {
        const category = await tx.category.upsert({
          where: { workspaceId_name: { workspaceId, name } },
          update: {},
          create: { workspaceId, name },
        });
        categoryByName.set(name, category.id);
      }

      await tx.receipt.update({
        where: { id: receiptId },
        data: {
          status: 'PARSED',
          merchantName: parsed.merchantName,
          purchaseDate: parsed.purchaseDate ? new Date(parsed.purchaseDate) : undefined,
          discountTotal: parsed.discountTotal,
          total: parsed.total,
          rawAgentResponse: parsed as any,
          items: {
            create: parsed.items.map((item) => ({
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              amount: item.amount,
              categoryId: item.suggestedCategory
                ? categoryByName.get(item.suggestedCategory)
                : undefined,
            })),
          },
        },
      });

      await tx.usageLog.create({
        data: {
          workspaceId,
          receiptId,
          inputTokens,
          outputTokens,
          imageCount,
          // Rough Claude Sonnet pricing placeholder — replace with the
          // current published rate; this is only for internal cost
          // tracking, not customer-facing billing.
          estimatedCostUsd:
            (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15,
        },
      });
    });
  }

  listForWorkspace(workspaceId: string) {
    return this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.receipt.findMany({
        where: { workspaceId },
        include: { items: { include: { category: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async get(workspaceId: string, receiptId: string) {
    const receipt = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.receipt.findUnique({
        where: { id: receiptId },
        include: { items: { include: { category: true } } },
      }),
    );
    if (!receipt) throw new NotFoundException('Receipt not found');
    return receipt;
  }

  /**
   * The months (YYYY-MM, newest first) that have at least one counted receipt,
   * so the summary page can offer a picker instead of a blind date input.
   * A receipt's month is its printed purchaseDate, or its upload date if the
   * agent couldn't read a date.
   */
  async availableMonths(workspaceId: string): Promise<string[]> {
    const receipts = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.receipt.findMany({
        where: { workspaceId, status: COUNTED_STATUSES },
        select: { purchaseDate: true, createdAt: true },
      }),
    );
    const months = new Set<string>();
    for (const r of receipts) {
      months.add((r.purchaseDate ?? r.createdAt).toISOString().slice(0, 7));
    }
    return [...months].sort().reverse();
  }

  /**
   * Spend totals for one calendar month: overall total, per-category breakdown
   * (from line items), per-day totals for a chart, and the biggest merchants.
   */
  async monthlySummary(workspaceId: string, month: string) {
    const { start, end } = monthRange(month);

    const receipts = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.receipt.findMany({
        where: {
          workspaceId,
          status: COUNTED_STATUSES,
          OR: [
            { purchaseDate: { gte: start, lt: end } },
            { AND: [{ purchaseDate: null }, { createdAt: { gte: start, lt: end } }] },
          ],
        },
        include: { items: { include: { category: true } } },
      }),
    );

    const zero = new Prisma.Decimal(0);
    let total = zero;
    const byCategory = new Map<string, { amount: Prisma.Decimal; itemCount: number }>();
    const byDay = new Map<string, { amount: Prisma.Decimal; receiptCount: number }>();
    const byMerchant = new Map<string, { amount: Prisma.Decimal; receiptCount: number }>();

    for (const r of receipts) {
      const paid = r.total ?? zero;
      total = total.plus(paid);

      const day = dayKey(r.purchaseDate ?? r.createdAt);
      const dayEntry = byDay.get(day) ?? { amount: zero, receiptCount: 0 };
      byDay.set(day, {
        amount: dayEntry.amount.plus(paid),
        receiptCount: dayEntry.receiptCount + 1,
      });

      const merchant = r.merchantName?.trim() || 'Unknown';
      const mEntry = byMerchant.get(merchant) ?? { amount: zero, receiptCount: 0 };
      byMerchant.set(merchant, {
        amount: mEntry.amount.plus(paid),
        receiptCount: mEntry.receiptCount + 1,
      });

      for (const item of r.items) {
        const name = item.category?.name ?? UNCATEGORIZED;
        const cEntry = byCategory.get(name) ?? { amount: zero, itemCount: 0 };
        byCategory.set(name, {
          amount: cEntry.amount.plus(item.amount),
          itemCount: cEntry.itemCount + 1,
        });
      }
    }

    return {
      month,
      currency: receipts[0]?.currency ?? 'THB',
      receiptCount: receipts.length,
      total: total.toFixed(2),
      byCategory: [...byCategory.entries()]
        .map(([category, v]) => ({
          category,
          amount: v.amount.toFixed(2),
          itemCount: v.itemCount,
        }))
        .sort((a, b) => Number(b.amount) - Number(a.amount)),
      byDay: [...byDay.entries()]
        .map(([date, v]) => ({
          date,
          amount: v.amount.toFixed(2),
          receiptCount: v.receiptCount,
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      topMerchants: [...byMerchant.entries()]
        .map(([merchant, v]) => ({
          merchant,
          amount: v.amount.toFixed(2),
          receiptCount: v.receiptCount,
        }))
        .sort((a, b) => Number(b.amount) - Number(a.amount))
        .slice(0, 5),
    };
  }
}
