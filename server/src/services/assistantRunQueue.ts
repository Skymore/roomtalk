import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

export const ASSISTANT_RUN_QUEUE_NAME = 'roomtalk-assistant-runs';
export const ASSISTANT_RUN_JOB_NAME = 'execute-assistant-run';

export interface AssistantRunJobDataV1 {
  schemaVersion: 1;
  runId: string;
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
