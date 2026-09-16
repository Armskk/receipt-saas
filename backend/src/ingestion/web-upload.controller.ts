import {
  BadRequestException,
  Controller,
  Param,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { StorageService } from '../common/storage.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { RECEIPT_PROCESSING_QUEUE, ReceiptProcessingJob } from '../queue/receipt-processing.types';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB per file
const MAX_FILES = 10; // photos per receipt

@Controller('workspaces/:workspaceId/receipts/upload')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class WebUploadController {
  constructor(
    private readonly storage: StorageService,
    private readonly receipts: ReceiptsService,
    @InjectQueue(RECEIPT_PROCESSING_QUEUE) private readonly queue: Queue<ReceiptProcessingJob>,
  ) {}

  // One upload = one receipt. Send the `files` field once for a single-photo
  // receipt, or several times when one receipt needed multiple photos (long
  // receipt shot in sections, front/back, multi-page bill) — the agent reads
  // them together and produces a single result. Non-image files are reported
  // in `rejected` and don't block the rest.
  @Post()
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES, { limits: { fileSize: MAX_FILE_BYTES } }),
  )
  async upload(
    @Param('workspaceId') workspaceId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: any,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded (expected multipart field "files")');
    }

    const images = files.filter((f) => f.mimetype.startsWith('image/'));
    const rejected = files
      .filter((f) => !f.mimetype.startsWith('image/'))
      .map((f) => ({ filename: f.originalname, reason: 'Only image uploads are supported' }));

    if (images.length === 0) {
      throw new BadRequestException(
        `No valid images. ${rejected.map((r) => `${r.filename}: ${r.reason}`).join('; ')}`,
      );
    }

    const imageKeys = await Promise.all(
      images.map((f) => this.storage.uploadImage(f.buffer, f.mimetype, workspaceId)),
    );

    const receipt = await this.receipts.createPending({
      workspaceId,
      imageKeys,
      source: 'WEB',
      createdByUserId: req.user.userId,
    });

    // Enqueue once and return immediately — the caller polls GET
    // /workspaces/:id/receipts for status, it doesn't wait here.
    await this.queue.add('process', { receiptId: receipt.id, workspaceId });

    return {
      receiptId: receipt.id,
      status: receipt.status,
      imageCount: imageKeys.length,
      rejected,
    };
  }
}
