import { RedisClientType } from 'redis';
import { PostgresPool } from '../repositories/postgresStore';
import {
  GitHubConnectionRecord,
  GitHubConnectionStore,
  GitHubEncryptedToken,
} from './githubConnection';

const COLUMNS = [
  'client_id', 'provider', 'status', 'encrypted_token', 'auth_version', 'key_version',
  'account_summary', 'created_at', 'updated_at', 'last_validated_at', 'last_used_at', 'last_error',
].join(', ');

type GitHubConnectionRow = {
  client_id: string;
  provider: 'github';
  status: 'connected' | 'reauth_required';
  encrypted_token: GitHubEncryptedToken;
  auth_version: number | string;
  key_version: string;
  account_summary: GitHubConnectionRecord['account'];
  created_at: string | Date;
  updated_at: string | Date;
  last_validated_at: string | Date;
  last_used_at: string | Date | null;
  last_error: string | null;
};

export class PostgresGitHubConnectionStore implements GitHubConnectionStore {
  constructor(private readonly pool: Pick<PostgresPool, 'query'>) {}

  async getConnection(clientId: string): Promise<GitHubConnectionRecord | null> {
    const result = await this.pool.query<GitHubConnectionRow>(
      `SELECT ${COLUMNS} FROM github_connections WHERE client_id = $1`,
      [clientId]
    );
    return mapRow(result.rows[0]);
  }

  async saveConnection(record: GitHubConnectionRecord): Promise<GitHubConnectionRecord> {
    const result = await this.pool.query<GitHubConnectionRow>(
      `INSERT INTO github_connections (
        client_id, provider, status, encrypted_token, auth_version, key_version, account_summary,
        created_at, updated_at, last_validated_at, last_used_at, last_error
      ) VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (client_id) DO UPDATE SET
        status = EXCLUDED.status,
        encrypted_token = EXCLUDED.encrypted_token,
        auth_version = EXCLUDED.auth_version,
        key_version = EXCLUDED.key_version,
        account_summary = EXCLUDED.account_summary,
        updated_at = EXCLUDED.updated_at,
        last_validated_at = EXCLUDED.last_validated_at,
        last_used_at = EXCLUDED.last_used_at,
        last_error = EXCLUDED.last_error
      RETURNING ${COLUMNS}`,
      [
        record.clientId, record.status, record.encryptedToken, record.authVersion, record.keyVersion,
        record.account, record.createdAt, record.updatedAt, record.lastValidatedAt,
        record.lastUsedAt || null, record.lastError || null,
      ]
    );
    const saved = mapRow(result.rows[0]);
    if (!saved) throw new Error(`PostgreSQL did not return saved GitHub connection for client ${record.clientId}`);
    return saved;
  }

  async deleteConnection(clientId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM github_connections WHERE client_id = $1', [clientId]);
    return (result.rowCount || 0) > 0;
  }
}

const REDIS_KEY = 'github:connections';

export class RedisGitHubConnectionStore implements GitHubConnectionStore {
  constructor(private readonly redisClient: RedisClientType) {}

  async getConnection(clientId: string): Promise<GitHubConnectionRecord | null> {
    const raw = await this.redisClient.hGet(REDIS_KEY, clientId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GitHubConnectionRecord;
    } catch {
      return null;
    }
  }

  async saveConnection(record: GitHubConnectionRecord): Promise<GitHubConnectionRecord> {
    await this.redisClient.hSet(REDIS_KEY, record.clientId, JSON.stringify(record));
    return structuredClone(record);
  }

  async deleteConnection(clientId: string): Promise<boolean> {
    return (await this.redisClient.hDel(REDIS_KEY, clientId)) > 0;
  }
}

const mapRow = (row?: GitHubConnectionRow): GitHubConnectionRecord | null => {
  if (!row) return null;
  return {
    clientId: row.client_id,
    provider: 'github',
    status: row.status,
    encryptedToken: row.encrypted_token,
    authVersion: Number(row.auth_version),
    keyVersion: row.key_version,
    account: row.account_summary,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    lastValidatedAt: toIso(row.last_validated_at),
    lastUsedAt: row.last_used_at ? toIso(row.last_used_at) : undefined,
    lastError: row.last_error || undefined,
  };
};

const toIso = (value: string | Date) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
