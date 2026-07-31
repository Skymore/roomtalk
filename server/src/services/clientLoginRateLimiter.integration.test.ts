import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createClient, RedisClientType } from 'redis';
import { RedisClientLoginRateLimiter } from './clientLoginRateLimiter';

const redisUrl = process.env.BULLMQ_TEST_REDIS_URL;

describe('client login rate limiter integration', { skip: !redisUrl }, () => {
  const keyPrefix = `roomtalk:client-login-rate-test:${process.pid}:${Date.now()}`;
  let redis: RedisClientType;

  before(async () => {
    redis = createClient({ url: redisUrl });
    await redis.connect();
  });

  after(async () => {
    const keys = await redis.keys(`${keyPrefix}:*`);
    if (keys.length > 0) await redis.del(keys);
    await redis.quit();
  });

  it('limits client/IP pairs, resets a verified client, and preserves IP-wide pressure', async () => {
    const limiter = new RedisClientLoginRateLimiter(redis, {
      windowSeconds: 60,
      maxAttemptsPerClientIp: 2,
      maxAttemptsPerClient: 3,
      maxAttemptsPerIp: 4,
    }, keyPrefix);

    assert.equal((await limiter.consume('client-a', '203.0.113.1')).allowed, true);
    assert.equal((await limiter.consume('client-a', '203.0.113.1')).allowed, true);
    const pairLimited = await limiter.consume('client-a', '203.0.113.1');
    assert.equal(pairLimited.allowed, false);
    assert.ok(pairLimited.retryAfterSeconds > 0);

    await limiter.resetClient('client-a', '203.0.113.1');
    assert.equal((await limiter.consume('client-a', '203.0.113.1')).allowed, true);

    // The fifth total attempt from this IP remains blocked even though the
    // verified client's pair/account counters were reset.
    assert.equal((await limiter.consume('client-b', '203.0.113.1')).allowed, false);
  });
});
