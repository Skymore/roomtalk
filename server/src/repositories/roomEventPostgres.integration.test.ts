import assert from 'assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MediaAsset, Message, Room, RoomAgentTurn } from '../types';
import { createPostgresPool } from './postgresPool';
import { POSTGRES_MIGRATIONS, POSTGRES_SCHEMA_SQL } from './postgresSchema';
import { PostgresPool, PostgresStore } from './postgresStore';
import { withAIStreamRecoveryMetadata } from '../services/aiStreamRecovery';
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
    assert.equal(snapshot.snapshotSeq, 3);

    const page = await store.readRoomEvents(roomId, { afterSeq: 0, limit: 100 });
    assert.deepEqual(page.events.map(event => [event.seq, event.type]), [
      [1, 'room.updated'],
      [2, 'members.changed'],
      [3, 'messages.upserted'],
    ]);
    assert.equal(page.events[2].payload.messages?.[0]?.content, 'message-1');
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
    assert.ok(await store.acquireCodeAgentRoomLease(
      roomId,
      runningTurn.id,
      'instance-a',
      '2026-07-21T00:00:00.000Z',
      30_000,
    ));

    assert.equal(await store.failInterruptedRoomAgentTurns('2026-07-21T00:00:10.000Z'), 0);
    assert.deepEqual(await store.findInterruptedCodeAgentRooms('2026-07-21T00:00:10.000Z'), []);

    assert.equal(await store.failInterruptedRoomAgentTurns('2026-07-21T00:00:31.000Z'), 1);
    assert.deepEqual(
      (await store.findInterruptedCodeAgentRooms('2026-07-21T00:00:31.000Z')).map(room => room.id),
      [roomId],
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
      for (const migration of POSTGRES_MIGRATIONS.slice(0, -1)) {
        await migrationPool.query(migration.sql);
      }

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

      await migrationPool.query(POSTGRES_MIGRATIONS.at(-1)!.sql);

      const activeRun = await migrationStore.getAssistantRun('legacy-active-run');
      assert.equal(activeRun?.status, 'queued');
      assert.deepEqual(activeRun?.requestPayload?.contextMessages.map(item => item.id), ['legacy-context']);
      assert.equal(activeRun?.leaseOwner, undefined);
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
