import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

// Unit-level: prisma and the queue are stubbed. The real wiring (DI, Redis, Postgres) is
// exercised by bringing the stack up — see docs/environments.md.
describe('HealthController', () => {
  let prisma: { $queryRaw: jest.Mock };
  let queue: { getJobCounts: jest.Mock };
  let controller: HealthController;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    queue = { getJobCounts: jest.fn().mockResolvedValue({ wait: 0 }) };
    controller = new HealthController(prisma as any, queue as any);
    jest.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.useRealTimers());

  const failure = async () => {
    try {
      await controller.check();
    } catch (err) {
      return err as ServiceUnavailableException;
    }
    throw new Error('expected the health check to fail');
  };

  it('reports ok when Postgres and Redis answer', async () => {
    expect(await controller.check()).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(queue.getJobCounts).toHaveBeenCalledTimes(1);
  });

  it('answers 503 and names the failing dependency when the database is down', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const err = await failure();
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse()).toEqual({ status: 'error', checks: { database: 'down', redis: 'up' } });
  });

  it('answers 503 when Redis is down', async () => {
    queue.getJobCounts.mockRejectedValue(new Error('Connection is closed.'));
    expect((await failure()).getResponse()).toEqual({ status: 'error', checks: { database: 'up', redis: 'down' } });
  });

  it('does not leak error text or hostnames to the caller', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('password authentication failed for user "receipts_app" at db.internal'));
    const body = JSON.stringify((await failure()).getResponse());
    expect(body).not.toMatch(/password|receipts_app|db\.internal|ECONN/i);
  });

  it('fails the probe instead of hanging when a dependency never answers', async () => {
    jest.useFakeTimers();
    queue.getJobCounts.mockReturnValue(new Promise(() => undefined)); // Redis accepts the command but never replies
    const pending = failure();
    await jest.advanceTimersByTimeAsync(2000);
    expect((await pending).getResponse()).toEqual({ status: 'error', checks: { database: 'up', redis: 'down' } });
  });

  it('reports both down when both are down', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('x'));
    queue.getJobCounts.mockRejectedValue(new Error('y'));
    expect((await failure()).getResponse()).toEqual({ status: 'error', checks: { database: 'down', redis: 'down' } });
  });
});
