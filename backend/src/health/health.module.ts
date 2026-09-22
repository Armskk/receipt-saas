import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { HealthController } from './health.controller';

@Module({
  imports: [QueueModule], // provides the receipt queue whose Redis connection we ping
  controllers: [HealthController],
})
export class HealthModule {}
