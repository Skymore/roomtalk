export const DEFAULT_AI_CONTEXT_MESSAGE_LIMIT = 100;
export const MIN_AI_CONTEXT_MESSAGE_LIMIT = 0;
export const MAX_AI_CONTEXT_MESSAGE_LIMIT = 1000;

export const normalizeAIContextMessageLimit = (
  value: unknown,
  fallback = DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
): number => {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : NaN;
  const normalizedFallback = Number.isFinite(fallback)
    ? Math.min(MAX_AI_CONTEXT_MESSAGE_LIMIT, Math.max(MIN_AI_CONTEXT_MESSAGE_LIMIT, Math.floor(fallback)))
    : DEFAULT_AI_CONTEXT_MESSAGE_LIMIT;

  return Number.isFinite(parsed)
    ? Math.min(MAX_AI_CONTEXT_MESSAGE_LIMIT, Math.max(MIN_AI_CONTEXT_MESSAGE_LIMIT, Math.floor(parsed)))
    : normalizedFallback;
};
