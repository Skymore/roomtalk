import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { AICost, Message, Room } from '../types';
import { POSTGRES_SCHEMA_SQL } from './postgresSchema';
import { PostgresClient, PostgresPool, PostgresQueryResult, PostgresStore } from './postgresStore';

type QueryCall = {
  sql: string;
  params?: unknown[];
};

type ScriptedResult = {
  rows?: unknown[];
  rowCount?: number | null;
  error?: Error;
  assertCall?: (call: QueryCall) => void;
};

class ScriptedExecutor {
  calls: QueryCall[] = [];

  constructor(private readonly results: ScriptedResult[] = []) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<T>> {
    const call = { sql, params };
    this.calls.push(call);
    const result = this.results.shift() || {};
    result.assertCall?.(call);
    if (result.error) {
      throw result.error;
    }

    return {
      rows: (result.rows || []) as T[],
      rowCount: result.rowCount ?? ((result.rows || []).length),
    };
  }
}

class ScriptedClient extends ScriptedExecutor implements PostgresClient {
  released = false;

  release() {
    this.released = true;
  }
}

class ScriptedPool extends ScriptedExecutor implements PostgresPool {
  connectCalls = 0;

  constructor(
    poolResults: ScriptedResult[] = [],
    readonly client = new ScriptedClient()
  ) {
    super(poolResults);
  }

  async connect(): Promise<PostgresClient> {
    this.connectCalls++;
    return this.client;
  }
}

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  lastActivityAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  ...overrides,
});

const roomRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  created_at: '2026-05-03T00:00:00.000Z',
  last_activity_at: '2026-05-03T00:00:00.000Z',
  creator_id: 'client-1',
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'message-1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-04T00:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

const cost = (totalUsd: number): AICost => ({
  currency: 'USD',
  inputUsd: totalUsd,
  outputUsd: 0,
  totalUsd,
  inputPerMillion: 1,
  outputPerMillion: 1,
  estimated: false,
});

describe('PostgresStore', () => {
  it('initializes schema idempotently', async () => {
    const pool = new ScriptedPool(POSTGRES_SCHEMA_SQL.map(() => ({ rowCount: 0 })));
    const store = new PostgresStore(pool, logger as any);

    await store.initializeSchema();

    assert.equal(pool.calls.length, POSTGRES_SCHEMA_SQL.length);
    assert.equal(pool.calls[0].sql, POSTGRES_SCHEMA_SQL[0]);
  });

  it('saves, reads, counts, and deletes rooms', async () => {
    const pool = new ScriptedPool([
      {
        rows: [roomRow({ name: 'Saved Room', description: 'desc' })],
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO rooms/);
          assert.doesNotMatch(call.sql, /creator_id = EXCLUDED\.creator_id/);
          assert.equal(call.params?.[1], 'Saved Room');
        },
      },
      {
        rows: [roomRow({ name: 'Saved Room', description: 'desc' })],
        assertCall(call) {
          assert.match(call.sql, /WHERE creator_id = \$1/);
          assert.deepEqual(call.params, ['client-1']);
        },
      },
      { rows: [roomRow({ name: 'Saved Room', description: 'desc' })] },
      { rows: [{ count: '1' }] },
      {
        rowCount: 1,
        assertCall(call) {
          assert.match(call.sql, /DELETE FROM rooms/);
          assert.deepEqual(call.params, ['room-1', 'client-1']);
        },
      },
    ]);
    const store = new PostgresStore(pool, logger as any);

    assert.deepEqual(await store.saveRoom(room({ name: 'Saved Room', description: 'desc' })), room({ name: 'Saved Room', description: 'desc' }));
    assert.deepEqual(await store.readRoomsByUser('client-1'), [room({ name: 'Saved Room', description: 'desc' })]);
    assert.deepEqual(await store.getRoomById('room-1'), room({ name: 'Saved Room', description: 'desc' }));
    assert.equal(await store.countRooms(), 1);
    await store.deleteRoom('room-1', 'client-1');
  });

  it('appends messages in a transaction and returns the updated room', async () => {
    const client = new ScriptedClient([
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'BEGIN') },
      { rows: [roomRow()] },
      { rows: [{ position: '2' }] },
      {
        rowCount: 1,
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO room_messages/);
          assert.equal(call.params?.[0], 'message-1');
          assert.equal(call.params?.[13], 2);
        },
      },
      { rows: [roomRow({ last_activity_at: '2026-05-04T00:00:00.000Z' })] },
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'COMMIT') },
    ]);
    const pool = new ScriptedPool([], client);
    const store = new PostgresStore(pool, logger as any);

    assert.deepEqual(await store.appendMessage(message()), room({ lastActivityAt: '2026-05-04T00:00:00.000Z' }));
    assert.equal(pool.connectCalls, 1);
    assert.equal(client.released, true);
  });

  it('upserts messages without rewriting room history', async () => {
    const client = new ScriptedClient([
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'BEGIN') },
      { rows: [roomRow()] },
      { rows: [{ position: '3' }] },
      {
        rowCount: 1,
        assertCall(call) {
          assert.match(call.sql, /ON CONFLICT \(id\) DO UPDATE/);
          assert.match(call.sql, /position = room_messages.position/);
          assert.equal(call.params?.[0], 'message-1');
          assert.equal(call.params?.[13], 3);
        },
      },
      {
        rows: [roomRow({ last_activity_at: '2026-05-04T00:00:00.000Z' })],
        assertCall(call) {
          assert.match(call.sql, /GREATEST\(last_activity_at/);
        },
      },
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'COMMIT') },
    ]);
    const pool = new ScriptedPool([], client);
    const store = new PostgresStore(pool, logger as any);

    assert.deepEqual(await store.upsertMessage(message()), room({ lastActivityAt: '2026-05-04T00:00:00.000Z' }));
    assert.equal(client.calls.some(call => /DELETE FROM room_messages/.test(call.sql)), false);
    assert.equal(client.released, true);
  });

  it('returns null when upserting a message into a missing room', async () => {
    const client = new ScriptedClient([
      { rowCount: 0 },
      { rows: [] },
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'COMMIT') },
    ]);
    const pool = new ScriptedPool([], client);
    const store = new PostgresStore(pool, logger as any);

    assert.equal(await store.upsertMessage(message()), null);
    assert.equal(client.calls.some(call => /INSERT INTO room_messages/.test(call.sql)), false);
    assert.equal(client.released, true);
  });

  it('rolls back append transactions on PostgreSQL errors', async () => {
    const errors: any[] = [];
    const testLogger = {
      ...logger,
      error(message: string, payload: any) {
        errors.push({ message, payload });
      },
    };
    const client = new ScriptedClient([
      { rowCount: 0 },
      { rows: [roomRow()] },
      { rows: [{ position: 0 }] },
      { error: new Error('insert failed') },
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'ROLLBACK') },
    ]);
    const pool = new ScriptedPool([], client);
    const store = new PostgresStore(pool, testLogger as any);

    assert.equal(await store.appendMessage(message()), null);
    assert.equal(client.calls[client.calls.length - 1]?.sql, 'ROLLBACK');
    assert.equal(client.released, true);
    assert.equal(errors[0].message, 'Error appending message to PostgreSQL');
  });

  it('saves, reads, and clears message history with metadata', async () => {
    const aiMessage = message({
      id: 'ai-1',
      clientId: 'ai_assistant',
      content: 'answer',
      messageType: 'ai',
      status: 'complete',
      aiModel: { id: 'deepseek-v4-pro', apiModel: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek V4 Pro' },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, source: 'reported' },
      cost: cost(0.01),
    });
    const client = new ScriptedClient([
      { rowCount: 0 },
      { rows: [roomRow()] },
      { rowCount: 1, assertCall: call => assert.match(call.sql, /DELETE FROM room_messages/) },
      { rowCount: 1, assertCall: call => assert.equal(call.params?.[13], 0) },
      { rows: [roomRow({ last_activity_at: '2026-05-04T00:00:00.000Z' })] },
      { rowCount: 0 },
    ]);
    const pool = new ScriptedPool([
      {
        rows: [{
          id: 'ai-1',
          room_id: 'room-1',
          client_id: 'ai_assistant',
          content: 'answer',
          timestamp: '2026-05-04T00:00:00.000Z',
          message_type: 'ai',
          username: null,
          avatar: null,
          mime_type: null,
          status: 'complete',
          ai_model: aiMessage.aiModel,
          usage: aiMessage.usage,
          cost: aiMessage.cost,
        }],
      },
      { rowCount: 2 },
    ], client);
    const store = new PostgresStore(pool, logger as any);

    assert.deepEqual(await store.saveMessageHistory('room-1', [aiMessage]), room({ lastActivityAt: '2026-05-04T00:00:00.000Z' }));
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [aiMessage]);
    assert.equal(await store.clearRoomMessages('room-1'), 2);
  });

  it('tracks AI cost totals and resets test data', async () => {
    const pool = new ScriptedPool([
      { rows: [{ total_usd: '0' }] },
      {
        rows: [{ total_usd: '0.25' }],
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO room_ai_cost_totals/);
          assert.deepEqual(call.params, ['room-1', 0.25]);
        },
      },
      { rowCount: 0, assertCall: call => assert.match(call.sql, /TRUNCATE room_ai_cost_totals/) },
      { rowCount: 2, assertCall: call => assert.match(call.sql, /WHERE status = 'streaming'/) },
    ]);
    const store = new PostgresStore(pool, logger as any);

    assert.deepEqual(await store.incrementRoomAICost('room-1', null), { roomId: 'room-1', currency: 'USD', totalUsd: 0 });
    assert.deepEqual(await store.incrementRoomAICost('room-1', cost(0.25)), { roomId: 'room-1', currency: 'USD', totalUsd: 0.25 });
    await store.resetAllDataForTests();
    assert.equal(await store.failInterruptedStreamingMessages('Response interrupted.'), 2);
  });
});
