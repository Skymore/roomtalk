import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCodeAgentAccessControl } from './codeAgentAccessControl';

describe('createCodeAgentAccessControl', () => {
  it('denies all code-agent entry points when the feature is disabled', () => {
    const access = createCodeAgentAccessControl({ enabled: false });

    assert.deepEqual(access.canUse('client-1'), {
      allowed: false,
      reason: 'disabled',
      message: 'Coco Agent is disabled',
    });
    assert.deepEqual(access.toFeaturePayload('client-1'), {
      enabled: false,
      rollout: 'disabled',
      reason: 'disabled',
    });
  });

  it('allows all clients when enabled without an allowlist', () => {
    const access = createCodeAgentAccessControl({ enabled: true });

    assert.deepEqual(access.canUse('client-1'), { allowed: true });
    assert.deepEqual(access.toFeaturePayload('client-1'), {
      enabled: true,
      rollout: 'all',
    });
  });

  it('enforces allowlisted clients and hides the feature for everyone else', () => {
    const access = createCodeAgentAccessControl({ enabled: true, allowedClientIds: ['client-1'] });

    assert.deepEqual(access.canUse('client-1'), { allowed: true });
    assert.deepEqual(access.canUse('client-2'), {
      allowed: false,
      reason: 'not_allowed',
      message: 'Coco Agent is not enabled for this user',
    });
    assert.deepEqual(access.canUse(null), {
      allowed: false,
      reason: 'missing_client_id',
      message: 'Coco Agent requires a registered client',
    });
    assert.deepEqual(access.toFeaturePayload('client-2'), {
      enabled: false,
      rollout: 'allowlist',
      reason: 'not_allowed',
    });
  });
});
