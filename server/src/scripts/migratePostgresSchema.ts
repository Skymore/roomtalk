import dotenv from 'dotenv';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresStore } from '../repositories/postgresStore';

dotenv.config();

async function main() {
  const databaseUrl = (process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL)?.trim();
  if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');

  const logger = new Logger('PostgresMigration');
  const pool = createPostgresPool(databaseUrl, logger);
  try {
    const store = new PostgresStore(pool, logger);
    await store.migrateSchema();
    await store.verifySchema();
  } finally {
    await pool.end?.();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
