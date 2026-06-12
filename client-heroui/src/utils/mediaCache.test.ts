// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedMediaObjectUrl,
  getCachedVideoPosterUrl,
  shouldCacheMediaBody,
  SMALL_VIDEO_CACHE_MAX_BYTES,
} from "./mediaCache";

describe("mediaCache", () => {
  const cachesByName = new Map<string, Map<string, Response>>();
  let fetchMock: ReturnType<typeof vi.fn>;
  let objectUrlIndex = 0;

  beforeEach(() => {
    cachesByName.clear();
    objectUrlIndex = 0;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", {
      open: vi.fn(async (name: string) => {
        if (!cachesByName.has(name)) {
          cachesByName.set(name, new Map());
        }
        const store = cachesByName.get(name)!;
        return {
          match: vi.fn(async (key: string | Request) => {
            const cacheKey = typeof key === "string" ? key : new URL(key.url).pathname;
            return store.get(cacheKey) || null;
          }),
          put: vi.fn(async (key: string, response: Response) => {
            store.set(key, response);
          }),
          keys: vi.fn(async () => [...store.keys()].map(key => new Request(`https://roomtalk.local${key}`))),
          delete: vi.fn(async (request: Request) => store.delete(new URL(request.url).pathname)),
        };
      }),
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:cached-${objectUrlIndex++}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("caches image bodies and reuses the cached object URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Blob(["image"], { type: "image/webp" }), {
      status: 200,
    }));

    await expect(getCachedMediaObjectUrl({
      assetId: "image-asset",
      url: "https://signed.example/image.webp",
      kind: "image",
      mimeType: "image/webp",
      byteSize: 5,
    })).resolves.toBe("blob:cached-0");

    await expect(getCachedMediaObjectUrl({
      assetId: "image-asset",
      url: "https://signed.example/image.webp",
      kind: "image",
      mimeType: "image/webp",
      byteSize: 5,
    })).resolves.toBe("blob:cached-0");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches audio bodies but skips oversized video bodies", async () => {
    expect(shouldCacheMediaBody("audio", 25 * 1024 * 1024)).toBe(true);
    expect(shouldCacheMediaBody("video", SMALL_VIDEO_CACHE_MAX_BYTES)).toBe(true);
    expect(shouldCacheMediaBody("video", SMALL_VIDEO_CACHE_MAX_BYTES + 1)).toBe(false);

    await expect(getCachedMediaObjectUrl({
      assetId: "large-video",
      url: "https://signed.example/video.mp4",
      kind: "video",
      mimeType: "video/mp4",
      byteSize: SMALL_VIDEO_CACHE_MAX_BYTES + 1,
    })).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns cached video posters without reading the video again", async () => {
    const posterCache = new Map<string, Response>();
    posterCache.set(
      "/roomtalk-media-cache/poster/video-asset.jpg",
      new Response(new Blob(["poster"], { type: "image/jpeg" }), { status: 200 }),
    );
    cachesByName.set("roomtalk-video-poster-v1", posterCache);

    await expect(getCachedVideoPosterUrl({
      assetId: "video-asset",
      videoUrl: "https://signed.example/video.mp4",
    })).resolves.toBe("blob:cached-0");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
