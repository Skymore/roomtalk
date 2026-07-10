import { Message } from './types';

const DB_NAME = 'roomtalk-message-cache';
const DB_VERSION = 1;
const STORE_NAME = 'room-message-windows';
const MAX_CACHED_MESSAGES = 100;
const CACHE_GENERATIONS_STORAGE_KEY = 'roomtalk-message-cache-generations';
const CACHE_INVALIDATION_STORAGE_PREFIX = 'roomtalk-message-cache-invalidated:';

export interface CachedRoomMessageWindow {
  roomId: string;
  historyVersion: number;
  messages: Message[];
  hasMore: boolean;
  oldestMessageId?: string;
  cachedAt: number;
}

type StoredRoomMessageWindow = CachedRoomMessageWindow & {
  cacheGeneration?: number;
};

// Synchronous, session-lived mirror of the latest window per room. IndexedDB is
// always async, so a fresh read always paints one loading frame first; this map
// lets a re-opened room render instantly while IndexedDB stays the cross-session
// backup.
const memoryCache = new Map<string, StoredRoomMessageWindow>();
// A room that is missing or no longer accessible must not be resurrected by an
// IndexedDB read or a late socket/cache callback. The generation survives a
// later successful rejoin, so work started before invalidation stays stale even
// after writes are enabled again.
const invalidatedRoomIds = new Set<string>();
const persistentInvalidationKey = (roomId: string) => `${CACHE_INVALIDATION_STORAGE_PREFIX}${encodeURIComponent(roomId)}`;
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
  invalidatedRoomIds.has(roomId) || isPersistentlyInvalidated(roomId)
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
  return cacheGenerationByRoomId.get(roomId) ?? 0;
};

const advanceCacheGeneration = (roomId: string) => {
  const nextGeneration = getCacheGeneration(roomId) + 1;
  cacheGenerationByRoomId.set(roomId, nextGeneration);
  persistCacheGenerations();
  memoryCache.delete(roomId);
  return nextGeneration;
};

const isCurrentGeneration = (window: StoredRoomMessageWindow, roomId: string) => (
  (window.cacheGeneration ?? 0) === getCacheGeneration(roomId)
);

export const readMemoryRoomMessageWindow = (roomId: string): CachedRoomMessageWindow | null => {
  if (isRoomInvalidated(roomId)) {
    return null;
  }
  const stored = memoryCache.get(roomId);
  if (!stored || !isCurrentGeneration(stored, roomId)) {
    memoryCache.delete(roomId);
    return null;
  }
  return stored;
};

const isIndexedDBAvailable = () => typeof indexedDB !== 'undefined';

const openCacheDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (!isIndexedDBAvailable()) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
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
      memoryCache.set(roomId, stored);
    }
    return stored;
  } catch {
    return null;
  }
};

export const writeCachedRoomMessageWindow = async (window: CachedRoomMessageWindow): Promise<void> => {
  if (isRoomInvalidated(window.roomId)) {
    return;
  }
  const cacheGeneration = getCacheGeneration(window.roomId);
  const trimmed: StoredRoomMessageWindow = {
    ...window,
    messages: window.messages.slice(-MAX_CACHED_MESSAGES),
    cachedAt: Date.now(),
    cacheGeneration,
  };
  memoryCache.set(trimmed.roomId, trimmed);
  try {
    await withStore('readwrite', store => store.put(trimmed));
    // Invalidation may have happened while the IndexedDB transaction was in
    // flight. Delete once more so that completion order cannot revive it.
    if (isRoomInvalidated(trimmed.roomId) || getCacheGeneration(trimmed.roomId) !== cacheGeneration) {
      await deleteStoredRoomMessageWindowIf(trimmed.roomId, stored => (
        (stored.cacheGeneration ?? 0) === cacheGeneration
      ));
    }
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
  invalidatedRoomIds.add(roomId);
  persistRoomInvalidation(roomId, true);
  advanceCacheGeneration(roomId);
  try {
    await deleteStoredRoomMessageWindowIf(roomId, () => true);
  } catch {
    // Local cache is best-effort only; generation checks still block stale reads.
  }
};

export const reactivateCachedRoomMessageWindow = (roomId: string): void => {
  invalidatedRoomIds.delete(roomId);
  persistRoomInvalidation(roomId, false);
};
