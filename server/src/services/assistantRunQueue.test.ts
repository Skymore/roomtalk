import assert from 'assert/strict';
import { describe, it } from 'node:test';
import {
  assistantRunJobOptions,
  decodeAssistantRunJobData,
  readAssistantRunQueueHealth,
  resolveAssistantRunWorkerHeartbeatKey,
  resolveQueueRedisUrl,
  writeAssistantRunWorkerHeartbeat,
} from './assistantRunQueue';

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

describe('assistant run queue health', () => {
  it('reports a live Worker heartbeat together with bounded queue metrics', async () => {
    const heartbeatAt = '2026-07-22T12:00:00.000Z';
    const client = {
      status: 'ready',
      ping: async () => 'PONG',
      get: async () => JSON.stringify({
        schemaVersion: 1,
        workerId: 'worker-1',
        heartbeatAt,
      }),
      pttl: async () => 12_000,
    };
    const queue = {
      client: Promise.resolve(client),
      getJobCounts: async () => ({ waiting: 3, active: 2, delayed: 1, failed: 4 }),
      getJobs: async (state: string) => state === 'waiting'
        ? [{ timestamp: Date.parse('2026-07-22T11:59:00.000Z') }]
        : [{ timestamp: Date.parse('2026-07-22T11:59:30.000Z') }],
    };

    assert.deepEqual(await readAssistantRunQueueHealth(queue as any), {
      workerAvailable: true,
      workerId: 'worker-1',
      workerHeartbeatAt: heartbeatAt,
      workerHeartbeatExpiresInMs: 12_000,
      waitingCount: 3,
      activeCount: 2,
      delayedCount: 1,
      failedCount: 4,
      oldestQueuedAt: '2026-07-22T11:59:00.000Z',
    });
  });

  it('does not treat a malformed or expired heartbeat as a live Worker', async () => {
    const queue = {
      client: Promise.resolve({
        status: 'ready',
        ping: async () => 'PONG',
        get: async () => '{bad-json',
        pttl: async () => -2,
      }),
      getJobCounts: async () => ({}),
      getJobs: async () => [],
    };

    assert.deepEqual(await readAssistantRunQueueHealth(queue as any), {
      workerAvailable: false,
      waitingCount: 0,
      activeCount: 0,
      delayedCount: 0,
      failedCount: 0,
    });
  });

  it('writes a namespaced heartbeat with a finite TTL', async () => {
    const calls: unknown[][] = [];
    const env = {
      ASSISTANT_RUN_QUEUE_NAME: 'queue-test',
      ASSISTANT_RUN_WORKER_HEARTBEAT_TTL_MS: '15000',
    } as NodeJS.ProcessEnv;
    const heartbeat = await writeAssistantRunWorkerHeartbeat(
      { set: async (...args: unknown[]) => { calls.push(args); return 'OK'; } } as any,
      'worker-1',
      env,
      new Date('2026-07-22T12:00:00.000Z'),
    );

    assert.equal(calls[0][0], resolveAssistantRunWorkerHeartbeatKey(env));
    assert.equal(calls[0][2], 'PX');
    assert.equal(calls[0][3], 15_000);
    assert.deepEqual(JSON.parse(calls[0][1] as string), heartbeat);
  });
});
