export const MAX_SOCKET_RESOURCE_ID_LENGTH = 128;
export const MAX_MESSAGE_TEXT_BYTES = 64 * 1024;
export const MAX_MESSAGE_USERNAME_LENGTH = 40;
export const MAX_MESSAGE_AVATAR_TEXT_LENGTH = 16;
export const MAX_MESSAGE_AVATAR_COLOR_LENGTH = 32;
export const MAX_A2UI_ACTION_STRING_LENGTH = 256;
export const MAX_A2UI_CONTEXT_BYTES = 16 * 1024;

export const isBoundedSocketIdentifier = (value: unknown): value is string => (
  typeof value === 'string' && value.length > 0 && value.length <= MAX_SOCKET_RESOURCE_ID_LENGTH
);

export const utf8ByteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

export const isBoundedJsonObject = (
  value: unknown,
  options: { maxBytes: number; maxDepth?: number; maxEntries?: number }
): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const maxDepth = options.maxDepth ?? 6;
  const maxEntries = options.maxEntries ?? 256;
  let entries = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      return true;
    }
    if (depth >= maxDepth || typeof candidate !== 'object') {
      return false;
    }
    const children = Array.isArray(candidate)
      ? candidate
      : Object.entries(candidate as Record<string, unknown>).flatMap(([key, child]) => [key, child]);
    entries += children.length;
    return entries <= maxEntries && children.every(child => visit(child, depth + 1));
  };
  if (!visit(value, 0)) {
    return false;
  }
  try {
    return utf8ByteLength(JSON.stringify(value)) <= options.maxBytes;
  } catch {
    return false;
  }
};

export const createSocketEventRateLimiter = (limit: number, windowMs: number) => {
  let windowStartedAt = 0;
  let count = 0;
  return (nowMs = Date.now()): boolean => {
    if (nowMs - windowStartedAt >= windowMs) {
      windowStartedAt = nowMs;
      count = 0;
    }
    count += 1;
    return count <= limit;
  };
};
