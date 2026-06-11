const VIDEO_PREVIEW_TIME_FRAGMENT = "t=0.001";

export const getVideoPreviewUrl = (url: string): string => {
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) {
    return `${url}#${VIDEO_PREVIEW_TIME_FRAGMENT}`;
  }

  const baseUrl = url.slice(0, hashIndex);
  const hash = url.slice(hashIndex + 1);
  if (!hash || hash.includes("t=")) {
    return url;
  }

  return `${baseUrl}#${hash}&${VIDEO_PREVIEW_TIME_FRAGMENT}`;
};
