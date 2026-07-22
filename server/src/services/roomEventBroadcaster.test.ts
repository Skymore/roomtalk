import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { RoomEvent } from '../types';
import { emitRoomEventLocally, emitRoomSyncRequiredLocally, RoomEventBroadcast, RoomEventBroadcaster } from './roomEventBroadcaster';

const roomEvent = (seq: number, content = 'hello'): RoomEvent => ({
  id: `room-1:${seq}`,
  roomId: 'room-1',
  seq,
  schemaVersion: 1,
  type: 'messages.upserted',
  payload: {
    messageIds: [`message-${seq}`],
    messages: [{
      id: `message-${seq}`,
      roomId: 'room-1',
      clientId: 'client-1',
      content,
      timestamp: '2026-07-20T00:00:00.000Z',
      messageType: 'text',
    }],
  },
  createdAt: '2026-07-20T00:00:00.000Z',
});

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for broadcaster to drain');
    await new Promise(resolve => setImmediate(resolve));
  }
};

describe('RoomEventBroadcaster', () => {
  it('reads the exact immutable committed event and includes it in the Socket fast path', async () => {
    const emitted: RoomEventBroadcast[] = [];
    const requests: unknown[] = [];
    const store = {
      readRoomEvent: async (roomId: string, seq: number) => {
        requests.push({ roomId, seq });
        return roomEvent(seq);
      },
    } as unknown as RoomStore;
    const broadcaster = new RoomEventBroadcaster({
      store,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256 * 1024,
      emit: event => emitted.push(event),
    });

    broadcaster.handle({ roomId: 'room-1', headSeq: 42 });
    await waitUntil(() => emitted.length === 1);

    assert.deepEqual(requests, [{ roomId: 'room-1', seq: 42 }]);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].headSeq, 42);
    assert.equal(emitted[0].events?.[0].seq, 42);
  });

  it('falls back to a head-only hint when the immutable payload is too large', async () => {
    const emitted: RoomEventBroadcast[] = [];
    const store = {
      readRoomEvent: async () => roomEvent(42, 'x'.repeat(1024)),
    } as unknown as RoomStore;
    const broadcaster = new RoomEventBroadcaster({
      store,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256,
      emit: event => emitted.push(event),
    });

    broadcaster.handle({ roomId: 'room-1', headSeq: 42 });
    await waitUntil(() => emitted.length === 1);

    assert.deepEqual(emitted, [{ roomId: 'room-1', headSeq: 42 }]);
  });

  it('falls back to a head-only hint when the exact PostgreSQL event read fails', async () => {
    const emitted: RoomEventBroadcast[] = [];
    const store = {
      readRoomEvent: async () => {
        throw new Error('temporary read failure');
      },
    } as unknown as RoomStore;
    const broadcaster = new RoomEventBroadcaster({
      store,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256 * 1024,
      emit: event => emitted.push(event),
    });

    broadcaster.handle({ roomId: 'room-1', headSeq: 42 });
    await waitUntil(() => emitted.length === 1);

    assert.deepEqual(emitted, [{ roomId: 'room-1', headSeq: 42 }]);
  });

  it('serializes same-room exact reads so fast-path events stay ordered', async () => {
    const emitted: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstRead = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const reads: number[] = [];
    const store = {
      readRoomEvent: async (_roomId: string, seq: number) => {
        reads.push(seq);
        if (seq === 42) await firstRead;
        return roomEvent(seq);
      },
    } as unknown as RoomStore;
    const broadcaster = new RoomEventBroadcaster({
      store,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256 * 1024,
      emit: event => emitted.push(event.headSeq),
    });

    broadcaster.handle({ roomId: 'room-1', headSeq: 42 });
    broadcaster.handle({ roomId: 'room-1', headSeq: 43 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [42]);
    releaseFirst?.();
    await waitUntil(() => emitted.length === 2);

    assert.deepEqual(reads, [42, 43]);
    assert.deepEqual(emitted, [42, 43]);
  });

  it('coalesces a burst into a bounded number of range reads and exposes queue metrics', async () => {
    const emitted: RoomEventBroadcast[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstRead = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const reads: Array<{ afterSeq: number; limit: number }> = [];
    const store = {
      readRoomEvents: async (_roomId: string, options: { afterSeq: number; limit: number }) => {
        reads.push({ afterSeq: options.afterSeq, limit: options.limit });
        if (options.afterSeq === 41) await firstRead;
        return {
          roomId: 'room-1',
          events: Array.from({ length: options.limit }, (_, index) => roomEvent(options.afterSeq + index + 1)),
          headSeq: options.afterSeq + options.limit,
          minAvailableSeq: 1,
          hasMore: false,
        };
      },
    } as unknown as RoomStore;
    const broadcaster = new RoomEventBroadcaster({
      store,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 10 * 1024 * 1024,
      emit: event => emitted.push(event),
    });

    broadcaster.handle({ roomId: 'room-1', headSeq: 42 });
    await new Promise(resolve => setImmediate(resolve));
    for (let seq = 43; seq <= 1042; seq++) {
      broadcaster.handle({ roomId: 'room-1', headSeq: seq });
    }
    releaseFirst?.();
    await waitUntil(() => emitted.length === 2);

    assert.deepEqual(reads, [
      { afterSeq: 41, limit: 1 },
      { afterSeq: 42, limit: 1000 },
    ]);
    assert.deepEqual(emitted.map(event => event.headSeq), [42, 1042]);
    assert.equal(emitted[1].events?.length, 1000);
    assert.equal(broadcaster.getMetrics().coalescedNotifications, 999);
    assert.equal(broadcaster.getMetrics().maxPendingSequenceSpan, 1000);
  });

  it('runs the local authorization barrier before emitting a durable payload', async () => {
    const order: string[] = [];
    const store = {
      readRoomEvent: async () => {
        order.push('read');
        return roomEvent(42);
      },
    } as unknown as RoomStore;
    const broadcaster = new RoomEventBroadcaster({
      store,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256 * 1024,
      authorizeLocalRoom: async () => { order.push('authorize'); return true; },
      emit: () => { order.push('emit'); },
    });

    broadcaster.handle({ roomId: 'room-1', headSeq: 42 });
    await waitUntil(() => order.includes('emit'));

    assert.deepEqual(order, ['read', 'authorize', 'emit']);
  });

  it('keeps local subscriptions and emits only a head hint when authorization is unavailable', async () => {
    const emitted: RoomEventBroadcast[] = [];
    const broadcaster = new RoomEventBroadcaster({
      store: { readRoomEvent: async () => roomEvent(42) } as unknown as RoomStore,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256 * 1024,
      authorizeLocalRoom: async () => false,
      emit: event => emitted.push(event),
    });

    broadcaster.handle({ roomId: 'room-1', headSeq: 42 });
    await waitUntil(() => emitted.length === 1);

    assert.deepEqual(emitted, [{ roomId: 'room-1', headSeq: 42 }]);
    assert.equal(broadcaster.getMetrics().authorizationUnavailable, 1);
  });

  it('does not read PostgreSQL payloads when this instance has no local subscribers', async () => {
    let reads = 0;
    const emitted: RoomEventBroadcast[] = [];
    const broadcaster = new RoomEventBroadcaster({
      store: {
        readRoomEvent: async () => {
          reads++;
          return roomEvent(42);
        },
      } as unknown as RoomStore,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256 * 1024,
      hasLocalSubscribers: async () => false,
      emit: event => emitted.push(event),
    });

    broadcaster.handle({ roomId: 'room-1', headSeq: 42 });
    await waitUntil(() => broadcaster.getMetrics().noLocalSubscriberSkips === 1);

    assert.equal(reads, 0);
    assert.deepEqual(emitted, []);
    assert.equal(broadcaster.getMetrics().noLocalSubscriberSkips, 1);
  });

  it('uses local-only fan-out so three LISTEN instances deliver once to each local client', () => {
    const deliveries: Array<{ instance: number; roomId?: string; event: string }> = [];
    const servers = Array.from({ length: 3 }, (_, instance) => ({
      local: {
        to: (roomId: string) => ({
          emit: (event: string) => deliveries.push({ instance, roomId, event }),
        }),
        emit: (event: string) => deliveries.push({ instance, event }),
      },
      to: () => {
        throw new Error('global Redis fan-out must not be used for PostgreSQL room-event notifications');
      },
    }));

    servers.forEach(server => emitRoomEventLocally(server as any, {
      roomId: 'room-1',
      headSeq: 42,
      events: [roomEvent(42)],
    }));

    assert.deepEqual(deliveries, [
      { instance: 0, roomId: 'room-1', event: 'room_event_available' },
      { instance: 1, roomId: 'room-1', event: 'room_event_available' },
      { instance: 2, roomId: 'room-1', event: 'room_event_available' },
    ]);
  });

  it('emits PostgreSQL listener anti-entropy only to local sockets', () => {
    const events: string[] = [];
    const io = {
      local: { emit: (event: string) => events.push(event) },
      emit: () => { throw new Error('global emit must not be used'); },
    };

    emitRoomSyncRequiredLocally(io as any, { reason: 'postgres_listener_reconnected' });

    assert.deepEqual(events, ['room_sync_required']);
  });
});
