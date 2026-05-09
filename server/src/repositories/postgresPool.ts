import { Logger } from '../logger';
import { PostgresPool } from './postgresStore';

type PgModule = {
  Pool: new (config: { connectionString: string; ssl?: { rejectUnauthorized: boolean } | boolean }) => PostgresPool;
};

export function resolvePostgresSslConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.POSTGRES_SSL !== 'true') {
    return undefined;
  }

  return {
    rejectUnauthorized: env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
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
