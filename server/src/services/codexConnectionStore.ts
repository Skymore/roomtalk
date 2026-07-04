import { RedisClientType } from 'redis';
import { PostgresPool } from '../repositories/postgresStore';
import {
  CodexConnectionRecord,
  CodexConnectionStatus,
  CodexConnectionStore,
  CodexEncryptedAuthJson,
} from './codexConnection';

const CODEX_CONNECTION_COLUMNS = [
  'client_id',
  'provider',
  'status',
  'encrypted_auth_json',
  'auth_version',
  'key_version',
  'created_at',
  'updated_at',
  'last_validated_at',
  'last_used_at',
  'active_run_id',
  'locked_until',
  'last_error',
].join(', ');

type CodexConnectionRow = {
  client_id: string;
  provider: 'codex';
  status: CodexConnectionStatus;
  encrypted_auth_json: unknown;
  auth_version: number | string;
  key_version: string;
  created_at: string | Date;
  updated_at: string | Date;
  last_validated_at: string | Date | null;
  last_used_at: string | Date | null;
  active_run_id: string | null;
  locked_until: string | Date | null;
  last_error: string | null;
};

export class PostgresCodexConnectionStore implements CodexConnectionStore {
  constructor(private readonly pool: Pick<PostgresPool, 'query'>) {}

  async getConnection(clientId: string): Promise<CodexConnectionRecord | null> {
    const result = await this.pool.query<CodexConnectionRow>(
      `SELECT ${CODEX_CONNECTION_COLUMNS}
      FROM codex_connections
      WHERE client_id = $1`,
      [clientId]
    );
    return mapPostgresConnectionRow(result.rows[0]);
  }

  async saveConnection(record: CodexConnectionRecord): Promise<CodexConnectionRecord> {
    const result = await this.pool.query<CodexConnectionRow>(
      `INSERT INTO codex_connections (
        client_id,
        provider,
        status,
        encrypted_auth_json,
        auth_version,
        key_version,
        created_at,
        updated_at,
        last_validated_at,
        last_used_at,
        active_run_id,
        locked_until,
        last_error
      )
      VALUES ($1, 'codex', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (client_id) DO UPDATE SET
        status = EXCLUDED.status,
        encrypted_auth_json = EXCLUDED.encrypted_auth_json,
        auth_version = EXCLUDED.auth_version,
        key_version = EXCLUDED.key_version,
        updated_at = EXCLUDED.updated_at,
        last_validated_at = EXCLUDED.last_validated_at,
        last_used_at = EXCLUDED.last_used_at,
        active_run_id = EXCLUDED.active_run_id,
        locked_until = EXCLUDED.locked_until,
        last_error = EXCLUDED.last_error
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [
        record.clientId,
        record.status,
        record.encryptedAuthJson || null,
        record.authVersion,
        record.keyVersion,
        record.createdAt,
        record.updatedAt,
        record.lastValidatedAt || null,
        record.lastUsedAt || null,
        record.activeRunId || null,
        record.lockedUntil || null,
        record.lastError || null,
      ]
    );
    const saved = mapPostgresConnectionRow(result.rows[0]);
    if (!saved) {
      throw new Error(`PostgreSQL did not return saved Codex connection for client ${record.clientId}`);
    }
    return saved;
  }

  async deleteConnection(clientId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM codex_connections WHERE client_id = $1',
      [clientId]
    );
    return (result.rowCount || 0) > 0;
  }

  async acquireConnectionLock(
    clientId: string,
    runId: string,
    lockedUntil: string,
    now: string
  ): Promise<CodexConnectionRecord | null> {
    const result = await this.pool.query<CodexConnectionRow>(
      `UPDATE codex_connections
      SET active_run_id = $2,
          locked_until = $3,
          updated_at = $4
      WHERE client_id = $1
        AND status = 'connected'
        AND encrypted_auth_json IS NOT NULL
        AND (
          active_run_id IS NULL
          OR locked_until IS NULL
          OR locked_until <= $4
          OR active_run_id = $2
        )
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [clientId, runId, lockedUntil, now]
    );
    return mapPostgresConnectionRow(result.rows[0]);
  }

  async releaseConnectionLock(clientId: string, runId: string, now: string): Promise<CodexConnectionRecord | null> {
    const result = await this.pool.query<CodexConnectionRow>(
      `UPDATE codex_connections
      SET active_run_id = NULL,
          locked_until = NULL,
          updated_at = $3
      WHERE client_id = $1
        AND active_run_id = $2
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [clientId, runId, now]
    );
    return mapPostgresConnectionRow(result.rows[0]) || this.getConnection(clientId);
  }
}

const REDIS_CODEX_CONNECTIONS_KEY = 'codex:connections';

export class RedisCodexConnectionStore implements CodexConnectionStore {
  constructor(private readonly redisClient: RedisClientType) {}

  async getConnection(clientId: string): Promise<CodexConnectionRecord | null> {
    const raw = await this.redisClient.hGet(REDIS_CODEX_CONNECTIONS_KEY, clientId);
    return parseRedisConnectionRecord(raw);
  }

  async saveConnection(record: CodexConnectionRecord): Promise<CodexConnectionRecord> {
    await this.redisClient.hSet(REDIS_CODEX_CONNECTIONS_KEY, record.clientId, JSON.stringify(record));
    return cloneRecord(record)!;
  }

  async deleteConnection(clientId: string): Promise<boolean> {
    const deleted = await this.redisClient.hDel(REDIS_CODEX_CONNECTIONS_KEY, clientId);
    return deleted > 0;
  }

  async acquireConnectionLock(
    clientId: string,
    runId: string,
    lockedUntil: string,
    now: string
  ): Promise<CodexConnectionRecord | null> {
    const raw = await (this.redisClient as any).eval(REDIS_ACQUIRE_CODEX_CONNECTION_LOCK_SCRIPT, {
      keys: [REDIS_CODEX_CONNECTIONS_KEY],
      arguments: [clientId, runId, lockedUntil, now],
    }) as string | null;
    return parseRedisConnectionRecord(raw);
  }

  async releaseConnectionLock(clientId: string, runId: string, now: string): Promise<CodexConnectionRecord | null> {
    const raw = await (this.redisClient as any).eval(REDIS_RELEASE_CODEX_CONNECTION_LOCK_SCRIPT, {
      keys: [REDIS_CODEX_CONNECTIONS_KEY],
      arguments: [clientId, runId, now],
    }) as string | null;
    return parseRedisConnectionRecord(raw);
  }
}

const REDIS_ACQUIRE_CODEX_CONNECTION_LOCK_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return ''
end

local ok, record = pcall(cjson.decode, raw)
if not ok then
  return ''
end

if record['status'] ~= 'connected' or not record['encryptedAuthJson'] then
  return ''
end

local active_run_id = record['activeRunId']
local locked_until = record['lockedUntil']
if active_run_id and locked_until and tostring(locked_until) > ARGV[4] and active_run_id ~= ARGV[2] then
  return ''
end

record['activeRunId'] = ARGV[2]
record['lockedUntil'] = ARGV[3]
record['updatedAt'] = ARGV[4]

local encoded = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const REDIS_RELEASE_CODEX_CONNECTION_LOCK_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return ''
end

local ok, record = pcall(cjson.decode, raw)
if not ok then
  return ''
end

if record['activeRunId'] ~= ARGV[2] then
  return raw
end

record['activeRunId'] = nil
record['lockedUntil'] = nil
record['updatedAt'] = ARGV[3]

local encoded = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const mapPostgresConnectionRow = (row?: CodexConnectionRow): CodexConnectionRecord | null => {
  if (!row) {
    return null;
  }
  return {
    clientId: row.client_id,
    provider: 'codex',
    status: row.status,
    encryptedAuthJson: parseEncryptedAuthJson(row.encrypted_auth_json),
    authVersion: Number(row.auth_version) || 0,
    keyVersion: row.key_version,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    lastValidatedAt: toOptionalIsoString(row.last_validated_at),
    lastUsedAt: toOptionalIsoString(row.last_used_at),
    activeRunId: row.active_run_id || undefined,
    lockedUntil: toOptionalIsoString(row.locked_until),
    lastError: row.last_error || undefined,
  };
};

const parseEncryptedAuthJson = (value: unknown): CodexEncryptedAuthJson | undefined => {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as CodexEncryptedAuthJson;
  }
  return value as CodexEncryptedAuthJson;
};

const parseRedisConnectionRecord = (raw: string | null | undefined): CodexConnectionRecord | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CodexConnectionRecord>;
    if (
      typeof parsed.clientId !== 'string' ||
      parsed.provider !== 'codex' ||
      !isCodexConnectionStatus(parsed.status) ||
      typeof parsed.authVersion !== 'number' ||
      typeof parsed.keyVersion !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.updatedAt !== 'string'
    ) {
      return null;
    }
    return parsed as CodexConnectionRecord;
  } catch {
    return null;
  }
};

const isCodexConnectionStatus = (status: unknown): status is CodexConnectionStatus => (
  status === 'pending' ||
  status === 'connected' ||
  status === 'reauth_required' ||
  status === 'disconnected'
);

const toIsoString = (value: string | Date): string => (
  value instanceof Date ? value.toISOString() : value
);

const toOptionalIsoString = (value: string | Date | null): string | undefined => {
  if (!value) {
    return undefined;
  }
  return toIsoString(value);
};

const cloneRecord = (record: CodexConnectionRecord | null): CodexConnectionRecord | null => {
  if (!record) {
    return null;
  }
  return JSON.parse(JSON.stringify(record)) as CodexConnectionRecord;
};
