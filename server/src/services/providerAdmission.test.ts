import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveProviderAdmissionLimits } from './providerAdmission';

describe('provider admission configuration', () => {
  it('parses provider-specific request and concurrency quotas', () => {
    assert.deepEqual(resolveProviderAdmissionLimits({
      ASSISTANT_PROVIDER_LIMITS_JSON: JSON.stringify({
        openai: { requestsPerSecond: 8, maxConcurrent: 3 },
        anthropic: { maxConcurrent: 2 },
      }),
    }), {
      openai: { requestsPerSecond: 8, maxConcurrent: 3 },
      anthropic: { maxConcurrent: 2 },
    });
  });

  it('fails closed on malformed or unknown provider limits', () => {
    assert.throws(
      () => resolveProviderAdmissionLimits({
        ASSISTANT_PROVIDER_LIMITS_JSON: '{"deepseek":{"requestsPerSecond":0}}',
      }),
      /requestsPerSecond.*positive integer/,
    );
    assert.throws(
      () => resolveProviderAdmissionLimits({
        ASSISTANT_PROVIDER_LIMITS_JSON: '{"unknown":{"maxConcurrent":2}}',
      }),
      /Unknown providers/,
    );
    assert.throws(
      () => resolveProviderAdmissionLimits({
        ASSISTANT_PROVIDER_LIMITS_JSON: '{"openai":{"requestsPerSecond":"8","maxConcurrent":2}}',
      }),
      /requestsPerSecond.*positive integer/,
    );
  });
});
