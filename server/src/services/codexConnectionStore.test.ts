import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CodexAuthCipher,
  CodexConnectionRecord,
  CodexConnectionService,
  CodexDeviceAuthDriver,
  CodexDeviceAuthInfo,
} from './codexConnection';
import { PostgresCodexConnectionStore, RedisCodexConnectionStore } from './codexConnectionStore';

const encryptedAuthJson = {
  algorithm: 'aes-256-gcm' as const,
  keyVersion: 'key-v1',
  iv: 'iv',
  tag: 'tag',
  ciphertext: 'ciphertext',
};

const makeRecord = (clientId = 'client-1'): CodexConnectionRecord => ({
  clientId,
  provider: 'codex',
  status: 'connected',
  encryptedAuthJson,
  authVersion: 1,
  keyVersion: 'key-v1',
  createdAt: '2026-07-04T00:00:00.000Z',
  updatedAt: '2026-07-04T00:00:00.000Z',
  lastValidatedAt: '2026-07-04T00:00:00.000Z',
});

describe('PostgresCodexConnectionStore', () => {
  it('persists, restores, locks, unlocks, and deletes Codex connections', async () => {
    const pool = new MemoryPostgresPool();
    const store = new PostgresCodexConnectionStore(pool);

    const saved = await store.saveConnection(makeRecord());
    assert.equal(saved.clientId, 'client-1');
    assert.equal(saved.provider, 'codex');
    assert.deepEqual(saved.encryptedAuthJson, encryptedAuthJson);

    assert.deepEqual(await store.getConnection('client-1'), saved);

    const locked = await store.acquireConnectionLock(
      'client-1',
      'run-1',
      '2026-07-04T00:10:00.000Z',
      '2026-07-04T00:00:00.000Z'
    );
    assert.equal(locked?.activeRunId, 'run-1');
    assert.equal(locked?.lockedUntil, '2026-07-04T00:10:00.000Z');

    const denied = await store.acquireConnectionLock(
      'client-1',
      'run-2',
      '2026-07-04T00:11:00.000Z',
      '2026-07-04T00:01:00.000Z'
    );
    assert.equal(denied, null);

    const sameRun = await store.acquireConnectionLock(
      'client-1',
      'run-1',
      '2026-07-04T00:12:00.000Z',
      '2026-07-04T00:02:00.000Z'
    );
    assert.equal(sameRun?.lockedUntil, '2026-07-04T00:12:00.000Z');

    const wrongRelease = await store.releaseConnectionLock('client-1', 'run-2', '2026-07-04T00:03:00.000Z');
    assert.equal(wrongRelease?.activeRunId, 'run-1');

    const released = await store.releaseConnectionLock('client-1', 'run-1', '2026-07-04T00:04:00.000Z');
    assert.equal(released?.activeRunId, undefined);
    assert.equal(released?.lockedUntil, undefined);

    assert.equal(await store.deleteConnection('client-1'), true);
    assert.equal(await store.getConnection('client-1'), null);
    assert.ok(pool.queries.some(query => query.includes('ON CONFLICT (client_id) DO UPDATE')));
  });

  it('does not lock disconnected or auth-less rows', async () => {
    const pool = new MemoryPostgresPool();
    const store = new PostgresCodexConnectionStore(pool);
    await store.saveConnection({
      ...makeRecord(),
      status: 'reauth_required',
      encryptedAuthJson: undefined,
      authVersion: 0,
    });

    assert.equal(await store.acquireConnectionLock(
      'client-1',
      'run-1',
      '2026-07-04T00:10:00.000Z',
      '2026-07-04T00:00:00.000Z'
    ), null);
  });
});

describe('RedisCodexConnectionStore', () => {
  it('persists, restores, locks, unlocks, and deletes Codex connections', async () => {
    const redis = new MemoryRedisClient();
    const store = new RedisCodexConnectionStore(redis as any);

    const saved = await store.saveConnection(makeRecord());
    assert.deepEqual(await store.getConnection('client-1'), saved);

    const locked = await store.acquireConnectionLock(
      'client-1',
      'run-1',
      '2026-07-04T00:10:00.000Z',
      '2026-07-04T00:00:00.000Z'
    );
    assert.equal(locked?.activeRunId, 'run-1');

    assert.equal(await store.acquireConnectionLock(
      'client-1',
      'run-2',
      '2026-07-04T00:11:00.000Z',
      '2026-07-04T00:01:00.000Z'
    ), null);

    const expiredLock = await store.acquireConnectionLock(
      'client-1',
      'run-2',
      '2026-07-04T00:21:00.000Z',
      '2026-07-04T00:20:00.000Z'
    );
    assert.equal(expiredLock?.activeRunId, 'run-2');

    const released = await store.releaseConnectionLock('client-1', 'run-2', '2026-07-04T00:22:00.000Z');
    assert.equal(released?.activeRunId, undefined);
    assert.equal(released?.lockedUntil, undefined);

    assert.equal(await store.deleteConnection('client-1'), true);
    assert.equal(await store.getConnection('client-1'), null);
  });

  it('handles corrupt Redis rows safely', async () => {
    const redis = new MemoryRedisClient();
    const store = new RedisCodexConnectionStore(redis as any);
    await redis.hSet('codex:connections', 'client-1', '{not json');

    assert.equal(await store.getConnection('client-1'), null);
    assert.equal(await store.acquireConnectionLock(
      'client-1',
      'run-1',
      '2026-07-04T00:10:00.000Z',
      '2026-07-04T00:00:00.000Z'
    ), null);
  });
});

describe('CodexConnectionService durable store integration', () => {
  it('connects, restores auth, and disconnects through the PostgreSQL store', async () => {
    const store = new PostgresCodexConnectionStore(new MemoryPostgresPool());
    const service = makeDurableService(store);

    const connected = await service.connectWithDeviceAuth('client-1');
    assert.equal(connected.status, 'connected');

    const result = await service.withCodexAuth('client-1', 'run-1', async authJson => {
      assert.equal(authJson, authJsonFixture);
      return { result: 'ok' };
    });
    assert.equal(result, 'ok');

    const disconnected = await service.disconnect('client-1');
    assert.equal(disconnected.status, 'disconnected');
  });

  it('connects, restores auth, and disconnects through the Redis store', async () => {
    const store = new RedisCodexConnectionStore(new MemoryRedisClient() as any);
    const service = makeDurableService(store);

    const connected = await service.connectWithDeviceAuth('client-1');
    assert.equal(connected.status, 'connected');

    const result = await service.withCodexAuth('client-1', 'run-1', async authJson => {
      assert.equal(authJson, authJsonFixture);
      return { result: 'ok' };
    });
    assert.equal(result, 'ok');

    const disconnected = await service.disconnect('client-1');
    assert.equal(disconnected.status, 'disconnected');
  });
});

const authJsonFixture = JSON.stringify({
  OPENAI_AUTH: {
    access_token: 'fake-access-token',
    refresh_token: 'fake-refresh-token',
  },
});

class FakeDeviceAuthDriver implements CodexDeviceAuthDriver {
  async runDeviceAuth(input: {
    clientId: string;
    onDeviceCode?: (info: CodexDeviceAuthInfo) => void | Promise<void>;
  }) {
    await input.onDeviceCode?.({
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-EFGH',
      expiresAt: '2026-07-04T00:15:00.000Z',
    });
    return {
      authJson: authJsonFixture,
      loginStatus: 'Logged in using ChatGPT',
    };
  }
}

const makeDurableService = (store: ConstructorParameters<typeof CodexConnectionService>[0]) => (
  new CodexConnectionService(
    store,
    new CodexAuthCipher('test-secret', 'key-v1'),
    new FakeDeviceAuthDriver(),
    {
      now: () => new Date('2026-07-04T00:00:00.000Z'),
      lockTtlMs: 60_000,
    }
  )
);

type PostgresRow = {
  client_id: string;
  provider: 'codex';
  status: CodexConnectionRecord['status'];
  encrypted_auth_json: unknown;
  auth_version: number;
  key_version: string;
  created_at: string;
  updated_at: string;
  last_validated_at: string | null;
  last_used_at: string | null;
  active_run_id: string | null;
  locked_until: string | null;
  last_error: string | null;
};

class MemoryPostgresPool {
  readonly rows = new Map<string, PostgresRow>();
  readonly queries: string[] = [];

  async query<T = any>(sql: string, params: unknown[] = []) {
    this.queries.push(sql);
    const normalizedSql = sql.trim();
    if (normalizedSql.startsWith('SELECT')) {
      const row = this.rows.get(String(params[0]));
      return { rows: row ? [clone(row) as T] : [], rowCount: row ? 1 : 0 };
    }
    if (normalizedSql.startsWith('INSERT')) {
      const row: PostgresRow = {
        client_id: String(params[0]),
        provider: 'codex',
        status: params[1] as CodexConnectionRecord['status'],
        encrypted_auth_json: params[2] || null,
        auth_version: Number(params[3]) || 0,
        key_version: String(params[4]),
        created_at: String(params[5]),
        updated_at: String(params[6]),
        last_validated_at: params[7] ? String(params[7]) : null,
        last_used_at: params[8] ? String(params[8]) : null,
        active_run_id: params[9] ? String(params[9]) : null,
        locked_until: params[10] ? String(params[10]) : null,
        last_error: params[11] ? String(params[11]) : null,
      };
      this.rows.set(row.client_id, row);
      return { rows: [clone(row) as T], rowCount: 1 };
    }
    if (normalizedSql.startsWith('DELETE')) {
      const deleted = this.rows.delete(String(params[0]));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }
    if (normalizedSql.startsWith('UPDATE codex_connections') && normalizedSql.includes('active_run_id = NULL')) {
      return this.releaseLock<T>(params);
    }
    if (normalizedSql.startsWith('UPDATE codex_connections') && normalizedSql.includes('active_run_id = $2')) {
      return this.acquireLock<T>(params);
    }
    throw new Error(`Unhandled SQL in test: ${sql}`);
  }

  private acquireLock<T>(params: unknown[]) {
    const [clientId, runId, lockedUntil, now] = params.map(String);
    const row = this.rows.get(clientId);
    if (!row || row.status !== 'connected' || !row.encrypted_auth_json) {
      return { rows: [], rowCount: 0 };
    }
    if (row.active_run_id && row.locked_until && row.locked_until > now && row.active_run_id !== runId) {
      return { rows: [], rowCount: 0 };
    }
    row.active_run_id = runId;
    row.locked_until = lockedUntil;
    row.updated_at = now;
    return { rows: [clone(row) as T], rowCount: 1 };
  }

  private releaseLock<T>(params: unknown[]) {
    const [clientId, runId, now] = params.map(String);
    const row = this.rows.get(clientId);
    if (!row || row.active_run_id !== runId) {
      return { rows: [], rowCount: 0 };
    }
    row.active_run_id = null;
    row.locked_until = null;
    row.updated_at = now;
    return { rows: [clone(row) as T], rowCount: 1 };
  }
}

class MemoryRedisClient {
  private readonly hashes = new Map<string, Map<string, string>>();

  async hGet(key: string, field: string) {
    return this.hashes.get(key)?.get(field) || null;
  }

  async hSet(key: string, field: string, value: string) {
    const hash = this.hashes.get(key) || new Map<string, string>();
    const existed = hash.has(field);
    hash.set(field, value);
    this.hashes.set(key, hash);
    return existed ? 0 : 1;
  }

  async hDel(key: string, field: string) {
    return this.hashes.get(key)?.delete(field) ? 1 : 0;
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    if (script.includes("record['activeRunId'] = nil")) {
      return this.releaseLock(options.keys[0], options.arguments);
    }
    return this.acquireLock(options.keys[0], options.arguments);
  }

  private async acquireLock(key: string, args: string[]) {
    const [clientId, runId, lockedUntil, now] = args;
    const raw = await this.hGet(key, clientId);
    if (!raw) {
      return '';
    }
    let record: CodexConnectionRecord;
    try {
      record = JSON.parse(raw) as CodexConnectionRecord;
    } catch {
      return '';
    }
    if (record.status !== 'connected' || !record.encryptedAuthJson) {
      return '';
    }
    if (record.activeRunId && record.lockedUntil && record.lockedUntil > now && record.activeRunId !== runId) {
      return '';
    }
    const next = {
      ...record,
      activeRunId: runId,
      lockedUntil,
      updatedAt: now,
    };
    await this.hSet(key, clientId, JSON.stringify(next));
    return JSON.stringify(next);
  }

  private async releaseLock(key: string, args: string[]) {
    const [clientId, runId, now] = args;
    const raw = await this.hGet(key, clientId);
    if (!raw) {
      return '';
    }
    let record: CodexConnectionRecord;
    try {
      record = JSON.parse(raw) as CodexConnectionRecord;
    } catch {
      return '';
    }
    if (record.activeRunId !== runId) {
      return raw;
    }
    const next = {
      ...record,
      activeRunId: undefined,
      lockedUntil: undefined,
      updatedAt: now,
    };
    await this.hSet(key, clientId, JSON.stringify(next));
    return JSON.stringify(next);
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
