import assert from 'assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MediaAsset, Message, Room, RoomAgentTurn } from '../types';
import { createPostgresPool } from './postgresPool';
import { POSTGRES_MIGRATIONS, POSTGRES_SCHEMA_SQL } from './postgresSchema';
import { PostgresPool, PostgresStore } from './postgresStore';
import { getAIStreamFence, getAIStreamOwnerId, withAIStreamRecoveryMetadata } from '../services/aiStreamRecovery';
import { PostgresMigrationTarget, RedisDurableGlobalData } from '../scripts/migrateRedisToPostgres';
import {
  RoomEventCursorAheadError,
  RoomEventCursorExpiredError,
  RoomEventPayloadInvalidError,
  RoomEventTooLargeError,
  RoomPaginationBoundaryExpiredError,
} from './store';

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const requireSafeTestDatabaseUrl = () => {
  const value = process.env.ROOM_EVENT_TEST_DATABASE_URL;
  if (!value) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('ROOM_EVENT_TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('ROOM_EVENT_TEST_DATABASE_URL must use postgres:// or postgresql://.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!/(^|[_-])(test|e2e)([_-]|$)/i.test(databaseName)) {
    throw new Error(
      `Refusing PostgreSQL integration tests against database "${databaseName || '(missing)'}"; its name must contain a separated test/e2e token.`,
    );
  }
  return value;
};

const databaseUrl = requireSafeTestDatabaseUrl();
const createdAt = '2026-07-20T12:00:00.000Z';

const room = (id: string): Room => ({
  id,
  name: `Room ${id}`,
  description: '',
  createdAt,
  lastActivityAt: createdAt,
  creatorId: 'event-test-owner',
});

const message = (
  roomId: string,
  id: string,
  overrides: Partial<Message> = {},
): Message => ({
  id,
  roomId,
  clientId: 'event-test-owner',
  clientMessageId: `client-${id}`,
  content: id,
  timestamp: '2026-07-20T12:01:00.000Z',
  messageType: 'text',
  ...overrides,
});

const assistantTestModel = {
  id: 'test-model',
  apiModel: 'test-model',
  provider: 'openai' as const,
  label: 'Test Model',
  description: 'PostgreSQL integration test model',
  pricing: {
    currency: 'USD' as const,
    inputPerMillion: 1,
    outputPerMillion: 1,
  },
};

const assistantMessageModel = {
  id: assistantTestModel.id,
  apiModel: assistantTestModel.apiModel,
  provider: assistantTestModel.provider,
  label: assistantTestModel.label,
};

const assistantRequest = (roomId: string, contextId = 'context-message') => ({
  schemaVersion: 1 as const,
  model: assistantTestModel,
  roleName: 'AI Assistant',
  systemPrompt: 'Be helpful.',
  contextMessages: [message(roomId, contextId)],
});

const emptyRedisGlobalData = (): RedisDurableGlobalData => ({
  pendingMediaUploads: [],
  audioTranscriptions: [],
  assistantRuns: [],
  outboxEvents: [],
  pushSubscriptions: [],
  accounts: [],
  clientPasswords: [],
  clientAuthTokens: [],
  clientNicknames: [],
  codexConnections: [],
  githubConnections: [],
});

const mediaAsset = (roomId: string, messageId: string): MediaAsset => ({
  id: `asset-${messageId}`,
  roomId,
  messageId,
  objectKey: `rooms/${roomId}/${messageId}.png`,
  kind: 'image',
  mimeType: 'image/png',
  byteSize: 1234,
  filename: 'immutable.png',
  width: 640,
  height: 480,
  uploadedByClientId: 'event-test-owner',
  createdAt,
});

const turn = (roomId: string, status: RoomAgentTurn['status'], updatedAt: string): RoomAgentTurn => ({
  id: 'turn-1',
  roomId,
  status,
  startedAt: createdAt,
  ...(status === 'running' ? {} : { completedAt: updatedAt }),
  backend: 'code-agent',
  assistantName: 'Coco',
  updatedAt,
});

describe('PostgreSQL room event integration', { skip: !databaseUrl }, () => {
  let pool: PostgresPool;
  let store: PostgresStore;

  before(async () => {
    pool = createPostgresPool(databaseUrl!, logger as any);
    store = new PostgresStore(pool, logger as any);
    await store.initializeSchema();
    await store.verifySchema();
  });

  beforeEach(async () => {
    await store.resetAllDataForTests();
  });

  after(async () => {
    await pool?.end?.();
  });

  it('builds one repeatable snapshot boundary and drops the retired version columns', async () => {
    const roomId = 'event-snapshot-room';
    assert.ok(await store.saveRoom(room(roomId)));
    assert.ok(await store.appendMessage(message(roomId, 'message-1')));

    const snapshot = await store.readRoomSnapshot(roomId);
    assert.equal(snapshot.room.id, roomId);
    assert.deepEqual(snapshot.messages.map(item => item.id), ['message-1']);
    assert.deepEqual(snapshot.messages.map(item => item.position), [0]);
    assert.equal(snapshot.snapshotSeq, 3);

    const page = await store.readRoomEvents(roomId, { afterSeq: 0, limit: 100 });
    assert.deepEqual(page.events.map(event => [event.seq, event.type]), [
      [1, 'room.updated'],
      [2, 'members.changed'],
      [3, 'messages.upserted'],
    ]);
    assert.equal(page.events[2].payload.messages?.[0]?.content, 'message-1');
    assert.equal(page.events[2].payload.messages?.[0]?.position, 0);
    assert.ok(page.events.every(event => event.schemaVersion === 1));

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'rooms'
        AND column_name IN ('message_version', 'room_version')`,
    );
    assert.deepEqual(columns.rows, []);
  });

  it('emits idempotent upsert, edit, and delete deltas from committed canonical writes', async () => {
    const roomId = 'event-mutation-room';
    assert.ok(await store.saveRoom(room(roomId)));
    const initialHead = await store.readRoomEventHead(roomId);

    const first = await store.appendMessageIdempotent(message(roomId, 'message-1', {
      clientMessageId: 'stable-retry-key',
      content: 'original',
    }));
    assert.equal(first?.inserted, true);
    const afterInsert = await store.readRoomEventHead(roomId);
    assert.equal(afterInsert, initialHead + 1);

    const retry = await store.appendMessageIdempotent(message(roomId, 'message-retry', {
      clientMessageId: 'stable-retry-key',
      content: 'must-not-win',
    }));
    assert.equal(retry?.inserted, false);
    assert.equal(retry?.message.id, 'message-1');
    assert.equal(await store.readRoomEventHead(roomId), afterInsert);

    const edited = await store.updateMessageContent(roomId, 'message-1', 'edited');
    assert.equal(edited?.found, true);
    const editPage = await store.readRoomEvents(roomId, { afterSeq: afterInsert, limit: 10 });
    assert.equal(editPage.events.length, 1);
    assert.equal(editPage.events[0].type, 'messages.upserted');
    assert.equal(editPage.events[0].payload.messages?.[0]?.content, 'edited');

    const deleted = await store.deleteMessageById(roomId, 'message-1');
    assert.equal(deleted?.deleted, true);
    const deletePage = await store.readRoomEvents(roomId, {
      afterSeq: editPage.events[0].seq,
      limit: 10,
    });
    assert.equal(deletePage.events.length, 1);
    assert.equal(deletePage.events[0].type, 'messages.deleted');
    assert.deepEqual(deletePage.events[0].payload.messageIds, ['message-1']);
  });

  it('rejects moving an existing message ID to another room without emitting ghost events', async () => {
    const sourceRoomId = 'event-message-source-room';
    const targetRoomId = 'event-message-target-room';
    assert.ok(await store.saveRoom(room(sourceRoomId)));
    assert.ok(await store.saveRoom(room(targetRoomId)));
    assert.ok(await store.appendMessage(message(sourceRoomId, 'fixed-room-message')));
    const sourceHead = await store.readRoomEventHead(sourceRoomId);
    const targetHead = await store.readRoomEventHead(targetRoomId);

    const moved = await store.upsertMessage(message(targetRoomId, 'fixed-room-message', {
      content: 'must not move',
    }));

    assert.equal(moved, null);
    assert.deepEqual((await store.readMessagesByRoom(sourceRoomId)).map(item => item.id), ['fixed-room-message']);
    assert.deepEqual(await store.readMessagesByRoom(targetRoomId), []);
    assert.equal(await store.readRoomEventHead(sourceRoomId), sourceHead);
    assert.equal(await store.readRoomEventHead(targetRoomId), targetHead);
  });

  it('timestamps retained events at materialization time instead of transaction start', async () => {
    const roomId = 'event-wall-clock-room';
    assert.ok(await store.saveRoom(room(roomId)));
    const baselineHead = await store.readRoomEventHead(roomId);
    const client = await pool.connect();
    let transactionStartedAt = 0;
    try {
      await client.query('BEGIN');
      const started = await client.query<{ started_at: string | Date }>(
        'SELECT transaction_timestamp() AS started_at',
      );
      transactionStartedAt = new Date(started.rows[0].started_at).getTime();
      await new Promise(resolve => setTimeout(resolve, 30));
      await client.query('UPDATE rooms SET name = $2 WHERE id = $1', [roomId, 'wall-clock update']);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const rows = await pool.query<{ created_at: string | Date }>(
      'SELECT created_at FROM room_events WHERE room_id = $1 AND seq > $2 ORDER BY seq',
      [roomId, baselineHead],
    );
    assert.equal(rows.rows.length, 1);
    assert.ok(new Date(rows.rows[0].created_at).getTime() - transactionStartedAt >= 20);
  });

  it('accepts an empty-content streaming AI placeholder as a valid strict payload', async () => {
    const roomId = 'event-ai-placeholder-room';
    assert.ok(await store.saveRoom(room(roomId)));
    const baselineHead = await store.readRoomEventHead(roomId);
    assert.ok(await store.appendMessage(message(roomId, 'ai-placeholder', {
      clientId: 'ai_assistant',
      clientMessageId: undefined,
      content: '',
      messageType: 'ai',
      status: 'streaming',
    })));

    const page = await store.readRoomEvents(roomId, { afterSeq: baselineHead, limit: 10 });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].payload.messages?.[0]?.content, '');
    assert.equal(page.events[0].payload.messages?.[0]?.status, 'streaming');
  });

  it('keeps committed message after-images immutable after later edits and deletion', async () => {
    const roomId = 'event-immutable-message-room';
    assert.ok(await store.saveRoom(room(roomId)));
    const baselineHead = await store.readRoomEventHead(roomId);

    assert.ok(await store.appendMessage(message(roomId, 'immutable-message', { content: 'A' })));
    assert.ok(await store.updateMessageContent(roomId, 'immutable-message', 'B'));

    const beforeDelete = await store.readRoomEvents(roomId, { afterSeq: baselineHead, limit: 10 });
    assert.deepEqual(
      beforeDelete.events.map(event => event.payload.messages?.[0]?.content),
      ['A', 'B'],
    );

    assert.equal((await store.deleteMessageById(roomId, 'immutable-message'))?.deleted, true);
    const afterDelete = await store.readRoomEvents(roomId, { afterSeq: baselineHead, limit: 10 });
    assert.deepEqual(
      afterDelete.events.slice(0, 2).map(event => event.payload.messages?.[0]?.content),
      ['A', 'B'],
    );
    assert.deepEqual(afterDelete.events[2].payload.messageIds, ['immutable-message']);
  });

  it('keeps each room and agent-turn after-image at its own commit state', async () => {
    const roomId = 'event-immutable-room-turn';
    assert.ok(await store.saveRoom(room(roomId)));
    const baselineHead = await store.readRoomEventHead(roomId);

    await pool.query('UPDATE rooms SET name = $2 WHERE id = $1', [roomId, 'First name']);
    await pool.query('UPDATE rooms SET name = $2 WHERE id = $1', [roomId, 'Second name']);
    assert.ok(await store.upsertRoomAgentTurn(turn(roomId, 'running', '2026-07-20T12:02:00.000Z')));
    assert.ok(await store.upsertRoomAgentTurn(turn(roomId, 'complete', '2026-07-20T12:03:00.000Z')));

    const page = await store.readRoomEvents(roomId, { afterSeq: baselineHead, limit: 20 });
    const roomEvents = page.events.filter(event => event.type === 'room.updated');
    assert.deepEqual(roomEvents.map(event => event.payload.room?.name), ['First name', 'Second name']);
    const turnEvents = page.events.filter(event => event.type === 'agent_turns.upserted');
    assert.deepEqual(turnEvents.map(event => event.payload.turns?.[0]?.status), ['running', 'complete']);

    await pool.query("UPDATE room_agent_turns SET status = 'error', updated_at = NOW() WHERE room_id = $1", [roomId]);
    const reread = await store.readRoomEvents(roomId, { afterSeq: baselineHead, limit: 20 });
    assert.deepEqual(
      reread.events.filter(event => event.type === 'agent_turns.upserted').slice(0, 2)
        .map(event => event.payload.turns?.[0]?.status),
      ['running', 'complete'],
    );
  });

  it('stores stable media metadata without internal object keys or expiring URLs', async () => {
    const roomId = 'event-media-room';
    const messageId = 'media-message';
    assert.ok(await store.saveRoom(room(roomId)));
    const baselineHead = await store.readRoomEventHead(roomId);

    // A future canonical-only column must not be copied automatically into the
    // event protocol. The writer uses an explicit safe DTO allowlist.
    await pool.query('ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS event_test_internal_secret TEXT');

    const saved = await store.appendMediaMessageWithAsset(
      message(roomId, messageId, { messageType: 'media', content: 'asset' }),
      mediaAsset(roomId, messageId),
    );
    assert.ok(saved);
    await pool.query(
      'UPDATE room_messages SET event_test_internal_secret = $3 WHERE room_id = $1 AND id = $2',
      [roomId, messageId, 'must-never-enter-room-events'],
    );

    const page = await store.readRoomEvents(roomId, { afterSeq: baselineHead, limit: 10 });
    const event = page.events.find(candidate => candidate.type === 'messages.upserted');
    assert.equal(event?.payload.messages?.[0]?.mediaAsset?.id, `asset-${messageId}`);
    assert.equal(event?.payload.messages?.[0]?.mediaAsset?.byteSize, 1234);
    assert.equal(event?.payload.messages?.[0]?.mediaAsset?.width, 640);

    const raw = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM room_events
      WHERE room_id = $1 AND event_type = 'messages.upserted'
      ORDER BY seq DESC LIMIT 1`,
      [roomId],
    );
    const serialized = JSON.stringify(raw.rows[0].payload);
    assert.doesNotMatch(serialized, /object_key|rooms\/event-media-room|https?:\/\//i);
    assert.doesNotMatch(serialized, /uploaded_by_client_id|ai_stream_owner_id/i);
    assert.doesNotMatch(serialized, /event_test_internal_secret|must-never-enter-room-events/i);
  });

  it('stores a safe room after-image without password hashes', async () => {
    const roomId = 'event-safe-room';
    assert.ok(await store.saveRoom(room(roomId)));
    await pool.query('UPDATE rooms SET password_hash = $2 WHERE id = $1', [roomId, 'hashed-secret-value']);

    const raw = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM room_events
      WHERE room_id = $1 AND event_type = 'room.updated'
      ORDER BY seq DESC LIMIT 1`,
      [roomId],
    );
    const serialized = JSON.stringify(raw.rows[0].payload);
    assert.doesNotMatch(serialized, /password_hash|hashed-secret-value/i);
    const page = await store.readRoomEvents(roomId, { afterSeq: 0, limit: 10 });
    assert.equal(page.events.filter(event => event.type === 'room.updated').at(-1)?.payload.room?.hasPassword, true);
  });

  it('sequences public membership change signals without exposing member IDs or roles', async () => {
    const roomId = 'event-membership-room';
    assert.ok(await store.saveRoom(room(roomId)));
    const baselineHead = await store.readRoomEventHead(roomId);

    await pool.query(
      `INSERT INTO room_members (room_id, client_id, role, joined_at)
      VALUES ($1, 'member-2', 'member', NOW())`,
      [roomId],
    );
    await pool.query(
      "UPDATE room_members SET role = 'admin' WHERE room_id = $1 AND client_id = 'member-2'",
      [roomId],
    );
    await pool.query(
      "DELETE FROM room_members WHERE room_id = $1 AND client_id = 'member-2'",
      [roomId],
    );

    const page = await store.readRoomEvents(roomId, { afterSeq: baselineHead, limit: 10 });
    assert.deepEqual(page.events.map(event => event.type), [
      'members.changed',
      'members.changed',
      'members.changed',
    ]);
    assert.ok(page.events.every(event => Object.keys(event.payload).length === 0));

    const raw = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM room_events
      WHERE room_id = $1 AND event_type = 'members.changed' AND seq > $2
      ORDER BY seq`,
      [roomId, baselineHead],
    );
    assert.equal(raw.rows.length, 3);
    assert.doesNotMatch(JSON.stringify(raw.rows), /member-2|admin|joined_at|client_id/i);
  });

  it('rejects malformed stored payloads instead of acknowledging an empty event', async () => {
    const roomId = 'event-invalid-payload-room';
    assert.ok(await store.saveRoom(room(roomId)));
    const inserted = await pool.query<{ head_seq: number | string }>(
      `UPDATE room_event_streams
      SET head_seq = head_seq + 1
      WHERE room_id = $1
      RETURNING head_seq`,
      [roomId],
    );
    const invalidSeq = Number(inserted.rows[0].head_seq);
    await pool.query(
      `INSERT INTO room_events (room_id, seq, event_type, schema_version, payload)
      VALUES ($1, $2, 'messages.upserted', 1, $3::jsonb)`,
      [roomId, invalidSeq, JSON.stringify({ messageRows: [], mediaAssets: [] })],
    );

    await assert.rejects(
      store.readRoomEvents(roomId, { afterSeq: invalidSeq - 1, limit: 10 }),
      (error: unknown) => (
        error instanceof RoomEventPayloadInvalidError
        && error.roomId === roomId
        && error.seq === invalidSeq
      ),
    );
    await assert.rejects(
      store.readRoomEvent(roomId, invalidSeq),
      (error: unknown) => error instanceof RoomEventPayloadInvalidError,
    );
  });

  it('rolls event writes back with domain writes and serializes concurrent room writers', async () => {
    const roomId = 'event-transaction-room';
    assert.ok(await store.saveRoom(room(roomId)));
    assert.ok(await store.appendMessage(message(roomId, 'message-original', { content: 'before' })));
    const baselineHead = await store.readRoomEventHead(roomId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE room_messages SET content = $3 WHERE room_id = $1 AND id = $2',
        [roomId, 'message-original', 'rolled-back'],
      );
      const inside = await client.query<{ head_seq: string | number }>(
        'SELECT head_seq FROM room_event_streams WHERE room_id = $1',
        [roomId],
      );
      assert.equal(Number(inside.rows[0].head_seq), baselineHead);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    assert.equal(await store.readRoomEventHead(roomId), baselineHead);
    assert.equal((await store.readMessagesByRoom(roomId))[0].content, 'before');

    await Promise.all(Array.from({ length: 8 }, (_, index) => store.appendMessage(message(
      roomId,
      `message-concurrent-${index}`,
      {
        clientId: `writer-${index}`,
        clientMessageId: `writer-key-${index}`,
        timestamp: `2026-07-20T12:02:${String(index).padStart(2, '0')}.000Z`,
      },
    ))));

    const page = await store.readRoomEvents(roomId, { afterSeq: baselineHead, limit: 20 });
    assert.equal(page.events.length, 8);
    assert.deepEqual(
      page.events.map(event => event.seq),
      Array.from({ length: 8 }, (_, index) => baselineHead + index + 1),
    );
    assert.ok(page.events.every(event => event.type === 'messages.upserted'));
  });

  it('orders complete room payloads by commit order without a second version counter', async () => {
    const roomId = 'event-room-metadata-order';
    assert.ok(await store.saveRoom(room(roomId)));
    const first = await pool.connect();
    const second = await pool.connect();

    try {
      // Start the transaction that will commit last first. PostgreSQL NOW()
      // would stamp it with the older transaction timestamp and recreate the
      // stale complete-object overwrite that roomVersion previously guarded.
      await first.query('BEGIN');
      await new Promise(resolve => setTimeout(resolve, 10));
      await second.query('BEGIN');
      const committedFirst = await second.query<{ updated_at: string | Date }>(
        `UPDATE rooms SET name = $2, updated_at = NOW()
        WHERE id = $1 RETURNING updated_at`,
        [roomId, 'committed-first'],
      );
      await second.query('COMMIT');

      const committedLast = await first.query<{ updated_at: string | Date }>(
        `UPDATE rooms SET name = $2, updated_at = NOW()
        WHERE id = $1 RETURNING updated_at`,
        [roomId, 'committed-last'],
      );
      await first.query('COMMIT');

      const firstStamp = new Date(committedFirst.rows[0].updated_at).getTime();
      const lastStamp = new Date(committedLast.rows[0].updated_at).getTime();
      assert.ok(lastStamp > firstStamp);
      assert.equal((await store.getRoomById(roomId))?.name, 'committed-last');
      assert.equal(await store.readRoomEventHead(roomId), 4);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('advances the replay floor after retention and forces an expired client to resnapshot', async () => {
    const roomId = 'event-retention-room';
    assert.ok(await store.saveRoom(room(roomId)));
    for (let index = 0; index < 5; index += 1) {
      assert.ok(await store.appendMessage(message(roomId, `retained-message-${index}`)));
    }

    const headSeq = await store.readRoomEventHead(roomId);
    assert.equal(headSeq, 7);
    assert.equal(await store.pruneRoomEvents({
      olderThan: '1970-01-01T00:00:00.000Z',
      maxEventsPerRoom: 2,
    }), 5);

    const retained = await store.readRoomEvents(roomId, { afterSeq: 5, limit: 10 });
    assert.equal(retained.minAvailableSeq, 6);
    assert.deepEqual(retained.events.map(event => event.seq), [6, 7]);
    await assert.rejects(
      store.readRoomEvents(roomId, { afterSeq: 0, limit: 10 }),
      (error: unknown) => error instanceof RoomEventCursorExpiredError
        && error.minAvailableSeq === 6,
    );
    await assert.rejects(
      store.readRoomEvents(roomId, { afterSeq: headSeq + 1, limit: 10 }),
      (error: unknown) => error instanceof RoomEventCursorAheadError
        && error.headSeq === headSeq,
    );
  });

  it('keeps a room deletion tombstone replayable after canonical rows cascade away', async () => {
    const roomId = 'event-deleted-room';
    assert.ok(await store.saveRoom(room(roomId)));
    assert.ok(await store.appendMessage(message(roomId, 'deleted-room-message')));
    const beforeDelete = await store.readRoomEventHead(roomId);

    assert.equal(await store.deleteRoom(roomId, 'event-test-owner'), true);
    assert.equal(await store.getRoomById(roomId), null);
    assert.equal(await store.canReadRoomEvents(roomId, 'event-test-owner'), true);
    assert.equal(await store.canReadRoomEvents(roomId, 'unrelated-client'), false);

    const page = await store.readRoomEvents(roomId, { afterSeq: beforeDelete, limit: 10 });
    const tombstone = page.events.find(event => event.type === 'room.deleted');
    assert.ok(tombstone);
    assert.equal(tombstone.payload.roomId, roomId);
    assert.deepEqual(page.events.map(event => event.type), ['room.deleted']);
  });

  it('jumps directly to the final tombstone for a deleted stream with hundreds of earlier events', async () => {
    const roomId = 'event-deleted-large-stream';
    assert.ok(await store.saveRoom(room(roomId)));
    await pool.query(
      `INSERT INTO room_events (room_id, seq, event_type, schema_version, payload, created_at)
      SELECT $1, seq, 'members.changed', 1, '{}'::jsonb, clock_timestamp()
      FROM generate_series(3, 600) AS seq`,
      [roomId],
    );
    await pool.query(
      'UPDATE room_event_streams SET head_seq = 600 WHERE room_id = $1',
      [roomId],
    );
    assert.equal(await store.deleteRoom(roomId, 'event-test-owner'), true);

    const page = await store.readRoomEvents(roomId, { afterSeq: 0, limit: 100 });

    assert.equal(page.headSeq, 601);
    assert.equal(page.hasMore, false);
    assert.deepEqual(page.events.map(event => [event.seq, event.type]), [[601, 'room.deleted']]);
  });

  it('rejects a first event that exceeds the caller byte budget', async () => {
    const roomId = 'event-too-large-room';
    assert.ok(await store.saveRoom(room(roomId)));
    const beforeMessage = await store.readRoomEventHead(roomId);
    assert.ok(await store.appendMessage(message(roomId, 'oversized-message', {
      content: 'x'.repeat(32 * 1024),
    })));

    await assert.rejects(
      store.readRoomEvents(roomId, { afterSeq: beforeMessage, limit: 10, maxBytes: 16 * 1024 }),
      (error: unknown) => error instanceof RoomEventTooLargeError
        && error.roomId === roomId
        && error.seq === beforeMessage + 1,
    );
  });

  it('reports an expired message pagination boundary explicitly', async () => {
    const roomId = 'pagination-boundary-room';
    assert.ok(await store.saveRoom(room(roomId)));
    assert.ok(await store.appendMessage(message(roomId, 'visible-message')));

    await assert.rejects(
      store.readRoomSnapshot(roomId, { beforeMessageId: 'deleted-message' }),
      (error: unknown) => error instanceof RoomPaginationBoundaryExpiredError
        && error.roomId === roomId
        && error.beforeMessageId === 'deleted-message',
    );
  });

  it('does not recover another live instance turn or sandbox until its lease expires', async () => {
    const roomId = 'leased-code-agent-room';
    const runningTurn = turn(roomId, 'running', '2026-07-21T00:00:00.000Z');
    assert.ok(await store.saveRoom({
      ...room(roomId),
      type: 'codeAgent',
      codeAgentStatus: 'running',
      sandboxStatus: 'ready',
    }));
    assert.ok(await store.upsertRoomAgentTurn(runningTurn));
    const liveLease = await store.acquireCodeAgentRoomLease(
      roomId,
      runningTurn.id,
      'instance-a',
      '2026-07-21T00:00:00.000Z',
      30_000,
    );
    assert.ok(liveLease);

    assert.equal(await store.failInterruptedRoomAgentTurns('2026-07-21T00:00:10.000Z'), 0);
    assert.deepEqual(await store.findInterruptedCodeAgentRooms('2026-07-21T00:00:10.000Z'), []);
    assert.equal(await store.recoverInterruptedCodeAgentRoomStates('2026-07-21T00:00:10.000Z'), 0);

    assert.equal(await store.failInterruptedRoomAgentTurns('2026-07-21T00:00:31.000Z'), 1);
    assert.equal(await store.renewCodeAgentRoomLease(
      roomId,
      runningTurn.id,
      'instance-a',
      '2026-07-21T00:00:31.000Z',
      30_000,
      liveLease?.fence,
    ), null);
    assert.deepEqual(
      (await store.findInterruptedCodeAgentRooms('2026-07-21T00:00:31.000Z')).map(room => room.id),
      [roomId],
    );
    assert.equal(await store.recoverInterruptedCodeAgentRoomStates('2026-07-21T00:00:31.000Z'), 1);
    assert.equal((await store.getRoomById(roomId))?.codeAgentStatus, 'error');
  });

  it('removes an expired room lease before recovering Code Agent room state', async () => {
    const roomId = 'expired-code-agent-room-state';
    assert.ok(await store.saveRoom({
      ...room(roomId),
      type: 'codeAgent',
      codeAgentStatus: 'running',
      sandboxStatus: 'ready',
    }));
    const lease = await store.acquireCodeAgentRoomLease(
      roomId,
      'orphaned-turn',
      'expired-instance',
      '2026-07-21T00:00:00.000Z',
      30_000,
    );
    assert.ok(lease);

    assert.equal(await store.recoverInterruptedCodeAgentRoomStates('2026-07-21T00:00:31.000Z'), 1);
    assert.equal((await store.getRoomById(roomId))?.codeAgentStatus, 'error');
    assert.equal(await store.renewCodeAgentRoomLease(
      roomId,
      'orphaned-turn',
      'expired-instance',
      '2026-07-21T00:00:31.000Z',
      30_000,
      lease?.fence,
    ), null);
  });

  it('atomically starts a code-agent turn and rejects every stale-fence write after takeover', async () => {
    const roomId = 'fenced-code-agent-room';
    const now = new Date().toISOString();
    assert.ok(await store.saveRoom({
      ...room(roomId),
      type: 'codeAgent',
      codeAgentStatus: 'idle',
      sandboxStatus: 'ready',
    }));
    const firstTurn: RoomAgentTurn = {
      ...turn(roomId, 'running', now),
      id: 'fenced-turn-1',
      startedAt: now,
      updatedAt: now,
    };
    const firstPlaceholder = withAIStreamRecoveryMetadata(message(roomId, 'fenced-ai-1', {
      clientId: 'ai_assistant',
      clientMessageId: undefined,
      messageType: 'ai',
      status: 'streaming',
      content: '',
      turnId: firstTurn.id,
    }), 'stream-owner-1');
    const first = await store.beginCodeAgentTurn({
      roomId,
      turn: firstTurn,
      placeholder: firstPlaceholder,
      ownerId: 'instance-1',
      now,
      leaseTtlMs: 60_000,
    });
    assert.equal(first.outcome, 'started');
    if (first.outcome !== 'started') return;
    assert.equal((await store.getRoomById(roomId))?.codeAgentStatus, 'running');
    assert.deepEqual((await store.readMessagesByRoom(roomId)).map(item => item.id), ['fenced-ai-1']);
    assert.deepEqual((await store.readRoomAgentTurns(roomId)).map(item => item.id), ['fenced-turn-1']);

    await pool.query(
      `UPDATE code_agent_room_leases
      SET expires_at = clock_timestamp() - interval '1 second'
      WHERE room_id = $1`,
      [roomId],
    );
    const secondNow = new Date().toISOString();
    const secondTurn: RoomAgentTurn = {
      ...turn(roomId, 'running', secondNow),
      id: 'fenced-turn-2',
      startedAt: secondNow,
      updatedAt: secondNow,
    };
    const secondPlaceholder = withAIStreamRecoveryMetadata(message(roomId, 'fenced-ai-2', {
      clientId: 'ai_assistant',
      clientMessageId: undefined,
      messageType: 'ai',
      status: 'streaming',
      content: '',
      turnId: secondTurn.id,
    }), 'stream-owner-2');
    const second = await store.beginCodeAgentTurn({
      roomId,
      turn: secondTurn,
      placeholder: secondPlaceholder,
      ownerId: 'instance-2',
      now: secondNow,
      leaseTtlMs: 60_000,
    });
    assert.equal(second.outcome, 'started');
    if (second.outcome !== 'started') return;

    const staleClaim = {
      roomId,
      turnId: firstTurn.id,
      ownerId: first.lease.ownerId,
      fence: first.lease.fence,
    };
    assert.deepEqual(
      await store.appendCodeAgentMessage(message(roomId, 'stale-tool', {
        messageType: 'tool_call',
        turnId: firstTurn.id,
      }), staleClaim),
      { outcome: 'stale' },
    );
    assert.equal(await store.updateCodeAgentTurn({
      ...firstTurn,
      phase: 'running',
      updatedAt: new Date().toISOString(),
    }, staleClaim), null);
    assert.deepEqual(await store.finishCodeAgentTurn({
      claim: staleClaim,
      outcome: 'complete',
      completedAt: new Date().toISOString(),
    }), { outcome: 'stale' });
    assert.equal((await store.readMessagesByRoom(roomId)).some(item => item.id === 'stale-tool'), false);
  });

  it('persists checkpoint boundaries and commits a fenced context restore atomically', async () => {
    const roomId = 'checkpoint-restore-room';
    const turnId = 'checkpoint-turn';
    const now = new Date().toISOString();
    assert.ok(await store.saveRoom({
      ...room(roomId),
      type: 'codeAgent',
      codeAgentBackend: 'codex-app-server',
      codeAgentStatus: 'idle',
      sandboxStatus: 'ready',
      codeAgentSessionId: 'thread-before',
      codeAgentLastTurnId: 'codex-turn-before',
    }));
    const runningTurn: RoomAgentTurn = {
      ...turn(roomId, 'running', now),
      id: turnId,
      backend: 'codex-app-server',
      assistantName: 'Codex',
      startedAt: now,
      updatedAt: now,
    };
    const placeholder = withAIStreamRecoveryMetadata(message(roomId, 'checkpoint-ai', {
      clientId: 'ai_assistant',
      clientMessageId: undefined,
      messageType: 'ai',
      status: 'streaming',
      content: '',
      turnId,
    }), 'checkpoint-stream-owner');
    const started = await store.beginCodeAgentTurn({
      roomId,
      turn: runningTurn,
      placeholder,
      ownerId: 'checkpoint-instance',
      now,
      leaseTtlMs: 60_000,
      captureWorkspaceRevision: true,
      backendSessionIdBefore: 'thread-before',
      backendLastTurnIdBefore: 'codex-turn-before',
    });
    assert.equal(started.outcome, 'started');
    if (started.outcome !== 'started') return;
    const checkpoint = {
      schemaVersion: 1 as const,
      status: 'ready' as const,
      objectKey: `code-agent-checkpoints/v1/${roomId}/${turnId}.tar.gz`,
      archiveByteSize: 123,
      manifest: {
        schemaVersion: 1 as const,
        checkpointId: turnId,
        createdAt: now,
        totalArchiveBytes: 42,
        files: [{
          path: 'src/App.tsx',
          beforeExists: true,
          afterExists: true,
          beforeSha256: 'a'.repeat(64),
          afterSha256: 'b'.repeat(64),
          beforeByteSize: 10,
          afterByteSize: 12,
          beforeMode: 0o644,
          afterMode: 0o644,
          restorable: true,
        }],
      },
    };
    const terminal = await store.finishCodeAgentTurn({
      claim: {
        roomId,
        turnId,
        ownerId: started.lease.ownerId,
        fence: started.lease.fence,
      },
      outcome: 'complete',
      completedAt: new Date().toISOString(),
      sessionId: 'thread-after',
      backendTurnId: 'codex-turn-after',
      workspaceCheckpoint: checkpoint,
      deleteMessageIds: [placeholder.id],
    });
    assert.equal(terminal.outcome, 'applied');
    const stored = await store.readCodeAgentWorkspaceCheckpoint(roomId, turnId);
    assert.equal(stored?.backendSessionIdBefore, 'thread-before');
    assert.equal(stored?.backendLastTurnIdBefore, 'codex-turn-before');
    assert.deepEqual(stored?.checkpoint, checkpoint);
    assert.equal((await store.getRoomById(roomId))?.codeAgentLastTurnId, 'codex-turn-after');
    const restorePlan = await store.readCodeAgentCheckpointRestorePlan(roomId, turnId);
    assert.ok(restorePlan);
    assert.equal(restorePlan?.currentRevisionId, `turn:${turnId}`);
    assert.equal(restorePlan?.targetRevisionId, `root:${roomId}`);
    assert.deepEqual(restorePlan?.steps.map(step => [step.turnId, step.direction]), [[turnId, 'before']]);

    assert.equal(await store.hasActiveCodeAgentRoomLease(roomId, new Date().toISOString()), false);
    const restoreLease = await store.acquireCodeAgentRoomLease(
      roomId,
      'checkpoint_restore_1',
      'restore-instance',
      new Date().toISOString(),
      60_000,
    );
    assert.ok(restoreLease);
    assert.equal(await store.hasActiveCodeAgentRoomLease(roomId, new Date().toISOString()), true);
    const committed = await store.commitCodeAgentCheckpointRestore({
      roomId,
      checkpointTurnId: turnId,
      restoreId: 'restore-1',
      restoredByClientId: 'event-test-owner',
      lease: restoreLease!,
      sourceRevisionId: restorePlan!.currentRevisionId,
      targetRevisionId: restorePlan!.targetRevisionId,
      resultRevisionId: 'restore:restore-1',
      targetBoundary: 'before',
      sessionId: 'thread-forked',
      lastTurnId: 'codex-turn-before',
      restoredPaths: ['src/App.tsx'],
      conflictPaths: [],
      unavailablePaths: [],
      restoredAt: new Date().toISOString(),
    });
    assert.equal(committed?.room.codeAgentSessionId, 'thread-forked');
    assert.equal(committed?.room.codeAgentLastTurnId, 'codex-turn-before');
    assert.equal(await store.hasActiveCodeAgentRoomLease(roomId, new Date().toISOString()), false);
    const audit = await pool.query<{
      backend_session_id_after: string;
      restored_paths: string[];
      source_revision_id: string;
      target_revision_id: string;
      result_revision_id: string;
      target_boundary: string;
    }>(
      `SELECT backend_session_id_after, restored_paths,
        source_revision_id, target_revision_id, result_revision_id, target_boundary
      FROM code_agent_checkpoint_restores
      WHERE id = 'restore-1'`,
    );
    assert.equal(audit.rows[0]?.backend_session_id_after, 'thread-forked');
    assert.deepEqual(audit.rows[0]?.restored_paths, ['src/App.tsx']);
    assert.equal(audit.rows[0]?.source_revision_id, `turn:${turnId}`);
    assert.equal(audit.rows[0]?.target_revision_id, `root:${roomId}`);
    assert.equal(audit.rows[0]?.result_revision_id, 'restore:restore-1');
    assert.equal(audit.rows[0]?.target_boundary, 'before');
    const repeatedPlan = await store.readCodeAgentCheckpointRestorePlan(roomId, turnId);
    assert.equal(repeatedPlan?.currentRevisionId, 'restore:restore-1');
    assert.equal(repeatedPlan?.targetRevisionId, `root:${roomId}`);
    assert.equal(repeatedPlan?.alreadyAtTarget, true);
    assert.deepEqual(repeatedPlan?.steps, []);

    const leafPlan = await store.readCodeAgentCheckpointRestorePlan(roomId, turnId, 'after');
    assert.equal(leafPlan?.targetBoundary, 'after');
    assert.equal(leafPlan?.currentRevisionId, 'restore:restore-1');
    assert.equal(leafPlan?.targetRevisionId, `turn:${turnId}`);
    assert.equal(leafPlan?.targetBackendSessionId, 'thread-after');
    assert.equal(leafPlan?.targetBackendLastTurnId, 'codex-turn-after');
    assert.deepEqual(leafPlan?.steps.map(step => [step.turnId, step.direction]), [[turnId, 'after']]);

    const leafLease = await store.acquireCodeAgentRoomLease(
      roomId,
      'checkpoint_restore_2',
      'restore-instance',
      new Date().toISOString(),
      60_000,
    );
    assert.ok(leafLease);
    const leafCommitted = await store.commitCodeAgentCheckpointRestore({
      roomId,
      checkpointTurnId: turnId,
      restoreId: 'restore-2',
      restoredByClientId: 'event-test-owner',
      lease: leafLease!,
      sourceRevisionId: leafPlan!.currentRevisionId,
      targetRevisionId: leafPlan!.targetRevisionId,
      resultRevisionId: 'restore:restore-2',
      targetBoundary: 'after',
      sessionId: 'thread-leaf-forked',
      lastTurnId: 'codex-turn-after',
      restoredPaths: ['src/App.tsx'],
      conflictPaths: [],
      unavailablePaths: [],
      restoredAt: new Date().toISOString(),
    });
    assert.equal(leafCommitted?.revision.parentRevisionId, `turn:${turnId}`);
    assert.equal(leafCommitted?.room.codeAgentSessionId, 'thread-leaf-forked');
    assert.equal(leafCommitted?.room.codeAgentLastTurnId, 'codex-turn-after');
    const leafAudit = await pool.query<{ target_boundary: string }>(
      `SELECT target_boundary FROM code_agent_checkpoint_restores WHERE id = 'restore-2'`,
    );
    assert.equal(leafAudit.rows[0]?.target_boundary, 'after');
  });

  it('clears backend-specific session continuity when the workspace backend changes', async () => {
    const roomId = 'backend-session-switch-room';
    assert.ok(await store.saveRoom({
      ...room(roomId),
      type: 'codeAgent',
      codeAgentBackend: 'hermes-agent',
      codeAgentSessionId: 'acp:hermes-agent:session-1',
      codeAgentLastTurnId: 'hermes-turn-1',
    }));

    const changed = await store.updateRoomSettings(roomId, { codeAgentBackend: 'opencode' });

    assert.equal(changed?.codeAgentBackend, 'opencode');
    assert.equal(changed?.codeAgentSessionId, undefined);
    assert.equal(changed?.codeAgentLastTurnId, undefined);
  });

  it('reads exact workspace activity totals while bounding command history', async () => {
    const roomId = 'workspace-activity-room';
    assert.ok(await store.saveRoom({
      ...room(roomId),
      type: 'codeAgent',
    }));
    for (let index = 1; index <= 3; index += 1) {
      assert.ok(await store.appendMessage(message(roomId, `tool-call-${index}`, {
        messageType: 'tool_call',
        toolCallId: `tool-${index}`,
        toolName: `Tool ${index}`,
        content: `input ${index}`,
      })));
      assert.ok(await store.appendMessage(message(roomId, `tool-result-${index}`, {
        messageType: 'tool_result',
        toolCallId: `tool-${index}`,
        toolName: `Tool ${index}`,
        content: `output ${index}`,
        status: index === 2 ? 'error' : 'complete',
        isError: index === 2,
      })));
    }

    const activity = await store.readCodeAgentWorkspaceActivity(roomId, 2);

    assert.deepEqual(activity.summary, {
      toolCalls: 3,
      toolResults: 3,
      toolErrors: 1,
      lastToolName: 'Tool 3',
    });
    assert.deepEqual(activity.messages.map(item => item.id), [
      'tool-call-2',
      'tool-result-2',
      'tool-call-3',
      'tool-result-3',
    ]);
  });

  it('backfills legacy turns and exact restores into an honest workspace revision graph', async () => {
    const schemaName = `workspace_revision_backfill_${Date.now()}`;
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const migrationPool = createPostgresPool(scopedUrl.toString(), logger as any);
    try {
      for (const sql of POSTGRES_SCHEMA_SQL) await migrationPool.query(sql);
      const revisionMigrationIndex = POSTGRES_MIGRATIONS.findIndex(
        migration => migration.id === '0013_code_agent_workspace_revision_dag',
      );
      assert.ok(revisionMigrationIndex >= 0);
      for (const migration of POSTGRES_MIGRATIONS.slice(0, revisionMigrationIndex)) {
        await migrationPool.query(migration.sql);
      }

      const roomId = 'legacy-workspace-revision-room';
      await migrationPool.query(
        `INSERT INTO rooms (
          id, name, description, created_at, last_activity_at, creator_id,
          type, code_agent_backend, code_agent_status
        ) VALUES ($1, 'Legacy revisions', '', $2, $2, 'event-test-owner',
          'codeAgent', 'codex-app-server', 'idle')`,
        [roomId, '2026-07-20T00:00:00.000Z'],
      );
      const readyCheckpoint = (checkpointId: string, createdAt: string) => JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        manifest: {
          schemaVersion: 1,
          checkpointId,
          createdAt,
          totalArchiveBytes: 0,
          files: [],
        },
      });
      const turnRows = [
        ['legacy-turn-a', 'complete', '2026-07-20T00:01:00.000Z', 'thread-a', 'codex-a', readyCheckpoint('legacy-turn-a', '2026-07-20T00:01:00.000Z')],
        ['legacy-turn-b', 'complete', '2026-07-20T00:02:00.000Z', 'thread-b', 'codex-b', readyCheckpoint('legacy-turn-b', '2026-07-20T00:02:00.000Z')],
        ['legacy-turn-c', 'complete', '2026-07-20T00:04:00.000Z', 'thread-c', 'codex-c', readyCheckpoint('legacy-turn-c', '2026-07-20T00:04:00.000Z')],
        ['legacy-turn-running', 'running', '2026-07-20T00:05:00.000Z', null, null, null],
      ];
      for (const [turnId, status, at, sessionAfter, turnAfter, checkpoint] of turnRows) {
        await migrationPool.query(
          `INSERT INTO room_agent_turns (
            id, room_id, status, started_at, completed_at, backend, assistant_name,
            updated_at, backend_session_id_after, backend_turn_id_after, workspace_checkpoint
          ) VALUES (
            $1, $2, $3, $4::timestamptz - interval '30 seconds',
            CASE WHEN $3 = 'running' THEN NULL ELSE $4::timestamptz END,
            'codex-app-server', 'Codex', $4, $5, $6, $7::jsonb
          )`,
          [turnId, roomId, status, at, sessionAfter, turnAfter, checkpoint],
        );
      }
      await migrationPool.query(
        `INSERT INTO code_agent_checkpoint_restores (
          id, room_id, checkpoint_turn_id, restored_by_client_id,
          backend_session_id_after, backend_last_turn_id_after,
          restored_paths, conflict_paths, unavailable_paths, restored_at
        ) VALUES (
          'legacy-restore-b', $1, 'legacy-turn-b', 'event-test-owner',
          'thread-a-fork', 'codex-a', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
          '2026-07-20T00:03:00.000Z'
        )`,
        [roomId],
      );

      await migrationPool.query(POSTGRES_MIGRATIONS[revisionMigrationIndex].sql);

      const revisions = await migrationPool.query<{
        id: string;
        parent_revision_id: string | null;
        kind: string;
        restored_from_revision_id: string | null;
        restore_target_revision_id: string | null;
        traversable: boolean;
      }>(
        `SELECT id, parent_revision_id, kind, restored_from_revision_id,
          restore_target_revision_id, traversable
        FROM code_agent_workspace_revisions
        WHERE room_id = $1
        ORDER BY created_at, id`,
        [roomId],
      );
      assert.deepEqual(revisions.rows.map(row => ({
        id: row.id,
        parent: row.parent_revision_id,
        kind: row.kind,
        source: row.restored_from_revision_id,
        target: row.restore_target_revision_id,
        traversable: row.traversable,
      })), [
        { id: `root:${roomId}`, parent: null, kind: 'root', source: null, target: null, traversable: true },
        { id: 'turn:legacy-turn-a', parent: `root:${roomId}`, kind: 'turn', source: null, target: null, traversable: true },
        { id: 'turn:legacy-turn-b', parent: 'turn:legacy-turn-a', kind: 'turn', source: null, target: null, traversable: true },
        { id: 'restore:legacy-restore-b', parent: 'turn:legacy-turn-a', kind: 'restore', source: 'turn:legacy-turn-b', target: 'turn:legacy-turn-a', traversable: true },
        { id: 'turn:legacy-turn-c', parent: 'restore:legacy-restore-b', kind: 'turn', source: null, target: null, traversable: true },
        { id: 'turn:legacy-turn-running', parent: 'turn:legacy-turn-c', kind: 'turn', source: null, target: null, traversable: false },
      ]);
      assert.equal((await migrationPool.query(
        'SELECT code_agent_workspace_revision_id FROM rooms WHERE id = $1',
        [roomId],
      )).rows[0]?.code_agent_workspace_revision_id, 'turn:legacy-turn-running');
      assert.deepEqual((await migrationPool.query(
        `SELECT source_revision_id, target_revision_id, result_revision_id
        FROM code_agent_checkpoint_restores WHERE id = 'legacy-restore-b'`,
      )).rows[0], {
        source_revision_id: 'turn:legacy-turn-b',
        target_revision_id: 'turn:legacy-turn-a',
        result_revision_id: 'restore:legacy-restore-b',
      });
    } finally {
      await migrationPool.end?.();
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
  });

  it('preserves AI stream ownership across code-agent continuation segments', async () => {
    const roomId = 'code-agent-continuation-stream-room';
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const streamOwnerId = 'continuation-stream-owner';
    const turnOwnerId = 'continuation-turn-owner';
    const runningTurn: RoomAgentTurn = {
      ...turn(roomId, 'running', now),
      id: 'continuation-turn',
      backend: 'codex-app-server',
      assistantName: 'Codex',
      startedAt: now,
      updatedAt: now,
    };
    assert.ok(await store.saveRoom({
      ...room(roomId),
      type: 'codeAgent',
      codeAgentStatus: 'idle',
      sandboxStatus: 'ready',
    }));
    await store.heartbeatAIStreamOwner(streamOwnerId, 'continuation-instance', now, 30_000);

    const started = await store.beginCodeAgentTurn({
      roomId,
      turn: runningTurn,
      placeholder: withAIStreamRecoveryMetadata(message(roomId, 'continuation-placeholder', {
        clientId: 'ai_assistant',
        clientMessageId: undefined,
        messageType: 'ai',
        status: 'streaming',
        content: 'First segment',
        turnId: runningTurn.id,
      }), streamOwnerId),
      ownerId: turnOwnerId,
      now,
      leaseTtlMs: 60_000,
    });
    assert.equal(started.outcome, 'started');
    if (started.outcome !== 'started') return;
    assert.equal(getAIStreamOwnerId(started.placeholder), streamOwnerId);
    assert.equal(getAIStreamFence(started.placeholder), 0);

    const claim = {
      roomId,
      turnId: runningTurn.id,
      ownerId: turnOwnerId,
      fence: started.lease.fence,
    };
    const continuation = {
      ...started.placeholder,
      id: 'continuation-segment',
      content: '',
      status: 'streaming' as const,
      timestamp: new Date(nowMs + 1_000).toISOString(),
    };
    const appended = await store.appendCodeAgentMessage(continuation, claim);
    assert.equal(appended.outcome, 'applied');
    assert.equal(
      (await pool.query<{ ai_stream_owner_id: string | null }>(
        'SELECT ai_stream_owner_id FROM room_messages WHERE id = $1',
        [continuation.id],
      )).rows[0]?.ai_stream_owner_id,
      streamOwnerId,
    );

    assert.equal(
      await store.failOrphanedStreamingMessages(
        'Response interrupted.',
        new Date(nowMs + 5_000).toISOString(),
      ),
      0,
    );
    const finalized = await store.finalizeCodeAgentMessage({
      ...continuation,
      content: 'Second segment',
      status: 'complete',
      timestamp: new Date(nowMs + 6_000).toISOString(),
    }, {
      ownerId: streamOwnerId,
      fence: getAIStreamFence(continuation),
    }, claim);
    assert.equal(finalized.outcome, 'applied');
  });

  it('orders finalized AI before later tools and atomically removes empty terminal segments', async () => {
    const roomId = 'terminal-segment-cleanup-room';
    const turnId = 'terminal-segment-cleanup-turn';
    const startedAt = '2026-08-06T00:04:10.000Z';
    const leaseNow = new Date().toISOString();
    assert.ok(await store.saveRoom({
      ...room(roomId),
      type: 'codeAgent',
      codeAgentStatus: 'idle',
      sandboxStatus: 'ready',
    }));
    const runningTurn: RoomAgentTurn = {
      ...turn(roomId, 'running', startedAt),
      id: turnId,
      startedAt: leaseNow,
      updatedAt: leaseNow,
    };
    const placeholder = withAIStreamRecoveryMetadata(message(roomId, 'unused-placeholder', {
      clientId: 'ai_assistant',
      clientMessageId: undefined,
      messageType: 'ai',
      content: '',
      status: 'streaming',
      turnId,
      timestamp: startedAt,
    }), 'terminal-stream-owner');
    const started = await store.beginCodeAgentTurn({
      roomId,
      turn: runningTurn,
      placeholder,
      ownerId: 'terminal-instance',
      now: leaseNow,
      leaseTtlMs: 60_000,
    });
    assert.equal(started.outcome, 'started');
    if (started.outcome !== 'started') return;
    const claim = {
      roomId,
      turnId,
      ownerId: started.lease.ownerId,
      fence: started.lease.fence,
    };

    const segmentCreatedAt = '2026-08-06T00:04:11.000Z';
    const textSegment = {
      ...started.placeholder,
      id: 'durable-ai-segment',
      content: '',
      status: 'streaming' as const,
      timestamp: segmentCreatedAt,
    };
    assert.equal((await store.appendCodeAgentMessage(textSegment, claim)).outcome, 'applied');
    const finalized = await store.finalizeCodeAgentMessage({
      ...textSegment,
      content: 'I will inspect the files first.',
      status: 'complete',
      // Deliberately later than the following tool events. The durable row must
      // retain segmentCreatedAt and use updatedAt for completion metadata.
      timestamp: '2026-08-06T00:04:20.000Z',
      updatedAt: '2026-08-06T00:04:20.000Z',
    }, {
      ownerId: 'terminal-stream-owner',
      fence: getAIStreamFence(textSegment),
    }, claim);
    assert.equal(finalized.outcome, 'applied');
    if (finalized.outcome !== 'applied') return;
    assert.equal(finalized.message.timestamp, segmentCreatedAt);
    assert.equal(finalized.message.updatedAt, '2026-08-06T00:04:20.000Z');

    const toolCallMessage = message(roomId, 'tool-call', {
      clientMessageId: undefined,
      clientId: 'code_agent_runner',
      messageType: 'tool_call',
      turnId,
      toolCallId: 'tool-1',
      toolName: 'Shell',
      timestamp: '2026-08-06T00:04:13.000Z',
    });
    const toolResultMessage = message(roomId, 'tool-result', {
      clientMessageId: undefined,
      clientId: 'code_agent_runner',
      messageType: 'tool_result',
      turnId,
      toolCallId: 'tool-1',
      toolName: 'Shell',
      timestamp: '2026-08-06T00:04:17.000Z',
    });
    assert.equal((await store.appendCodeAgentMessage(toolCallMessage, claim)).outcome, 'applied');

    const completedAt = new Date().toISOString();
    const terminalErrorMessage = message(roomId, 'terminal-error', {
      clientMessageId: undefined,
      clientId: 'ai_assistant',
      messageType: 'ai',
      turnId,
      status: 'error',
      isError: true,
      content: 'Coco task reached the task time limit and was stopped.',
      timestamp: completedAt,
      updatedAt: completedAt,
    });
    const terminalInput = {
      claim,
      outcome: 'error' as const,
      completedAt,
      finalMessageId: 'terminal-error',
      appendMessage: terminalErrorMessage,
      deleteMessageIds: [placeholder.id],
    };
    const headWithDanglingTool = await store.readRoomEventHead(roomId);
    await assert.rejects(store.finishCodeAgentTurn(terminalInput), /left pending tools/);
    assert.equal(await store.readRoomEventHead(roomId), headWithDanglingTool);
    assert.equal((await store.readRoomAgentTurns(roomId, [turnId]))[0]?.status, 'running');
    assert.equal((await store.readMessagesByRoom(roomId)).some(item => item.id === 'terminal-error'), false);

    assert.equal((await store.appendCodeAgentMessage(toolResultMessage, claim)).outcome, 'applied');
    const eventHeadBeforeTerminal = await store.readRoomEventHead(roomId);
    const terminal = await store.finishCodeAgentTurn(terminalInput);
    assert.equal(terminal.outcome, 'applied');
    if (terminal.outcome !== 'applied') return;
    assert.equal(terminal.message?.id, 'terminal-error');
    assert.equal(terminal.turn.status, 'error');
    assert.equal(terminal.turn.finalMessageId, 'terminal-error');

    const durableMessages = await store.readMessagesByRoom(roomId);
    assert.deepEqual(durableMessages.map(item => item.id), [
      'durable-ai-segment',
      'tool-call',
      'tool-result',
      'terminal-error',
    ]);
    assert.deepEqual(durableMessages.map(item => item.position), [1, 2, 3, 4]);
    assert.equal(durableMessages[0].timestamp, segmentCreatedAt);
    assert.equal(durableMessages.some(item => item.status === 'streaming'), false);

    const snapshot = await store.readRoomSnapshot(roomId);
    assert.deepEqual(snapshot.messages.map(item => item.id), durableMessages.map(item => item.id));
    assert.equal(snapshot.messages.some(item => item.status === 'streaming'), false);
    const terminalEvents = await store.readRoomEvents(roomId, { afterSeq: eventHeadBeforeTerminal, limit: 100 });
    const deletedEvent = terminalEvents.events.find(item => item.type === 'messages.deleted');
    const appendedEvent = terminalEvents.events.find(item => (
      item.type === 'messages.upserted'
      && item.payload.messageIds?.includes('terminal-error')
    ));
    assert.deepEqual(deletedEvent?.payload.messageIds, [placeholder.id]);
    assert.equal(appendedEvent?.payload.messages?.[0]?.position, 4);
  });

  it('rolls back the whole code-agent terminal projection when any terminal write fails', async () => {
    const roomId = 'atomic-code-agent-terminal-room';
    const now = new Date().toISOString();
    assert.ok(await store.saveRoom({
      ...room(roomId),
      type: 'codeAgent',
      codeAgentStatus: 'idle',
      sandboxStatus: 'ready',
    }));
    const runningTurn: RoomAgentTurn = {
      ...turn(roomId, 'running', now),
      id: 'atomic-code-agent-turn',
      startedAt: now,
      updatedAt: now,
    };
    const placeholder = withAIStreamRecoveryMetadata(message(roomId, 'atomic-code-agent-ai', {
      clientId: 'ai_assistant',
      clientMessageId: undefined,
      messageType: 'ai',
      status: 'streaming',
      content: '',
      turnId: runningTurn.id,
    }), 'atomic-stream-owner');
    const started = await store.beginCodeAgentTurn({
      roomId,
      turn: runningTurn,
      placeholder,
      ownerId: 'atomic-instance',
      now,
      leaseTtlMs: 60_000,
    });
    assert.equal(started.outcome, 'started');
    if (started.outcome !== 'started') return;
    const claim = {
      roomId,
      turnId: runningTurn.id,
      ownerId: started.lease.ownerId,
      fence: started.lease.fence,
    };
    const completedMessage: Message = {
      ...placeholder,
      content: 'durable answer',
      status: 'complete',
      timestamp: new Date().toISOString(),
      cost: {
        currency: 'USD',
        inputUsd: 0.25,
        outputUsd: 0,
        totalUsd: 0.25,
        inputPerMillion: 1,
        outputPerMillion: 1,
        estimated: false,
      },
    };

    await assert.rejects(
      store.finishCodeAgentTurn({
        claim,
        outcome: 'complete',
        completedAt: new Date().toISOString(),
        finalMessageId: 'missing-final-message',
        deleteMessageIds: [placeholder.id],
        cost: completedMessage.cost,
      }),
      /foreign key|violates/i,
    );
    assert.equal((await store.readMessagesByRoom(roomId))[0]?.status, 'streaming');
    assert.equal((await store.readRoomAgentTurns(roomId))[0]?.status, 'running');
    assert.equal((await store.getRoomById(roomId))?.codeAgentStatus, 'running');
    assert.equal((await store.readRoomAICost(roomId)).totalUsd, 0);

    const sealed = await store.finalizeCodeAgentMessage(
      completedMessage,
      { ownerId: 'atomic-stream-owner', fence: 0 },
      claim,
    );
    assert.equal(sealed.outcome, 'applied');

    const terminal = await store.finishCodeAgentTurn({
      claim,
      outcome: 'complete',
      completedAt: new Date().toISOString(),
      message: completedMessage,
      expectedMessageOwnership: { ownerId: 'atomic-stream-owner', fence: 0 },
      finalMessageId: completedMessage.id,
      sessionId: 'codex-session-1',
      cost: completedMessage.cost,
    });
    assert.equal(terminal.outcome, 'applied');
    if (terminal.outcome !== 'applied') return;
    assert.equal(terminal.message?.status, 'complete');
    assert.equal(terminal.turn.status, 'complete');
    assert.equal(terminal.room.codeAgentStatus, 'idle');
    assert.equal(terminal.room.codeAgentSessionId, 'codex-session-1');
    assert.equal(terminal.roomCostTotal.totalUsd, 0.25);
    assert.deepEqual(await store.finishCodeAgentTurn({
      claim,
      outcome: 'complete',
      completedAt: new Date().toISOString(),
      cost: completedMessage.cost,
    }), { outcome: 'stale' });
    assert.equal((await store.readRoomAICost(roomId)).totalUsd, 0.25);
  });

  it('restores abandoned starting and steering queue states but leaves live turns alone', async () => {
    const roomId = 'recover-code-agent-queue-room';
    const liveRoomId = 'live-code-agent-queue-room';
    const oldTimestamp = '2026-07-20T00:00:00.000Z';
    for (const id of [roomId, liveRoomId]) {
      assert.ok(await store.saveRoom({
        ...room(id),
        type: 'codeAgent',
        codeAgentStatus: 'idle',
      }));
    }
    assert.ok(await store.appendMessage(message(roomId, 'abandoned-starting', {
      codeAgentQueuedInput: {
        state: 'starting',
        queuedAt: oldTimestamp,
        updatedAt: oldTimestamp,
        selectedModel: assistantTestModel,
      },
      updatedAt: oldTimestamp,
    })));
    assert.ok(await store.appendMessage(message(roomId, 'abandoned-steering', {
      codeAgentQueuedInput: {
        state: 'steering',
        queuedAt: oldTimestamp,
        updatedAt: oldTimestamp,
        selectedModel: assistantTestModel,
      },
      updatedAt: oldTimestamp,
    })));
    assert.ok(await store.appendMessage(message(liveRoomId, 'live-steering', {
      codeAgentQueuedInput: {
        state: 'steering',
        queuedAt: oldTimestamp,
        updatedAt: oldTimestamp,
        selectedModel: assistantTestModel,
      },
      updatedAt: oldTimestamp,
    })));
    assert.ok(await store.acquireCodeAgentRoomLease(
      liveRoomId,
      'live-turn',
      'live-instance',
      new Date().toISOString(),
      60_000,
    ));

    assert.equal(
      await store.recoverStaleCodeAgentQueuedMessages(
        '2026-07-21T00:00:00.000Z',
        '2026-07-24T00:00:00.000Z',
      ),
      2,
    );
    const recovered = await store.readMessagesByRoom(roomId);
    assert.deepEqual(
      recovered.map(item => item.codeAgentQueuedInput?.state),
      ['queued', 'queued'],
    );
    assert.equal(
      (await store.readMessagesByRoom(liveRoomId))[0]?.codeAgentQueuedInput?.state,
      'steering',
    );
  });

  it('recovers streaming placeholders only after their owner lease expires', async () => {
    const roomId = 'leased-ai-stream-room';
    const ownerId = 'stream-owner-a';
    assert.ok(await store.saveRoom(room(roomId)));
    assert.ok(await store.upsertMessage(withAIStreamRecoveryMetadata(message(roomId, 'streaming-message', {
      messageType: 'ai',
      content: '',
      status: 'streaming',
    }), ownerId)));
    await store.heartbeatAIStreamOwner(ownerId, 'instance-a', '2026-07-21T00:00:00.000Z', 30_000);

    assert.equal(await store.failOrphanedStreamingMessages('Response interrupted.', '2026-07-21T00:00:10.000Z'), 0);
    assert.equal((await store.readMessagesByRoom(roomId))[0]?.status, 'streaming');

    assert.equal(await store.failOrphanedStreamingMessages('Response interrupted.', '2026-07-21T00:00:31.000Z'), 1);
    assert.equal((await store.readMessagesByRoom(roomId))[0]?.status, 'error');
  });

  it('creates one durable assistant-run aggregate with its placeholder and no AI outbox job', async () => {
    const roomId = 'atomic-assistant-run-room';
    const messageId = 'atomic-assistant-message';
    const runId = 'atomic-assistant-run';
    assert.ok(await store.saveRoom(room(roomId)));
    const placeholder = message(roomId, messageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
      aiModel: assistantMessageModel,
    });
    const run = {
      id: runId,
      roomId,
      requestedByClientId: 'event-test-owner',
      aiMessageId: messageId,
      status: 'queued' as const,
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai' as const,
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
      requestPayload: assistantRequest(roomId),
      generation: 0,
      attempt: 0,
      availableAt: createdAt,
    };

    const result = await store.createAssistantRunWithMessage(placeholder, run);
    assert.ok(result);
    assert.equal((await store.readMessagesByRoom(roomId))[0]?.id, messageId);
    assert.equal((await store.getAssistantRun(runId))?.status, 'queued');
    assert.deepEqual((await store.getAssistantRun(runId))?.requestPayload?.contextMessages.map(item => item.id), ['context-message']);
    assert.equal((await pool.query(
      `SELECT COUNT(*) AS count FROM outbox_events
      WHERE aggregate_type = 'assistant_run' AND aggregate_id = $1`,
      [runId],
    )).rows[0]?.count, '0');

    await assert.rejects(
      store.createAssistantRunWithMessage(
        message(roomId, 'wrong-message', { messageType: 'ai', status: 'streaming' }),
        { ...run, id: 'wrong-run', aiMessageId: 'different-message' },
      ),
      /streaming placeholder/,
    );
    assert.equal((await store.readMessagesByRoom(roomId)).some(item => item.id === 'wrong-message'), false);

    const rolledBack = await store.createAssistantRunWithMessage(
      message(roomId, 'rolled-back-message', {
        clientId: 'ai_assistant',
        messageType: 'ai',
        content: '',
        status: 'streaming',
      }),
      {
        ...run,
        id: runId,
        aiMessageId: 'rolled-back-message',
      },
    );
    assert.equal(rolledBack, null);
    assert.equal((await store.readMessagesByRoom(roomId)).some(item => item.id === 'rolled-back-message'), false);
    assert.equal((await store.getAssistantRun(runId))?.aiMessageId, messageId);
  });

  it('fences run generations and projects message, run, usage, and cost exactly once', async () => {
    const roomId = 'assistant-run-fence-room';
    const messageId = 'assistant-run-fence-message';
    const runId = 'assistant-run-fence';
    const initialTime = '2026-07-22T00:00:00.000Z';
    assert.ok(await store.saveRoom(room(roomId)));
    const placeholder = message(roomId, messageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
      aiModel: assistantMessageModel,
    });
    assert.ok(await store.createAssistantRunWithMessage(placeholder, {
      id: runId,
      roomId,
      requestedByClientId: 'event-test-owner',
      aiMessageId: messageId,
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt: initialTime,
      queuedAt: initialTime,
      updatedAt: initialTime,
      requestPayload: assistantRequest(roomId),
      generation: 0,
      attempt: 0,
      availableAt: initialTime,
    }));

    const first = await store.claimAssistantRun({
      workerId: 'worker-1',
      leaseMs: 1_000,
      now: initialTime,
    });
    assert.ok(first);
    assert.equal(first.phase, 'execute');
    assert.equal(first.run.generation, 1);
    assert.equal(first.run.attempt, 1);
    assert.equal(await store.claimAssistantRun({
      workerId: 'worker-2',
      leaseMs: 1_000,
      now: '2026-07-22T00:00:00.500Z',
    }), null);

    const replacement = await store.claimAssistantRun({
      workerId: 'worker-2',
      leaseMs: 1_000,
      now: '2026-07-22T00:00:01.001Z',
    });
    assert.ok(replacement);
    assert.equal(replacement.phase, 'execute');
    assert.equal(replacement.run.generation, 2);
    assert.equal(replacement.run.attempt, 2);

    const finalMessage = {
      ...placeholder,
      content: 'durable answer',
      status: 'complete' as const,
      timestamp: '2026-07-22T00:00:02.000Z',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        source: 'reported' as const,
      },
      cost: {
        currency: 'USD' as const,
        inputUsd: 0.00001,
        outputUsd: 0.000005,
        totalUsd: 0.000015,
        inputPerMillion: 1,
        outputPerMillion: 1,
        estimated: false,
      },
    };
    const terminal = {
      schemaVersion: 1 as const,
      outcome: 'complete' as const,
      message: finalMessage,
      metadata: { contentLength: finalMessage.content.length },
    };

    assert.equal(await store.stageAssistantRunTerminal(runId, first.token, terminal), null);
    assert.ok(await store.stageAssistantRunTerminal(runId, replacement.token, terminal));
    assert.deepEqual(await store.projectAssistantRunTerminal(runId, first.token), { outcome: 'stale' });

    const projected = await store.projectAssistantRunTerminal(runId, replacement.token);
    assert.equal(projected.outcome, 'applied');
    if (projected.outcome !== 'applied') throw new Error('Expected applied projection');
    assert.equal(projected.message.content, 'durable answer');
    assert.equal(projected.run.status, 'complete');
    assert.equal(projected.roomCostTotal.totalUsd, 0.000015);
    assert.deepEqual(await store.projectAssistantRunTerminal(runId, replacement.token), { outcome: 'stale' });

    assert.equal((await store.readRoomAICost(roomId)).totalUsd, 0.000015);
    assert.equal((await store.readMessagesByRoom(roomId))[0]?.status, 'complete');

    assert.equal((await store.deleteMessageById(roomId, messageId))?.deleted, true);
    const retainedRun = await store.getAssistantRun(runId);
    assert.equal(retainedRun?.status, 'complete');
    assert.equal(retainedRun?.terminalPayload?.message.cost?.totalUsd, 0.000015);
    assert.equal((await store.readRoomAICost(roomId)).totalUsd, 0.000015);
  });

  it('atomically creates password accounts, credentials, and expiring sessions', async () => {
    const failedClientId = 'atomic-password-failed-client';
    const failedAccountId = 'atomic-password-failed-account';
    await assert.rejects(
      store.setPasswordAccountCredentials({
        accountId: failedAccountId,
        clientId: failedClientId,
        passwordHash: 'password-hash',
        authToken: {
          clientId: failedClientId,
          accountId: failedAccountId,
          authMethod: 'password',
          tokenHash: 'failed-token-hash',
          createdAt,
        },
        now: createdAt,
      }),
      /client_auth_tokens_account_expiry_check/,
    );
    assert.equal(await store.getAccountByClientId(failedClientId), null);
    assert.equal(await store.getClientPasswordHash(failedClientId), null);
    assert.equal((await pool.query(
      'SELECT COUNT(*) AS count FROM client_auth_tokens WHERE client_id = $1',
      [failedClientId],
    )).rows[0]?.count, '0');

    const clientId = 'atomic-password-client';
    const accountId = 'atomic-password-account';
    const expiresAt = '2026-08-19T12:00:00.000Z';
    const account = await store.setPasswordAccountCredentials({
      accountId,
      clientId,
      passwordHash: 'password-hash',
      authToken: {
        clientId,
        accountId,
        authMethod: 'password',
        tokenHash: 'atomic-token-hash',
        createdAt,
        expiresAt,
      },
      now: createdAt,
    });
    assert.equal(account?.accountId, accountId);
    assert.equal(await store.getClientPasswordHash(clientId), 'password-hash');
    assert.deepEqual((await pool.query<{
      account_id: string;
      auth_method: string;
      expires_at: Date;
    }>(
      `SELECT account_id, auth_method, expires_at
      FROM client_auth_tokens
      WHERE token_hash = $1`,
      ['atomic-token-hash'],
    )).rows[0], {
      account_id: accountId,
      auth_method: 'password',
      expires_at: new Date(expiresAt),
    });
  });

  it('disconnects Google only with a password fallback and preserves durable account state', async () => {
    const accountId = 'google-disconnect-account';
    const clientId = 'google-disconnect-client';
    const providerSubject = 'google-disconnect-subject';
    const googleAccount = await store.createGoogleAccountForClient({
      accountId,
      clientId,
      providerSubject,
      email: 'disconnect@example.com',
      emailVerified: true,
      displayName: 'Disconnect Test',
      now: createdAt,
    });
    assert.equal(googleAccount?.googleLinked, true);
    assert.equal(await store.disconnectGoogleAccount({
      id: 'identity-event-without-password',
      clientId,
      now: createdAt,
    }), 'password_required');
    assert.equal((await store.getAccountByClientId(clientId))?.googleLinked, true);

    assert.ok(await store.setPasswordAccountCredentials({
      accountId,
      clientId,
      passwordHash: 'password-hash',
      authToken: {
        clientId,
        accountId,
        authMethod: 'password',
        tokenHash: 'google-disconnect-password-token',
        createdAt,
        expiresAt: '2026-08-19T12:00:00.000Z',
      },
      now: createdAt,
    }));
    assert.ok(await store.updateAccountMembership({
      accountId,
      tier: 'pro',
      status: 'active',
      now: createdAt,
    }));
    assert.ok(await store.grantAccountCredits({
      id: 'google-disconnect-credit',
      accountId,
      amountUsd: 5,
      idempotencyKey: 'google-disconnect-credit',
      now: createdAt,
    }));
    assert.equal(await store.grantAccountRole({
      id: 'google-disconnect-role-event',
      accountId,
      role: 'admin',
      now: createdAt,
    }), true);

    assert.equal(await store.disconnectGoogleAccount({
      id: 'google-disconnect-identity-event',
      clientId,
      now: createdAt,
    }), 'disconnected');
    const disconnected = await store.getAccountByClientId(clientId);
    assert.equal(disconnected?.accountId, accountId);
    assert.equal(disconnected?.googleLinked, false);
    assert.equal(disconnected?.provider, 'password');
    assert.equal(disconnected?.email, undefined);
    assert.equal(disconnected?.displayName, undefined);
    assert.equal(await store.getAccountByGoogleSubject(providerSubject), null);
    assert.deepEqual(await store.getAccountRoles(accountId), ['admin']);
    const entitlement = await store.getAccountEntitlementByClientId(clientId);
    assert.equal(entitlement?.tier, 'pro');
    assert.equal(entitlement?.creditBalanceUsd, 5);
    assert.equal((await pool.query(
      `SELECT COUNT(*) AS count
      FROM account_identity_events
      WHERE account_id = $1 AND provider = 'google' AND action = 'disconnect'`,
      [accountId],
    )).rows[0]?.count, '1');
  });

  it('applies membership transitions and credit grants as one idempotent transaction', async () => {
    const accountId = 'atomic-membership-account';
    const clientId = 'atomic-membership-client';
    assert.ok(await store.createPasswordAccountForClient({
      accountId,
      clientId,
      now: createdAt,
    }));
    const change = {
      id: 'atomic-membership-event',
      idempotencyKey: 'atomic-membership-invoice',
      accountId,
      tier: 'priority' as const,
      status: 'active' as const,
      creditGrantUsd: 20,
      now: createdAt,
    };
    const retries = await Promise.all([
      store.applyAccountMembershipChange(change),
      store.applyAccountMembershipChange({ ...change, id: 'atomic-membership-event-retry' }),
    ]);
    assert.ok(retries.every(Boolean));
    assert.equal(retries[0]?.tier, 'priority');
    assert.equal(retries[0]?.creditBalanceUsd, 20);
    assert.equal(retries[0]?.queuePriority, 1);
    assert.equal(retries[1]?.creditBalanceUsd, 20);
    assert.equal((await pool.query(
      'SELECT COUNT(*) AS count FROM account_membership_events WHERE idempotency_key = $1',
      [change.idempotencyKey],
    )).rows[0]?.count, '1');
    assert.equal((await pool.query(
      'SELECT COUNT(*) AS count FROM account_credit_ledger WHERE idempotency_key = $1',
      [change.idempotencyKey],
    )).rows[0]?.count, '1');
    await assert.rejects(
      store.applyAccountMembershipChange({
        ...change,
        id: 'atomic-membership-conflict',
        creditGrantUsd: 21,
      }),
      /different change/,
    );

    const rollbackAccountId = 'atomic-membership-rollback-account';
    const rollbackClientId = 'atomic-membership-rollback-client';
    assert.ok(await store.createPasswordAccountForClient({
      accountId: rollbackAccountId,
      clientId: rollbackClientId,
      now: createdAt,
    }));
    await assert.rejects(
      store.applyAccountMembershipChange({
        ...change,
        idempotencyKey: 'atomic-membership-rollback',
        accountId: rollbackAccountId,
        creditGrantUsd: 5,
      }),
      /account_(credit_ledger|membership_events)_pkey/,
    );
    const rolledBack = await store.getAccountEntitlementByClientId(rollbackClientId);
    assert.equal(rolledBack?.tier, 'free');
    assert.equal(rolledBack?.creditBalanceUsd, 5);
  });

  it('grants signed-in Free accounts five non-rollover dollars per UTC calendar month', async () => {
    const accountId = 'monthly-free-account';
    const clientId = 'monthly-free-client';
    assert.ok(await store.createPasswordAccountForClient({
      accountId,
      clientId,
      now: '2026-07-15T12:00:00.000Z',
    }));
    assert.equal(await store.getAccountEntitlementByClientId('monthly-free-guest', createdAt), null);

    const july = await store.getAccountEntitlementByClientId(clientId, '2026-07-15T12:00:00.000Z');
    assert.equal(july?.creditBalanceUsd, 5);
    assert.equal(july?.monthlyCreditAllowanceUsd, 5);
    assert.equal(july?.monthlyCreditRemainingUsd, 5);
    assert.equal(july?.monthlyCreditPeriodStart, '2026-07-01');
    assert.equal(july?.monthlyCreditPeriodEnd, '2026-08-01');
    assert.equal(july?.queuePriority, 60);

    const usage = await store.settleAccountAIUsage({
      id: 'monthly-free-july-usage',
      clientId,
      source: 'code_agent_gateway',
      costUsd: 2,
      provider: 'openai',
      modelId: 'test-model',
      now: '2026-07-20T12:00:00.000Z',
    });
    assert.equal(usage?.creditAppliedUsd, 2);
    const afterUsage = await store.getAccountEntitlementByClientId(clientId, '2026-07-31T23:59:00.000Z');
    assert.equal(afterUsage?.creditBalanceUsd, 3);
    assert.equal(afterUsage?.monthlyCreditRemainingUsd, 3);

    assert.ok(await store.grantAccountCredits({
      id: 'monthly-free-manual-credit',
      accountId,
      amountUsd: 7,
      idempotencyKey: 'monthly-free-manual-credit',
      now: '2026-07-31T23:59:30.000Z',
    }));
    const august = await store.getAccountEntitlementByClientId(clientId, '2026-08-01T00:00:00.000Z');
    assert.equal(august?.creditBalanceUsd, 12);
    assert.equal(august?.monthlyCreditRemainingUsd, 5);
    assert.equal(august?.monthlyCreditPeriodStart, '2026-08-01');
    assert.equal((await pool.query(
      `SELECT COUNT(*) AS count
      FROM account_credit_ledger
      WHERE account_id = $1
        AND metadata->>'source' = 'free_monthly_allowance'`,
      [accountId],
    )).rows[0]?.count, '3');
  });

  it('reads platform administrator authorization from PostgreSQL account roles', async () => {
    const accountId = 'platform-admin-account';
    assert.ok(await store.createPasswordAccountForClient({
      accountId,
      clientId: 'platform-admin-client',
      now: createdAt,
    }));
    assert.deepEqual(await store.getAccountRoles(accountId), []);

    assert.equal(await store.grantAccountRole({
      id: 'platform-admin-grant-event',
      accountId,
      role: 'admin',
      metadata: { source: 'integration_test' },
      now: createdAt,
    }), true);
    assert.equal(await store.grantAccountRole({
      id: 'platform-admin-grant-event-retry',
      accountId,
      role: 'admin',
      metadata: { source: 'integration_test' },
      now: createdAt,
    }), true);

    assert.deepEqual(await store.getAccountRoles(accountId), ['admin']);
    const adminEntitlement = await store.getAccountEntitlementByClientId(
      'platform-admin-client',
      createdAt,
    );
    assert.equal(adminEntitlement?.effectiveTier, 'priority');
    assert.equal(adminEntitlement?.creditUnlimited, true);
    assert.equal(adminEntitlement?.creditState, 'available');
    assert.equal(adminEntitlement?.queuePriority, 1);
    assert.equal(adminEntitlement?.creditBalanceUsd, 0);

    const adminRoomId = 'platform-admin-priority-room';
    const adminRunId = 'platform-admin-priority-run';
    const adminMessageId = 'platform-admin-priority-message';
    assert.ok(await store.saveRoom(room(adminRoomId)));
    const adminPlaceholder = message(adminRoomId, adminMessageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
      aiModel: assistantMessageModel,
    });
    assert.ok(await store.createAssistantRunWithMessage(adminPlaceholder, {
      id: adminRunId,
      roomId: adminRoomId,
      requestedByClientId: 'platform-admin-client',
      aiMessageId: adminMessageId,
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
      requestPayload: assistantRequest(adminRoomId),
      generation: 0,
      attempt: 0,
      availableAt: createdAt,
    }));
    const adminRun = await store.getAssistantRun(adminRunId);
    assert.equal(adminRun?.membershipTier, 'priority');
    assert.equal(adminRun?.creditState, 'available');
    assert.equal(adminRun?.queuePriority, 1);

    const adminClaim = await store.claimAssistantRunById(adminRunId, {
      workerId: 'platform-admin-worker',
      now: createdAt,
      leaseMs: 30_000,
    });
    assert.ok(adminClaim);
    assert.ok(await store.stageAssistantRunTerminal(adminRunId, adminClaim.token, {
      schemaVersion: 1,
      outcome: 'complete',
      message: {
        ...adminPlaceholder,
        content: 'unlimited admin answer',
        status: 'complete',
        timestamp: createdAt,
        usage: {
          promptTokens: 500_000,
          completionTokens: 500_000,
          totalTokens: 1_000_000,
          source: 'reported',
        },
        cost: {
          currency: 'USD',
          inputUsd: 0.5,
          outputUsd: 0.5,
          totalUsd: 1,
          inputPerMillion: 1,
          outputPerMillion: 1,
          estimated: false,
        },
      },
    }));
    const adminProjection = await store.projectAssistantRunTerminal(adminRunId, adminClaim.token);
    assert.equal(adminProjection.outcome, 'applied');
    if (adminProjection.outcome !== 'applied') throw new Error('Expected admin projection');
    assert.equal(adminProjection.run.creditAppliedUsd, 0);

    const adminUsage = await store.settleAccountAIUsage({
      id: 'platform-admin-unlimited-usage',
      clientId: 'platform-admin-client',
      source: 'code_agent_gateway',
      costUsd: 25,
      provider: 'openai',
      modelId: 'test-model',
      now: createdAt,
    });
    assert.equal(adminUsage?.membershipTier, 'priority');
    assert.equal(adminUsage?.creditAppliedUsd, 0);
    assert.equal(adminUsage?.creditBalanceUsd, 0);
    assert.equal((await store.getAccountEntitlementByClientId(
      'platform-admin-client',
      createdAt,
    ))?.lifetimeUsageUsd, 26);
    assert.equal((await pool.query(
      `SELECT COUNT(*) AS count
      FROM account_role_events
      WHERE account_id = $1 AND role = 'admin' AND action = 'grant'`,
      [accountId],
    )).rows[0]?.count, '1');
  });

  it('snapshots membership priority and debits account credits exactly once', async () => {
    const roomId = 'assistant-run-membership-room';
    const accountId = 'assistant-run-membership-account';
    const clientId = 'event-test-owner';
    const runId = 'assistant-run-membership-first';
    const messageId = 'assistant-run-membership-message-first';
    assert.ok(await store.saveRoom(room(roomId)));
    assert.ok(await store.createPasswordAccountForClient({
      accountId,
      clientId,
      now: createdAt,
    }));
    assert.ok(await store.updateAccountMembership({
      accountId,
      tier: 'pro',
      status: 'active',
      now: createdAt,
    }));
    // Concurrent billing webhook retries must both succeed without granting
    // the same credit twice.
    const grants = await Promise.all([
      store.grantAccountCredits({
        id: 'assistant-run-membership-grant',
        accountId,
        amountUsd: 0.000015,
        idempotencyKey: 'assistant-run-membership-grant',
        now: createdAt,
      }),
      store.grantAccountCredits({
        id: 'assistant-run-membership-grant-retry',
        accountId,
        amountUsd: 0.000015,
        idempotencyKey: 'assistant-run-membership-grant',
        now: createdAt,
      }),
    ]);
    assert.ok(grants.every(Boolean));
    await assert.rejects(store.grantAccountCredits({
      id: 'assistant-run-membership-grant-conflict',
      accountId,
      amountUsd: 1,
      idempotencyKey: 'assistant-run-membership-grant',
      now: createdAt,
    }), /another amount/);
    assert.equal((await store.getAccountEntitlementByClientId(clientId))?.creditBalanceUsd, 0.000015);

    const placeholder = message(roomId, messageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
      aiModel: assistantMessageModel,
    });
    assert.ok(await store.createAssistantRunWithMessage(placeholder, {
      id: runId,
      roomId,
      requestedByClientId: clientId,
      aiMessageId: messageId,
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
      requestPayload: assistantRequest(roomId),
      generation: 0,
      attempt: 0,
      availableAt: createdAt,
    }));

    const queued = await store.getAssistantRun(runId);
    assert.equal(queued?.billingAccountId, accountId);
    assert.equal(queued?.membershipTier, 'pro');
    assert.equal(queued?.creditState, 'available');
    assert.equal(queued?.queuePriority, 20);
    assert.equal((await pool.query<{ queue_priority: number }>(
      'SELECT queue_priority FROM task_dispatch_outbox WHERE run_id = $1',
      [runId],
    )).rows[0]?.queue_priority, 20);

    const execution = await store.claimAssistantRunById(runId, {
      workerId: 'membership-worker',
      now: createdAt,
      leaseMs: 30_000,
    });
    assert.ok(execution);
    assert.ok(await store.stageAssistantRunTerminal(runId, execution.token, {
      schemaVersion: 1,
      outcome: 'complete',
      message: {
        ...placeholder,
        content: 'membership answer',
        status: 'complete',
        timestamp: createdAt,
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          source: 'reported',
        },
        cost: {
          currency: 'USD',
          inputUsd: 0.00001,
          outputUsd: 0.000005,
          totalUsd: 0.000015,
          inputPerMillion: 1,
          outputPerMillion: 1,
          estimated: false,
        },
      },
    }));
    const projected = await store.projectAssistantRunTerminal(runId, execution.token);
    assert.equal(projected.outcome, 'applied');
    if (projected.outcome !== 'applied') throw new Error('Expected applied projection');
    assert.equal(projected.run.chargedCostUsd, 0.000015);
    assert.equal(projected.run.creditAppliedUsd, 0.000015);
    assert.deepEqual(await store.projectAssistantRunTerminal(runId, execution.token), { outcome: 'stale' });

    const entitlement = await store.getAccountEntitlementByClientId(clientId);
    assert.equal(entitlement?.creditBalanceUsd, 0);
    assert.equal(entitlement?.lifetimeUsageUsd, 0.000015);
    assert.equal((await pool.query(
      'SELECT COUNT(*) AS count FROM account_ai_usage_events WHERE assistant_run_id = $1',
      [runId],
    )).rows[0]?.count, '1');

    const exhaustedRunId = 'assistant-run-membership-exhausted';
    assert.ok(await store.createAssistantRunWithMessage(message(roomId, 'assistant-run-membership-message-exhausted', {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
      aiModel: assistantMessageModel,
    }), {
      id: exhaustedRunId,
      roomId,
      requestedByClientId: clientId,
      aiMessageId: 'assistant-run-membership-message-exhausted',
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
      requestPayload: assistantRequest(roomId, 'context-message-exhausted'),
      generation: 0,
      attempt: 0,
      availableAt: createdAt,
    }));
    const exhaustedRun = await store.getAssistantRun(exhaustedRunId);
    assert.equal(exhaustedRun?.membershipTier, 'pro');
    assert.equal(exhaustedRun?.creditState, 'exhausted');
    assert.equal(exhaustedRun?.queuePriority, 40);

    assert.ok(await store.grantAccountCredits({
      id: 'code-agent-gateway-grant',
      accountId,
      amountUsd: 0.00002,
      idempotencyKey: 'code-agent-gateway-grant',
      now: createdAt,
    }));
    const gatewayUsage = {
      id: 'code-agent-gateway:token-1:1',
      clientId,
      source: 'code_agent_gateway' as const,
      costUsd: 0.00001,
      provider: 'openai' as const,
      modelId: 'test-model',
      roomId,
      turnId: 'code-agent-turn-1',
      now: createdAt,
    };
    const gatewaySettlements = await Promise.all([
      store.settleAccountAIUsage(gatewayUsage),
      store.settleAccountAIUsage(gatewayUsage),
    ]);
    assert.equal(gatewaySettlements.filter(settlement => settlement?.duplicate === false).length, 1);
    assert.equal(gatewaySettlements.filter(settlement => settlement?.duplicate === true).length, 1);
    const afterGatewayUsage = await store.getAccountEntitlementByClientId(clientId);
    assert.equal(afterGatewayUsage?.creditBalanceUsd, 0.00001);
    assert.equal(afterGatewayUsage?.lifetimeUsageUsd, 0.000025);
    assert.deepEqual((await pool.query<{
      source: string;
      room_id: string | null;
      turn_id: string | null;
      credit_applied_usd: string;
    }>(
      `SELECT source, room_id, turn_id, credit_applied_usd
      FROM account_ai_usage_events
      WHERE assistant_run_id = $1`,
      [gatewayUsage.id],
    )).rows[0], {
      source: 'code_agent_gateway',
      room_id: roomId,
      turn_id: 'code-agent-turn-1',
      credit_applied_usd: '0.000010000',
    });

    assert.equal(await store.deleteRoom(roomId, clientId), true);
    assert.equal(await store.getAssistantRun(runId), null);
    assert.equal((await pool.query(
      'SELECT COUNT(*) AS count FROM account_ai_usage_events WHERE assistant_run_id = $1',
      [runId],
    )).rows[0]?.count, '1');
    assert.equal((await store.getAccountEntitlementByClientId(clientId))?.lifetimeUsageUsd, 0.000025);
    assert.equal((await pool.query(
      'SELECT COUNT(*) AS count FROM account_ai_usage_events WHERE assistant_run_id = $1',
      [gatewayUsage.id],
    )).rows[0]?.count, '1');
  });

  it('commits queue dispatch with the placeholder and safely retries a failed Redis enqueue', async () => {
    const roomId = 'assistant-run-dispatch-room';
    const messageId = 'assistant-run-dispatch-message';
    const runId = 'assistant-run-dispatch';
    const initialTime = '2026-07-22T00:00:00.000Z';
    assert.ok(await store.saveRoom(room(roomId)));
    const placeholder = message(roomId, messageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
      aiModel: assistantMessageModel,
    });
    assert.ok(await store.createAssistantRunWithMessage(placeholder, {
      id: runId,
      roomId,
      requestedByClientId: 'event-test-owner',
      aiMessageId: messageId,
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt: initialTime,
      queuedAt: initialTime,
      updatedAt: initialTime,
      requestPayload: assistantRequest(roomId),
      generation: 0,
      attempt: 0,
      availableAt: initialTime,
    }));

    const durable = await pool.query<{ message_count: string; run_count: string; dispatch_count: string }>(
      `SELECT
        (SELECT COUNT(*) FROM room_messages WHERE id = $1) AS message_count,
        (SELECT COUNT(*) FROM assistant_runs WHERE id = $2) AS run_count,
        (SELECT COUNT(*) FROM task_dispatch_outbox WHERE run_id = $2 AND status = 'pending') AS dispatch_count`,
      [messageId, runId],
    );
    assert.deepEqual(durable.rows.map(row => [
      Number(row.message_count),
      Number(row.run_count),
      Number(row.dispatch_count),
    ]), [[1, 1, 1]]);

    const first = await store.claimTaskDispatches({
      workerId: 'relay-1',
      now: initialTime,
      lockMs: 1_000,
    });
    assert.equal(first.length, 1);
    assert.equal(first[0].runId, runId);
    assert.equal(first[0].attempts, 1);
    assert.equal((await store.claimTaskDispatches({
      workerId: 'relay-2',
      now: '2026-07-22T00:00:00.500Z',
      lockMs: 1_000,
    })).length, 0);

    assert.equal(await store.releaseTaskDispatch(
      runId,
      { workerId: 'relay-1', attempt: 1 },
      'queue redis unavailable',
      1_000,
      initialTime,
    ), true);
    assert.equal((await store.claimTaskDispatches({
      workerId: 'relay-2',
      now: '2026-07-22T00:00:00.999Z',
    })).length, 0);
    const retry = await store.claimTaskDispatches({
      workerId: 'relay-2',
      now: '2026-07-22T00:00:01.001Z',
    });
    assert.equal(retry[0]?.attempts, 2);
    assert.equal(await store.markTaskDispatchDispatched(
      runId,
      { workerId: 'relay-1', attempt: 1 },
      '2026-07-22T00:00:02.000Z',
    ), false);
    assert.equal(await store.markTaskDispatchDispatched(
      runId,
      { workerId: 'relay-2', attempt: 2 },
      '2026-07-22T00:00:02.000Z',
    ), true);
    assert.deepEqual(await store.readTaskDispatchMetrics(), {
      pendingCount: 0,
      processingCount: 0,
    });
    assert.deepEqual(
      (await store.readActiveDispatchedTaskDispatches({
        graceMs: 0,
        now: '2026-07-22T00:00:02.001Z',
      })).map(item => item.runId),
      [runId],
    );

    const claimedRun = await store.claimAssistantRunById(runId, {
      workerId: 'bull-worker-1',
      now: '2026-07-22T00:00:02.001Z',
    });
    assert.equal(claimedRun?.run.id, runId);
    assert.equal(claimedRun?.phase, 'execute');
  });

  it('rolls message and room cost back when the final run transition fails', async () => {
    const roomId = 'assistant-run-atomic-projection-room';
    const messageId = 'assistant-run-atomic-projection-message';
    const runId = 'assistant-run-atomic-projection';
    const failureFunction = 'fail_assistant_run_projection_for_test';
    const failureTrigger = 'assistant_run_projection_failure_test';
    assert.ok(await store.saveRoom(room(roomId)));
    const placeholder = message(roomId, messageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
      aiModel: assistantMessageModel,
    });
    assert.ok(await store.createAssistantRunWithMessage(placeholder, {
      id: runId,
      roomId,
      requestedByClientId: 'event-test-owner',
      aiMessageId: messageId,
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
      requestPayload: assistantRequest(roomId),
      generation: 0,
      attempt: 0,
      availableAt: createdAt,
    }));
    const execution = await store.claimAssistantRun({ workerId: 'worker-1', now: createdAt, leaseMs: 30_000 });
    assert.ok(execution);
    assert.ok(await store.stageAssistantRunTerminal(runId, execution.token, {
      schemaVersion: 1,
      outcome: 'complete',
      message: {
        ...placeholder,
        content: 'atomic answer',
        status: 'complete',
        timestamp: createdAt,
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          source: 'reported',
        },
        cost: {
          currency: 'USD',
          inputUsd: 0.00001,
          outputUsd: 0.000005,
          totalUsd: 0.000015,
          inputPerMillion: 1,
          outputPerMillion: 1,
          estimated: false,
        },
      },
    }));

    await pool.query(`
      CREATE OR REPLACE FUNCTION ${failureFunction}()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${runId}' AND NEW.status = 'complete' THEN
          RAISE EXCEPTION 'forced terminal projection failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${failureTrigger}
      BEFORE UPDATE ON assistant_runs
      FOR EACH ROW EXECUTE FUNCTION ${failureFunction}();
    `);
    try {
      await assert.rejects(
        store.projectAssistantRunTerminal(runId, execution.token),
        /forced terminal projection failure/,
      );

      const afterRollback = (await store.readMessagesByRoom(roomId)).find(item => item.id === messageId);
      assert.equal(afterRollback?.status, 'streaming');
      assert.equal(afterRollback?.content, '');
      assert.equal((await store.getAssistantRun(runId))?.status, 'finalizing');
      assert.equal((await pool.query(
        'SELECT total_usd FROM room_ai_cost_totals WHERE room_id = $1',
        [roomId],
      )).rows.length, 0);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${failureTrigger} ON assistant_runs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${failureFunction}()`);
    }

    assert.equal((await store.projectAssistantRunTerminal(runId, execution.token)).outcome, 'applied');
    assert.equal((await store.readRoomAICost(roomId)).totalUsd, 0.000015);
    assert.deepEqual(await store.projectAssistantRunTerminal(runId, execution.token), { outcome: 'stale' });
    assert.equal((await store.readRoomAICost(roomId)).totalUsd, 0.000015);
  });

  it('terminalizes a corrupted durable request exactly once without accepting a normal result', async () => {
    const roomId = 'assistant-run-invalid-request-room';
    const messageId = 'assistant-run-invalid-request-message';
    const runId = 'assistant-run-invalid-request';
    assert.ok(await store.saveRoom(room(roomId)));
    const placeholder = message(roomId, messageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
      aiModel: assistantMessageModel,
    });
    assert.ok(await store.createAssistantRunWithMessage(placeholder, {
      id: runId,
      roomId,
      requestedByClientId: 'event-test-owner',
      aiMessageId: messageId,
      status: 'queued',
      modelId: assistantTestModel.id,
      apiModel: assistantTestModel.apiModel,
      provider: assistantTestModel.provider,
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
      requestPayload: assistantRequest(roomId),
      generation: 0,
      attempt: 0,
      availableAt: createdAt,
    }));
    const execution = await store.claimAssistantRun({ workerId: 'worker-1', now: createdAt });
    assert.ok(execution);
    await pool.query(
      `UPDATE assistant_runs SET request_payload = '{"schemaVersion": 99}'::jsonb WHERE id = $1`,
      [runId],
    );

    await assert.rejects(
      store.stageAssistantRunTerminal(runId, execution.token, {
        schemaVersion: 1,
        outcome: 'complete',
        message: { ...placeholder, status: 'complete', content: 'must not apply' },
      }),
      /invalid terminal payload/,
    );
    const notice = 'Sorry, this AI request has an invalid durable context snapshot.';
    assert.ok(await store.stageAssistantRunTerminal(runId, execution.token, {
      schemaVersion: 1,
      outcome: 'error',
      error: notice,
      metadata: { invalidRequestPayload: true },
      message: {
        ...placeholder,
        status: 'error',
        isError: true,
        content: notice,
      },
    }));
    assert.equal((await store.projectAssistantRunTerminal(runId, execution.token)).outcome, 'applied');
    assert.equal((await store.getAssistantRun(runId))?.status, 'error');
    const terminalMessage = (await store.readMessagesByRoom(roomId)).find(item => item.id === messageId);
    assert.equal(terminalMessage?.status, 'error');
    assert.equal(terminalMessage?.content, notice);
    assert.equal((await store.readRoomAICost(roomId)).totalUsd, 0);
  });

  it('reclaims a staged terminal only for projection and never repeats provider work', async () => {
    const roomId = 'assistant-run-finalizing-room';
    const messageId = 'assistant-run-finalizing-message';
    const runId = 'assistant-run-finalizing';
    assert.ok(await store.saveRoom(room(roomId)));
    const placeholder = message(roomId, messageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
      aiModel: assistantMessageModel,
    });
    assert.ok(await store.createAssistantRunWithMessage(placeholder, {
      id: runId,
      roomId,
      requestedByClientId: 'event-test-owner',
      aiMessageId: messageId,
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
      requestPayload: assistantRequest(roomId),
      generation: 0,
      attempt: 0,
      availableAt: createdAt,
    }));
    const execution = await store.claimAssistantRun({ workerId: 'worker-1', now: createdAt, leaseMs: 30_000 });
    assert.ok(execution);
    assert.ok(await store.stageAssistantRunTerminal(runId, execution.token, {
      schemaVersion: 1,
      outcome: 'complete',
      message: { ...placeholder, content: 'staged', status: 'complete', timestamp: createdAt },
    }));
    assert.equal(await store.releaseAssistantRunClaim(runId, execution.token, 'projection unavailable', 0, createdAt), true);

    const projection = await store.claimAssistantRun({
      workerId: 'worker-2',
      now: '2026-07-20T12:00:00.001Z',
      leaseMs: 30_000,
    });
    assert.ok(projection);
    assert.equal(projection.phase, 'project');
    assert.equal(projection.run.attempt, 1);
    assert.equal(projection.run.generation, 2);
    assert.equal((await store.projectAssistantRunTerminal(runId, projection.token)).outcome, 'applied');
  });

  it('cancels an active run when its placeholder is deleted and never resurrects the message', async () => {
    const roomId = 'assistant-run-deleted-placeholder-room';
    const messageId = 'assistant-run-deleted-placeholder';
    const runId = 'assistant-run-deleted-placeholder';
    assert.ok(await store.saveRoom(room(roomId)));
    const placeholder = message(roomId, messageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
      aiModel: assistantMessageModel,
    });
    assert.ok(await store.createAssistantRunWithMessage(placeholder, {
      id: runId,
      roomId,
      requestedByClientId: 'event-test-owner',
      aiMessageId: messageId,
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
      requestPayload: assistantRequest(roomId),
      generation: 0,
      attempt: 0,
      availableAt: createdAt,
    }));
    const execution = await store.claimAssistantRun({ workerId: 'worker-1', now: createdAt, leaseMs: 30_000 });
    assert.ok(execution);
    assert.ok(await store.stageAssistantRunTerminal(runId, execution.token, {
      schemaVersion: 1,
      outcome: 'complete',
      message: { ...placeholder, content: 'must not return', status: 'complete', timestamp: createdAt },
    }));
    assert.equal((await store.deleteMessageById(roomId, messageId))?.deleted, true);
    assert.equal((await store.getAssistantRun(runId))?.status, 'cancelled');

    const projected = await store.projectAssistantRunTerminal(runId, execution.token);
    assert.equal(projected.outcome, 'stale');
    assert.equal((await store.getAssistantRun(runId))?.status, 'cancelled');
    assert.equal((await store.readMessagesByRoom(roomId)).some(item => item.id === messageId), false);

    const queuedMessageId = 'assistant-run-deleted-before-claim-message';
    const queuedRunId = 'assistant-run-deleted-before-claim';
    assert.ok(await store.createAssistantRunWithMessage(message(roomId, queuedMessageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
    }), {
      id: queuedRunId,
      roomId,
      requestedByClientId: 'event-test-owner',
      aiMessageId: queuedMessageId,
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
      requestPayload: assistantRequest(roomId, 'queued-context-message'),
      generation: 0,
      attempt: 0,
      availableAt: createdAt,
    }));
    assert.equal((await store.deleteMessageById(roomId, queuedMessageId))?.deleted, true);
    assert.equal((await store.getAssistantRun(queuedRunId))?.status, 'cancelled');
    assert.equal(await store.claimAssistantRun({ workerId: 'must-not-run', now: createdAt }), null);
    assert.deepEqual(
      (await store.readActiveDispatchedTaskDispatches({
        graceMs: 0,
        now: '2026-07-22T00:00:00.000Z',
      })).map(item => item.runId),
      [],
    );
  });

  it('keeps a streaming placeholder recoverable while its assistant run is active', async () => {
    const roomId = 'recoverable-assistant-run-room';
    const messageId = 'recoverable-assistant-message';
    const runId = 'recoverable-assistant-run';
    assert.ok(await store.saveRoom(room(roomId)));
    assert.ok(await store.createAssistantRunWithMessage(message(roomId, messageId, {
      clientId: 'ai_assistant',
      messageType: 'ai',
      content: '',
      status: 'streaming',
    }), {
      id: runId,
      roomId,
      requestedByClientId: 'event-test-owner',
      aiMessageId: messageId,
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
      requestPayload: assistantRequest(roomId),
      generation: 0,
      attempt: 0,
      availableAt: createdAt,
    }));

    assert.equal(await store.failOrphanedStreamingMessages('Response interrupted.', createdAt), 0);
    assert.equal((await store.readMessagesByRoom(roomId))[0]?.status, 'streaming');

    assert.equal((await pool.query(
      `UPDATE assistant_runs
      SET status = 'cancelled', completed_at = $2, updated_at = $2
      WHERE id = $1`,
      [runId, createdAt],
    )).rowCount, 1);
    assert.equal(await store.failOrphanedStreamingMessages('Response interrupted.', createdAt), 1);
    assert.equal((await store.readMessagesByRoom(roomId))[0]?.status, 'error');
  });

  it('imports legacy Redis AI jobs into the run aggregate without reviving the retired outbox worker', async () => {
    const roomId = 'legacy-redis-assistant-import-room';
    const recoverableMessageId = 'legacy-redis-recoverable-message';
    const missingRequestMessageId = 'legacy-redis-missing-request-message';
    const completedMessageId = 'legacy-redis-completed-message';
    assert.ok(await store.saveRoom(room(roomId)));
    for (const candidate of [
      message(roomId, recoverableMessageId, {
        clientId: 'ai_assistant', messageType: 'ai', content: '', status: 'streaming',
      }),
      message(roomId, missingRequestMessageId, {
        clientId: 'ai_assistant', messageType: 'ai', content: '', status: 'streaming',
      }),
      message(roomId, completedMessageId, {
        clientId: 'ai_assistant', messageType: 'ai', content: 'legacy result', status: 'complete',
        usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6, source: 'reported' },
      }),
    ]) {
      assert.ok(await store.appendMessage(candidate));
    }

    const runBase = {
      roomId,
      requestedByClientId: 'event-test-owner',
      status: 'queued',
      modelId: 'legacy-model',
      apiModel: 'provider/legacy-model',
      provider: 'openrouter',
      roleName: 'Legacy Assistant',
      systemPrompt: 'Use the imported request.',
      createdAt,
      queuedAt: createdAt,
      updatedAt: createdAt,
    };
    const requestEvent = {
      id: 'legacy-redis-ai-outbox',
      eventType: 'ai.run_requested',
      aggregateType: 'assistant_run',
      aggregateId: 'legacy-redis-recoverable-run',
      roomId,
      payload: { contextMessages: [message(roomId, 'legacy-redis-context')] },
      status: 'processing',
      attempts: 1,
      availableAt: createdAt,
      lockedAt: createdAt,
      lockedBy: 'retired-worker',
      createdAt,
      updatedAt: createdAt,
    };
    const data: RedisDurableGlobalData = {
      ...emptyRedisGlobalData(),
      assistantRuns: [
        {
          ...runBase,
          id: 'legacy-redis-recoverable-run',
          aiMessageId: recoverableMessageId,
          status: 'running',
        },
        {
          ...runBase,
          id: 'legacy-redis-missing-request-run',
          aiMessageId: missingRequestMessageId,
        },
        {
          ...runBase,
          id: 'legacy-redis-completed-run',
          aiMessageId: completedMessageId,
          status: 'complete',
          completedAt: createdAt,
        },
      ] as any,
      outboxEvents: [requestEvent] as any,
    };
    const target = new PostgresMigrationTarget(pool, store);
    await target.saveGlobalData(data);

    const recoverable = await store.getAssistantRun('legacy-redis-recoverable-run');
    assert.equal(recoverable?.status, 'queued');
    assert.equal(recoverable?.requestPayload?.model.id, 'legacy-model');
    assert.equal(recoverable?.requestPayload?.roleName, 'Legacy Assistant');
    assert.deepEqual(
      recoverable?.requestPayload?.contextMessages.map(item => item.id),
      ['legacy-redis-context'],
    );
    assert.equal((await store.getAssistantRun('legacy-redis-missing-request-run'))?.status, 'cancelled');
    assert.equal(
      (await store.readMessagesByRoom(roomId)).find(item => item.id === missingRequestMessageId)?.status,
      'error',
    );
    const completed = await store.getAssistantRun('legacy-redis-completed-run');
    assert.equal(completed?.status, 'complete');
    assert.equal(completed?.terminalPayload?.message.content, 'legacy result');
    assert.equal(completed?.terminalPayload?.message.usage?.totalTokens, 6);
    assert.deepEqual((await pool.query(
      `SELECT status, locked_at, locked_by
      FROM outbox_events
      WHERE id = $1`,
      [requestEvent.id],
    )).rows[0], { status: 'processed', locked_at: null, locked_by: null });

    const claimed = await store.claimAssistantRun({ workerId: 'new-worker', now: createdAt });
    assert.equal(claimed?.run.id, 'legacy-redis-recoverable-run');
    await target.saveGlobalData(data);
    assert.equal((await store.getAssistantRun('legacy-redis-recoverable-run'))?.status, 'running');
  });

  it('cuts legacy AI jobs over to the single run aggregate and backfills terminal audit data', async () => {
    const schemaName = `assistant_run_cutover_${Date.now()}`;
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const migrationPool = createPostgresPool(scopedUrl.toString(), logger as any);
    try {
      for (const sql of POSTGRES_SCHEMA_SQL) await migrationPool.query(sql);
      const aggregateMigrationIndex = POSTGRES_MIGRATIONS.findIndex(
        migration => migration.id === '0009_assistant_run_execution_aggregate',
      );
      assert.ok(aggregateMigrationIndex >= 0);
      for (const migration of POSTGRES_MIGRATIONS.slice(0, aggregateMigrationIndex)) {
        await migrationPool.query(migration.sql);
      }
      // This fixture intentionally stops before the 0009 cutover, while the
      // current PostgresStore selects every additive room column. Add only the
      // later nullable projection column needed to exercise that old boundary.
      await migrationPool.query(`ALTER TABLE rooms
        ADD COLUMN IF NOT EXISTS code_agent_last_turn_id TEXT,
        ADD COLUMN IF NOT EXISTS code_agent_workspace_revision_id TEXT`);

      const migrationStore = new PostgresStore(migrationPool, logger as any);
      const roomId = 'assistant-cutover-room';
      const otherRoomId = 'assistant-cutover-other-room';
      assert.ok(await migrationStore.saveRoom(room(roomId)));
      assert.ok(await migrationStore.saveRoom(room(otherRoomId)));

      const activeMessage = message(roomId, 'legacy-active-message', {
        clientId: 'ai_assistant',
        messageType: 'ai',
        status: 'streaming',
        content: '',
      });
      const missingRequestMessage = message(roomId, 'legacy-missing-request-message', {
        clientId: 'ai_assistant',
        messageType: 'ai',
        status: 'streaming',
        content: '',
      });
      const completedMessage = message(roomId, 'legacy-completed-message', {
        clientId: 'ai_assistant',
        messageType: 'ai',
        status: 'complete',
        content: 'legacy answer',
        usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6, source: 'reported' },
        cost: {
          currency: 'USD', inputUsd: 0.001, outputUsd: 0.002, totalUsd: 0.003,
          inputPerMillion: 1, outputPerMillion: 1, estimated: false,
        },
      });
      const identityMessage = message(roomId, 'legacy-identity-message', {
        clientId: 'ai_assistant',
        messageType: 'ai',
        status: 'streaming',
        content: '',
      });
      for (const candidate of [activeMessage, missingRequestMessage, completedMessage, identityMessage]) {
        assert.ok(await migrationStore.appendMessage(candidate));
      }

      await migrationPool.query(
        `INSERT INTO assistant_runs (
          id, room_id, requested_by_client_id, ai_message_id, status,
          model_id, api_model, provider, created_at, queued_at, started_at,
          completed_at, updated_at
        ) VALUES
          ('legacy-active-run', $1, 'owner', $2, 'running', 'model', 'model', 'openai', $3, $3, $3, NULL, $3),
          ('legacy-missing-request-run', $1, 'owner', $4, 'queued', 'model', 'model', 'openai', $3, $3, NULL, NULL, $3),
          ('legacy-completed-run', $1, 'owner', $5, 'complete', 'model', 'model', 'openai', $3, $3, $3, $3, $3)`,
        [roomId, activeMessage.id, createdAt, missingRequestMessage.id, completedMessage.id],
      );
      await migrationPool.query(
        `INSERT INTO outbox_events (
          id, event_type, aggregate_type, aggregate_id, room_id, payload,
          status, attempts, available_at, created_at, updated_at
        ) VALUES (
          'legacy-active-outbox', 'ai.run_requested', 'assistant_run',
          'legacy-active-run', $1, $2::jsonb, 'processing', 1, $3, $3, $3
        )`,
        [roomId, JSON.stringify({ contextMessages: [message(roomId, 'legacy-context')] }), createdAt],
      );

      for (const migration of POSTGRES_MIGRATIONS.slice(aggregateMigrationIndex)) {
        await migrationPool.query(migration.sql);
      }

      const activeRun = await migrationStore.getAssistantRun('legacy-active-run');
      assert.equal(activeRun?.status, 'queued');
      assert.deepEqual(activeRun?.requestPayload?.contextMessages.map(item => item.id), ['legacy-context']);
      assert.equal(activeRun?.leaseOwner, undefined);
      assert.equal(activeRun?.membershipTier, 'guest');
      assert.equal(activeRun?.creditState, 'none');
      assert.equal(activeRun?.queuePriority, 100);
      assert.equal((await migrationPool.query(
        "SELECT status FROM outbox_events WHERE id = 'legacy-active-outbox'",
      )).rows[0]?.status, 'processed');

      const missingRequestRun = await migrationStore.getAssistantRun('legacy-missing-request-run');
      assert.equal(missingRequestRun?.status, 'cancelled');
      assert.equal(
        (await migrationStore.readMessagesByRoom(roomId)).find(item => item.id === missingRequestMessage.id)?.status,
        'error',
      );

      const completedRun = await migrationStore.getAssistantRun('legacy-completed-run');
      assert.equal(completedRun?.terminalPayload?.outcome, 'complete');
      assert.equal(completedRun?.terminalPayload?.message.content, 'legacy answer');
      assert.equal(completedRun?.terminalPayload?.message.cost?.totalUsd, 0.003);
      assert.equal((await migrationStore.deleteMessageById(roomId, completedMessage.id))?.deleted, true);
      assert.equal((await migrationStore.getAssistantRun('legacy-completed-run'))?.status, 'complete');
      assert.equal((await migrationPool.query(
        "SELECT to_regclass('assistant_run_usage') AS relation",
      )).rows[0]?.relation, null);

      await assert.rejects(
        migrationPool.query(
          `INSERT INTO assistant_runs (
            id, room_id, requested_by_client_id, ai_message_id, status,
            model_id, api_model, provider, created_at, queued_at, updated_at,
            request_payload
          ) VALUES (
            'wrong-room-run', $1, 'owner', $2, 'queued',
            'model', 'model', 'openai', $3, $3, $3,
            $4::jsonb
          )`,
          [
            otherRoomId,
            identityMessage.id,
            createdAt,
            JSON.stringify({ schemaVersion: 1, contextMessages: [message(otherRoomId, 'other-context')] }),
          ],
        ),
        /must reference a streaming AI message in room/,
      );
    } finally {
      await migrationPool.end?.();
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
  });

  it('fences AI worker ownership and never resurrects a deleted placeholder', async () => {
    const roomId = 'fenced-ai-stream-room';
    assert.ok(await store.saveRoom(room(roomId)));
    const placeholder = withAIStreamRecoveryMetadata(message(roomId, 'fenced-message', {
      messageType: 'ai',
      content: '',
      status: 'streaming',
    }), 'inline-owner');
    assert.ok(await store.appendMessage(placeholder));
    const headBeforeClaims = await store.readRoomEventHead(roomId);

    assert.equal((await store.claimAIMessageStream(roomId, placeholder.id, { ownerId: 'worker-1', fence: 1 })).outcome, 'claimed');
    assert.equal((await store.claimAIMessageStream(roomId, placeholder.id, { ownerId: 'worker-2', fence: 2 })).outcome, 'claimed');
    assert.equal(
      await store.readRoomEventHead(roomId),
      headBeforeClaims,
      'internal ownership changes must not create public room events',
    );
    const completed = { ...placeholder, content: 'durable answer', status: 'complete' as const };
    assert.deepEqual(await store.finalizeAIMessage(completed, { ownerId: 'worker-1', fence: 1 }), { outcome: 'obsolete' });
    assert.equal((await store.finalizeAIMessage(completed, { ownerId: 'worker-2', fence: 2 })).outcome, 'applied');
    assert.equal((await store.readMessagesByRoom(roomId)).find(item => item.id === placeholder.id)?.content, 'durable answer');

    const deleted = withAIStreamRecoveryMetadata(message(roomId, 'deleted-fenced-message', {
      messageType: 'ai',
      content: '',
      status: 'streaming',
    }), 'inline-owner');
    assert.ok(await store.appendMessage(deleted));
    assert.equal((await store.claimAIMessageStream(roomId, deleted.id, { ownerId: 'worker-3', fence: 1 })).outcome, 'claimed');
    assert.equal((await store.deleteMessageById(roomId, deleted.id))?.deleted, true);
    assert.deepEqual(
      await store.finalizeAIMessage({ ...deleted, content: 'late answer', status: 'complete' }, { ownerId: 'worker-3', fence: 1 }),
      { outcome: 'obsolete' },
    );
    assert.equal((await store.readMessagesByRoom(roomId)).some(item => item.id === deleted.id), false);
  });

  it('allows only one app instance to run singleton maintenance at a time', async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = store.withMaintenanceLock('roomtalk-integration-maintenance', async () => {
      markFirstStarted();
      await firstGate;
      return 'first';
    });
    await firstStarted;

    const second = await store.withMaintenanceLock('roomtalk-integration-maintenance', async () => 'second');
    assert.deepEqual(second, { acquired: false });

    releaseFirst();
    assert.deepEqual(await first, { acquired: true, result: 'first' });
  });

  it('cuts over legacy replay rows atomically while preserving deleted-room authorization', async () => {
    const schemaName = `room_event_cutover_${Date.now()}`;
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const migrationPool = createPostgresPool(scopedUrl.toString(), logger as any);
    const concurrentMigrationPool = createPostgresPool(scopedUrl.toString(), logger as any);
    try {
      for (const sql of POSTGRES_SCHEMA_SQL) await migrationPool.query(sql);
      await migrationPool.query(`CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await migrationPool.query(
        'INSERT INTO schema_migrations (id) VALUES ($1), ($2)',
        [POSTGRES_MIGRATIONS[0].id, POSTGRES_MIGRATIONS[1].id],
      );
      await migrationPool.query(
        `INSERT INTO rooms (id, name, description, created_at, last_activity_at, creator_id)
        VALUES ('legacy-active', 'Legacy active', '', NOW(), NOW(), 'legacy-owner')`,
      );
      await migrationPool.query(
        `INSERT INTO room_event_streams (
          room_id, head_seq, min_available_seq, deleted_at, deleted_reader_ids, updated_at
        ) VALUES
          ('legacy-active', 5, 1, NULL, ARRAY[]::TEXT[], NOW()),
          ('legacy-deleted', 7, 1, NOW(), ARRAY['legacy-reader']::TEXT[], NOW())
        ON CONFLICT (room_id) DO UPDATE SET
          head_seq = EXCLUDED.head_seq,
          min_available_seq = EXCLUDED.min_available_seq,
          deleted_at = EXCLUDED.deleted_at,
          deleted_reader_ids = EXCLUDED.deleted_reader_ids`,
      );
      await migrationPool.query(
        `INSERT INTO room_events (room_id, seq, event_type, schema_version, payload)
        VALUES
          ('legacy-active', 5, 'messages.upserted', 1, '{"messageIds":["current-state-polluted"]}'::jsonb),
          ('legacy-deleted', 7, 'room.deleted', 1, '{"roomId":"legacy-deleted"}'::jsonb)`,
      );

      const migrationStore = new PostgresStore(migrationPool, logger as any);
      const concurrentMigrationStore = new PostgresStore(concurrentMigrationPool, logger as any);
      await Promise.all([
        migrationStore.initializeSchema(),
        concurrentMigrationStore.initializeSchema(),
      ]);

      const applied = await migrationPool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM schema_migrations WHERE id = $1',
        [POSTGRES_MIGRATIONS[2].id],
      );
      assert.equal(Number(applied.rows[0].count), 1);
      const privacyRepairApplied = await migrationPool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM schema_migrations WHERE id = $1',
        [POSTGRES_MIGRATIONS[3].id],
      );
      assert.equal(Number(privacyRepairApplied.rows[0].count), 1);

      const activeStream = await migrationPool.query<{ head_seq: string; min_available_seq: string }>(
        "SELECT head_seq, min_available_seq FROM room_event_streams WHERE room_id = 'legacy-active'",
      );
      assert.deepEqual(activeStream.rows.map(row => [Number(row.head_seq), Number(row.min_available_seq)]), [[5, 6]]);
      await assert.rejects(
        migrationStore.readRoomEvents('legacy-active', { afterSeq: 4, limit: 10 }),
        (error: unknown) => error instanceof RoomEventCursorExpiredError && error.minAvailableSeq === 6,
      );

      // Even a cursor far behind the discarded legacy prefix must receive the
      // terminal tombstone instead of CURSOR_EXPIRED -> impossible snapshot.
      const deletedPage = await migrationStore.readRoomEvents('legacy-deleted', { afterSeq: 0, limit: 10 });
      assert.equal(deletedPage.minAvailableSeq, 8);
      assert.deepEqual(deletedPage.events.map(event => [event.seq, event.type, event.schemaVersion]), [
        [8, 'room.deleted', 1],
      ]);
      assert.equal(await migrationStore.canReadRoomEvents('legacy-deleted', 'legacy-reader'), true);
      assert.equal(await migrationStore.canReadRoomEvents('legacy-deleted', 'unrelated'), false);
    } finally {
      await concurrentMigrationPool.end?.();
      await migrationPool.end?.();
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
  });

  it('repairs member details written by the pre-production V1 writer before serving events', async () => {
    const schemaName = `room_event_member_repair_${Date.now()}`;
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const migrationPool = createPostgresPool(scopedUrl.toString(), logger as any);
    try {
      for (const sql of POSTGRES_SCHEMA_SQL) await migrationPool.query(sql);
      await migrationPool.query(POSTGRES_MIGRATIONS[2].sql);
      await migrationPool.query(`CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await migrationPool.query(
        'INSERT INTO schema_migrations (id) VALUES ($1), ($2), ($3)',
        [POSTGRES_MIGRATIONS[0].id, POSTGRES_MIGRATIONS[1].id, POSTGRES_MIGRATIONS[2].id],
      );
      await migrationPool.query(
        `INSERT INTO rooms (id, name, description, created_at, last_activity_at, creator_id)
        VALUES ('member-repair-room', 'Member repair', '', NOW(), NOW(), 'owner-1')`,
      );
      await migrationPool.query('ALTER TABLE room_events DROP CONSTRAINT room_events_event_type_check');
      await migrationPool.query(`ALTER TABLE room_events ADD CONSTRAINT room_events_event_type_check
        CHECK (event_type IN (
          'messages.upserted', 'messages.deleted', 'agent_turns.upserted', 'agent_turns.deleted',
          'members.changed', 'members.upserted', 'members.deleted', 'room.updated', 'room.deleted'
        ))`);
      const legacySeq = await migrationPool.query<{ head_seq: number | string }>(
        `UPDATE room_event_streams
        SET head_seq = head_seq + 1
        WHERE room_id = 'member-repair-room'
        RETURNING head_seq`,
      );
      await migrationPool.query(
        `INSERT INTO room_events (room_id, seq, event_type, schema_version, payload)
        VALUES (
          'member-repair-room', $1, 'members.upserted', 1,
          '{"memberRows":[{"room_id":"member-repair-room","client_id":"private-member","role":"admin","joined_at":"2026-07-20T00:00:00.000Z"}]}'::jsonb
        )`,
        [Number(legacySeq.rows[0].head_seq)],
      );

      const migrationStore = new PostgresStore(migrationPool, logger as any);
      await migrationStore.initializeSchema();
      await migrationPool.query(
        `INSERT INTO room_members (room_id, client_id, role, joined_at)
        VALUES ('member-repair-room', 'new-private-member', 'member', NOW())`,
      );

      const raw = await migrationPool.query<{ event_type: string; payload: unknown }>(
        `SELECT event_type, payload FROM room_events
        WHERE room_id = 'member-repair-room' AND event_type = 'members.changed'
        ORDER BY seq`,
      );
      assert.equal(raw.rows.length, 2);
      assert.ok(raw.rows.every(row => JSON.stringify(row.payload) === '{}'));
      assert.doesNotMatch(JSON.stringify(raw.rows), /private-member|admin|client_id|role/i);
      const page = await migrationStore.readRoomEvents('member-repair-room', { afterSeq: 0, limit: 10 });
      assert.equal(page.events.filter(event => event.type === 'members.changed').length, 2);
    } finally {
      await migrationPool.end?.();
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
  });
});
