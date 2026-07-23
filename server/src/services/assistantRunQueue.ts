import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

export const ASSISTANT_RUN_QUEUE_NAME = 'roomtalk-assistant-runs';
export const ASSISTANT_RUN_JOB_NAME = 'execute-assistant-run';

export interface AssistantRunJobDataV1 {
  schemaVersion: 1;
  runId: string;
}

export interface AssistantRunWorkerHeartbeatV1 {
  schemaVersion: 1;
  workerId: string;
  heartbeatAt: string;
}

export interface AssistantRunQueueHealthSnapshot {
  workerAvailable: boolean;
  workerId?: string;
  workerHeartbeatAt?: string;
  workerHeartbeatExpiresInMs?: number;
  waitingCount: number;
  activeCount: number;
  delayedCount: number;
  failedCount: number;
  oldestQueuedAt?: string;
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const resolveQueueRedisUrl = (env: NodeJS.ProcessEnv = process.env): string => (
  env.QUEUE_REDIS_URL || env.REDIS_URL || 'redis://localhost:6379'
);

export const resolveAssistantRunQueueName = (env: NodeJS.ProcessEnv = process.env): string => (
  env.ASSISTANT_RUN_QUEUE_NAME || ASSISTANT_RUN_QUEUE_NAME
);

export const resolveAssistantRunWorkerHeartbeatTtlMs = (
  env: NodeJS.ProcessEnv = process.env,
): number => parsePositiveInt(env.ASSISTANT_RUN_WORKER_HEARTBEAT_TTL_MS, 20_000);

export const resolveAssistantRunWorkerHeartbeatKey = (
  env: NodeJS.ProcessEnv = process.env,
): string => `roomtalk:assistant-run-worker-heartbeat:${resolveAssistantRunQueueName(env)}`;

export const decodeAssistantRunJobData = (value: unknown): AssistantRunJobDataV1 | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.runId !== 'string'
    || candidate.runId.length === 0
    || Object.keys(candidate).some(key => key !== 'schemaVersion' && key !== 'runId')
  ) return null;
  return candidate as unknown as AssistantRunJobDataV1;
};

export const createQueueRedisConnection = (
  redisUrl = resolveQueueRedisUrl(),
  role: 'producer' | 'worker' = 'producer',
): IORedis => new IORedis(redisUrl, {
  // BullMQ workers rely on blocking Redis commands and must not stop retrying
  // the connection underneath an active job. Producers fail in bounded time so
  // PostgreSQL dispatch rows can be released and retried by the relay.
  maxRetriesPerRequest: role === 'worker' ? null : 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

export const assistantRunJobOptions = (
  env: NodeJS.ProcessEnv = process.env,
): JobsOptions => ({
  attempts: parsePositiveInt(env.ASSISTANT_RUN_QUEUE_ATTEMPTS, 12),
  backoff: {
    type: 'exponential',
    delay: parsePositiveInt(env.ASSISTANT_RUN_QUEUE_BACKOFF_MS, 5_000),
  },
  removeOnComplete: {
    age: parsePositiveInt(env.ASSISTANT_RUN_QUEUE_COMPLETE_RETENTION_SECONDS, 24 * 60 * 60),
    count: parsePositiveInt(env.ASSISTANT_RUN_QUEUE_COMPLETE_RETENTION_COUNT, 2_000),
  },
  removeOnFail: {
    age: parsePositiveInt(env.ASSISTANT_RUN_QUEUE_FAILED_RETENTION_SECONDS, 7 * 24 * 60 * 60),
    count: parsePositiveInt(env.ASSISTANT_RUN_QUEUE_FAILED_RETENTION_COUNT, 5_000),
  },
});

export const createAssistantRunQueue = (
  connection = createQueueRedisConnection(resolveQueueRedisUrl(), 'producer'),
  env: NodeJS.ProcessEnv = process.env,
) => new Queue<AssistantRunJobDataV1>(resolveAssistantRunQueueName(env), {
  connection,
  defaultJobOptions: assistantRunJobOptions(env),
});

const decodeAssistantRunWorkerHeartbeat = (value: string | null): AssistantRunWorkerHeartbeatV1 | null => {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    if (
      candidate.schemaVersion !== 1
      || typeof candidate.workerId !== 'string'
      || !candidate.workerId
      || typeof candidate.heartbeatAt !== 'string'
      || !Number.isFinite(Date.parse(candidate.heartbeatAt))
    ) return null;
    return candidate as unknown as AssistantRunWorkerHeartbeatV1;
  } catch {
    return null;
  }
};

export const writeAssistantRunWorkerHeartbeat = async (
  connection: Pick<IORedis, 'set'>,
  workerId: string,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<AssistantRunWorkerHeartbeatV1> => {
  const heartbeat: AssistantRunWorkerHeartbeatV1 = {
    schemaVersion: 1,
    workerId,
    heartbeatAt: now.toISOString(),
  };
  await connection.set(
    resolveAssistantRunWorkerHeartbeatKey(env),
    JSON.stringify(heartbeat),
    'PX',
    resolveAssistantRunWorkerHeartbeatTtlMs(env),
  );
  return heartbeat;
};

export const readAssistantRunQueueHealth = async (
  queue: Queue<AssistantRunJobDataV1>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AssistantRunQueueHealthSnapshot> => {
  const client = await queue.client as unknown as {
    status: string;
    ping(): Promise<unknown>;
    get(key: string): Promise<string | null>;
    pttl(key: string): Promise<number>;
  };
  if (client.status !== 'ready') {
    throw new Error(`Assistant run queue Redis is ${client.status}`);
  }
  await client.ping();
  const heartbeatKey = resolveAssistantRunWorkerHeartbeatKey(env);
  const [rawHeartbeat, heartbeatTtl, counts, waiting, delayed] = await Promise.all([
    client.get(heartbeatKey),
    client.pttl(heartbeatKey),
    queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
    queue.getJobs('waiting', 0, 0, true),
    queue.getJobs('delayed', 0, 0, true),
  ]);
  const heartbeat = decodeAssistantRunWorkerHeartbeat(rawHeartbeat);
  const oldestTimestamp = [...waiting, ...delayed]
    .map(job => job.timestamp)
    .filter(timestamp => Number.isFinite(timestamp) && timestamp > 0)
    .sort((left, right) => left - right)[0];
  return {
    workerAvailable: Boolean(heartbeat && heartbeatTtl > 0),
    ...(heartbeat ? {
      workerId: heartbeat.workerId,
      workerHeartbeatAt: heartbeat.heartbeatAt,
    } : {}),
    ...(heartbeatTtl > 0 ? { workerHeartbeatExpiresInMs: heartbeatTtl } : {}),
    waitingCount: counts.waiting || 0,
    activeCount: counts.active || 0,
    delayedCount: counts.delayed || 0,
    failedCount: counts.failed || 0,
    ...(oldestTimestamp ? { oldestQueuedAt: new Date(oldestTimestamp).toISOString() } : {}),
  };
};
