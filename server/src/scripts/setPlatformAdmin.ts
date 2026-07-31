import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { resolvePostgresSslConfig } from '../repositories/postgresPool';
import { resolvePlatformAdminEmails } from '../services/platformAdmin';

dotenv.config();

type PgClient = {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{
    rows: T[];
    rowCount: number | null;
  }>;
  end(): Promise<void>;
};

type PgModule = {
  Client: new (config: {
    connectionString: string;
    ssl?: { rejectUnauthorized: boolean; ca?: string } | boolean;
  }) => PgClient;
};

const readArgument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const clientId = readArgument('--client-id');
  const explicitEmail = readArgument('--email');
  const grant = process.argv.includes('--grant');
  const revoke = process.argv.includes('--revoke');

  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (clientId && explicitEmail) throw new Error('Specify only one of --client-id or --email');
  if (grant === revoke) throw new Error('Specify exactly one of --grant or --revoke');

  let email = explicitEmail;
  if (email) {
    [email] = resolvePlatformAdminEmails(email);
  } else if (!clientId) {
    const configuredEmails = resolvePlatformAdminEmails();
    if (configuredEmails.length !== 1) {
      throw new Error('Configure exactly one PLATFORM_ADMIN_EMAILS address or pass --client-id/--email');
    }
    [email] = configuredEmails;
  }

  const pg = require('pg') as PgModule;
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: resolvePostgresSslConfig(),
  });

  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('roomtalk_platform_admin_roles'))");
    const accountResult = clientId
      ? await client.query<{ account_id: string }>(
        `SELECT account_id
        FROM client_account_links
        WHERE client_id = $1
        LIMIT 1`,
        [clientId],
      )
      : await client.query<{ account_id: string }>(
        `SELECT DISTINCT account_id
        FROM account_identities
        WHERE provider = 'google'
          AND email_verified = TRUE
          AND LOWER(email) = LOWER($1)`,
        [email],
      );
    if (accountResult.rows.length > 1) {
      throw new Error('More than one account matches that verified Google email');
    }
    const accountId = accountResult.rows[0]?.account_id;
    if (!accountId) {
      throw new Error(clientId
        ? 'No registered account exists for that User ID'
        : 'No registered account has that verified Google email');
    }

    let changed = false;
    if (grant) {
      const result = await client.query(
        `INSERT INTO account_roles (account_id, role)
        VALUES ($1, 'admin')
        ON CONFLICT (account_id, role) DO NOTHING`,
        [accountId],
      );
      changed = (result.rowCount || 0) > 0;
    } else {
      const existing = await client.query<{ is_admin: boolean; admin_count: string }>(
        `SELECT
          EXISTS (
            SELECT 1 FROM account_roles
            WHERE account_id = $1 AND role = 'admin'
          ) AS is_admin,
          (SELECT COUNT(*) FROM account_roles WHERE role = 'admin') AS admin_count`,
        [accountId],
      );
      if (existing.rows[0]?.is_admin && Number(existing.rows[0].admin_count) <= 1) {
        throw new Error('Refusing to revoke the last platform administrator');
      }
      const result = await client.query(
        `DELETE FROM account_roles
        WHERE account_id = $1 AND role = 'admin'`,
        [accountId],
      );
      changed = (result.rowCount || 0) > 0;
    }

    if (changed) {
      await client.query(
        `INSERT INTO account_role_events (
          id, account_id, role, action, metadata
        ) VALUES ($1, $2, 'admin', $3, $4::jsonb)`,
        [
          randomUUID(),
          accountId,
          grant ? 'grant' : 'revoke',
          JSON.stringify({
            source: 'operator_script',
            subjectType: clientId ? 'client_id' : 'verified_google_email',
          }),
        ],
      );
    }
    await client.query('COMMIT');
    console.log(changed
      ? `Platform administrator role ${grant ? 'granted' : 'revoked'}.`
      : 'Platform administrator role was already in the requested state.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
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
