import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCocoAccessControl } from './cocoAccessControl';

describe('createCocoAccessControl', () => {
  it('denies all Coco entry points when the feature is disabled', () => {
    const access = createCocoAccessControl({ enabled: false });

    assert.deepEqual(access.canUse('client-1'), {
      allowed: false,
      reason: 'disabled',
      message: 'Coco is disabled',
    });
    assert.deepEqual(access.toFeaturePayload('client-1'), {
      enabled: false,
      rollout: 'disabled',
      reason: 'disabled',
    });
  });

  it('allows all clients when enabled without an allowlist', () => {
    const access = createCocoAccessControl({ enabled: true });

    assert.deepEqual(access.canUse('client-1'), { allowed: true });
    assert.deepEqual(access.toFeaturePayload('client-1'), {
      enabled: true,
      rollout: 'all',
    });
  });

  it('enforces allowlisted clients and hides the feature for everyone else', () => {
    const access = createCocoAccessControl({ enabled: true, allowedClientIds: ['client-1'] });

    assert.deepEqual(access.canUse('client-1'), { allowed: true });
    assert.deepEqual(access.canUse('client-2'), {
      allowed: false,
      reason: 'not_allowed',
      message: 'Coco is not enabled for this user',
    });
    assert.deepEqual(access.canUse(null), {
      allowed: false,
      reason: 'missing_client_id',
      message: 'Coco requires a registered client',
    });
    assert.deepEqual(access.toFeaturePayload('client-2'), {
      enabled: false,
      rollout: 'allowlist',
      reason: 'not_allowed',
    });
  });
});
