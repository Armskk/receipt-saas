import {
  BadRequestException,
  Controller,
  Headers,
  Logger,
  Post,
  Body,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { RECEIPT_PROCESSING_QUEUE, ReceiptProcessingJob } from '../queue/receipt-processing.types';

// Telegram Bot API webhook. After creating the bot via @BotFather, register
// this URL with:
//   curl "https://api.telegram.org/bot<token>/setWebhook" \
//     -d "url=https://api.yourdomain.com/webhooks/telegram" \
//     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
@Controller('webhooks/telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly receipts: ReceiptsService,
    @InjectQueue(RECEIPT_PROCESSING_QUEUE) private readonly queue: Queue<ReceiptProcessingJob>,
  ) {}

  @Post()
  async handleWebhook(
    @Body() update: any,
    @Headers('x-telegram-bot-api-secret-token') secretToken: string,
  ) {
    if (secretToken !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      throw new BadRequestException('Invalid webhook secret');
    }

    this.handleUpdate(update).catch((err) =>
      this.logger.error(`Failed handling Telegram update: ${err instanceof Error ? err.message : err}`),
    );

    return { ok: true };
  }

  private async handleUpdate(update: any) {
    const message = update.message;
    const photos = message?.photo; // array of PhotoSize, smallest -> largest
    if (!photos || photos.length === 0) return;

    const chatId: string | undefined = message.chat?.id?.toString();
    if (!chatId) return;

    // Same caveat as the LINE controller: linking a Telegram chat to a
    // workspace needs a dashboard flow that isn't scaffolded yet.
    const workspace = await this.prisma.workspace.findUnique({
      where: { telegramChatId: chatId },
    });
    if (!workspace) {
      this.logger.warn(`Received photo from unlinked Telegram chat ${chatId} — ignoring`);
      return;
    }

    const largest = photos[photos.length - 1];
    const imageBuffer = await this.downloadFile(largest.file_id);
    const imageKey = await this.storage.uploadImage(imageBuffer, 'image/jpeg', workspace.id);

    const receipt = await this.receipts.createPending({
      workspaceId: workspace.id,
      imageKeys: [imageKey],
      source: 'TELEGRAM',
      sourceRef: message.message_id?.toString(),
    });

    await this.queue.add('process', { receiptId: receipt.id, workspaceId: workspace.id });
  }

  private async downloadFile(fileId: string): Promise<Buffer> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoRes.json();
    if (!fileInfo.ok) {
      throw new Error(`Telegram getFile failed: ${JSON.stringify(fileInfo)}`);
    }
    const filePath = fileInfo.result.file_path;
    const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!fileRes.ok) {
      throw new Error(`Telegram file download failed: ${fileRes.status}`);
    }
    return Buffer.from(await fileRes.arrayBuffer());
  }
}
