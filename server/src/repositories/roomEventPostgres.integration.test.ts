import assert from 'assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Message, Room } from '../types';
import { createPostgresPool } from './postgresPool';
import { PostgresPool, PostgresStore } from './postgresStore';
import { RoomEventCursorAheadError, RoomEventCursorExpiredError } from './store';

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

describe('PostgreSQL room event integration', { skip: !databaseUrl }, () => {
  let pool: PostgresPool;
  let store: PostgresStore;

  before(async () => {
    pool = createPostgresPool(databaseUrl!, logger as any);
    store = new PostgresStore(pool, logger as any);
    await store.initializeSchema();
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
    assert.equal(snapshot.snapshotSeq, 2);

    const page = await store.readRoomEvents(roomId, { afterSeq: 0, limit: 100 });
    assert.deepEqual(page.events.map(event => [event.seq, event.type]), [
      [1, 'room.updated'],
      [2, 'messages.upserted'],
    ]);
    assert.equal(page.events[1].payload.messages?.[0]?.content, 'message-1');

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
      assert.equal(Number(inside.rows[0].head_seq), baselineHead + 1);
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
      assert.equal(await store.readRoomEventHead(roomId), 3);
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
    assert.equal(headSeq, 6);
    assert.equal(await store.pruneRoomEvents({
      olderThan: '1970-01-01T00:00:00.000Z',
      maxEventsPerRoom: 2,
    }), 4);

    const retained = await store.readRoomEvents(roomId, { afterSeq: 4, limit: 10 });
    assert.equal(retained.minAvailableSeq, 5);
    assert.deepEqual(retained.events.map(event => event.seq), [5, 6]);
    await assert.rejects(
      store.readRoomEvents(roomId, { afterSeq: 0, limit: 10 }),
      (error: unknown) => error instanceof RoomEventCursorExpiredError
        && error.minAvailableSeq === 5,
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
    assert.ok(page.events.some(event => event.type === 'messages.deleted'));
  });
});
