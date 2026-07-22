import assert from 'assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MediaAsset, Message, Room, RoomAgentTurn } from '../types';
import { createPostgresPool } from './postgresPool';
import { POSTGRES_MIGRATIONS, POSTGRES_SCHEMA_SQL } from './postgresSchema';
import { PostgresPool, PostgresStore } from './postgresStore';
import { withAIStreamRecoveryMetadata } from '../services/aiStreamRecovery';
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

  it('creates the AI placeholder, assistant run, and outbox event in one transaction', async () => {
    const roomId = 'atomic-ai-run-start-room';
    const messageId = 'atomic-ai-message';
    const runId = 'atomic-ai-run';
    const eventId = 'atomic-ai-event';
    assert.ok(await store.saveRoom(room(roomId)));
    const placeholder = withAIStreamRecoveryMetadata(message(roomId, messageId, {
      messageType: 'ai',
      content: '',
      status: 'streaming',
    }), 'request-owner');
    const result = await store.createAssistantRunWithMessageAndOutbox(placeholder, {
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
    }, {
      id: eventId,
      eventType: 'ai.run_requested',
      aggregateType: 'assistant_run',
      aggregateId: runId,
      roomId,
      payload: { runId, roomId, aiMessageId: messageId },
      status: 'pending',
      attempts: 0,
      availableAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });
    assert.ok(result);
    assert.equal((await store.readMessagesByRoom(roomId))[0]?.id, messageId);
    assert.equal((await store.getAssistantRun(runId))?.status, 'queued');
    assert.equal((await pool.query('SELECT status FROM outbox_events WHERE id = $1', [eventId])).rows[0]?.status, 'pending');

    const invalid = await store.createAssistantRunWithMessageAndOutbox(
      message(roomId, 'wrong-message', { messageType: 'ai', status: 'streaming' }),
      {
        ...result.run,
        id: 'wrong-run',
        aiMessageId: 'different-message',
      },
      {
        ...result.event,
        id: 'wrong-event',
        aggregateId: 'wrong-run',
      },
    ).catch(error => error);
    assert.ok(invalid instanceof Error);
    assert.equal((await store.readMessagesByRoom(roomId)).some(item => item.id === 'wrong-message'), false);

    const rolledBack = await store.createAssistantRunWithMessageAndOutbox(
      message(roomId, 'rolled-back-message', { messageType: 'ai', content: '', status: 'streaming' }),
      {
        ...result.run,
        id: 'rolled-back-run',
        aiMessageId: 'rolled-back-message',
        provider: 'invalid-provider' as any,
      },
      {
        ...result.event,
        id: 'rolled-back-event',
        aggregateId: 'rolled-back-run',
        payload: { runId: 'rolled-back-run', roomId, aiMessageId: 'rolled-back-message' },
      },
    );
    assert.equal(rolledBack, null);
    assert.equal((await store.readMessagesByRoom(roomId)).some(item => item.id === 'rolled-back-message'), false);
    assert.equal((await store.getAssistantRun('rolled-back-run')), null);
    assert.equal((await pool.query('SELECT 1 FROM outbox_events WHERE id = $1', ['rolled-back-event'])).rows.length, 0);
  });

  it('does not fail an expired-owner placeholder while its durable AI job is recoverable', async () => {
    const roomId = 'recoverable-ai-job-room';
    const messageId = 'recoverable-ai-message';
    const runId = 'recoverable-ai-run';
    const now = '2026-07-21T00:00:31.000Z';
    assert.ok(await store.saveRoom(room(roomId)));
    assert.ok(await store.appendMessage(withAIStreamRecoveryMetadata(message(roomId, messageId, {
      messageType: 'ai',
      content: '',
      status: 'streaming',
    }), 'expired-request-owner')));
    const created = await store.createAssistantRunWithOutbox({
      id: runId,
      roomId,
      requestedByClientId: 'event-test-owner',
      aiMessageId: messageId,
      status: 'queued',
      modelId: 'test-model',
      apiModel: 'test-model',
      provider: 'openai',
      createdAt: now,
      queuedAt: now,
      updatedAt: now,
    }, {
      id: 'recoverable-ai-event',
      eventType: 'ai.run_requested',
      aggregateType: 'assistant_run',
      aggregateId: runId,
      roomId,
      payload: { runId, roomId, aiMessageId: messageId },
      status: 'pending',
      attempts: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
    assert.ok(created);

    assert.equal(await store.failOrphanedStreamingMessages('Response interrupted.', now), 0);
    assert.equal((await store.readMessagesByRoom(roomId))[0]?.status, 'streaming');

    const claimed = await store.claimOutboxEvents({ workerId: 'dead-worker', limit: 1, now, lockMs: 1_000 });
    assert.equal(claimed.length, 1);
    assert.ok(await store.markOutboxEventFailed(
      claimed[0].id,
      'terminal failure',
      { workerId: 'dead-worker', attempt: claimed[0].attempts },
      { maxAttempts: 1, now },
    ));
    assert.ok(await store.updateAssistantRun(runId, { status: 'error', completedAt: now, updatedAt: now }));

    assert.equal(await store.failOrphanedStreamingMessages('Response interrupted.', now), 1);
    const recovered = (await store.readMessagesByRoom(roomId))[0];
    assert.equal(recovered?.status, 'error');
    assert.equal(recovered?.isError, true);
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
