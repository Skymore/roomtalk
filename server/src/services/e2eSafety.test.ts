import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requireSafeE2EDatabaseUrl, requireSafeE2EQueueRedisUrl, requireSafeE2ERedisUrl } from './e2eSafety';

describe('E2E PostgreSQL safety', () => {
  it('accepts only explicitly named test databases in E2E mode', () => {
    const safe = 'postgresql://localhost/roomtalk_e2e_13';
    assert.equal(requireSafeE2EDatabaseUrl({
      E2E_TEST_MODE: 'true',
      DATABASE_URL: safe,
    }), safe);

    assert.throws(
      () => requireSafeE2EDatabaseUrl({ DATABASE_URL: safe }),
      /E2E_TEST_MODE=true/,
    );
    assert.throws(
      () => requireSafeE2EDatabaseUrl({
        E2E_TEST_MODE: 'true',
        DATABASE_URL: 'postgresql://localhost/roomtalk_production',
      }),
      /non-test PostgreSQL database/,
    );
  });
});

describe('E2E Redis safety', () => {
  it('accepts an explicit non-zero local disposable database', () => {
    assert.equal(requireSafeE2ERedisUrl({
      E2E_TEST_MODE: 'true',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
    }), 'redis://127.0.0.1:6379/15');
  });

  it('rejects missing mode, missing database, database zero, and remote hosts', () => {
    assert.throws(
      () => requireSafeE2ERedisUrl({ REDIS_URL: 'redis://127.0.0.1:6379/15' }),
      /E2E_TEST_MODE=true/,
    );
    assert.throws(
      () => requireSafeE2ERedisUrl({ E2E_TEST_MODE: 'true', REDIS_URL: 'redis://127.0.0.1:6379' }),
      /explicit non-zero/,
    );
    assert.throws(
      () => requireSafeE2ERedisUrl({ E2E_TEST_MODE: 'true', REDIS_URL: 'redis://localhost:6379/0' }),
      /explicit non-zero/,
    );
    assert.throws(
      () => requireSafeE2ERedisUrl({ E2E_TEST_MODE: 'true', REDIS_URL: 'redis://cache.internal:6379/15' }),
      /local disposable/,
    );
  });

  it('requires the queue to use the same explicit disposable Redis database', () => {
    const safeEnv = {
      E2E_TEST_MODE: 'true',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      QUEUE_REDIS_URL: 'redis://127.0.0.1:6379/15',
    };
    assert.equal(requireSafeE2EQueueRedisUrl(safeEnv), safeEnv.QUEUE_REDIS_URL);
    assert.throws(
      () => requireSafeE2EQueueRedisUrl({
        ...safeEnv,
        QUEUE_REDIS_URL: 'redis://queue.production.internal:6379/0',
      }),
      /local disposable/,
    );
    assert.throws(
      () => requireSafeE2EQueueRedisUrl({
        ...safeEnv,
        QUEUE_REDIS_URL: 'redis://127.0.0.1:6379/14',
      }),
      /must match REDIS_URL/,
    );
    assert.throws(
      () => requireSafeE2EQueueRedisUrl({
        E2E_TEST_MODE: 'true',
        REDIS_URL: safeEnv.REDIS_URL,
      }),
      /explicit QUEUE_REDIS_URL/,
    );
  });
});
