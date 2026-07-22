import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { assistantRunJobOptions, decodeAssistantRunJobData, resolveQueueRedisUrl } from './assistantRunQueue';

describe('assistant run BullMQ contract', () => {
  it('keeps the job payload to one versioned PostgreSQL run reference', () => {
    assert.deepEqual(decodeAssistantRunJobData({ schemaVersion: 1, runId: 'run-1' }), {
      schemaVersion: 1,
      runId: 'run-1',
    });
    assert.equal(decodeAssistantRunJobData({ schemaVersion: 1, runId: 'run-1', prompt: 'secret' }), null);
    assert.equal(decodeAssistantRunJobData({ schemaVersion: 2, runId: 'run-1' }), null);
  });

  it('supports a future queue Redis split while defaulting to the realtime endpoint', () => {
    assert.equal(resolveQueueRedisUrl({ REDIS_URL: 'redis://realtime:6379' }), 'redis://realtime:6379');
    assert.equal(resolveQueueRedisUrl({
      REDIS_URL: 'redis://realtime:6379',
      QUEUE_REDIS_URL: 'redis://queue:6379',
    }), 'redis://queue:6379');
    assert.ok(Number(assistantRunJobOptions().attempts) > 10);
  });
});
