import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger';
import type { AIModelProvider } from '../types';

export interface ProviderAdmissionLimit {
  requestsPerSecond?: number;
  maxConcurrent?: number;
}

export type ProviderAdmissionLimits = Partial<Record<AIModelProvider, ProviderAdmissionLimit>>;

interface RedisAdmissionClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface ProviderAdmissionLease {
  release(): Promise<void>;
}

export interface ProviderAdmissionAcquireOptions {
  priority?: number;
  signal?: AbortSignal;
}

export interface ProviderAdmissionTryOptions {
  priority?: number;
  requestId: string;
}

export interface ProviderAdmissionAttempt {
  lease?: ProviderAdmissionLease;
  retryAfterMs: number;
}

const PROVIDERS: AIModelProvider[] = ['openai', 'openrouter', 'deepseek', 'anthropic'];
const DEFAULT_CONCURRENCY_LEASE_MS = 120_000;
const DEFAULT_WAITER_LEASE_MS = 120_000;
const MAX_ADMISSION_WAIT_MS = 100;
const MAX_QUEUE_PRIORITY = 2_097_152;

const parsePositiveNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
);

const parsePositiveInteger = (value: unknown): number | undefined => {
  const parsed = parsePositiveNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
};

export const resolveProviderAdmissionLimits = (
  env: NodeJS.ProcessEnv = process.env,
): ProviderAdmissionLimits => {
  const raw = env.ASSISTANT_PROVIDER_LIMITS_JSON?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ASSISTANT_PROVIDER_LIMITS_JSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ASSISTANT_PROVIDER_LIMITS_JSON must be a provider object');
  }

  const result: ProviderAdmissionLimits = {};
  for (const provider of PROVIDERS) {
    const candidate = (parsed as Record<string, unknown>)[provider];
    if (candidate === undefined) continue;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`Provider limit for ${provider} must be an object`);
    }
    const candidateRecord = candidate as Record<string, unknown>;
    const requestsPerSecond = parsePositiveInteger(candidateRecord.requestsPerSecond);
    const maxConcurrent = parsePositiveInteger(candidateRecord.maxConcurrent);
    if (candidateRecord.requestsPerSecond !== undefined && requestsPerSecond === undefined) {
      throw new Error(`requestsPerSecond for ${provider} must be a positive integer`);
    }
    if (candidateRecord.maxConcurrent !== undefined && maxConcurrent === undefined) {
      throw new Error(`maxConcurrent for ${provider} must be a positive integer`);
    }
    if (requestsPerSecond === undefined && maxConcurrent === undefined) {
      throw new Error(`Provider limit for ${provider} needs requestsPerSecond or maxConcurrent`);
    }
    result[provider] = {
      ...(requestsPerSecond !== undefined ? { requestsPerSecond } : {}),
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    };
  }
  const unknownProviders = Object.keys(parsed as Record<string, unknown>)
    .filter(provider => !PROVIDERS.includes(provider as AIModelProvider));
  if (unknownProviders.length > 0) {
    throw new Error(`Unknown providers in ASSISTANT_PROVIDER_LIMITS_JSON: ${unknownProviders.join(', ')}`);
  }
  return result;
};

const wait = (milliseconds: number) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

const toNumberTuple = (value: unknown): [number, number] => {
  if (!Array.isArray(value)) throw new Error('Provider admission returned an invalid response');
  return [Number(value[0]), Number(value[1])];
};

export class RedisProviderAdmissionController {
  constructor(
    private readonly redis: RedisAdmissionClient,
    private readonly limits: ProviderAdmissionLimits,
    private readonly logger?: Logger,
    private readonly concurrencyLeaseMs = DEFAULT_CONCURRENCY_LEASE_MS,
    private readonly keyPrefix = 'roomtalk:provider-admission',
  ) {}

  private providerKeys(provider: AIModelProvider) {
    const providerPrefix = `${this.keyPrefix}:${provider}`;
    return {
      concurrency: `${providerPrefix}:concurrency`,
      rate: `${providerPrefix}:rate`,
      waitQueue: `${providerPrefix}:wait`,
      waitExpiry: `${providerPrefix}:wait-expiry`,
      waitSequence: `${providerPrefix}:wait-sequence`,
    };
  }

  private normalizePriority(priority?: number) {
    return Math.min(
      MAX_QUEUE_PRIORITY,
      Math.max(1, Math.floor(priority || 100)),
    );
  }

  private createLease(
    provider: AIModelProvider,
    concurrencyKey: string,
    requestId: string,
  ): ProviderAdmissionLease {
    let released = false;
    let renewal: Promise<unknown> | null = null;
    const renew = () => {
      if (released || renewal) return;
      renewal = this.redis.eval(
        RENEW_PROVIDER_ADMISSION_SCRIPT,
        1,
        concurrencyKey,
        requestId,
        this.concurrencyLeaseMs,
      ).catch(error => {
        this.logger?.error('Failed to renew provider concurrency admission', {
          error,
          provider,
          requestId,
        });
      }).finally(() => {
        renewal = null;
      });
    };
    const renewalTimer = setInterval(renew, Math.max(1_000, Math.floor(this.concurrencyLeaseMs / 3)));
    renewalTimer.unref?.();

    return {
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(renewalTimer);
        if (renewal) await renewal;
        await this.redis.eval(
          RELEASE_PROVIDER_ADMISSION_SCRIPT,
          1,
          concurrencyKey,
          requestId,
        );
      },
    };
  }

  async acquire(
    provider: AIModelProvider,
    options: ProviderAdmissionAcquireOptions = {},
  ): Promise<ProviderAdmissionLease> {
    const limit = this.limits[provider];
    if (!limit) return { release: async () => undefined };

    const requestId = randomUUID();
    const keys = this.providerKeys(provider);
    const priority = this.normalizePriority(options.priority);
    let admitted = false;
    try {
      while (true) {
        if (options.signal?.aborted) {
          throw options.signal.reason || new Error('Provider admission was aborted');
        }
        const [admissionResult, retryAfterMs] = toNumberTuple(await this.redis.eval(
          ACQUIRE_PROVIDER_ADMISSION_SCRIPT,
          5,
          keys.concurrency,
          keys.rate,
          keys.waitQueue,
          keys.waitExpiry,
          keys.waitSequence,
          requestId,
          limit.requestsPerSecond || 0,
          limit.maxConcurrent || 0,
          this.concurrencyLeaseMs,
          DEFAULT_WAITER_LEASE_MS,
          priority,
        ));
        if (admissionResult === 1) {
          admitted = true;
          break;
        }
        await wait(Math.min(
          MAX_ADMISSION_WAIT_MS,
          Math.max(10, Number.isFinite(retryAfterMs) ? retryAfterMs : 100),
        ));
      }
    } finally {
      if (!admitted) {
        await this.redis.eval(
          CANCEL_PROVIDER_ADMISSION_SCRIPT,
          3,
          keys.waitQueue,
          keys.waitExpiry,
          keys.waitSequence,
          requestId,
        ).catch(error => {
          this.logger?.error('Failed to cancel provider admission waiter', {
            error,
            provider,
            requestId,
          });
        });
      }
    }
    if (options.signal?.aborted) {
      await this.redis.eval(
        RELEASE_PROVIDER_ADMISSION_SCRIPT,
        1,
        keys.concurrency,
        requestId,
      );
      throw options.signal.reason || new Error('Provider admission was aborted');
    }

    return this.createLease(provider, keys.concurrency, requestId);
  }

  async tryAcquire(
    provider: AIModelProvider,
    options: ProviderAdmissionTryOptions,
  ): Promise<ProviderAdmissionAttempt> {
    const limit = this.limits[provider];
    if (!limit) {
      return {
        lease: { release: async () => undefined },
        retryAfterMs: 0,
      };
    }
    const requestId = options.requestId.trim();
    if (!requestId) throw new Error('Provider admission requestId is required');

    const keys = this.providerKeys(provider);
    const [admissionResult, retryAfterMs] = toNumberTuple(await this.redis.eval(
      ACQUIRE_PROVIDER_ADMISSION_SCRIPT,
      5,
      keys.concurrency,
      keys.rate,
      keys.waitQueue,
      keys.waitExpiry,
      keys.waitSequence,
      requestId,
      limit.requestsPerSecond || 0,
      limit.maxConcurrent || 0,
      this.concurrencyLeaseMs,
      DEFAULT_WAITER_LEASE_MS,
      this.normalizePriority(options.priority),
    ));
    if (admissionResult !== 1) {
      return {
        retryAfterMs: Math.min(
          this.concurrencyLeaseMs,
          Math.max(10, Number.isFinite(retryAfterMs) ? retryAfterMs : 100),
        ),
      };
    }
    return {
      lease: this.createLease(provider, keys.concurrency, requestId),
      retryAfterMs: 0,
    };
  }

  async cancel(provider: AIModelProvider, requestId: string): Promise<void> {
    if (!this.limits[provider]) return;
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) return;
    const keys = this.providerKeys(provider);
    await this.redis.eval(
      CANCEL_PROVIDER_ADMISSION_SCRIPT,
      3,
      keys.waitQueue,
      keys.waitExpiry,
      keys.waitSequence,
      normalizedRequestId,
    );
  }
}

const ACQUIRE_PROVIDER_ADMISSION_SCRIPT = `
local concurrency_key = KEYS[1]
local rate_key = KEYS[2]
local wait_queue_key = KEYS[3]
local wait_expiry_key = KEYS[4]
local wait_sequence_key = KEYS[5]
local request_id = ARGV[1]
local requests_per_second = tonumber(ARGV[2])
local max_concurrent = tonumber(ARGV[3])
local lease_ms = tonumber(ARGV[4])
local waiter_lease_ms = tonumber(ARGV[5])
local priority = tonumber(ARGV[6])
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', concurrency_key, '-inf', now_ms)
redis.call('ZREMRANGEBYSCORE', rate_key, '-inf', now_ms - 1000)

local expired_waiters = redis.call('ZRANGEBYSCORE', wait_expiry_key, '-inf', now_ms, 'LIMIT', 0, 100)
for _, expired_waiter in ipairs(expired_waiters) do
  redis.call('ZREM', wait_queue_key, expired_waiter)
  redis.call('ZREM', wait_expiry_key, expired_waiter)
end

if not redis.call('ZSCORE', wait_queue_key, request_id) then
  if redis.call('ZCARD', wait_queue_key) == 0 then
    redis.call('DEL', wait_sequence_key)
  end
  local sequence = redis.call('INCR', wait_sequence_key)
  local score = (priority * 1000000000) + sequence
  redis.call('ZADD', wait_queue_key, score, request_id)
end
redis.call('ZADD', wait_expiry_key, now_ms + waiter_lease_ms, request_id)
redis.call('PEXPIRE', wait_queue_key, waiter_lease_ms * 2)
redis.call('PEXPIRE', wait_expiry_key, waiter_lease_ms * 2)
redis.call('PEXPIRE', wait_sequence_key, waiter_lease_ms * 2)

local next_waiter = redis.call('ZRANGE', wait_queue_key, 0, 0)
if not next_waiter[1] or next_waiter[1] ~= request_id then
  return {0, 25}
end

if max_concurrent > 0 and redis.call('ZCARD', concurrency_key) >= max_concurrent then
  local earliest = redis.call('ZRANGE', concurrency_key, 0, 0, 'WITHSCORES')
  local retry_after = 100
  if earliest[2] then retry_after = math.max(10, tonumber(earliest[2]) - now_ms) end
  return {0, retry_after}
end

if requests_per_second > 0 and redis.call('ZCARD', rate_key) >= math.floor(requests_per_second) then
  local earliest = redis.call('ZRANGE', rate_key, 0, 0, 'WITHSCORES')
  local retry_after = 100
  if earliest[2] then retry_after = math.max(10, tonumber(earliest[2]) + 1000 - now_ms) end
  return {0, retry_after}
end

redis.call('ZREM', wait_queue_key, request_id)
redis.call('ZREM', wait_expiry_key, request_id)
if redis.call('ZCARD', wait_queue_key) == 0 then
  redis.call('DEL', wait_sequence_key)
end
redis.call('ZADD', rate_key, now_ms, request_id)
redis.call('ZADD', concurrency_key, now_ms + lease_ms, request_id)
redis.call('PEXPIRE', rate_key, 2000)
redis.call('PEXPIRE', concurrency_key, lease_ms * 2)
return {1, 0}
`;

const RENEW_PROVIDER_ADMISSION_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  local redis_time = redis.call('TIME')
  local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
  redis.call('ZADD', KEYS[1], 'XX', now_ms + tonumber(ARGV[2]), ARGV[1])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
  return 1
end
return 0
`;

const RELEASE_PROVIDER_ADMISSION_SCRIPT = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

const CANCEL_PROVIDER_ADMISSION_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[3])
end
return 1
`;
