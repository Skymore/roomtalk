import React from "react";
import { CacheableMediaKind, getCachedMediaObjectUrl, getCachedVideoPosterUrl } from "../utils/mediaCache";

export const useCachedMedia = (input: {
  assetId?: string;
  url: string | null;
  fallbackUrl?: string | null;
  fallbackHeaders?: Record<string, string>;
  kind?: CacheableMediaKind;
  mimeType?: string;
  byteSize?: number;
}) => {
  const { assetId, url, fallbackUrl, fallbackHeaders, kind, mimeType, byteSize } = input;
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
      const mediaObjectUrl = await getCachedMediaObjectUrl({
        assetId,
        url,
        fallbackUrl: fallbackUrl || undefined,
        fallbackHeaders,
        kind,
        mimeType,
        byteSize,
      });
      if (!cancelled && mediaObjectUrl) {
        setCachedUrl(mediaObjectUrl);
      }

      if (kind !== "video") {
        return;
      }

      const videoPosterUrl = await getCachedVideoPosterUrl({
        assetId,
        videoUrl: mediaObjectUrl || url,
      });
      if (!cancelled && videoPosterUrl) {
        setPosterUrl(videoPosterUrl);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assetId, byteSize, fallbackHeaders, fallbackUrl, kind, mimeType, url]);

  return {
    mediaUrl: cachedUrl || url,
    cachedUrl,
    posterUrl,
  };
};
