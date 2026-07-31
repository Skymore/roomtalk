import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import IORedis from 'ioredis';
import { RedisProviderAdmissionController } from './providerAdmission';

const redisUrl = process.env.BULLMQ_TEST_REDIS_URL;
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('provider admission priority queue integration', { skip: !redisUrl }, () => {
  const keyPrefix = `roomtalk:provider-admission-test:${process.pid}:${Date.now()}`;
  let redis: IORedis;

  before(async () => {
    redis = new IORedis(redisUrl!, { maxRetriesPerRequest: 3 });
    await redis.ping();
  });

  after(async () => {
    const keys = await redis.keys(`${keyPrefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('lets a later higher-priority waiter overtake an earlier lower-priority waiter', async () => {
    const controller = new RedisProviderAdmissionController(
      redis,
      { openai: { maxConcurrent: 1 } },
      undefined,
      10_000,
      keyPrefix,
    );
    const active = await controller.acquire('openai', { priority: 100 });
    const acquired: string[] = [];
    const lowPromise = controller.acquire('openai', { priority: 80 }).then(lease => {
      acquired.push('low');
      return lease;
    });
    await delay(50);
    const highPromise = controller.acquire('openai', { priority: 1 }).then(lease => {
      acquired.push('high');
      return lease;
    });
    await delay(50);

    await active.release();
    const highLease = await highPromise;
    assert.deepEqual(acquired, ['high']);
    await highLease.release();

    const lowLease = await lowPromise;
    assert.deepEqual(acquired, ['high', 'low']);
    await lowLease.release();
  });

  it('keeps yielded waiters registered while workers retry without holding a processor slot', async () => {
    const controller = new RedisProviderAdmissionController(
      redis,
      { anthropic: { maxConcurrent: 1 } },
      undefined,
      10_000,
      keyPrefix,
    );
    const active = await controller.acquire('anthropic', { priority: 100 });

    const low = await controller.tryAcquire('anthropic', {
      requestId: 'ordinary-low',
      priority: 80,
    });
    const high = await controller.tryAcquire('anthropic', {
      requestId: 'ordinary-high',
      priority: 1,
    });
    assert.equal(low.lease, undefined);
    assert.equal(high.lease, undefined);

    await active.release();
    const lowRetry = await controller.tryAcquire('anthropic', {
      requestId: 'ordinary-low',
      priority: 80,
    });
    assert.equal(lowRetry.lease, undefined);

    const highRetry = await controller.tryAcquire('anthropic', {
      requestId: 'ordinary-high',
      priority: 1,
    });
    assert.ok(highRetry.lease);
    await highRetry.lease.release();

    const lowFinal = await controller.tryAcquire('anthropic', {
      requestId: 'ordinary-low',
      priority: 80,
    });
    assert.ok(lowFinal.lease);
    await lowFinal.lease.release();
  });
});
