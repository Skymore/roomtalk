const FAVICON_PROVIDER = 'https://www.google.com/s2/favicons';

export function codeAgentFaviconUrlForOrigin(
  rawUrl: string | null | undefined,
  size = 32,
): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    if (!url.host || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return null;
    }
    return `${FAVICON_PROVIDER}?domain=${encodeURIComponent(url.host)}&sz=${size}`;
  } catch {
    return null;
  }
}
