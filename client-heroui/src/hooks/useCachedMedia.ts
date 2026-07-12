import React from "react";
import { CacheableMediaKind, getCachedMediaObjectUrl, getCachedMediaObjectUrlFromCache, getCachedVideoPosterUrl } from "../utils/mediaCache";

export const useCachedMedia = (input: {
  assetId?: string;
  url: string | null;
  kind?: CacheableMediaKind;
  mimeType?: string;
  byteSize?: number;
  cacheBodyFetchKey?: number | null;
  roomId?: string;
  isAccessVerified?: boolean;
  cacheLookupKey?: number;
}) => {
  const { assetId, url, kind, mimeType, byteSize, cacheBodyFetchKey, roomId, isAccessVerified = true, cacheLookupKey = 0 } = input;
  const [cachedUrl, setCachedUrl] = React.useState<string | null>(null);
  const [posterUrl, setPosterUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setCachedUrl(null);
    setPosterUrl(null);

    if (!assetId || !kind || !isAccessVerified) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const mediaObjectUrl = await getCachedMediaObjectUrlFromCache({
        assetId,
        kind,
        byteSize,
        roomId,
      });
      if (!cancelled && mediaObjectUrl) {
        setCachedUrl(mediaObjectUrl);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assetId, byteSize, cacheLookupKey, isAccessVerified, kind, roomId]);

  React.useEffect(() => {
    let cancelled = false;

    if (!assetId || !url || !kind || !isAccessVerified || cacheBodyFetchKey === null) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const mediaObjectUrl = await getCachedMediaObjectUrl({
        assetId,
        url,
        kind,
        mimeType,
        byteSize,
        roomId,
      });
      if (!cancelled && mediaObjectUrl) {
        setCachedUrl(mediaObjectUrl);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assetId, byteSize, cacheBodyFetchKey, isAccessVerified, kind, mimeType, roomId, url]);

  React.useEffect(() => {
    let cancelled = false;

    if (!assetId || !url || kind !== "video" || !isAccessVerified || cacheBodyFetchKey === null) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const videoPosterUrl = await getCachedVideoPosterUrl({
        assetId,
        videoUrl: cachedUrl || url,
        roomId,
      });
      if (!cancelled && videoPosterUrl) {
        setPosterUrl(videoPosterUrl);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assetId, cacheBodyFetchKey, cachedUrl, isAccessVerified, kind, roomId, url]);

  return {
    mediaUrl: cachedUrl || url,
    cachedUrl,
    posterUrl,
  };
};
