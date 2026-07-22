import dotenv from 'dotenv';
import { resolvePostgresSslConfig } from '../repositories/postgresPool';

dotenv.config();

type QueryResult<T = Record<string, unknown>> = {
  rows: T[];
};

type PgClient = {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
};

type PgModule = {
  Client: new (config: { connectionString: string; ssl?: { rejectUnauthorized: boolean; ca?: string } | boolean }) => PgClient;
};

const ROOMTALK_TABLES = [
  'rooms',
  'room_members',
  'room_saves',
  'room_messages',
  'media_assets',
  'pending_media_uploads',
  'audio_transcriptions',
  'room_ai_cost_totals',
  'client_profiles',
  'accounts',
  'account_identities',
  'client_account_links',
  'push_subscriptions',
  'client_passwords',
  'client_auth_tokens',
  'schema_migrations',
];

const quoteIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;

const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

const roleExists = async (client: PgClient, roleName: string) => {
  const result = await client.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [roleName]
  );
  return result.rows[0]?.exists === true;
};

const relationExists = async (client: PgClient, schemaName: string, tableName: string) => {
  const result = await client.query<{ relation: string | null }>(
    'SELECT to_regclass($1) AS relation',
    [`${schemaName}.${tableName}`]
  );
  return result.rows[0]?.relation !== null;
};

const validateRoleName = (roleName: string) => {
  if (!roleName.trim()) {
    throw new Error('APP_DATABASE_USER must not be empty');
  }
  if (roleName === 'postgres' || roleName.startsWith('pg_')) {
    throw new Error('APP_DATABASE_USER must be a dedicated non-system role');
  }
};

const createOrUpdateRole = async (client: PgClient, roleName: string, password: string) => {
  const roleSql = `${quoteIdent(roleName)} WITH LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`;
  if (await roleExists(client, roleName)) {
    await client.query(`ALTER ROLE ${roleSql}`);
    console.log(`Updated role flags and password for ${roleName}`);
    return;
  }

  await client.query(`CREATE ROLE ${roleSql}`);
  console.log(`Created role ${roleName}`);
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const appUser = process.env.APP_DATABASE_USER || 'roomtalk_app';
  const appPassword = process.env.APP_DATABASE_PASSWORD;
  const schemaName = process.env.APP_DATABASE_SCHEMA || 'public';

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  if (!appPassword) {
    throw new Error('APP_DATABASE_PASSWORD is required');
  }
  validateRoleName(appUser);

  const pg = require('pg') as PgModule;
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: resolvePostgresSslConfig(),
  });

  await client.connect();
  try {
    const dbResult = await client.query<{ current_database: string }>('SELECT current_database()');
    const databaseName = dbResult.rows[0].current_database;
    const role = quoteIdent(appUser);
    const schema = quoteIdent(schemaName);

    await createOrUpdateRole(client, appUser, appPassword);
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdent(databaseName)} TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);

    for (const tableName of ROOMTALK_TABLES) {
      if (!(await relationExists(client, schemaName, tableName))) {
        continue;
      }

      const table = `${schema}.${quoteIdent(tableName)}`;
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${role}`);
    }

    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);

    const verification = await client.query<{
      rolname: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      'SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1',
      [appUser]
    );
    console.log(JSON.stringify(verification.rows[0]));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
