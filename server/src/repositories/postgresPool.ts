import { Logger } from '../logger';
import { PostgresPool } from './postgresStore';

type PgModule = {
  Pool: new (config: { connectionString: string; ssl?: { rejectUnauthorized: boolean; ca?: string } | boolean }) => PostgresPool;
};

export function resolvePostgresSslConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.POSTGRES_SSL !== 'true') {
    return undefined;
  }

  const sslConfig: { rejectUnauthorized: boolean; ca?: string } = {
    rejectUnauthorized: env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false',
  };

  if (env.POSTGRES_SSL_CA_BASE64) {
    sslConfig.ca = Buffer.from(env.POSTGRES_SSL_CA_BASE64, 'base64').toString('utf8');
  } else if (env.POSTGRES_SSL_CA) {
    sslConfig.ca = env.POSTGRES_SSL_CA;
  }

  return sslConfig;
}

export function createPostgresPool(connectionString: string, logger: Logger): PostgresPool {
  let pg: PgModule;
  try {
    // Loaded only when PostgreSQL persistence is enabled, so Redis-only deployments do not require it at runtime.
    pg = require('pg') as PgModule;
  } catch (error) {
    logger.error('PostgreSQL persistence requires the pg package', { error });
    throw error;
  }

  return new pg.Pool({
    connectionString,
    ssl: resolvePostgresSslConfig(),
  });
}
