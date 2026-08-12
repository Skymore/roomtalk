export const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const DEFAULT_E2E_REDIS_URL = 'redis://127.0.0.1:6379/15';
const LOCAL_REDIS_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const requireSafeE2ERedisUrl = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const redisUrl = env.E2E_REDIS_URL?.trim() || DEFAULT_E2E_REDIS_URL;
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error('E2E_REDIS_URL must be a valid Redis connection URL.');
  }
  if (parsed.protocol !== 'redis:') {
    throw new Error('E2E_REDIS_URL must use the redis:// protocol.');
  }
  if (!LOCAL_REDIS_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('E2E_REDIS_URL must target a local disposable Redis instance.');
  }
  const databaseToken = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!/^[1-9]\d*$/.test(databaseToken)) {
    throw new Error('E2E_REDIS_URL must select an explicit non-zero disposable database.');
  }
  return redisUrl;
};

export const requireSafeE2EDatabaseUrl = (): string => {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'E2E_DATABASE_URL is required. Use a dedicated PostgreSQL database whose name includes "test" or "e2e" as a separated token.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('E2E_DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('E2E_DATABASE_URL must use the postgres:// or postgresql:// protocol.');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!/(^|[_-])(test|e2e)([_-]|$)/i.test(databaseName)) {
    throw new Error(
      `Refusing to run E2E against database "${databaseName || '(missing)'}". The database name must include "test" or "e2e" as a separated token.`
    );
  }

  return databaseUrl;
};
