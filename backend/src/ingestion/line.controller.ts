import { BadRequestException, Controller, Headers, Logger, Post, Req } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { RECEIPT_PROCESSING_QUEUE, ReceiptProcessingJob } from '../queue/receipt-processing.types';

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
    if (event.type !== 'message' || event.message?.type !== 'image') return;

    const lineUserId: string | undefined = event.source?.userId;
    if (!lineUserId) return;

    // The workspace must already have this LINE user linked (via a
    // dashboard "connect LINE" flow — not scaffolded yet: it'd be a
    // one-time code shown in the web app that the user sends to the bot,
    // which a handler here looks up and writes to Workspace.lineUserId).
    const workspace = await this.prisma.workspace.findUnique({ where: { lineUserId } });
    if (!workspace) {
      this.logger.warn(`Received image from unlinked LINE user ${lineUserId} — ignoring`);
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
