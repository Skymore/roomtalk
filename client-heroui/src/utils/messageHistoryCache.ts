import { Message } from './types';

const DB_NAME = 'roomtalk-message-cache';
const DB_VERSION = 1;
const STORE_NAME = 'room-message-windows';
const MAX_CACHED_MESSAGES = 100;

export interface CachedRoomMessageWindow {
  roomId: string;
  historyVersion: number;
  messages: Message[];
  hasMore: boolean;
  oldestMessageId?: string;
  cachedAt: number;
}

// Synchronous, session-lived mirror of the latest window per room. IndexedDB is
// always async, so a fresh read always paints one loading frame first; this map
// lets a re-opened room render instantly while IndexedDB stays the cross-session
// backup.
const memoryCache = new Map<string, CachedRoomMessageWindow>();

export const readMemoryRoomMessageWindow = (roomId: string): CachedRoomMessageWindow | null => {
  return memoryCache.get(roomId) ?? null;
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
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    });
  } finally {
    db.close();
  }
};

export const readCachedRoomMessageWindow = async (roomId: string): Promise<CachedRoomMessageWindow | null> => {
  try {
    const stored = await withStore<CachedRoomMessageWindow | undefined>('readonly', store => store.get(roomId)) || null;
    if (stored) {
      memoryCache.set(roomId, stored);
    }
    return stored;
  } catch {
    return null;
  }
};

export const writeCachedRoomMessageWindow = async (window: CachedRoomMessageWindow): Promise<void> => {
  const trimmed: CachedRoomMessageWindow = {
    ...window,
    messages: window.messages.slice(-MAX_CACHED_MESSAGES),
    cachedAt: Date.now(),
  };
  memoryCache.set(trimmed.roomId, trimmed);
  try {
    await withStore('readwrite', store => store.put(trimmed));
  } catch {
    // Local cache is best-effort only.
  }
};

export const deleteCachedRoomMessageWindow = async (roomId: string): Promise<void> => {
  memoryCache.delete(roomId);
  try {
    await withStore('readwrite', store => store.delete(roomId));
  } catch {
    // Local cache is best-effort only.
  }
};
