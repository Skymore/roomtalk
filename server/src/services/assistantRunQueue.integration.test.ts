import assert from 'assert/strict';
import { after, before, describe, it } from 'node:test';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const redisUrl = process.env.BULLMQ_TEST_REDIS_URL;

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
      if (executions === 1) throw new Error('simulated worker crash');
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
});
