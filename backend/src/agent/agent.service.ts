import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ParsedReceiptDto } from './dto/parsed-receipt.dto';

export interface AgentExtractionResult {
  parsed: ParsedReceiptDto;
  inputTokens: number;
  outputTokens: number;
}

// Forces Claude's response into exactly this shape via tool use, instead of
// hoping a "please respond in JSON" instruction is followed. See
// https://platform.claude.com/docs — tool_choice with a single tool is the
// standard pattern for structured extraction.
const RECORD_RECEIPT_TOOL: Anthropic.Tool = {
  name: 'record_receipt',
  description:
    'Record the structured data extracted from a photographed receipt/bill.',
  input_schema: {
    type: 'object',
    properties: {
      merchantName: { type: 'string', description: 'Store/vendor name, if legible' },
      purchaseDate: {
        type: 'string',
        description: 'ISO 8601 date (YYYY-MM-DD) if printed on the receipt; omit if not visible',
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            suggestedCategory: {
              type: 'string',
              description:
                'Best-guess spending category for this line item, e.g. "Food", "Household", "Transport"',
            },
            quantity: { type: 'number' },
            unitPrice: { type: 'number' },
            amount: { type: 'number', description: 'Line total for this item, in the receipt currency' },
          },
          required: ['description', 'amount'],
        },
      },
      discountTotal: {
        type: 'number',
        description:
          'The amount subtracted from the sum of item amounts to reach the final total, as a ' +
          'positive number — i.e. sum(items[].amount) - discountTotal must equal total. Only ' +
          'set this for a discount/coupon/promo applied on top of the item prices shown (e.g. a ' +
          'separate "Discount"/"ส่วนลด" line, or a bill-level percentage off). If an item\'s price ' +
          'already reflects a markdown (a struck-through original price next to a lower sale ' +
          'price, or a "was/now" pair) and you used the lower sale price as that item\'s amount, ' +
          'do NOT also report that markdown here — it is already baked into the item price and ' +
          'reporting it again would double it. Omit this field entirely when there is no discount.',
      },
      total: { type: 'number', description: 'Final amount actually paid' },
      notes: {
        type: 'string',
        description: 'Anything ambiguous worth a human double-checking (blurry text, guessed values, etc.)',
      },
    },
    required: ['items', 'total'],
  },
};

const EXTRACTION_PROMPT = `You are extracting structured expense data from photos of a receipt or bill. \
You may be given more than one image: these are multiple photos of the SAME receipt (different \
sections of a long receipt, front and back, or the pages of a multi-page bill). Combine them into \
a single result — do not double-count line items that appear in the overlap between two photos. \
The receipt may be in Thai, English, or a mix of both. Read every line item carefully, including \
per-item prices, quantities, discounts, and the final total paid. sum(items[].amount) minus \
discountTotal must equal total — if an item's own price already reflects a markdown (a struck-\
through original price shown next to a lower sale price), use the lower sale price as that \
item's amount and do not also put that same markdown into discountTotal, or it will be counted \
twice. discountTotal is only for a discount applied on top of the item prices you extracted. If \
the photos clearly show \
different, unrelated receipts, extract only the first one and say so in "notes". If text is \
unclear, make your best reading and note the uncertainty in "notes" rather than guessing silently. \
Call record_receipt once with the combined result.`;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly client: Anthropic;
  private readonly model: string;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
  }

  /**
   * @param images one or more photos of a single receipt. Each entry is raw
   *               base64 (no `data:` prefix) plus its media type
   *               (e.g. "image/jpeg"). All are sent to Claude in one call.
   */
  async extractReceipt(
    images: Array<{ base64: string; mediaType: string }>,
  ): Promise<AgentExtractionResult> {
    if (images.length === 0) {
      throw new BadGatewayException('No images to extract from');
    }

    const response = await this.client.messages.create({
      model: this.model,
      // A real supermarket receipt can run 30+ line items; the structured
      // tool_use JSON for that is well over 2k tokens. Too low a cap here
      // truncates the JSON mid-object and validation then rejects it.
      max_tokens: 8192,
      tools: [RECORD_RECEIPT_TOOL],
      tool_choice: { type: 'tool', name: 'record_receipt' },
      messages: [
        {
          role: 'user',
          content: [
            ...images.map((img) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: img.mediaType as any,
                data: img.base64,
              },
            })),
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (!toolUse) {
      throw new BadGatewayException('Agent did not return structured receipt data');
    }

    // If generation stopped at the token cap, the tool_use JSON is truncated
    // and any downstream error would be misleading — surface the real cause.
    if (response.stop_reason === 'max_tokens') {
      throw new BadGatewayException(
        'Receipt has more detail than one pass can capture (hit the token limit) — try a clearer photo or split a very long receipt',
      );
    }

    // Tool input is normally a parsed object; guard against a stringified one.
    const rawInput: unknown =
      typeof toolUse.input === 'string' ? JSON.parse(toolUse.input) : toolUse.input;

    const parsed = plainToInstance(ParsedReceiptDto, rawInput);
    const errors = await validate(parsed);
    if (errors.length > 0) {
      this.logger.warn(
        `Agent output failed validation: ${JSON.stringify(errors)} — raw: ${JSON.stringify(rawInput)}`,
      );
      throw new BadGatewayException('Agent output did not match the expected receipt shape');
    }

    // Not enforced (the schema/prompt guidance can still be misread), just
    // logged: sum(items) - discountTotal should equal total. A mismatch
    // beyond rounding means discountTotal was double-counted or missed
    // relative to the item amounts — worth a human glancing at the receipt.
    const itemsSum = parsed.items.reduce((sum, item) => sum + item.amount, 0);
    const reconciled = itemsSum - (parsed.discountTotal ?? 0);
    if (Math.abs(reconciled - parsed.total) > 0.01) {
      this.logger.warn(
        `Agent output has an inconsistent discountTotal: items sum ${itemsSum} - discountTotal ` +
          `${parsed.discountTotal ?? 0} = ${reconciled}, but total is ${parsed.total}`,
      );
    }

    return {
      parsed,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
