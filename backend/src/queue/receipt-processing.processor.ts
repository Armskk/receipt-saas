import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { StorageService } from '../common/storage.service';
import { AgentService } from '../agent/agent.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { RECEIPT_PROCESSING_QUEUE, ReceiptProcessingJob } from './receipt-processing.types';

// This is the piece that actually does the slow work — see README "Why
// things are wired this way". Runs in the `worker` process
// (src/worker.ts), not the API process, so a burst of uploads never makes
// LINE/Telegram webhooks or the web upload endpoint time out.
@Processor(RECEIPT_PROCESSING_QUEUE)
export class ReceiptProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ReceiptProcessingProcessor.name);

  constructor(
    private readonly storage: StorageService,
    private readonly agent: AgentService,
    private readonly receipts: ReceiptsService,
  ) {
    super();
  }

  async process(job: Job<ReceiptProcessingJob>): Promise<void> {
    const { receiptId, workspaceId } = job.data;
    this.logger.log(`Processing receipt ${receiptId} (workspace ${workspaceId})`);

    await this.receipts.markProcessing(receiptId);

    try {
      const receipt = await this.receipts.get(receiptId);
      const images = await Promise.all(
        receipt.imageKeys.map(async (key) => {
          const { base64, contentType } = await this.storage.getImageBase64(key);
          return { base64, mediaType: contentType };
        }),
      );

      const result = await this.agent.extractReceipt(images);
      await this.receipts.applyParsedResult(workspaceId, receiptId, result, images.length);

      this.logger.log(
        `Receipt ${receiptId} parsed from ${images.length} image(s): ${result.parsed.items.length} items`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Receipt ${receiptId} failed: ${message}`);
      await this.receipts.markFailed(receiptId, message);
      throw err; // let BullMQ apply its retry policy
    }
  }
}
