export const RECEIPT_PROCESSING_QUEUE = 'receipt-processing';

export interface ReceiptProcessingJob {
  receiptId: string;
  workspaceId: string;
}
