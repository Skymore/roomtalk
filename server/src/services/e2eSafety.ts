const LOCAL_REDIS_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const requireSafeE2EDatabaseUrl = (env: NodeJS.ProcessEnv): string => {
  if (env.E2E_TEST_MODE !== 'true') {
    throw new Error('E2E PostgreSQL access requires E2E_TEST_MODE=true');
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('E2E PostgreSQL access requires an explicit DATABASE_URL');

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('E2E DATABASE_URL must be a valid PostgreSQL connection URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('E2E DATABASE_URL must use the postgres:// or postgresql:// protocol');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!/(^|[_-])(test|e2e)([_-]|$)/i.test(databaseName)) {
    throw new Error(`E2E refuses non-test PostgreSQL database "${databaseName || '(missing)'}"`);
  }
  return databaseUrl;
};

export const requireSafeE2ERedisUrl = (env: NodeJS.ProcessEnv): string => {
  if (env.E2E_TEST_MODE !== 'true') {
    throw new Error('E2E Redis access requires E2E_TEST_MODE=true');
  }

  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error('E2E Redis access requires an explicit REDIS_URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error('E2E REDIS_URL must be a valid Redis connection URL');
  }
  if (parsed.protocol !== 'redis:') {
    throw new Error('E2E REDIS_URL must use the redis:// protocol');
  }
  if (!LOCAL_REDIS_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('E2E REDIS_URL must target a local disposable Redis instance');
  }

  const databaseToken = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!/^[1-9]\d*$/.test(databaseToken)) {
    throw new Error('E2E REDIS_URL must select an explicit non-zero disposable database');
  }

  return redisUrl;
};

export const requireSafeE2EQueueRedisUrl = (env: NodeJS.ProcessEnv): string => {
  const redisUrl = requireSafeE2ERedisUrl(env);
  const queueRedisUrl = env.QUEUE_REDIS_URL?.trim();
  if (!queueRedisUrl) {
    throw new Error('E2E queue access requires an explicit QUEUE_REDIS_URL');
  }
  requireSafeE2ERedisUrl({
    ...env,
    REDIS_URL: queueRedisUrl,
  });
  if (new URL(queueRedisUrl).href !== new URL(redisUrl).href) {
    throw new Error('E2E QUEUE_REDIS_URL must match REDIS_URL');
  }
  return queueRedisUrl;
};
