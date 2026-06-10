import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { AICost, MediaAsset, Message, Room } from '../types';
import { POSTGRES_MIGRATIONS, POSTGRES_SCHEMA_SQL } from './postgresSchema';
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

const mediaAsset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'asset-1',
  roomId: 'room-1',
  messageId: 'message-1',
  objectKey: 'rooms/room-1/media/image/asset-1',
  kind: 'image',
  mimeType: 'image/webp',
  byteSize: 123,
  createdAt: '2026-05-04T00:00:00.000Z',
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
  it('runs idempotent DDL then checks migrations, skipping already-applied ones', async () => {
    const pool = new ScriptedPool([
      ...POSTGRES_SCHEMA_SQL.map(() => ({ rowCount: 0 })),
      { rowCount: 0 }, // CREATE TABLE schema_migrations
      ...POSTGRES_MIGRATIONS.map(() => ({ rows: [{ ok: 1 }] })), // each existence check -> applied
    ]);
    const store = new PostgresStore(pool, logger as any);

    await store.initializeSchema();

    // DDL, then the migrations table, then one existence check per migration.
    assert.equal(pool.calls.length, POSTGRES_SCHEMA_SQL.length + 1 + POSTGRES_MIGRATIONS.length);
    assert.equal(pool.calls[0].sql, POSTGRES_SCHEMA_SQL[0]);
    assert.match(pool.calls[POSTGRES_SCHEMA_SQL.length].sql, /CREATE TABLE IF NOT EXISTS schema_migrations/);
    // None applied this run, so no transaction was opened.
    assert.equal(pool.connectCalls, 0);
    // The one-time backfill no longer lives in the always-rerun DDL.
    assert.ok(POSTGRES_SCHEMA_SQL.every(sql => !/INSERT INTO room_members/.test(sql)));
  });

  it('applies pending migrations exactly once and records each in a transaction', async () => {
    const migrationCount = POSTGRES_MIGRATIONS.length;
    const clientResults: ScriptedResult[] = [];
    for (let i = 0; i < migrationCount; i++) {
      clientResults.push({ rowCount: 0, assertCall: call => assert.equal(call.sql, 'BEGIN') });
      clientResults.push({ rowCount: 0 }); // the migration SQL itself
      clientResults.push({ rowCount: 0, assertCall: call => assert.match(call.sql, /INSERT INTO schema_migrations/) });
      clientResults.push({ rowCount: 0, assertCall: call => assert.equal(call.sql, 'COMMIT') });
    }
    const client = new ScriptedClient(clientResults);
    const pool = new ScriptedPool([
      ...POSTGRES_SCHEMA_SQL.map(() => ({ rowCount: 0 })),
      { rowCount: 0 }, // CREATE TABLE schema_migrations
      ...POSTGRES_MIGRATIONS.map(() => ({ rows: [] })), // each existence check -> not applied
    ], client);
    const store = new PostgresStore(pool, logger as any);

    await store.initializeSchema();

    assert.equal(pool.connectCalls, migrationCount);
    assert.equal(client.calls.filter(call => /INSERT INTO schema_migrations/.test(call.sql)).length, migrationCount);
    // The backfill migration runs through the transaction client, not the pool.
    assert.equal(client.calls.filter(call => /INSERT INTO room_members/.test(call.sql)).length, 1);
  });

  it('saves, reads, counts, and deletes rooms', async () => {
    const client = new ScriptedClient([
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'BEGIN') },
      {
        rows: [roomRow({ name: 'Saved Room', description: 'desc' })],
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO rooms/);
          assert.doesNotMatch(call.sql, /creator_id = EXCLUDED\.creator_id/);
          assert.equal(call.params?.[1], 'Saved Room');
        },
      },
      {
        rowCount: 1,
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO room_members/);
          assert.deepEqual(call.params, ['room-1', 'client-1', '2026-05-03T00:00:00.000Z']);
        },
      },
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'COMMIT') },
    ]);
    const pool = new ScriptedPool([
      {
        rows: [roomRow({ name: 'Saved Room', description: 'desc' })],
        assertCall(call) {
          assert.match(call.sql, /FROM rooms/);
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
    ], client);
    const store = new PostgresStore(pool, logger as any);

    assert.deepEqual(await store.saveRoom(room({ name: 'Saved Room', description: 'desc' })), room({ name: 'Saved Room', description: 'desc' }));
    assert.deepEqual(await store.readRoomsByUser('client-1'), [room({ name: 'Saved Room', description: 'desc' })]);
    assert.deepEqual(await store.getRoomById('room-1'), room({ name: 'Saved Room', description: 'desc' }));
    assert.equal(await store.countRooms(), 1);
    await store.deleteRoom('room-1', 'client-1');
  });

  it('persists and reads room memberships', async () => {
    const pool = new ScriptedPool([
      {
        rows: [{
          room_id: 'room-1',
          client_id: 'client-2',
          role: 'member',
          joined_at: '2026-05-03T00:01:00.000Z',
        }],
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO room_members/);
          assert.deepEqual(call.params, ['room-1', 'client-2', 'member', '2026-05-03T00:01:00.000Z']);
        },
      },
      {
        rows: [{
          room_id: 'room-1',
          client_id: 'client-2',
          role: 'member',
          joined_at: '2026-05-03T00:01:00.000Z',
        }],
        assertCall(call) {
          assert.match(call.sql, /WHERE room_id = \$1 AND client_id = \$2/);
        },
      },
      {
        rows: [{ '?column?': 1 }],
        assertCall(call) {
          assert.match(call.sql, /SELECT 1 FROM room_members/);
        },
      },
      {
        rows: [
          {
            room_id: 'room-1',
            client_id: 'client-1',
            role: 'owner',
            joined_at: '2026-05-03T00:00:00.000Z',
          },
          {
            room_id: 'room-1',
            client_id: 'client-2',
            role: 'member',
            joined_at: '2026-05-03T00:01:00.000Z',
          },
        ],
        assertCall(call) {
          assert.match(call.sql, /ORDER BY joined_at ASC/);
        },
      },
      {
        rowCount: 1,
        assertCall(call) {
          assert.match(call.sql, /DELETE FROM room_members/);
          assert.match(call.sql, /role <> 'owner'/);
          assert.deepEqual(call.params, ['room-1', 'client-2']);
        },
      },
    ]);
    const store = new PostgresStore(pool, logger as any);

    assert.deepEqual(await store.addRoomMember('room-1', 'client-2', 'member', '2026-05-03T00:01:00.000Z'), {
      roomId: 'room-1',
      clientId: 'client-2',
      role: 'member',
      joinedAt: '2026-05-03T00:01:00.000Z',
    });
    assert.deepEqual(await store.getRoomMember('room-1', 'client-2'), {
      roomId: 'room-1',
      clientId: 'client-2',
      role: 'member',
      joinedAt: '2026-05-03T00:01:00.000Z',
    });
    assert.equal(await store.isRoomMember('room-1', 'client-2'), true);
    assert.deepEqual(await store.readRoomMembers('room-1'), [
      {
        roomId: 'room-1',
        clientId: 'client-1',
        role: 'owner',
        joinedAt: '2026-05-03T00:00:00.000Z',
      },
      {
        roomId: 'room-1',
        clientId: 'client-2',
        role: 'member',
        joinedAt: '2026-05-03T00:01:00.000Z',
      },
    ]);
    assert.equal(await store.removeRoomMember('room-1', 'client-2'), true);
  });

  it('persists and reads saved rooms independently from owned rooms', async () => {
    const pool = new ScriptedPool([
      {
        rows: [{ room_id: 'room-1' }],
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO room_saves/);
          assert.deepEqual(call.params, ['room-1', 'client-2', '2026-05-03T00:02:00.000Z']);
        },
      },
      {
        rows: [roomRow()],
        assertCall(call) {
          assert.match(call.sql, /SELECT id, name, description, created_at, last_activity_at, creator_id, message_version, password_hash, posting_schedule, room_version, updated_at FROM rooms WHERE id = \$1/);
          assert.deepEqual(call.params, ['room-1']);
        },
      },
      {
        rows: [roomRow()],
        assertCall(call) {
          assert.match(call.sql, /INNER JOIN room_saves/);
          assert.match(call.sql, /WHERE rs\.client_id = \$1/);
          assert.deepEqual(call.params, ['client-2']);
        },
      },
      {
        rowCount: 1,
        assertCall(call) {
          assert.match(call.sql, /DELETE FROM room_saves/);
          assert.deepEqual(call.params, ['room-1', 'client-2']);
        },
      },
    ]);
    const store = new PostgresStore(pool, logger as any);

    assert.deepEqual(await store.saveRoomForUser('room-1', 'client-2', '2026-05-03T00:02:00.000Z'), room());
    assert.deepEqual(await store.readSavedRoomsByUser('client-2'), [room()]);
    assert.equal(await store.removeSavedRoomForUser('room-1', 'client-2'), true);
  });

  it('persists media assets and attaches public metadata to media messages', async () => {
    const mediaAssetRow = {
      id: 'asset-1',
      room_id: 'room-1',
      message_id: 'media-message',
      object_key: 'rooms/room-1/media/image/asset-1',
      kind: 'image',
      mime_type: 'image/webp',
      byte_size: 123,
      width: 10,
      height: 20,
      duration_ms: null,
      uploaded_by_client_id: 'client-1',
      created_at: '2026-05-03T00:00:00.000Z',
    };
    const mediaMessageRow = {
      id: 'media-message',
      room_id: 'room-1',
      client_id: 'client-1',
      content: '',
      timestamp: '2026-05-03T00:00:01.000Z',
      message_type: 'media',
      username: null,
      avatar: null,
      mime_type: 'image/webp',
      status: null,
      ai_model: null,
      usage: null,
      cost: null,
      reply_to: null,
    };
    const pool = new ScriptedPool([
      {
        rows: [mediaAssetRow],
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO media_assets/);
          assert.equal(call.params?.[0], 'asset-1');
          assert.equal(call.params?.[3], 'rooms/room-1/media/image/asset-1');
          assert.equal(call.params?.[4], 'image');
        },
      },
      { rows: [mediaAssetRow], assertCall: call => assert.match(call.sql, /WHERE id = \$1/) },
      { rows: [mediaAssetRow], assertCall: call => assert.match(call.sql, /WHERE message_id = \$1/) },
      { rows: [mediaAssetRow], assertCall: call => assert.match(call.sql, /WHERE room_id = \$1/) },
      { rows: [mediaMessageRow] },
      { rows: [mediaAssetRow] },
      { rowCount: 1, assertCall: call => assert.match(call.sql, /DELETE FROM media_assets WHERE id = \$1/) },
    ]);
    const store = new PostgresStore(pool, logger as any);
    const asset = {
      id: 'asset-1',
      roomId: 'room-1',
      messageId: 'media-message',
      objectKey: 'rooms/room-1/media/image/asset-1',
      kind: 'image' as const,
      mimeType: 'image/webp',
      byteSize: 123,
      width: 10,
      height: 20,
      uploadedByClientId: 'client-1',
      createdAt: '2026-05-03T00:00:00.000Z',
    };

    assert.deepEqual(await store.saveMediaAsset(asset), asset);
    assert.deepEqual(await store.getMediaAsset('asset-1'), asset);
    assert.deepEqual(await store.getMediaAssetByMessageId('media-message'), asset);
    assert.deepEqual(await store.readMediaAssetsByRoom('room-1'), [asset]);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [{
      id: 'media-message',
      clientId: 'client-1',
      content: '',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'media',
      mimeType: 'image/webp',
      mediaAsset: {
        id: 'asset-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
        width: 10,
        height: 20,
      },
    }]);
    await store.deleteMediaAsset('asset-1');
  });

  it('replaces legacy image message payloads with media asset metadata without changing room activity', async () => {
    const asset = {
      id: 'asset-legacy',
      roomId: 'room-1',
      messageId: 'legacy-image',
      objectKey: 'rooms/room-1/media/image/asset-legacy',
      kind: 'image' as const,
      mimeType: 'image/webp',
      byteSize: 456,
      width: 12,
      height: 14,
      createdAt: '2026-05-03T00:00:11.000Z',
    };
    const imageMessageRow = {
      id: 'legacy-image',
      room_id: 'room-1',
      client_id: 'client-1',
      content: '',
      timestamp: '2026-05-03T00:00:01.000Z',
      message_type: 'media',
      username: null,
      avatar: null,
      mime_type: 'image/webp',
      status: null,
      ai_model: null,
      usage: null,
      cost: null,
      reply_to: null,
    };
    const mediaAssetRow = {
      id: 'asset-legacy',
      room_id: 'room-1',
      message_id: 'legacy-image',
      object_key: 'rooms/room-1/media/image/asset-legacy',
      kind: 'image',
      mime_type: 'image/webp',
      byte_size: 456,
      width: 12,
      height: 14,
      duration_ms: null,
      uploaded_by_client_id: null,
      created_at: '2026-05-03T00:00:11.000Z',
    };
    const client = new ScriptedClient([
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'BEGIN') },
      { rows: [roomRow({ last_activity_at: '2026-05-03T00:00:10.000Z' })] },
      {
        rows: [imageMessageRow],
        assertCall(call) {
          assert.match(call.sql, /UPDATE room_messages/);
          assert.match(call.sql, /message_type = 'media'/);
          assert.deepEqual(call.params, ['room-1', 'legacy-image', '', 'image/webp']);
        },
      },
      {
        rows: [mediaAssetRow],
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO media_assets/);
          assert.deepEqual(call.params, [
            'asset-legacy',
            'room-1',
            'legacy-image',
            'rooms/room-1/media/image/asset-legacy',
            'image',
            'image/webp',
            456,
            12,
            14,
            null,
            null,
            '2026-05-03T00:00:11.000Z',
          ]);
        },
      },
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'COMMIT') },
    ]);
    const pool = new ScriptedPool([], client);
    const store = new PostgresStore(pool, logger as any);

    assert.deepEqual(await store.replaceMessageMediaAsset('room-1', 'legacy-image', asset), {
      room: room({ lastActivityAt: '2026-05-03T00:00:10.000Z' }),
      found: true,
      updatedMessage: {
        id: 'legacy-image',
        clientId: 'client-1',
        content: '',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:01.000Z',
        messageType: 'media',
        mimeType: 'image/webp',
        mediaAsset: {
          id: 'asset-legacy',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          width: 12,
          height: 14,
        },
      },
    });
    assert.equal(client.calls.some(call => /UPDATE rooms/.test(call.sql)), false);
    assert.equal(client.released, true);
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
          assert.equal(call.params?.[5], null);
          assert.equal(call.params?.[15], 2);
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

  it('appends media messages and assets in one transaction with the message inserted first', async () => {
    const client = new ScriptedClient([
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'BEGIN') },
      { rows: [roomRow()] },
      { rows: [{ position: '4' }] },
      {
        rowCount: 1,
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO room_messages/);
          assert.equal(call.params?.[0], 'message-1');
          assert.equal(call.params?.[6], 'media');
          assert.equal(call.params?.[9], 'image/webp');
          assert.equal(call.params?.[15], 4);
        },
      },
      {
        rows: [{
          id: 'asset-1',
          room_id: 'room-1',
          message_id: 'message-1',
          object_key: 'rooms/room-1/media/image/asset-1',
          kind: 'image',
          mime_type: 'image/webp',
          byte_size: 123,
          width: 20,
          height: 10,
          duration_ms: null,
          uploaded_by_client_id: 'client-1',
          created_at: '2026-05-04T00:00:00.000Z',
        }],
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO media_assets/);
          assert.equal(call.params?.[0], 'asset-1');
          assert.equal(call.params?.[2], 'message-1');
        },
      },
      { rows: [roomRow({ last_activity_at: '2026-05-04T00:00:00.000Z' })] },
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'COMMIT') },
    ]);
    const pool = new ScriptedPool([], client);
    const store = new PostgresStore(pool, logger as any);

    const result = await store.appendMediaMessageWithAsset(
      message({ content: '', messageType: 'media', mimeType: 'image/webp' }),
      mediaAsset({ width: 20, height: 10, uploadedByClientId: 'client-1' })
    );

    assert.deepEqual(result, {
      room: room({ lastActivityAt: '2026-05-04T00:00:00.000Z' }),
      message: message({
        content: '',
        messageType: 'media',
        mimeType: 'image/webp',
        mediaAsset: {
          id: 'asset-1',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 123,
          width: 20,
          height: 10,
        },
      }),
      asset: mediaAsset({ width: 20, height: 10, uploadedByClientId: 'client-1' }),
    });
    const messageInsertIndex = client.calls.findIndex(call => /INSERT INTO room_messages/.test(call.sql));
    const assetInsertIndex = client.calls.findIndex(call => /INSERT INTO media_assets/.test(call.sql));
    assert.ok(messageInsertIndex >= 0);
    assert.ok(assetInsertIndex > messageInsertIndex);
    assert.equal(pool.connectCalls, 1);
    assert.equal(client.released, true);
  });

  it('rolls back the media message transaction when media asset insertion fails', async () => {
    const errors: any[] = [];
    const testLogger = {
      ...logger,
      error(message: string, payload: any) {
        errors.push({ message, payload });
      },
    };
    const client = new ScriptedClient([
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'BEGIN') },
      { rows: [roomRow()] },
      { rows: [{ position: '0' }] },
      {
        rowCount: 1,
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO room_messages/);
        },
      },
      {
        error: new Error('foreign key or asset insert failed'),
        assertCall(call) {
          assert.match(call.sql, /INSERT INTO media_assets/);
        },
      },
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'ROLLBACK') },
    ]);
    const pool = new ScriptedPool([], client);
    const store = new PostgresStore(pool, testLogger as any);

    assert.equal(
      await store.appendMediaMessageWithAsset(
        message({ content: '', messageType: 'media', mimeType: 'image/webp' }),
        mediaAsset()
      ),
      null
    );
    assert.equal(client.calls[client.calls.length - 1]?.sql, 'ROLLBACK');
    assert.equal(client.calls.some(call => /UPDATE rooms/.test(call.sql)), false);
    assert.equal(client.released, true);
    assert.equal(errors[0].message, 'Error appending PostgreSQL media message and asset');
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
          assert.equal(call.params?.[5], null);
          assert.equal(call.params?.[15], 3);
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
      replyTo: {
        messageId: 'm1',
        username: 'Ada',
        messageType: 'text',
        preview: 'question',
      },
    });
    const client = new ScriptedClient([
      { rowCount: 0 },
      { rows: [roomRow()] },
      { rowCount: 1, assertCall: call => assert.match(call.sql, /DELETE FROM room_messages/) },
      {
        rowCount: 1,
        assertCall(call) {
          assert.equal(call.params?.[14], JSON.stringify(aiMessage.replyTo));
          assert.equal(call.params?.[15], 0);
        },
      },
      { rows: [roomRow({ last_activity_at: '2026-05-04T00:00:00.000Z' })] },
      { rowCount: 0 },
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'BEGIN') },
      { rows: [], assertCall: call => assert.match(call.sql, /DELETE FROM media_assets WHERE room_id = \$1 RETURNING object_key/) },
      { rowCount: 2, assertCall: call => assert.match(call.sql, /DELETE FROM room_messages/) },
      { rowCount: 1, assertCall: call => assert.match(call.sql, /message_version = message_version \+ 1/) },
      { rowCount: 0, assertCall: call => assert.equal(call.sql, 'COMMIT') },
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
          reply_to: aiMessage.replyTo,
        }],
      },
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
      {
        rows: [{ total_usd: '1.5' }],
        assertCall(call) {
          assert.match(call.sql, /total_usd = EXCLUDED\.total_usd/);
          assert.deepEqual(call.params, ['room-1', 1.5]);
        },
      },
      {
        rowCount: 1,
        assertCall(call) {
          assert.match(call.sql, /DELETE FROM room_ai_cost_totals/);
          assert.deepEqual(call.params, ['room-1']);
        },
      },
      { rowCount: 0, assertCall: call => assert.match(call.sql, /TRUNCATE room_ai_cost_totals/) },
      { rowCount: 2, assertCall: call => assert.match(call.sql, /WHERE status = 'streaming'/) },
    ]);
    const store = new PostgresStore(pool, logger as any);

    assert.deepEqual(await store.incrementRoomAICost('room-1', null), { roomId: 'room-1', currency: 'USD', totalUsd: 0 });
    assert.deepEqual(await store.incrementRoomAICost('room-1', cost(0.25)), { roomId: 'room-1', currency: 'USD', totalUsd: 0.25 });
    assert.deepEqual(await store.setRoomAICostTotal('room-1', 1.5), { roomId: 'room-1', currency: 'USD', totalUsd: 1.5 });
    assert.deepEqual(await store.setRoomAICostTotal('room-1', 0), { roomId: 'room-1', currency: 'USD', totalUsd: 0 });
    await store.resetAllDataForTests();
    assert.equal(await store.failInterruptedStreamingMessages('Response interrupted.'), 2);
  });
});
