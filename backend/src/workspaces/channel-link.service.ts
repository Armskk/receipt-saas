import { Injectable } from '@nestjs/common';
import { ChannelType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { channelMessages } from './channel-messages';
import {
  CODE_TTL_MS,
  extractLinkCode,
  formatCode,
  generateCode,
  hashCode,
} from './channel-link-code';

export type RedeemResult =
  | { ok: true; workspaceId: string; workspaceName: string }
  | { ok: false; reason: 'INVALID_OR_EXPIRED' | 'ALREADY_LINKED_ELSEWHERE' };

export interface ChannelStatus {
  line: boolean;
  telegram: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Links a LINE/Telegram chat to a workspace with a one-time code:
 * the dashboard calls createCode(), the user sends the code to the bot, and the
 * webhook calls handleText()/redeem(), which writes Workspace.lineUserId /
 * telegramChatId.
 *
 * `channel_link_codes` and `workspaces` are not under RLS (the webhook needs
 * them before it knows the workspace), so this service uses the plain client,
 * not PrismaService.withWorkspace.
 */
@Injectable()
export class ChannelLinkService {
  constructor(private readonly prisma: PrismaService) {}

  /** New code for (workspace, channel). Any older unused code for that pair stops working. */
  async createCode(workspaceId: string, channel: ChannelType) {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.channelLinkCode.deleteMany({
        where: {
          workspaceId,
          channel,
          // superseded (never used) codes, plus used ones after a day
          OR: [{ usedAt: null }, { expiresAt: { lt: new Date(Date.now() - DAY_MS) } }],
        },
      }),
      this.prisma.channelLinkCode.create({
        data: { workspaceId, channel, codeHash: hashCode(code), expiresAt },
      }),
    ]);
    return { code: formatCode(code), expiresAt };
  }

  /**
   * Consumes a (normalized) code and links `externalId` — the LINE userId or
   * Telegram chat id — to the code's workspace. The code is only spent when the
   * link succeeds. Re-linking a workspace to a different chat replaces the old one.
   */
  async redeem(channel: ChannelType, externalId: string, code: string): Promise<RedeemResult> {
    const codeHash = hashCode(code);
    const now = new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.channelLinkCode.findUnique({
          where: { codeHash },
          include: { workspace: { select: { id: true, name: true } } },
        });
        if (!row || row.channel !== channel || row.usedAt || row.expiresAt <= now) {
          return { ok: false, reason: 'INVALID_OR_EXPIRED' } as const;
        }

        // A chat can belong to only one workspace. Don't burn the code on a conflict.
        const taken = await tx.workspace.findFirst({
          where: { ...this.linkFilter(channel, externalId), NOT: { id: row.workspaceId } },
          select: { id: true },
        });
        if (taken) return { ok: false, reason: 'ALREADY_LINKED_ELSEWHERE' } as const;

        // Single-use even if two chats redeem the same code at once: only one update matches.
        const spent = await tx.channelLinkCode.updateMany({
          where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (spent.count !== 1) return { ok: false, reason: 'INVALID_OR_EXPIRED' } as const;

        await tx.workspace.update({
          where: { id: row.workspaceId },
          data: this.linkData(channel, externalId),
        });
        return { ok: true, workspaceId: row.workspace.id, workspaceName: row.workspace.name } as const;
      });
    } catch (err) {
      // Lost a race for the unique lineUserId/telegramChatId to another workspace.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { ok: false, reason: 'ALREADY_LINKED_ELSEWHERE' };
      }
      throw err;
    }
  }

  /**
   * What the bot should answer to a text message from `externalId`, or null to
   * stay silent: a code links the chat; anything else from a chat that isn't
   * linked yet gets the how-to; a linked chat's other text is ignored.
   */
  async handleText(channel: ChannelType, externalId: string, text: string): Promise<string | null> {
    const code = extractLinkCode(text);
    if (code) {
      const result = await this.redeem(channel, externalId, code);
      if (result.ok) return channelMessages.linked(result.workspaceName);
      return result.reason === 'ALREADY_LINKED_ELSEWHERE'
        ? channelMessages.alreadyLinkedElsewhere
        : channelMessages.invalidCode;
    }
    return (await this.isLinked(channel, externalId)) ? null : channelMessages.notLinkedHelp;
  }

  async isLinked(channel: ChannelType, externalId: string): Promise<boolean> {
    const found = await this.prisma.workspace.findFirst({
      where: this.linkFilter(channel, externalId),
      select: { id: true },
    });
    return !!found;
  }

  async status(workspaceId: string): Promise<ChannelStatus> {
    const w = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { lineUserId: true, telegramChatId: true },
    });
    return { line: !!w.lineUserId, telegram: !!w.telegramChatId };
  }

  async unlink(workspaceId: string, channel: ChannelType): Promise<ChannelStatus> {
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: this.linkData(channel, null),
    });
    return this.status(workspaceId);
  }

  private linkFilter(channel: ChannelType, externalId: string): Prisma.WorkspaceWhereInput {
    return channel === 'LINE' ? { lineUserId: externalId } : { telegramChatId: externalId };
  }

  private linkData(channel: ChannelType, externalId: string | null): Prisma.WorkspaceUpdateInput {
    return channel === 'LINE' ? { lineUserId: externalId } : { telegramChatId: externalId };
  }
}
