import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RECEIPT_PROCESSING_QUEUE } from '../queue/receipt-processing.types';

const PROBE_TIMEOUT_MS = 2000;

/**
 * Liveness + dependency check for deploy smoke tests, the compose healthcheck and uptime
 * monitors: 200 when Postgres and Redis answer, 503 when either doesn't. Public and
 * unauthenticated by design, so it reports only up/down — never error text or hostnames.
 * (It doesn't check MinIO or the Claude API: an outage there shouldn't take the API "down".)
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(RECEIPT_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  @Get()
  async check() {
    const [database, redis] = await Promise.all([
      this.probe('database', async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      }),
      this.probe('redis', async () => {
        // Goes through the same queue the API enqueues to, so it proves that path works
        // (and stays on BullMQ's public API — the raw Redis client isn't exposed in v6).
        await this.queue.getJobCounts('wait');
      }),
    ]);

    const body = {
      status: database && redis ? 'ok' : 'error',
      checks: { database: database ? 'up' : 'down', redis: redis ? 'up' : 'down' },
    };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }

  // A dependency that hangs must fail the probe, not hang the request.
  private async probe(name: string, fn: () => Promise<void>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch (err) {
      this.logger.warn(`Health check "${name}" failed: ${err instanceof Error ? err.message : err}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
