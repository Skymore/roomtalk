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

const PROVIDERS: AIModelProvider[] = ['openai', 'openrouter', 'deepseek', 'anthropic'];
const DEFAULT_CONCURRENCY_LEASE_MS = 120_000;
const MAX_ADMISSION_WAIT_MS = 1_000;

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
  ) {}

  async acquire(provider: AIModelProvider, signal?: AbortSignal): Promise<ProviderAdmissionLease> {
    const limit = this.limits[provider];
    if (!limit) return { release: async () => undefined };

    const requestId = randomUUID();
    const concurrencyKey = `roomtalk:provider-admission:${provider}:concurrency`;
    const rateKey = `roomtalk:provider-admission:${provider}:rate`;
    while (true) {
      if (signal?.aborted) throw signal.reason || new Error('Provider admission was aborted');
      const now = Date.now();
      const [admitted, retryAfterMs] = toNumberTuple(await this.redis.eval(
        ACQUIRE_PROVIDER_ADMISSION_SCRIPT,
        2,
        concurrencyKey,
        rateKey,
        now,
        requestId,
        limit.requestsPerSecond || 0,
        limit.maxConcurrent || 0,
        this.concurrencyLeaseMs,
      ));
      if (admitted === 1) break;
      await wait(Math.min(
        MAX_ADMISSION_WAIT_MS,
        Math.max(10, Number.isFinite(retryAfterMs) ? retryAfterMs : 100),
      ));
    }

    let released = false;
    let renewal: Promise<unknown> | null = null;
    const renew = () => {
      if (released || renewal) return;
      renewal = this.redis.eval(
        RENEW_PROVIDER_ADMISSION_SCRIPT,
        1,
        concurrencyKey,
        requestId,
        Date.now() + this.concurrencyLeaseMs,
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
}

const ACQUIRE_PROVIDER_ADMISSION_SCRIPT = `
local concurrency_key = KEYS[1]
local rate_key = KEYS[2]
local now_ms = tonumber(ARGV[1])
local request_id = ARGV[2]
local requests_per_second = tonumber(ARGV[3])
local max_concurrent = tonumber(ARGV[4])
local lease_ms = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', concurrency_key, '-inf', now_ms)
redis.call('ZREMRANGEBYSCORE', rate_key, '-inf', now_ms - 1000)

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

redis.call('ZADD', rate_key, now_ms, request_id)
redis.call('ZADD', concurrency_key, now_ms + lease_ms, request_id)
redis.call('PEXPIRE', rate_key, 2000)
redis.call('PEXPIRE', concurrency_key, lease_ms * 2)
return {1, 0}
`;

const RENEW_PROVIDER_ADMISSION_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], 'XX', ARGV[2], ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return 1
end
return 0
`;

const RELEASE_PROVIDER_ADMISSION_SCRIPT = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;
