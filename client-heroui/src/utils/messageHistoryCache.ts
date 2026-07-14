import { ensurePersistentBrowserStorage, getBrowserCacheOwnerId, getOwnedBrowserCacheName } from './browserCacheStorage';
import { Message, RoomAgentTurn } from './types';

const DB_NAME = 'roomtalk-message-cache-v3';
const LEGACY_DB_NAMES = ['roomtalk-message-cache', 'roomtalk-message-cache-v2'];
const DB_VERSION = 1;
const STORE_NAME = 'room-message-windows';
const MAX_CACHED_MESSAGES = 100;
const MAX_CACHED_AGENT_TURNS = 50;
const MAX_CACHED_ROOMS = 40;
const MESSAGE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MESSAGE_CACHE_TOUCH_INTERVAL_MS = 60 * 1000;
const CACHE_GENERATIONS_STORAGE_KEY = 'roomtalk-message-cache-generations';
const CACHE_INVALIDATION_STORAGE_PREFIX = 'roomtalk-message-cache-invalidated:';
let legacyMessageCacheCleanup: Promise<void> | null = null;

export interface CachedRoomMessageWindow {
  roomId: string;
  messageVersion: number;
  messages: Message[];
  turns?: RoomAgentTurn[];
  hasMore: boolean;
  oldestMessageId?: string;
  cachedAt: number;
  lastAccessedAt?: number;
}

type StoredRoomMessageWindow = CachedRoomMessageWindow & {
  cacheGeneration?: number;
};

// Synchronous, session-lived mirror of the latest window per room. IndexedDB is
// always async, so a fresh read always paints one loading frame first; this map
// lets a re-opened room render instantly while IndexedDB stays the cross-session
// backup.
const memoryCache = new Map<string, StoredRoomMessageWindow>();
const lastPersistedTouchByRoom = new Map<string, number>();
// A room that is missing or no longer accessible must not be resurrected by an
// IndexedDB read or a late socket/cache callback. The generation survives a
// later successful rejoin, so work started before invalidation stays stale even
// after writes are enabled again.
const invalidatedRoomIds = new Set<string>();
const scopedRoomKey = (roomId: string, ownerId = getBrowserCacheOwnerId()) => `${ownerId}:${roomId}`;
const memoryCacheKey = (roomId: string) => scopedRoomKey(roomId);
const persistentInvalidationKey = (roomId: string) => `${CACHE_INVALIDATION_STORAGE_PREFIX}${encodeURIComponent(scopedRoomKey(roomId))}`;
const isPersistentlyInvalidated = (roomId: string) => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(persistentInvalidationKey(roomId)) === '1';
  } catch {
    return false;
  }
};
const persistRoomInvalidation = (roomId: string, invalidated: boolean) => {
  try {
    if (typeof localStorage === 'undefined') return;
    if (invalidated) {
      localStorage.setItem(persistentInvalidationKey(roomId), '1');
    } else {
      localStorage.removeItem(persistentInvalidationKey(roomId));
    }
  } catch {
    // The in-memory tombstone still protects this tab when storage is unavailable.
  }
};
const isRoomInvalidated = (roomId: string) => (
  invalidatedRoomIds.has(scopedRoomKey(roomId)) || isPersistentlyInvalidated(roomId)
);
const readPersistedCacheGenerations = (): Map<string, number> => {
  try {
    if (typeof localStorage === 'undefined') return new Map();
    const parsed = JSON.parse(localStorage.getItem(CACHE_GENERATIONS_STORAGE_KEY) || '{}') as Record<string, unknown>;
    return new Map(Object.entries(parsed).flatMap(([roomId, generation]) => (
      typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
        ? [[roomId, generation] as const]
        : []
    )));
  } catch {
    return new Map();
  }
};
const cacheGenerationByRoomId = readPersistedCacheGenerations();

// Other tabs share localStorage and IndexedDB but not this module instance.
// Pull persisted generations before every read/write decision so an already
// open tab cannot revive a window invalidated elsewhere.
const syncPersistedCacheGenerations = () => {
  const persisted = readPersistedCacheGenerations();
  persisted.forEach((generation, roomId) => {
    const current = cacheGenerationByRoomId.get(roomId) ?? 0;
    if (generation > current) {
      cacheGenerationByRoomId.set(roomId, generation);
      memoryCache.delete(roomId);
      lastPersistedTouchByRoom.delete(roomId);
    }
  });
};

const persistCacheGenerations = () => {
  try {
    if (typeof localStorage === 'undefined') return;
    // Merge monotonically with values written by other tabs instead of
    // overwriting unrelated/newer generations from a stale in-memory map.
    syncPersistedCacheGenerations();
    localStorage.setItem(CACHE_GENERATIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(cacheGenerationByRoomId)));
  } catch {
    // Cache invalidation remains session-safe when storage is unavailable.
  }
};

const getCacheGeneration = (roomId: string) => {
  syncPersistedCacheGenerations();
  return cacheGenerationByRoomId.get(scopedRoomKey(roomId)) ?? 0;
};

const advanceCacheGeneration = (roomId: string) => {
  const nextGeneration = getCacheGeneration(roomId) + 1;
  cacheGenerationByRoomId.set(scopedRoomKey(roomId), nextGeneration);
  persistCacheGenerations();
  const key = memoryCacheKey(roomId);
  memoryCache.delete(key);
  lastPersistedTouchByRoom.delete(key);
  return nextGeneration;
};

const isCurrentGeneration = (window: StoredRoomMessageWindow, roomId: string) => (
  (window.cacheGeneration ?? 0) === getCacheGeneration(roomId)
);

export const readMemoryRoomMessageWindow = (roomId: string): CachedRoomMessageWindow | null => {
  if (isRoomInvalidated(roomId)) {
    return null;
  }
  const key = memoryCacheKey(roomId);
  const stored = memoryCache.get(key);
  if (!stored || !isCurrentGeneration(stored, roomId)) {
    memoryCache.delete(key);
    return null;
  }
  const now = Date.now();
  stored.lastAccessedAt = now;
  if (now - (lastPersistedTouchByRoom.get(key) ?? 0) >= MESSAGE_CACHE_TOUCH_INTERVAL_MS) {
    lastPersistedTouchByRoom.set(key, now);
    void persistTouchedRoomWindow(stored);
  }
  return stored;
};

const isIndexedDBAvailable = () => typeof indexedDB !== 'undefined';

const cleanupLegacyMessageCache = () => {
  if (legacyMessageCacheCleanup) return legacyMessageCacheCleanup;
  legacyMessageCacheCleanup = new Promise<void>(resolve => {
    if (!isIndexedDBAvailable() || typeof indexedDB.deleteDatabase !== 'function') {
      resolve();
      return;
    }
    let remaining = LEGACY_DB_NAMES.length;
    const settle = () => {
      remaining -= 1;
      if (remaining === 0) resolve();
    };
    LEGACY_DB_NAMES.forEach(baseName => {
      const databaseName = baseName === 'roomtalk-message-cache'
        ? baseName
        : getOwnedBrowserCacheName(baseName);
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = settle;
      request.onerror = settle;
      request.onblocked = settle;
    });
  });
  return legacyMessageCacheCleanup;
};

const openCacheDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (!isIndexedDBAvailable()) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    void cleanupLegacyMessageCache();

    const request = indexedDB.open(getOwnedBrowserCacheName(DB_NAME), DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'roomId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
};

const withStore = async <T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openCacheDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = work(transaction.objectStore(STORE_NAME));
      let requestResult: T;
      let requestSucceeded = false;
      request.onsuccess = () => {
        requestResult = request.result;
        requestSucceeded = true;
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
      transaction.oncomplete = () => {
        if (requestSucceeded) {
          resolve(requestResult);
        } else {
          reject(new Error('IndexedDB transaction completed without a request result'));
        }
      };
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
};

async function persistTouchedRoomWindow(window: StoredRoomMessageWindow): Promise<void> {
  try {
    await withStore('readwrite', store => store.put(window));
  } catch {
    // A synchronous memory hit must never wait on or fail because of IndexedDB.
  }
}

const trimStoredRoomWindows = async (): Promise<void> => {
  if (!isIndexedDBAvailable()) return;
  const db = await openCacheDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      if (typeof store.getAll !== 'function') {
        resolve();
        return;
      }
      const request = store.getAll() as IDBRequest<StoredRoomMessageWindow[]>;
      request.onsuccess = () => {
        const now = Date.now();
        const windows = request.result
          .slice()
          .sort((a, b) => (b.lastAccessedAt ?? b.cachedAt) - (a.lastAccessedAt ?? a.cachedAt));
        windows.forEach((window, index) => {
          const isExpired = now - (window.lastAccessedAt ?? window.cachedAt) > MESSAGE_CACHE_MAX_AGE_MS;
          if (index >= MAX_CACHED_ROOMS || isExpired) {
            store.delete(window.roomId);
            const key = memoryCacheKey(window.roomId);
            memoryCache.delete(key);
            lastPersistedTouchByRoom.delete(key);
          }
        });
      };
      request.onerror = () => reject(request.error || new Error('Failed to inspect message cache'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Failed to trim message cache'));
      transaction.onabort = () => reject(transaction.error || new Error('Message cache trim aborted'));
    });
  } finally {
    db.close();
  }
};

const sanitizeCachedMessages = (messages: Message[]) => messages
  .filter(message => !message.id.startsWith('temp-') && message.deliveryStatus !== 'pending')
  .map(message => {
    const { localMediaPending: _localMediaPending, localMediaPreviewUrl: _localMediaPreviewUrl, ...stored } = message;
    return stored;
  });

const deleteStoredRoomMessageWindowIf = async (
  roomId: string,
  shouldDelete: (stored: StoredRoomMessageWindow) => boolean,
): Promise<void> => {
  const db = await openCacheDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const getRequest = store.get(roomId) as IDBRequest<StoredRoomMessageWindow | undefined>;
      getRequest.onsuccess = () => {
        if (getRequest.result && shouldDelete(getRequest.result)) {
          store.delete(roomId);
        }
      };
      getRequest.onerror = () => reject(getRequest.error || new Error('IndexedDB request failed'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
};

export const readCachedRoomMessageWindow = async (roomId: string): Promise<CachedRoomMessageWindow | null> => {
  if (isRoomInvalidated(roomId)) {
    return null;
  }
  const requestedGeneration = getCacheGeneration(roomId);
  try {
    const stored = await withStore<StoredRoomMessageWindow | undefined>('readonly', store => store.get(roomId)) || null;
    const generationChanged = requestedGeneration !== getCacheGeneration(roomId);
    const storedGenerationIsStale = Boolean(stored && !isCurrentGeneration(stored, roomId));
    if (
      isRoomInvalidated(roomId)
      || generationChanged
      || storedGenerationIsStale
    ) {
      if (stored && storedGenerationIsStale) {
        await deleteStoredRoomMessageWindowIf(roomId, current => (
          (current.cacheGeneration ?? 0) === (stored.cacheGeneration ?? 0)
        ));
      }
      return null;
    }
    if (stored) {
      const touched = { ...stored, lastAccessedAt: Date.now() };
      memoryCache.set(memoryCacheKey(roomId), touched);
      void withStore('readwrite', store => store.put(touched)).catch(() => undefined);
      return touched;
    }
    return null;
  } catch {
    return null;
  }
};

export const writeCachedRoomMessageWindow = async (window: CachedRoomMessageWindow): Promise<void> => {
  if (isRoomInvalidated(window.roomId)) {
    return;
  }
  void ensurePersistentBrowserStorage();
  const cacheGeneration = getCacheGeneration(window.roomId);
  const now = Date.now();
  const trimmed: StoredRoomMessageWindow = {
    ...window,
    messages: sanitizeCachedMessages(window.messages).slice(-MAX_CACHED_MESSAGES),
    turns: window.turns?.slice(-MAX_CACHED_AGENT_TURNS),
    cachedAt: now,
    lastAccessedAt: now,
    cacheGeneration,
  };
  memoryCache.set(memoryCacheKey(trimmed.roomId), trimmed);
  lastPersistedTouchByRoom.set(memoryCacheKey(trimmed.roomId), now);
  try {
    await withStore('readwrite', store => store.put(trimmed));
    // Invalidation may have happened while the IndexedDB transaction was in
    // flight. Delete once more so that completion order cannot revive it.
    if (isRoomInvalidated(trimmed.roomId) || getCacheGeneration(trimmed.roomId) !== cacheGeneration) {
      await deleteStoredRoomMessageWindowIf(trimmed.roomId, stored => (
        (stored.cacheGeneration ?? 0) === cacheGeneration
      ));
      return;
    }
    await trimStoredRoomWindows();
  } catch {
    // Local cache is best-effort only.
  }
};

// Clear history for a room that still exists. Advancing the generation makes
// writes that started before the clear stale, while leaving subsequent writes
// enabled for new messages in the same room.
export const clearCachedRoomMessageWindow = async (roomId: string): Promise<void> => {
  const nextGeneration = advanceCacheGeneration(roomId);
  try {
    await deleteStoredRoomMessageWindowIf(roomId, stored => (
      (stored.cacheGeneration ?? 0) !== nextGeneration
    ));
  } catch {
    // Generation checks still prevent a stale record from being read.
  }
};

export const invalidateCachedRoomMessageWindow = async (roomId: string): Promise<void> => {
  invalidatedRoomIds.add(scopedRoomKey(roomId));
  persistRoomInvalidation(roomId, true);
  advanceCacheGeneration(roomId);
  try {
    await deleteStoredRoomMessageWindowIf(roomId, () => true);
  } catch {
    // Local cache is best-effort only; generation checks still block stale reads.
  }
};

export const reactivateCachedRoomMessageWindow = (roomId: string): void => {
  invalidatedRoomIds.delete(scopedRoomKey(roomId));
  persistRoomInvalidation(roomId, false);
};

export const clearCachedMessageWindowsForClient = async (ownerId: string): Promise<void> => {
  const ownerPrefix = `${ownerId}:`;
  for (const key of memoryCache.keys()) {
    if (key.startsWith(ownerPrefix)) {
      memoryCache.delete(key);
      lastPersistedTouchByRoom.delete(key);
    }
  }
  for (const key of invalidatedRoomIds) {
    if (key.startsWith(ownerPrefix)) invalidatedRoomIds.delete(key);
  }
  try {
    const generations = readPersistedCacheGenerations();
    for (const key of generations.keys()) {
      if (key.startsWith(ownerPrefix)) generations.delete(key);
    }
    localStorage.setItem(CACHE_GENERATIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(generations)));
    const invalidationPrefix = `${CACHE_INVALIDATION_STORAGE_PREFIX}${encodeURIComponent(ownerPrefix)}`;
    const keysToRemove: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(invalidationPrefix)) keysToRemove.push(key);
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
  } catch {
    // The scoped database deletion below still prevents cross-account reads.
  }
  if (!isIndexedDBAvailable()) return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(getOwnedBrowserCacheName(DB_NAME, ownerId));
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
};
