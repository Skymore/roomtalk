import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_FEATURE_FLAGS, fetchFeatureFlags } from './features';

describe('feature flags', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults Coco to disabled for fail-closed UI behavior', () => {
    expect(FALLBACK_FEATURE_FLAGS).toEqual({
      coco: { enabled: false, rollout: 'disabled' },
    });
  });

  it('fetches per-client feature flags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ coco: { enabled: true, rollout: 'allowlist' } }),
    })));

    await expect(fetchFeatureFlags('client-1')).resolves.toEqual({
      coco: { enabled: true, rollout: 'allowlist', reason: undefined },
    });
    expect(fetch).toHaveBeenCalledWith('/api/features?clientId=client-1');
  });

  it('rejects failed or invalid feature responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(fetchFeatureFlags('client-1')).rejects.toThrow('Failed to load feature flags: 500');

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ coco: {} }),
    })));
    await expect(fetchFeatureFlags('client-1')).rejects.toThrow('Feature flag response is invalid');
  });
});
