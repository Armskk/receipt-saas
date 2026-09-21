import { BadRequestException, Controller, Headers, Logger, Post, Req } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { ChannelLinkService } from '../workspaces/channel-link.service';
import { channelMessages } from '../workspaces/channel-messages';
import { RECEIPT_PROCESSING_QUEUE, ReceiptProcessingJob } from '../queue/receipt-processing.types';
import { ChannelMessenger } from './channel-messenger.service';

// LINE Messaging API webhook. Register this URL (https://api.yourdomain.com/webhooks/line)
// in the LINE Developers Console for your Messaging API channel.
// Docs: https://developers.line.biz/en/reference/messaging-api/#webhooks
@Controller('webhooks/line')
export class LineController {
  private readonly logger = new Logger(LineController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly receipts: ReceiptsService,
    private readonly channelLinks: ChannelLinkService,
    private readonly messenger: ChannelMessenger,
    @InjectQueue(RECEIPT_PROCESSING_QUEUE) private readonly queue: Queue<ReceiptProcessingJob>,
  ) {}

  @Post()
  async handleWebhook(@Req() req: any, @Headers('x-line-signature') signature: string) {
    this.verifySignature(req.rawBody, signature);

    const events = req.body?.events ?? [];
    for (const event of events) {
      // Fire-and-forget per event so one bad event doesn't block the rest;
      // LINE just needs a fast 200 regardless.
      this.handleEvent(event).catch((err) =>
        this.logger.error(`Failed handling LINE event: ${err instanceof Error ? err.message : err}`),
      );
    }

    return { ok: true };
  }

  private verifySignature(rawBody: Buffer | undefined, signature: string | undefined) {
    const secret = process.env.LINE_CHANNEL_SECRET;
    if (!rawBody || !signature || !secret) {
      throw new BadRequestException('Missing signature or channel secret');
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
    const ok =
      expected.length === signature.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!ok) {
      throw new BadRequestException('Invalid LINE signature');
    }
  }

  private async handleEvent(event: any) {
    const lineUserId: string | undefined = event.source?.userId;
    if (!lineUserId) return;

    // Someone just added the bot: tell them how to connect, unless they already are.
    if (event.type === 'follow') {
      if (!(await this.channelLinks.isLinked('LINE', lineUserId))) {
        await this.messenger.replyLine(event.replyToken, channelMessages.notLinkedHelp);
      }
      return;
    }

    if (event.type !== 'message') return;

    // A text message is either a link code from the dashboard's "Connect chat"
    // page (which links this LINE user to a workspace) or noise.
    if (event.message?.type === 'text') {
      const reply = await this.channelLinks.handleText('LINE', lineUserId, event.message.text);
      if (reply) await this.messenger.replyLine(event.replyToken, reply);
      return;
    }

    if (event.message?.type !== 'image') return;

    // The workspace must already have this LINE user linked (see ChannelLinkService).
    const workspace = await this.prisma.workspace.findUnique({ where: { lineUserId } });
    if (!workspace) {
      this.logger.warn(`Received image from unlinked LINE user ${lineUserId} — ignoring`);
      await this.messenger.replyLine(event.replyToken, channelMessages.notLinkedHelp);
      return;
    }

    const imageBuffer = await this.downloadContent(event.message.id);
    const imageKey = await this.storage.uploadImage(imageBuffer, 'image/jpeg', workspace.id);

    const receipt = await this.receipts.createPending({
      workspaceId: workspace.id,
      imageKeys: [imageKey],
      source: 'LINE',
      sourceRef: event.message.id,
    });

    await this.queue.add('process', { receiptId: receipt.id, workspaceId: workspace.id });
  }

  private async downloadContent(messageId: string): Promise<Buffer> {
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(`LINE content download failed: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
