import React from "react";
import { CacheableMediaKind, getCachedMediaObjectUrl, getCachedMediaObjectUrlFromCache, getCachedVideoPosterUrl } from "../utils/mediaCache";

export const useCachedMedia = (input: {
  assetId?: string;
  url: string | null;
  kind?: CacheableMediaKind;
  mimeType?: string;
  byteSize?: number;
  cacheBodyFetchKey?: number | null;
}) => {
  const { assetId, url, kind, mimeType, byteSize, cacheBodyFetchKey } = input;
  const [cachedUrl, setCachedUrl] = React.useState<string | null>(null);
  const [posterUrl, setPosterUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setCachedUrl(null);
    setPosterUrl(null);

    if (!assetId || !url || !kind) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const mediaObjectUrl = await getCachedMediaObjectUrlFromCache({
        assetId,
        kind,
        byteSize,
      });
      if (!cancelled && mediaObjectUrl) {
        setCachedUrl(mediaObjectUrl);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assetId, byteSize, kind, url]);

  React.useEffect(() => {
    let cancelled = false;

    if (!assetId || !url || !kind || cacheBodyFetchKey === null) {
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
      });
      if (!cancelled && mediaObjectUrl) {
        setCachedUrl(mediaObjectUrl);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assetId, byteSize, cacheBodyFetchKey, kind, mimeType, url]);

  React.useEffect(() => {
    let cancelled = false;

    if (!assetId || !url || kind !== "video" || cacheBodyFetchKey === null) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const videoPosterUrl = await getCachedVideoPosterUrl({
        assetId,
        videoUrl: cachedUrl || url,
      });
      if (!cancelled && videoPosterUrl) {
        setPosterUrl(videoPosterUrl);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assetId, cacheBodyFetchKey, cachedUrl, kind, url]);

  return {
    mediaUrl: cachedUrl || url,
    cachedUrl,
    posterUrl,
  };
};
