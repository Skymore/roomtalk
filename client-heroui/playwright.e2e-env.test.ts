import { describe, expect, it } from 'vitest';
import { requireSafeE2ERedisUrl } from './playwright.e2e-env';

describe('Playwright E2E Redis safety', () => {
  it('defaults to and accepts local non-zero disposable databases', () => {
    expect(requireSafeE2ERedisUrl({})).toBe('redis://127.0.0.1:6379/15');
    expect(requireSafeE2ERedisUrl({ E2E_REDIS_URL: 'redis://localhost:6379/9' }))
      .toBe('redis://localhost:6379/9');
  });

  it.each([
    'redis://127.0.0.1:6379',
    'redis://127.0.0.1:6379/0',
    'redis://cache.internal:6379/15',
    'rediss://127.0.0.1:6379/15',
  ])('rejects unsafe Redis target %s', unsafeUrl => {
    expect(() => requireSafeE2ERedisUrl({ E2E_REDIS_URL: unsafeUrl })).toThrow();
  });
});
