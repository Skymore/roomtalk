import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_FEATURE_FLAGS, fetchFeatureFlags } from './features';

describe('feature flags', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults code agent to disabled for fail-closed UI behavior', () => {
    expect(FALLBACK_FEATURE_FLAGS).toEqual({
      codeAgent: { enabled: false, mode: 'plan', availableModes: ['plan'], defaultMode: 'plan', rollout: 'disabled' },
      codex: { connections: { enabled: false } },
    });
  });

  it('fetches per-client feature flags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        codeAgent: {
          enabled: true,
          mode: 'acceptEdits',
          availableModes: ['plan', 'acceptEdits'],
          defaultMode: 'plan',
          rollout: 'allowlist',
        },
        codex: {
          connections: {
            enabled: true,
          },
        },
      }),
    })));

    await expect(fetchFeatureFlags('client-1')).resolves.toEqual({
      codeAgent: {
        enabled: true,
        mode: 'edit',
        availableModes: ['plan', 'edit'],
        defaultMode: 'plan',
        rollout: 'allowlist',
        reason: undefined,
      },
      codex: {
        connections: {
          enabled: true,
        },
      },
    });
    expect(fetch).toHaveBeenCalledWith('/api/features?clientId=client-1');
  });

  it('defaults unknown or missing code-agent mode to plan', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ codeAgent: { enabled: true, rollout: 'all' } }),
    })));

    await expect(fetchFeatureFlags('client-1')).resolves.toMatchObject({
      codeAgent: { enabled: true, mode: 'plan', availableModes: ['plan'], defaultMode: 'plan' },
      codex: { connections: { enabled: false } },
    });
  });

  it('derives available modes from the legacy max mode payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ codeAgent: { enabled: true, mode: 'acceptEdits', rollout: 'all' } }),
    })));

    await expect(fetchFeatureFlags('client-1')).resolves.toMatchObject({
      codeAgent: {
        mode: 'edit',
        availableModes: ['plan', 'edit'],
        defaultMode: 'plan',
      },
    });
  });

  it('rejects failed or invalid feature responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(fetchFeatureFlags('client-1')).rejects.toThrow('Failed to load feature flags: 500');

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ codeAgent: {} }),
    })));
    await expect(fetchFeatureFlags('client-1')).rejects.toThrow('Feature flag response is invalid');
  });
});
