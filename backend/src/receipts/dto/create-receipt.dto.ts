import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ReceiptSource } from '@prisma/client';

export class CreateReceiptDto {
  @IsEnum(ReceiptSource)
  source!: ReceiptSource;

  @IsOptional()
  @IsString()
  sourceRef?: string;
}
