import crypto from 'node:crypto';
import { RedisClientType } from 'redis';

export interface ClientLoginRateLimitConfig {
  windowSeconds: number;
  maxAttemptsPerClientIp: number;
  maxAttemptsPerClient: number;
  maxAttemptsPerIp: number;
}

export interface ClientLoginRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface ClientLoginRateLimiter {
  consume(clientId: string, ipAddress: string): Promise<ClientLoginRateLimitResult>;
  resetClient(clientId: string, ipAddress: string): Promise<void>;
}

const DEFAULT_CONFIG: ClientLoginRateLimitConfig = {
  windowSeconds: 15 * 60,
  maxAttemptsPerClientIp: 10,
  maxAttemptsPerClient: 30,
  maxAttemptsPerIp: 100,
};

const parsePositiveInteger = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  maximum: number,
): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
};

export const resolveClientLoginRateLimitConfig = (
  env: Record<string, string | undefined> = process.env,
): ClientLoginRateLimitConfig => ({
  windowSeconds: parsePositiveInteger(
    env,
    'CLIENT_AUTH_LOGIN_WINDOW_SECONDS',
    DEFAULT_CONFIG.windowSeconds,
    24 * 60 * 60,
  ),
  maxAttemptsPerClientIp: parsePositiveInteger(
    env,
    'CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_CLIENT_IP',
    DEFAULT_CONFIG.maxAttemptsPerClientIp,
    100_000,
  ),
  maxAttemptsPerClient: parsePositiveInteger(
    env,
    'CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_CLIENT',
    DEFAULT_CONFIG.maxAttemptsPerClient,
    100_000,
  ),
  maxAttemptsPerIp: parsePositiveInteger(
    env,
    'CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_IP',
    DEFAULT_CONFIG.maxAttemptsPerIp,
    100_000,
  ),
});

const CONSUME_LOGIN_ATTEMPT_SCRIPT = `
local window_ms = tonumber(ARGV[1])
local pair_count = redis.call('INCR', KEYS[1])
if pair_count == 1 then redis.call('PEXPIRE', KEYS[1], window_ms) end
local client_count = redis.call('INCR', KEYS[2])
if client_count == 1 then redis.call('PEXPIRE', KEYS[2], window_ms) end
local ip_count = redis.call('INCR', KEYS[3])
if ip_count == 1 then redis.call('PEXPIRE', KEYS[3], window_ms) end

local allowed = pair_count <= tonumber(ARGV[2])
  and client_count <= tonumber(ARGV[3])
  and ip_count <= tonumber(ARGV[4])
local retry_ms = 0
if not allowed then
  if pair_count > tonumber(ARGV[2]) then
    retry_ms = math.max(retry_ms, redis.call('PTTL', KEYS[1]))
  end
  if client_count > tonumber(ARGV[3]) then
    retry_ms = math.max(retry_ms, redis.call('PTTL', KEYS[2]))
  end
  if ip_count > tonumber(ARGV[4]) then
    retry_ms = math.max(retry_ms, redis.call('PTTL', KEYS[3]))
  end
end
return {allowed and 1 or 0, retry_ms}
`;

const digestKeyPart = (value: string) => (
  crypto.createHash('sha256').update(value).digest('base64url')
);

export class RedisClientLoginRateLimiter implements ClientLoginRateLimiter {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly config = resolveClientLoginRateLimitConfig(),
    private readonly keyPrefix = 'roomtalk:auth:login:v1',
  ) {}

  private keys(clientId: string, ipAddress: string) {
    const clientDigest = digestKeyPart(clientId.trim());
    const ipDigest = digestKeyPart(ipAddress.trim() || 'unknown');
    return {
      pair: `${this.keyPrefix}:pair:${clientDigest}:${ipDigest}`,
      client: `${this.keyPrefix}:client:${clientDigest}`,
      ip: `${this.keyPrefix}:ip:${ipDigest}`,
    };
  }

  async consume(clientId: string, ipAddress: string): Promise<ClientLoginRateLimitResult> {
    const keys = this.keys(clientId, ipAddress);
    const result = await (this.redisClient as any).eval(CONSUME_LOGIN_ATTEMPT_SCRIPT, {
      keys: [keys.pair, keys.client, keys.ip],
      arguments: [
        String(this.config.windowSeconds * 1000),
        String(this.config.maxAttemptsPerClientIp),
        String(this.config.maxAttemptsPerClient),
        String(this.config.maxAttemptsPerIp),
      ],
    }) as [number | string, number | string];
    return {
      allowed: Number(result[0]) === 1,
      retryAfterSeconds: Math.max(1, Math.ceil(Number(result[1]) / 1000)),
    };
  }

  async resetClient(clientId: string, ipAddress: string): Promise<void> {
    const keys = this.keys(clientId, ipAddress);
    // Preserve the IP-wide counter so one known valid credential cannot erase
    // evidence of password spraying against other accounts from the same IP.
    await this.redisClient.del([keys.pair, keys.client]);
  }
}
