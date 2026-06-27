import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_FEATURE_FLAGS, fetchFeatureFlags } from './features';

describe('feature flags', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults Coco to disabled for fail-closed UI behavior', () => {
    expect(FALLBACK_FEATURE_FLAGS).toEqual({
      coco: { enabled: false, mode: 'plan', availableModes: ['plan'], defaultMode: 'plan', rollout: 'disabled' },
    });
  });

  it('fetches per-client feature flags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        coco: {
          enabled: true,
          mode: 'acceptEdits',
          availableModes: ['plan', 'acceptEdits'],
          defaultMode: 'plan',
          rollout: 'allowlist',
        },
      }),
    })));

    await expect(fetchFeatureFlags('client-1')).resolves.toEqual({
      coco: {
        enabled: true,
        mode: 'acceptEdits',
        availableModes: ['plan', 'acceptEdits'],
        defaultMode: 'plan',
        rollout: 'allowlist',
        reason: undefined,
      },
    });
    expect(fetch).toHaveBeenCalledWith('/api/features?clientId=client-1');
  });

  it('defaults unknown or missing Coco mode to plan', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ coco: { enabled: true, rollout: 'all' } }),
    })));

    await expect(fetchFeatureFlags('client-1')).resolves.toMatchObject({
      coco: { enabled: true, mode: 'plan', availableModes: ['plan'], defaultMode: 'plan' },
    });
  });

  it('derives available modes from the legacy max mode payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ coco: { enabled: true, mode: 'acceptEdits', rollout: 'all' } }),
    })));

    await expect(fetchFeatureFlags('client-1')).resolves.toMatchObject({
      coco: {
        mode: 'acceptEdits',
        availableModes: ['plan', 'acceptEdits'],
        defaultMode: 'plan',
      },
    });
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
