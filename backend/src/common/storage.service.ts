import { Injectable, OnModuleInit } from '@nestjs/common';
import { Client } from 'minio';
import { randomUUID } from 'crypto';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: Client;
  private readonly bucket: string;

  constructor() {
    this.client = new Client({
      endPoint: process.env.S3_ENDPOINT ?? 'localhost',
      port: Number(process.env.S3_PORT ?? 9000),
      useSSL: process.env.S3_USE_SSL === 'true',
      accessKey: process.env.S3_ACCESS_KEY,
      secretKey: process.env.S3_SECRET_KEY,
    });
    this.bucket = process.env.S3_BUCKET ?? 'receipt-images';
  }

  async onModuleInit() {
    const exists = await this.client.bucketExists(this.bucket).catch(() => false);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
    }
  }

  async uploadImage(buffer: Buffer, contentType: string, workspaceId: string): Promise<string> {
    const key = `${workspaceId}/${randomUUID()}`;
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': contentType,
    });
    return key;
  }

  async getImageBase64(key: string): Promise<{ base64: string; contentType: string }> {
    const stat = await this.client.statObject(this.bucket, key);
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return {
      base64: Buffer.concat(chunks).toString('base64'),
      contentType: stat.metaData['content-type'] ?? 'image/jpeg',
    };
  }
}
