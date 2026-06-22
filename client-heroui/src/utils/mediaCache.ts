import { getVideoPreviewUrl } from "./videoPreview";

export type CacheableMediaKind = "image" | "audio" | "video";

export const SMALL_VIDEO_CACHE_MAX_BYTES = 20 * 1024 * 1024;

const MEDIA_BODY_CACHE_NAME = "roomtalk-media-body-v1";
const VIDEO_POSTER_CACHE_NAME = "roomtalk-video-poster-v1";
const MAX_OBJECT_URLS = 160;
const MAX_BODY_CACHE_BYTES = 300 * 1024 * 1024;
const MAX_POSTER_CACHE_BYTES = 50 * 1024 * 1024;
const POSTER_MAX_WIDTH = 640;
const POSTER_MAX_HEIGHT = 640;

const objectUrls = new Map<string, string>();
const inFlightBodyUrls = new Map<string, Promise<string | null>>();
const inFlightPosterUrls = new Map<string, Promise<string | null>>();

const canUseBrowserCache = () => (
  typeof window !== "undefined"
  && typeof caches !== "undefined"
  && typeof fetch !== "undefined"
  && typeof URL !== "undefined"
  && typeof URL.createObjectURL === "function"
);

const rememberObjectUrl = (key: string, objectUrl: string) => {
  const existing = objectUrls.get(key);
  if (existing) {
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

export const shouldCacheMediaBody = (
  kind: CacheableMediaKind,
  byteSize?: number,
) => {
  if (kind === "image" || kind === "audio") {
    return true;
  }
  return typeof byteSize === "number" && byteSize > 0 && byteSize <= SMALL_VIDEO_CACHE_MAX_BYTES;
};

const getBlobObjectUrlFromCache = async (cacheName: string, key: string) => {
  const objectUrlKey = getCacheObjectUrlKey(cacheName, key);
  const existingObjectUrl = objectUrls.get(objectUrlKey);
  if (existingObjectUrl) {
    return existingObjectUrl;
  }

  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(key);
  if (!cachedResponse) {
    return null;
  }

  const blob = await cachedResponse.blob();
  if (blob.size === 0) {
    return null;
  }

  return rememberObjectUrl(objectUrlKey, URL.createObjectURL(blob));
};

export const getCachedMediaObjectUrlFromCache = async (input: {
  assetId?: string;
  kind: CacheableMediaKind;
  byteSize?: number;
}): Promise<string | null> => {
  const { assetId, kind, byteSize } = input;
  if (!assetId || !canUseBrowserCache() || !shouldCacheMediaBody(kind, byteSize)) {
    return null;
  }

  try {
    return await getBlobObjectUrlFromCache(MEDIA_BODY_CACHE_NAME, bodyCacheKey(assetId));
  } catch (error) {
    console.warn("Cached media object URL unavailable:", error);
    return null;
  }
};

const trimCache = async (cacheName: string, maxBytes: number) => {
  const cache = await caches.open(cacheName);
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
    deleteRememberedObjectUrl(cacheName, entry.key);
    totalBytes -= entry.byteSize;
    if (totalBytes <= maxBytes) {
      return;
    }
  }
};

const putBlobInCache = async (
  cacheName: string,
  key: string,
  blob: Blob,
  mimeType: string | undefined,
  maxBytes: number,
) => {
  const headers = new Headers();
  if (mimeType || blob.type) {
    headers.set("Content-Type", mimeType || blob.type);
  }
  headers.set("X-RoomTalk-Cached-At", new Date().toISOString());
  headers.set("X-RoomTalk-Byte-Size", String(blob.size));

  const cache = await caches.open(cacheName);
  await cache.put(key, new Response(blob, { headers }));
  await trimCache(cacheName, maxBytes);
};

export const getCachedMediaObjectUrl = async (input: {
  assetId?: string;
  url: string;
  kind: CacheableMediaKind;
  mimeType?: string;
  byteSize?: number;
}): Promise<string | null> => {
  const { assetId, url, kind, mimeType, byteSize } = input;
  if (!assetId || !canUseBrowserCache() || !shouldCacheMediaBody(kind, byteSize)) {
    return null;
  }

  const key = bodyCacheKey(assetId);
  const existingRequest = inFlightBodyUrls.get(key);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    try {
      const cachedUrl = await getBlobObjectUrlFromCache(MEDIA_BODY_CACHE_NAME, key);
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

      await putBlobInCache(MEDIA_BODY_CACHE_NAME, key, blob, mimeType, MAX_BODY_CACHE_BYTES);
      return rememberObjectUrl(getCacheObjectUrlKey(MEDIA_BODY_CACHE_NAME, key), URL.createObjectURL(blob));
    } catch (error) {
      console.warn("Media body cache skipped:", error);
      return null;
    } finally {
      inFlightBodyUrls.delete(key);
    }
  })();

  inFlightBodyUrls.set(key, request);
  return request;
};

export const getCachedMediaBlob = async (assetId?: string): Promise<Blob | null> => {
  if (!assetId || !canUseBrowserCache()) {
    return null;
  }

  try {
    const cache = await caches.open(MEDIA_BODY_CACHE_NAME);
    const cachedResponse = await cache.match(bodyCacheKey(assetId));
    if (!cachedResponse) {
      return null;
    }

    const blob = await cachedResponse.blob();
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
}): Promise<string | null> => {
  const { assetId, videoUrl } = input;
  if (!assetId || !canUseBrowserCache()) {
    return null;
  }

  const key = posterCacheKey(assetId);
  const existingRequest = inFlightPosterUrls.get(key);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    try {
      const cachedUrl = await getBlobObjectUrlFromCache(VIDEO_POSTER_CACHE_NAME, key);
      if (cachedUrl) {
        return cachedUrl;
      }

      const blob = await createVideoPosterBlob(videoUrl);
      if (!blob || blob.size === 0) {
        return null;
      }

      await putBlobInCache(VIDEO_POSTER_CACHE_NAME, key, blob, "image/jpeg", MAX_POSTER_CACHE_BYTES);
      return rememberObjectUrl(getCacheObjectUrlKey(VIDEO_POSTER_CACHE_NAME, key), URL.createObjectURL(blob));
    } catch (error) {
      console.warn("Video poster cache skipped:", error);
      return null;
    } finally {
      inFlightPosterUrls.delete(key);
    }
  })();

  inFlightPosterUrls.set(key, request);
  return request;
};
