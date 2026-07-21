import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { RoomEvent } from '../types';
import { RoomEventBroadcast, RoomEventBroadcaster } from './roomEventBroadcaster';

const roomEvent = (seq: number, content = 'hello'): RoomEvent => ({
  id: `room-1:${seq}`,
  roomId: 'room-1',
  seq,
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

describe('RoomEventBroadcaster', () => {
  it('hydrates a committed event and includes it in the Socket fast path', async () => {
    const emitted: RoomEventBroadcast[] = [];
    const requests: unknown[] = [];
    const store = {
      readRoomEvents: async (_roomId: string, options: unknown) => {
        requests.push(options);
        return {
          roomId: 'room-1',
          events: [roomEvent(42)],
          headSeq: 42,
          minAvailableSeq: 1,
          hasMore: false,
        };
      },
    } as unknown as RoomStore;
    const broadcaster = new RoomEventBroadcaster({
      store,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256 * 1024,
      emit: event => emitted.push(event),
    });

    await broadcaster.handle({ roomId: 'room-1', headSeq: 42 });

    assert.deepEqual(requests, [{ afterSeq: 41, limit: 1, maxBytes: 256 * 1024 }]);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].headSeq, 42);
    assert.equal(emitted[0].events?.[0].seq, 42);
  });

  it('falls back to a head-only hint when the hydrated payload is too large', async () => {
    const emitted: RoomEventBroadcast[] = [];
    const store = {
      readRoomEvents: async () => ({
        roomId: 'room-1',
        events: [roomEvent(42, 'x'.repeat(1024))],
        headSeq: 42,
        minAvailableSeq: 1,
        hasMore: false,
      }),
    } as unknown as RoomStore;
    const broadcaster = new RoomEventBroadcaster({
      store,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256,
      emit: event => emitted.push(event),
    });

    await broadcaster.handle({ roomId: 'room-1', headSeq: 42 });

    assert.deepEqual(emitted, [{ roomId: 'room-1', headSeq: 42 }]);
  });

  it('falls back to a head-only hint when PostgreSQL hydration fails', async () => {
    const emitted: RoomEventBroadcast[] = [];
    const store = {
      readRoomEvents: async () => {
        throw new Error('temporary read failure');
      },
    } as unknown as RoomStore;
    const broadcaster = new RoomEventBroadcaster({
      store,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256 * 1024,
      emit: event => emitted.push(event),
    });

    await broadcaster.handle({ roomId: 'room-1', headSeq: 42 });

    assert.deepEqual(emitted, [{ roomId: 'room-1', headSeq: 42 }]);
  });

  it('serializes same-room hydration so fast-path events stay ordered', async () => {
    const emitted: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstRead = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const reads: number[] = [];
    const store = {
      readRoomEvents: async (_roomId: string, options: { afterSeq: number }) => {
        const seq = options.afterSeq + 1;
        reads.push(seq);
        if (seq === 42) await firstRead;
        return {
          roomId: 'room-1',
          events: [roomEvent(seq)],
          headSeq: seq,
          minAvailableSeq: 1,
          hasMore: false,
        };
      },
    } as unknown as RoomStore;
    const broadcaster = new RoomEventBroadcaster({
      store,
      logger: new Logger('RoomEventBroadcasterTest'),
      maxPayloadBytes: 256 * 1024,
      emit: event => emitted.push(event.headSeq),
    });

    const first = broadcaster.handle({ roomId: 'room-1', headSeq: 42 });
    const second = broadcaster.handle({ roomId: 'room-1', headSeq: 43 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [42]);
    releaseFirst?.();
    await Promise.all([first, second]);

    assert.deepEqual(reads, [42, 43]);
    assert.deepEqual(emitted, [42, 43]);
  });
});
