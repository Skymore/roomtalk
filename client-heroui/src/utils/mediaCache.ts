import { getVideoPreviewUrl } from "./videoPreview";
import { ensurePersistentBrowserStorage, getBrowserCacheOwnerId, getBrowserStorageQuota, getOwnedBrowserCacheName } from "./browserCacheStorage";

export type CacheableMediaKind = "image" | "audio" | "video";

export const SMALL_VIDEO_CACHE_MAX_BYTES = 20 * 1024 * 1024;

const MEDIA_BODY_CACHE_NAME = "roomtalk-media-body-v2";
const VIDEO_POSTER_CACHE_NAME = "roomtalk-video-poster-v2";
const MEDIA_INDEX_DB_NAME = "roomtalk-media-cache-index-v1";
const MEDIA_INDEX_STORE_NAME = "media-entries";
const MEDIA_INDEX_DB_VERSION = 1;
const MAX_OBJECT_URLS = 160;
const FALLBACK_MEDIA_CACHE_BYTES = 300 * 1024 * 1024;
const MAX_MEDIA_CACHE_BYTES = 1024 * 1024 * 1024;
const MEDIA_CACHE_QUOTA_FRACTION = 0.2;
const MAX_POSTER_CACHE_BYTES = 50 * 1024 * 1024;
const POSTER_MAX_WIDTH = 640;
const POSTER_MAX_HEIGHT = 640;

const objectUrls = new Map<string, string>();
const inFlightBodyUrls = new Map<string, Promise<string | null>>();
const inFlightBodyWrites = new Map<string, Promise<void>>();
const inFlightPosterUrls = new Map<string, Promise<string | null>>();
let legacyCacheCleanup: Promise<void> | null = null;

type MediaCacheName = typeof MEDIA_BODY_CACHE_NAME | typeof VIDEO_POSTER_CACHE_NAME;

interface MediaCacheEntry {
  entryKey: string;
  assetId: string;
  roomId?: string;
  cacheName: MediaCacheName;
  cacheKey: string;
  byteSize: number;
  mimeType?: string;
  cachedAt: number;
  lastAccessedAt: number;
}

const resolveCacheName = (baseName: MediaCacheName, ownerId = getBrowserCacheOwnerId()) => (
  getOwnedBrowserCacheName(baseName, ownerId)
);

const mediaIndexDbName = (ownerId = getBrowserCacheOwnerId()) => (
  getOwnedBrowserCacheName(MEDIA_INDEX_DB_NAME, ownerId)
);

const mediaEntryKey = (cacheName: MediaCacheName, assetId: string) => `${cacheName}:${assetId}`;

const canUseBrowserCache = () => (
  typeof window !== "undefined"
  && typeof caches !== "undefined"
  && typeof fetch !== "undefined"
  && typeof URL !== "undefined"
  && typeof URL.createObjectURL === "function"
);

const canUseMediaIndex = () => typeof indexedDB !== "undefined";

const cleanupLegacyMediaCaches = () => {
  if (legacyCacheCleanup) return legacyCacheCleanup;
  legacyCacheCleanup = (async () => {
    if (typeof caches?.delete !== "function") return;
    await Promise.all([
      caches.delete("roomtalk-media-body-v1"),
      caches.delete("roomtalk-video-poster-v1"),
    ]);
  })().catch(() => undefined);
  return legacyCacheCleanup;
};

const openMediaIndexDb = (ownerId = getBrowserCacheOwnerId()): Promise<IDBDatabase> => (
  new Promise((resolve, reject) => {
    if (!canUseMediaIndex()) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(mediaIndexDbName(ownerId), MEDIA_INDEX_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA_INDEX_STORE_NAME)) {
        db.createObjectStore(MEDIA_INDEX_STORE_NAME, { keyPath: "entryKey" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open media cache index"));
  })
);

const withMediaIndexStore = async <T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
  ownerId = getBrowserCacheOwnerId(),
): Promise<T> => {
  const db = await openMediaIndexDb(ownerId);
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(MEDIA_INDEX_STORE_NAME, mode);
      const request = work(transaction.objectStore(MEDIA_INDEX_STORE_NAME));
      let result: T;
      let succeeded = false;
      request.onsuccess = () => {
        result = request.result;
        succeeded = true;
      };
      request.onerror = () => reject(request.error || new Error("Media cache index request failed"));
      transaction.oncomplete = () => succeeded
        ? resolve(result)
        : reject(new Error("Media cache index transaction completed without a result"));
      transaction.onerror = () => reject(transaction.error || new Error("Media cache index transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("Media cache index transaction aborted"));
    });
  } finally {
    db.close();
  }
};

const putMediaIndexEntry = async (entry: MediaCacheEntry) => {
  if (!canUseMediaIndex()) return;
  await withMediaIndexStore("readwrite", store => store.put(entry));
};

const deleteMediaIndexEntry = async (entryKey: string, ownerId = getBrowserCacheOwnerId()) => {
  if (!canUseMediaIndex()) return;
  await withMediaIndexStore("readwrite", store => store.delete(entryKey), ownerId);
};

const touchMediaIndexEntry = async (cacheName: MediaCacheName, assetId: string) => {
  if (!canUseMediaIndex()) return;
  const entryKey = mediaEntryKey(cacheName, assetId);
  const entry = await withMediaIndexStore<MediaCacheEntry | undefined>("readonly", store => store.get(entryKey));
  if (!entry) return;
  await putMediaIndexEntry({ ...entry, lastAccessedAt: Date.now() });
};

const readAllMediaIndexEntries = async (ownerId = getBrowserCacheOwnerId()): Promise<MediaCacheEntry[]> => {
  if (!canUseMediaIndex()) return [];
  return withMediaIndexStore<MediaCacheEntry[]>("readonly", store => store.getAll(), ownerId);
};

const rememberObjectUrl = (key: string, objectUrl: string) => {
  const existing = objectUrls.get(key);
  if (existing) {
    objectUrls.delete(key);
    objectUrls.set(key, existing);
    return existing;
  }

  objectUrls.set(key, objectUrl);
  while (objectUrls.size > MAX_OBJECT_URLS) {
    const [oldestKey, oldestUrl] = objectUrls.entries().next().value as [string, string];
    objectUrls.delete(oldestKey);
    URL.revokeObjectURL(oldestUrl);
  }
  return objectUrl;
};

const bodyCacheKey = (assetId: string) => `/roomtalk-media-cache/body/${encodeURIComponent(assetId)}`;
const posterCacheKey = (assetId: string) => `/roomtalk-media-cache/poster/${encodeURIComponent(assetId)}.jpg`;
const getCacheObjectUrlKey = (cacheName: string, key: string) => `${cacheName}:${key}`;

const getRequestPathname = (request: Request) => {
  try {
    return new URL(request.url).pathname;
  } catch {
    return request.url;
  }
};

const deleteRememberedObjectUrl = (cacheName: string, key: string) => {
  const objectUrlKey = getCacheObjectUrlKey(cacheName, key);
  const objectUrl = objectUrls.get(objectUrlKey);
  if (!objectUrl) {
    return;
  }
  objectUrls.delete(objectUrlKey);
  URL.revokeObjectURL(objectUrl);
};

const readBlobAsArrayBuffer = (blob: Blob) => (
  new Promise<ArrayBuffer>((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      reject(new Error("FileReader is unavailable"));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read blob"));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  })
);

const getPortableBlobBody = async (blob: Blob): Promise<BodyInit> => {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  try {
    return await readBlobAsArrayBuffer(blob);
  } catch {
    return blob;
  }
};

export const shouldCacheMediaBody = (
  kind: CacheableMediaKind,
  byteSize?: number,
) => {
  if (kind === "image" || kind === "audio") {
    return true;
  }
  return typeof byteSize === "number" && byteSize > 0 && byteSize <= SMALL_VIDEO_CACHE_MAX_BYTES;
};

const getBlobObjectUrlFromCache = async (
  cacheName: MediaCacheName,
  key: string,
  assetId?: string,
  roomId?: string,
) => {
  const resolvedCacheName = resolveCacheName(cacheName);
  const objectUrlKey = getCacheObjectUrlKey(resolvedCacheName, key);
  const existingObjectUrl = objectUrls.get(objectUrlKey);
  if (existingObjectUrl) {
    objectUrls.delete(objectUrlKey);
    objectUrls.set(objectUrlKey, existingObjectUrl);
    if (assetId) void touchMediaIndexEntry(cacheName, assetId).catch(() => undefined);
    return existingObjectUrl;
  }

  const cache = await caches.open(resolvedCacheName);
  const cachedResponse = await cache.match(key);
  if (!cachedResponse) {
    return null;
  }

  const blob = await cachedResponse.blob();
  if (blob.size === 0) {
    return null;
  }

  if (assetId) {
    const cachedAtHeader = Date.parse(cachedResponse.headers.get("X-RoomTalk-Cached-At") || "");
    const now = Date.now();
    void putMediaIndexEntry({
      entryKey: mediaEntryKey(cacheName, assetId),
      assetId,
      roomId: roomId || cachedResponse.headers.get("X-RoomTalk-Room-Id") || undefined,
      cacheName,
      cacheKey: key,
      byteSize: blob.size,
      mimeType: cachedResponse.headers.get("Content-Type") || blob.type || undefined,
      cachedAt: Number.isFinite(cachedAtHeader) ? cachedAtHeader : now,
      lastAccessedAt: now,
    }).catch(() => undefined);
  }

  return rememberObjectUrl(objectUrlKey, URL.createObjectURL(blob));
};

export const getCachedMediaObjectUrlFromCache = async (input: {
  assetId?: string;
  kind: CacheableMediaKind;
  byteSize?: number;
  roomId?: string;
}): Promise<string | null> => {
  const { assetId, kind, byteSize, roomId } = input;
  if (!assetId || !canUseBrowserCache() || !shouldCacheMediaBody(kind, byteSize)) {
    return null;
  }
  void cleanupLegacyMediaCaches();

  try {
    const key = bodyCacheKey(assetId);
    await inFlightBodyWrites.get(`${resolveCacheName(MEDIA_BODY_CACHE_NAME)}:${key}`);
    return await getBlobObjectUrlFromCache(MEDIA_BODY_CACHE_NAME, key, assetId, roomId);
  } catch (error) {
    console.warn("Cached media object URL unavailable:", error);
    return null;
  }
};

const trimCacheWithoutIndex = async (cacheName: MediaCacheName, maxBytes: number) => {
  const resolvedCacheName = resolveCacheName(cacheName);
  const cache = await caches.open(resolvedCacheName);
  const requests = await cache.keys();
  const entries = await Promise.all(requests.map(async (request) => {
    const response = await cache.match(request);
    const byteSize = Number(response?.headers.get("X-RoomTalk-Byte-Size")) || 0;
    const cachedAt = Date.parse(response?.headers.get("X-RoomTalk-Cached-At") || "");
    return {
      request,
      key: getRequestPathname(request),
      byteSize,
      cachedAt: Number.isFinite(cachedAt) ? cachedAt : 0,
    };
  }));

  let totalBytes = entries.reduce((total, entry) => total + entry.byteSize, 0);
  if (totalBytes <= maxBytes) {
    return;
  }

  for (const entry of entries.sort((a, b) => a.cachedAt - b.cachedAt)) {
    await cache.delete(entry.request);
    deleteRememberedObjectUrl(resolvedCacheName, entry.key);
    totalBytes -= entry.byteSize;
    if (totalBytes <= maxBytes) {
      return;
    }
  }
};

const getBodyCacheBudget = async () => {
  const quota = await getBrowserStorageQuota();
  return quota
    ? Math.min(MAX_MEDIA_CACHE_BYTES, Math.max(1, Math.floor(quota * MEDIA_CACHE_QUOTA_FRACTION)))
    : FALLBACK_MEDIA_CACHE_BYTES;
};

const trimIndexedMediaCache = async (cacheName: MediaCacheName, maxBytes: number) => {
  const entries = (await readAllMediaIndexEntries())
    .filter(entry => entry.cacheName === cacheName)
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  let totalBytes = entries.reduce((total, entry) => total + entry.byteSize, 0);
  if (totalBytes <= maxBytes) return;

  const resolvedCacheName = resolveCacheName(cacheName);
  const cache = await caches.open(resolvedCacheName);
  for (const entry of entries) {
    await cache.delete(entry.cacheKey);
    deleteRememberedObjectUrl(resolvedCacheName, entry.cacheKey);
    await deleteMediaIndexEntry(entry.entryKey);
    totalBytes -= entry.byteSize;
    if (totalBytes <= maxBytes) return;
  }
};

const trimMediaCaches = async () => {
  if (!canUseMediaIndex()) {
    await trimCacheWithoutIndex(MEDIA_BODY_CACHE_NAME, FALLBACK_MEDIA_CACHE_BYTES);
    await trimCacheWithoutIndex(VIDEO_POSTER_CACHE_NAME, MAX_POSTER_CACHE_BYTES);
    return;
  }
  await trimIndexedMediaCache(MEDIA_BODY_CACHE_NAME, await getBodyCacheBudget());
  await trimIndexedMediaCache(VIDEO_POSTER_CACHE_NAME, MAX_POSTER_CACHE_BYTES);
};

const putBlobInCache = async (
  cacheName: MediaCacheName,
  assetId: string,
  key: string,
  blob: Blob,
  mimeType: string | undefined,
  roomId?: string,
) => {
  void ensurePersistentBrowserStorage();
  const headers = new Headers();
  if (mimeType || blob.type) {
    headers.set("Content-Type", mimeType || blob.type);
  }
  headers.set("X-RoomTalk-Cached-At", new Date().toISOString());
  headers.set("X-RoomTalk-Byte-Size", String(blob.size));
  if (roomId) headers.set("X-RoomTalk-Room-Id", roomId);

  const resolvedCacheName = resolveCacheName(cacheName);
  const cache = await caches.open(resolvedCacheName);
  await cache.put(key, new Response(await getPortableBlobBody(blob), { headers }));
  const now = Date.now();
  await putMediaIndexEntry({
    entryKey: mediaEntryKey(cacheName, assetId),
    assetId,
    roomId,
    cacheName,
    cacheKey: key,
    byteSize: blob.size,
    mimeType: mimeType || blob.type || undefined,
    cachedAt: now,
    lastAccessedAt: now,
  }).catch(() => undefined);
  await trimMediaCaches().catch(() => undefined);
};

export const getCachedMediaObjectUrl = async (input: {
  assetId?: string;
  url: string;
  kind: CacheableMediaKind;
  mimeType?: string;
  byteSize?: number;
  roomId?: string;
}): Promise<string | null> => {
  const { assetId, url, kind, mimeType, byteSize, roomId } = input;
  if (!assetId || !canUseBrowserCache() || !shouldCacheMediaBody(kind, byteSize)) {
    return null;
  }
  void cleanupLegacyMediaCaches();

  const key = bodyCacheKey(assetId);
  const requestKey = `${resolveCacheName(MEDIA_BODY_CACHE_NAME)}:${key}`;
  const existingRequest = inFlightBodyUrls.get(requestKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    try {
      const cachedUrl = await getBlobObjectUrlFromCache(MEDIA_BODY_CACHE_NAME, key, assetId, roomId);
      if (cachedUrl) {
        return cachedUrl;
      }

      const response = await fetch(url, { cache: "force-cache" });
      if (!response.ok) {
        return null;
      }

      const blob = await response.blob();
      if (kind === "video" && blob.size > SMALL_VIDEO_CACHE_MAX_BYTES) {
        return null;
      }

      await putBlobInCache(MEDIA_BODY_CACHE_NAME, assetId, key, blob, mimeType, roomId);
      return rememberObjectUrl(getCacheObjectUrlKey(resolveCacheName(MEDIA_BODY_CACHE_NAME), key), URL.createObjectURL(blob));
    } catch (error) {
      console.warn("Media body cache skipped:", error);
      return null;
    } finally {
      inFlightBodyUrls.delete(requestKey);
    }
  })();

  inFlightBodyUrls.set(requestKey, request);
  return request;
};

export const getCachedMediaBlob = async (assetId?: string): Promise<Blob | null> => {
  if (!assetId || !canUseBrowserCache()) {
    return null;
  }
  void cleanupLegacyMediaCaches();

  try {
    const cache = await caches.open(resolveCacheName(MEDIA_BODY_CACHE_NAME));
    const cachedResponse = await cache.match(bodyCacheKey(assetId));
    if (!cachedResponse) {
      return null;
    }

    const blob = await cachedResponse.blob();
    if (blob.size > 0) void touchMediaIndexEntry(MEDIA_BODY_CACHE_NAME, assetId).catch(() => undefined);
    return blob.size > 0 ? blob : null;
  } catch (error) {
    console.warn("Cached media blob unavailable:", error);
    return null;
  }
};

const waitForVideoEvent = (video: HTMLVideoElement, eventName: "loadeddata" | "seeked") => (
  new Promise<void>((resolve, reject) => {
    let timeoutId: number | undefined;
    const cleanup = () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      video.removeEventListener(eventName, handleEvent);
      video.removeEventListener("error", handleError);
    };
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Failed to load video frame"));
    };
    video.addEventListener(eventName, handleEvent, { once: true });
    video.addEventListener("error", handleError, { once: true });
    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out while waiting for ${eventName}`));
    }, 8000);
  })
);

const createVideoPosterBlob = async (videoUrl: string): Promise<Blob | null> => {
  if (typeof document === "undefined") {
    return null;
  }

  const canvas = document.createElement("canvas");
  if (typeof canvas.getContext !== "function" || typeof canvas.toBlob !== "function") {
    return null;
  }

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = getVideoPreviewUrl(videoUrl);

  await waitForVideoEvent(video, "loadeddata");
  if (Number.isFinite(video.duration) && video.currentTime < 0.001) {
    video.currentTime = Math.min(0.1, Math.max(0.001, video.duration / 100));
    await waitForVideoEvent(video, "seeked");
  }

  const sourceWidth = video.videoWidth || POSTER_MAX_WIDTH;
  const sourceHeight = video.videoHeight || POSTER_MAX_HEIGHT;
  const scale = Math.min(1, POSTER_MAX_WIDTH / sourceWidth, POSTER_MAX_HEIGHT / sourceHeight);
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.82);
  });
};

export const getCachedVideoPosterUrl = async (input: {
  assetId?: string;
  videoUrl: string;
  roomId?: string;
}): Promise<string | null> => {
  const { assetId, videoUrl, roomId } = input;
  if (!assetId || !canUseBrowserCache()) {
    return null;
  }

  const key = posterCacheKey(assetId);
  const requestKey = `${resolveCacheName(VIDEO_POSTER_CACHE_NAME)}:${key}`;
  const existingRequest = inFlightPosterUrls.get(requestKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    try {
      const cachedUrl = await getBlobObjectUrlFromCache(VIDEO_POSTER_CACHE_NAME, key, assetId, roomId);
      if (cachedUrl) {
        return cachedUrl;
      }

      const blob = await createVideoPosterBlob(videoUrl);
      if (!blob || blob.size === 0) {
        return null;
      }

      await putBlobInCache(VIDEO_POSTER_CACHE_NAME, assetId, key, blob, "image/jpeg", roomId);
      return rememberObjectUrl(getCacheObjectUrlKey(resolveCacheName(VIDEO_POSTER_CACHE_NAME), key), URL.createObjectURL(blob));
    } catch (error) {
      console.warn("Video poster cache skipped:", error);
      return null;
    } finally {
      inFlightPosterUrls.delete(requestKey);
    }
  })();

  inFlightPosterUrls.set(requestKey, request);
  return request;
};

export const cacheMediaBlob = async (input: {
  assetId?: string;
  roomId?: string;
  kind: CacheableMediaKind;
  blob: Blob;
  mimeType?: string;
}): Promise<void> => {
  const { assetId, roomId, kind, blob, mimeType } = input;
  if (!assetId || !canUseBrowserCache() || !shouldCacheMediaBody(kind, blob.size)) return;
  void cleanupLegacyMediaCaches();
  const key = bodyCacheKey(assetId);
  const requestKey = `${resolveCacheName(MEDIA_BODY_CACHE_NAME)}:${key}`;
  const existingWrite = inFlightBodyWrites.get(requestKey);
  if (existingWrite) return existingWrite;
  const write = putBlobInCache(
    MEDIA_BODY_CACHE_NAME,
    assetId,
    key,
    blob,
    mimeType,
    roomId,
  ).finally(() => inFlightBodyWrites.delete(requestKey));
  inFlightBodyWrites.set(requestKey, write);
  return write;
};

const deleteIndexedMediaEntry = async (entry: MediaCacheEntry, ownerId = getBrowserCacheOwnerId()) => {
  const resolvedCacheName = resolveCacheName(entry.cacheName, ownerId);
  const cache = await caches.open(resolvedCacheName);
  await cache.delete(entry.cacheKey);
  deleteRememberedObjectUrl(resolvedCacheName, entry.cacheKey);
  await deleteMediaIndexEntry(entry.entryKey, ownerId);
};

export const clearCachedMediaAsset = async (assetId: string): Promise<void> => {
  if (!assetId || !canUseBrowserCache()) return;
  const entries = await readAllMediaIndexEntries().catch(() => []);
  const matches = entries.filter(entry => entry.assetId === assetId);
  if (matches.length > 0) {
    await Promise.all(matches.map(entry => deleteIndexedMediaEntry(entry)));
  }
  await Promise.all(([MEDIA_BODY_CACHE_NAME, VIDEO_POSTER_CACHE_NAME] as const).map(async cacheName => {
    const key = cacheName === MEDIA_BODY_CACHE_NAME ? bodyCacheKey(assetId) : posterCacheKey(assetId);
    const resolvedCacheName = resolveCacheName(cacheName);
    const cache = await caches.open(resolvedCacheName);
    await cache.delete(key);
    deleteRememberedObjectUrl(resolvedCacheName, key);
  }));
};

export const clearCachedMediaForRoom = async (roomId: string): Promise<void> => {
  if (!roomId || !canUseBrowserCache()) return;
  const entries = await readAllMediaIndexEntries().catch(() => []);
  const matches = entries.filter(entry => entry.roomId === roomId);
  if (matches.length > 0) {
    await Promise.all(matches.map(entry => deleteIndexedMediaEntry(entry)));
  }

  await Promise.all(([MEDIA_BODY_CACHE_NAME, VIDEO_POSTER_CACHE_NAME] as const).map(async cacheName => {
    const resolvedCacheName = resolveCacheName(cacheName);
    const cache = await caches.open(resolvedCacheName);
    const requests = await cache.keys();
    await Promise.all(requests.map(async request => {
      const response = await cache.match(request);
      if (response?.headers.get("X-RoomTalk-Room-Id") !== roomId) return;
      await cache.delete(request);
      deleteRememberedObjectUrl(resolvedCacheName, getRequestPathname(request));
    }));
  }));
};

export const clearCachedMediaForClient = async (ownerId: string): Promise<void> => {
  const resolvedNames = ([MEDIA_BODY_CACHE_NAME, VIDEO_POSTER_CACHE_NAME] as const)
    .map(cacheName => resolveCacheName(cacheName, ownerId));
  if (typeof caches !== "undefined") {
    await Promise.all(resolvedNames.map(cacheName => caches.delete(cacheName).catch(() => false)));
  }
  resolvedNames.forEach(cacheName => {
    for (const [key, url] of objectUrls) {
      if (!key.startsWith(`${cacheName}:`)) continue;
      objectUrls.delete(key);
      URL.revokeObjectURL(url);
    }
  });
  if (!canUseMediaIndex()) return;
  await new Promise<void>(resolve => {
    const request = indexedDB.deleteDatabase(mediaIndexDbName(ownerId));
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
};
