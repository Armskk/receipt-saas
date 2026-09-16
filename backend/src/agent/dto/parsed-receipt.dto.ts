import { Type } from 'class-transformer';
import {
  IsArray,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

// This is the shape we force Claude's response into (via the tool-use
// schema in agent.service.ts) and then validate here before anything is
// written to the database. If Claude's response doesn't match this shape,
// class-validator rejects it in ingestion — see queue/receipt-processing.processor.ts.

export class ParsedReceiptItemDto {
  @IsString()
  description!: string;

  @IsOptional()
  @IsString()
  suggestedCategory?: string;

  @IsOptional()
  @IsNumber()
  quantity?: number;

  @IsOptional()
  @IsNumber()
  unitPrice?: number;

  @IsNumber()
  amount!: number;
}

export class ParsedReceiptDto {
  @IsOptional()
  @IsString()
  merchantName?: string;

  @IsOptional()
  @IsISO8601()
  purchaseDate?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParsedReceiptItemDto)
  items!: ParsedReceiptItemDto[];

  @IsOptional()
  @IsNumber()
  discountTotal?: number;

  @IsNumber()
  total!: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
