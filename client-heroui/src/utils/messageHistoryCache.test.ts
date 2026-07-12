import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearCachedRoomMessageWindow,
  invalidateCachedRoomMessageWindow,
  reactivateCachedRoomMessageWindow,
  readCachedRoomMessageWindow,
  readMemoryRoomMessageWindow,
  writeCachedRoomMessageWindow,
} from './messageHistoryCache';
import type { CachedRoomMessageWindow } from './messageHistoryCache';

const cachedWindow = (roomId: string, content: string): CachedRoomMessageWindow => ({
  roomId,
  historyVersion: 1,
  messages: [{ id: `${roomId}-message`, roomId, content } as CachedRoomMessageWindow['messages'][number]],
  hasMore: false,
  cachedAt: Date.now(),
});

const installControlledIndexedDb = () => {
  const records = new Map<string, unknown>();
  let openCount = 0;
  let releaseFirstOpen = () => {};

  const database = {
    close: () => {},
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction: () => {
      let pendingRequests = 0;
      let completionScheduled = false;
      const transaction: Record<string, any> = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
      };
      const scheduleCompletion = () => {
        if (pendingRequests !== 0 || completionScheduled) return;
        completionScheduled = true;
        queueMicrotask(() => transaction.oncomplete?.());
      };
      const request = (operation: () => unknown) => {
        const result: Record<string, any> = { result: undefined, error: null, onsuccess: null, onerror: null };
        pendingRequests += 1;
        queueMicrotask(() => {
          result.result = operation();
          result.onsuccess?.();
          pendingRequests -= 1;
          scheduleCompletion();
        });
        return result;
      };
      const store = {
        get: (roomId: string) => request(() => records.get(roomId)),
        put: (value: { roomId: string }) => request(() => {
          records.set(value.roomId, value);
          return value.roomId;
        }),
        delete: (roomId: string) => request(() => records.delete(roomId)),
      };
      transaction.objectStore = () => store;
      return transaction;
    },
  };

  vi.stubGlobal('indexedDB', {
    open: () => {
      const request: Record<string, any> = {
        result: database,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      openCount += 1;
      const succeed = () => queueMicrotask(() => request.onsuccess?.());
      if (openCount === 1) {
        releaseFirstOpen = succeed;
      } else {
        succeed();
      }
      return request;
    },
  });

  return {
    records,
    releaseFirstOpen: () => releaseFirstOpen(),
  };
};

describe('messageHistoryCache invalidation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a normal history clear writable for an existing room', async () => {
    const roomId = 'existing-room';
    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'before clear'));
    await clearCachedRoomMessageWindow(roomId);
    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'after clear'));

    expect(readMemoryRoomMessageWindow(roomId)?.messages[0]?.content).toBe('after clear');
  });

  it('persists agent turns while dropping temporary messages and blob URLs', async () => {
    const roomId = 'agent-cache-room';
    await writeCachedRoomMessageWindow({
      ...cachedWindow(roomId, 'saved'),
      messages: [
        { id: 'temp-upload', roomId, content: '', deliveryStatus: 'pending' } as CachedRoomMessageWindow['messages'][number],
        {
          id: 'saved-media',
          roomId,
          content: '',
          messageType: 'media',
          localMediaPreviewUrl: 'blob:temporary',
          localMediaPending: false,
        } as CachedRoomMessageWindow['messages'][number],
      ],
      turns: [{
        id: 'turn-1',
        roomId,
        status: 'complete',
        startedAt: '2026-07-12T00:00:00.000Z',
        backend: 'code-agent',
        assistantName: 'Coco',
        updatedAt: '2026-07-12T00:00:01.000Z',
      }],
    });

    const cached = readMemoryRoomMessageWindow(roomId);
    expect(cached?.messages.map(message => message.id)).toEqual(['saved-media']);
    expect(cached?.messages[0].localMediaPreviewUrl).toBeUndefined();
    expect(cached?.turns?.map(turn => turn.id)).toEqual(['turn-1']);
  });

  it('isolates room message windows by the active client id', async () => {
    const roomId = 'shared-room-id';
    localStorage.setItem('clientId', 'cache-owner-a');
    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'owner a'));

    localStorage.setItem('clientId', 'cache-owner-b');
    expect(readMemoryRoomMessageWindow(roomId)).toBeNull();

    localStorage.setItem('clientId', 'cache-owner-a');
    expect(readMemoryRoomMessageWindow(roomId)?.messages[0]?.content).toBe('owner a');
  });

  it('rejects an old write that completes after clear while allowing the new generation', async () => {
    const roomId = 'clear-race-room';
    const controlledDb = installControlledIndexedDb();
    const staleWrite = writeCachedRoomMessageWindow(cachedWindow(roomId, 'stale in-flight write'));

    await clearCachedRoomMessageWindow(roomId);
    controlledDb.releaseFirstOpen();
    await staleWrite;

    expect(readMemoryRoomMessageWindow(roomId)).toBeNull();
    expect(controlledDb.records.has(roomId)).toBe(false);

    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'new generation'));

    expect(readMemoryRoomMessageWindow(roomId)?.messages[0]?.content).toBe('new generation');
    expect((await readCachedRoomMessageWindow(roomId))?.messages[0]?.content).toBe('new generation');
  });

  it('does not let late cache writes resurrect a confirmed-missing room', async () => {
    const roomId = 'missing-room';
    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'stale'));
    await invalidateCachedRoomMessageWindow(roomId);

    expect(readMemoryRoomMessageWindow(roomId)).toBeNull();

    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'late write'));
    expect(readMemoryRoomMessageWindow(roomId)).toBeNull();
  });

  it('allows a new cache generation after a successful rejoin', async () => {
    const roomId = 'rejoined-room';
    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'before access removal'));
    await invalidateCachedRoomMessageWindow(roomId);

    reactivateCachedRoomMessageWindow(roomId);
    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'after rejoin'));

    expect(readMemoryRoomMessageWindow(roomId)?.messages[0]?.content).toBe('after rejoin');
  });

  it('observes a newer generation written by another tab before reading or writing', async () => {
    const roomId = 'cross-tab-room';
    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'old tab window'));
    expect(readMemoryRoomMessageWindow(roomId)?.messages[0]?.content).toBe('old tab window');

    const storageKey = 'roomtalk-message-cache-generations';
    const persisted = JSON.parse(localStorage.getItem(storageKey) || '{}') as Record<string, number>;
    const scopedRoomId = `${localStorage.getItem('clientId') || 'anonymous'}:${roomId}`;
    localStorage.setItem(storageKey, JSON.stringify({
      ...persisted,
      [scopedRoomId]: (persisted[scopedRoomId] ?? 0) + 1,
    }));

    expect(readMemoryRoomMessageWindow(roomId)).toBeNull();

    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'new tab generation'));
    expect(readMemoryRoomMessageWindow(roomId)?.messages[0]?.content).toBe('new tab generation');
  });

  it('honors a cross-tab invalidation tombstone until a verified rejoin', async () => {
    const roomId = 'cross-tab-missing-room';
    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'before remote invalidation'));
    const scopedRoomId = `${localStorage.getItem('clientId') || 'anonymous'}:${roomId}`;
    localStorage.setItem(`roomtalk-message-cache-invalidated:${encodeURIComponent(scopedRoomId)}`, '1');

    expect(readMemoryRoomMessageWindow(roomId)).toBeNull();
    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'late remote-tab event'));
    expect(readMemoryRoomMessageWindow(roomId)).toBeNull();

    reactivateCachedRoomMessageWindow(roomId);
    await writeCachedRoomMessageWindow(cachedWindow(roomId, 'after verified rejoin'));
    expect(readMemoryRoomMessageWindow(roomId)?.messages[0]?.content).toBe('after verified rejoin');
  });
});
