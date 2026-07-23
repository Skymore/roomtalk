import assert from 'assert/strict';
import { after, before, describe, it } from 'node:test';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import type { TaskDispatchRecord } from '../repositories/store';
import { AssistantRunQueueReconciler } from './assistantRunQueueReconciler';

const redisUrl = process.env.BULLMQ_TEST_REDIS_URL;
const logger = { debug() {}, info() {}, warn() {}, error() {} };

const dispatch = (runId: string): TaskDispatchRecord => ({
  runId,
  status: 'dispatched',
  attempts: 1,
  availableAt: '2026-07-22T00:00:00.000Z',
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  dispatchedAt: '2026-07-22T00:00:01.000Z',
});

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for BullMQ state');
};

describe('BullMQ assistant run integration', { skip: !redisUrl }, () => {
  const queueName = `roomtalk-assistant-run-test-${process.pid}-${Date.now()}`;
  let producerConnection: IORedis;
  let workerConnection: IORedis;
  let queue: Queue;

  before(async () => {
    producerConnection = new IORedis(redisUrl!, { maxRetriesPerRequest: 3 });
    workerConnection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection: producerConnection });
    await queue.waitUntilReady();
  });

  after(async () => {
    await queue?.obliterate({ force: true });
    await queue?.close();
    await Promise.allSettled([
      producerConnection?.quit(),
      workerConnection?.quit(),
    ]);
  });

  it('deduplicates two relay deliveries and executes one retrying job', async () => {
    const runId = `run-${Date.now()}`;
    const first = await queue.add('execute-assistant-run', { schemaVersion: 1, runId }, {
      jobId: runId,
      attempts: 2,
      backoff: { type: 'fixed', delay: 10 },
      removeOnComplete: false,
      removeOnFail: false,
    });
    const duplicate = await queue.add('execute-assistant-run', { schemaVersion: 1, runId }, {
      jobId: runId,
      attempts: 2,
      backoff: { type: 'fixed', delay: 10 },
      removeOnComplete: false,
      removeOnFail: false,
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(await queue.getWaitingCount(), 1);

    let executions = 0;
    let resolveCompleted!: () => void;
    const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
    const worker = new Worker(queueName, async job => {
      executions += 1;
      assert.equal(job.data.runId, runId);
      if (executions === 1) throw new Error('simulated processor failure');
      return 'complete';
    }, { connection: workerConnection, concurrency: 1 });
    worker.on('completed', () => resolveCompleted());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        completed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('BullMQ retry did not complete')), 5_000);
        }),
      ]);
      assert.equal(executions, 2);
      assert.equal((await queue.getJob(runId))?.attemptsMade, 2);
    } finally {
      if (timeout) clearTimeout(timeout);
      await worker.close();
    }
  });

  it('recreates a missing dispatched job from the active PostgreSQL run', async () => {
    const runId = `run-missing-${Date.now()}`;
    const job = await queue.add('execute-assistant-run', { schemaVersion: 1, runId }, {
      jobId: runId,
      removeOnComplete: false,
      removeOnFail: false,
    });
    await job.remove();
    assert.equal(await queue.getJob(runId), undefined);

    const reconciler = new AssistantRunQueueReconciler({
      store: {
        withMaintenanceLock: async (_name, operation) => ({ acquired: true, result: await operation() }),
        readActiveDispatchedTaskDispatches: async () => [dispatch(runId)],
      },
      queue,
      logger: logger as any,
      graceMs: 0,
    });
    const metrics = await reconciler.reconcileOnce();

    assert.equal(metrics.missingRequeued, 1);
    assert.equal(await (await queue.getJob(runId))?.getState(), 'waiting');
  });

  it('retries an exhausted BullMQ job while PostgreSQL still says the run is active', async () => {
    const runId = `run-failed-${Date.now()}`;
    await queue.add('execute-assistant-run', { schemaVersion: 1, runId }, {
      jobId: runId,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
    const worker = new Worker(queueName, async job => {
      if (job.id === runId) throw new Error('temporary database outage');
      return 'ignored';
    }, { connection: workerConnection, concurrency: 1 });
    try {
      await waitFor(async () => (await queue.getJob(runId))?.getState().then(state => state === 'failed') || false);
    } finally {
      await worker.close();
    }

    const reconciler = new AssistantRunQueueReconciler({
      store: {
        withMaintenanceLock: async (_name, operation) => ({ acquired: true, result: await operation() }),
        readActiveDispatchedTaskDispatches: async () => [dispatch(runId)],
      },
      queue,
      logger: logger as any,
      graceMs: 0,
    });
    const metrics = await reconciler.reconcileOnce();

    assert.equal(metrics.failedRetried, 1);
    assert.equal(await (await queue.getJob(runId))?.getState(), 'waiting');
    assert.equal((await queue.getJob(runId))?.attemptsMade, 0);
  });
});
