import dotenv from 'dotenv';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresStore } from '../repositories/postgresStore';
import { requireSafeE2EDatabaseUrl, requireSafeE2EQueueRedisUrl, requireSafeE2ERedisUrl } from '../services/e2eSafety';

dotenv.config();

async function main() {
  const databaseUrl = requireSafeE2EDatabaseUrl(process.env);
  requireSafeE2ERedisUrl(process.env);
  requireSafeE2EQueueRedisUrl(process.env);
  const logger = new Logger('E2ESchema');
  const pool = createPostgresPool(databaseUrl, logger);
  try {
    const store = new PostgresStore(pool, logger);
    await store.migrateSchema();
    await store.verifySchema();
  } finally {
    await pool.end?.();
  }

  require('../server');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
