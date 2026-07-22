import http from 'node:http';
import dotenv from 'dotenv';
import { Worker } from 'bullmq';
import { createClient } from 'redis';
import { Logger } from './logger';
import { createPostgresPool } from './repositories/postgresPool';
import { PostgresStore } from './repositories/postgresStore';
import { createAIClients } from './services/aiClients';
import { createMediaObjectStorageFromEnv } from './services/mediaObjectStorage';
import { executeAssistantRun } from './socket/aiHandlers';
import {
  createQueueRedisConnection,
  decodeAssistantRunJobData,
  resolveAssistantRunQueueName,
  resolveQueueRedisUrl,
  type AssistantRunJobDataV1,
} from './services/assistantRunQueue';
import { processAssistantRunJob } from './services/assistantRunBullProcessor';
import { RedisAssistantRunEventPublisher } from './services/assistantRunEvents';
import { resolveRuntimeInstanceId } from './services/runtimeInstance';

dotenv.config();

const logger = new Logger('AIWorker');
const openaiLogger = new Logger('OpenAI');
const postgresLogger = new Logger('PostgreSQL');
const redisLogger = new Logger('Redis');

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('AI worker requires DATABASE_URL');

const realtimeRedisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const queueRedisUrl = resolveQueueRedisUrl();
const runtimeInstanceId = resolveRuntimeInstanceId();
const workerId = `bullmq:${runtimeInstanceId}:${process.pid}`;
const mediaObjectStorage = createMediaObjectStorageFromEnv(new Logger('MediaStorage'));
const postgresPool = createPostgresPool(databaseUrl, postgresLogger);
const store = new PostgresStore(postgresPool, postgresLogger, mediaObjectStorage);
const transientRedis = createClient({ url: realtimeRedisUrl });
const eventPublisher = new RedisAssistantRunEventPublisher(transientRedis);
const queueConnection = createQueueRedisConnection(queueRedisUrl, 'worker');
const { getAIClientForModel } = createAIClients(process.env);

transientRedis.on('error', error => redisLogger.error('AI worker transient Redis error', { error }));
queueConnection.on('error', error => redisLogger.error('AI worker queue Redis error', { error }));

let shuttingDown = false;
let worker: Worker<AssistantRunJobDataV1> | null = null;

const healthPort = parsePositiveInt(process.env.AI_WORKER_HEALTH_PORT, 3013);
const healthServer = http.createServer(async (request, response) => {
  if (request.url !== '/health') {
    response.writeHead(404).end();
    return;
  }
  try {
    await postgresPool.query('SELECT 1 FROM assistant_runs LIMIT 1');
    const ready = !shuttingDown
      && Boolean(worker?.isRunning())
      && queueConnection.status === 'ready'
      && transientRedis.isReady;
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status: ready ? 'ready' : 'degraded',
      worker: worker?.isRunning() ? 'running' : 'stopped',
      queueRedis: queueConnection.status,
      transientRedis: transientRedis.isReady ? 'ready' : 'unavailable',
    }));
  } catch (error) {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'degraded', error: error instanceof Error ? error.message : String(error) }));
  }
});

const start = async () => {
  await Promise.all([
    store.verifySchema(),
    transientRedis.connect(),
  ]);
  worker = new Worker<AssistantRunJobDataV1>(
    resolveAssistantRunQueueName(),
    async job => {
      const data = decodeAssistantRunJobData(job.data);
      if (!data) throw new Error(`Invalid assistant run BullMQ payload for job ${job.id || 'unknown'}`);
      return processAssistantRunJob(data, {
        store,
        logger,
        workerId: `${workerId}:${job.id || data.runId}`,
        leaseMs: parsePositiveInt(process.env.ASSISTANT_RUN_WORKER_LEASE_MS, 60_000),
        maxAttempts: parsePositiveInt(process.env.ASSISTANT_RUN_WORKER_MAX_ATTEMPTS, 10),
        execute: (claim, execution) => executeAssistantRun(claim, {
          store,
          socketLogger: logger,
          openaiLogger,
          getAIClientForModel,
          eventPublisher,
        }, execution),
      });
    },
    {
      connection: queueConnection,
      concurrency: parsePositiveInt(process.env.ASSISTANT_RUN_WORKER_CONCURRENCY, 2),
      lockDuration: parsePositiveInt(process.env.ASSISTANT_RUN_QUEUE_LOCK_MS, 60_000),
      stalledInterval: parsePositiveInt(process.env.ASSISTANT_RUN_QUEUE_STALLED_INTERVAL_MS, 30_000),
      maxStalledCount: parsePositiveInt(process.env.ASSISTANT_RUN_QUEUE_MAX_STALLED_COUNT, 2),
    },
  );
  worker.on('completed', job => logger.info('Assistant run BullMQ job completed', {
    jobId: job.id,
    runId: job.data.runId,
    attemptsMade: job.attemptsMade,
  }));
  worker.on('failed', (job, error) => logger.error('Assistant run BullMQ job failed', {
    error,
    jobId: job?.id,
    runId: job?.data.runId,
    attemptsMade: job?.attemptsMade,
  }));
  worker.on('stalled', jobId => logger.warn('Assistant run BullMQ job stalled', { jobId }));
  worker.on('error', error => logger.error('Assistant run BullMQ worker error', { error }));

  await new Promise<void>((resolve, reject) => {
    healthServer.once('error', reject);
    healthServer.listen(healthPort, '0.0.0.0', () => resolve());
  });
  logger.info('Assistant run BullMQ worker started', {
    workerId,
    queue: resolveAssistantRunQueueName(),
    concurrency: parsePositiveInt(process.env.ASSISTANT_RUN_WORKER_CONCURRENCY, 2),
    healthPort,
  });
};

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Stopping assistant run BullMQ worker', { signal });
  const forceExit = setTimeout(() => process.exit(1), 15_000);
  forceExit.unref();
  healthServer.close();
  // Stop accepting jobs and let the active processor finish while its
  // PostgreSQL/Redis dependencies are still usable. Closing those connections
  // concurrently would turn an otherwise graceful drain into a failed job.
  const [workerClose] = await Promise.allSettled([
    worker?.close(false) || Promise.resolve(),
  ]);
  await Promise.allSettled([
    transientRedis.quit(),
    queueConnection.quit(),
    postgresPool.end?.() || Promise.resolve(),
  ]);
  if (workerClose.status === 'rejected') {
    logger.error('Assistant run BullMQ worker did not drain cleanly', { error: workerClose.reason });
  }
  clearTimeout(forceExit);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start().catch(error => {
  logger.error('Assistant run BullMQ worker failed to start', { error });
  process.exit(1);
});
