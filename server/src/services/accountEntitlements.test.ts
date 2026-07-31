import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BULLMQ_MAX_PRIORITY,
  normalizeQueuePriority,
  resolveAssistantRunScheduling,
} from './accountEntitlements';

describe('account entitlement scheduling', () => {
  it('keeps guests in the lowest service class', () => {
    assert.deepEqual(resolveAssistantRunScheduling(), {
      membershipTier: 'guest',
      creditState: 'none',
      queuePriority: 100,
    });
  });

  it('degrades an account after its credits are exhausted', () => {
    const funded = resolveAssistantRunScheduling({
      accountId: 'account-1',
      tier: 'pro',
      status: 'active',
      creditBalanceUsd: 2,
    });
    const exhausted = resolveAssistantRunScheduling({
      accountId: 'account-1',
      tier: 'pro',
      status: 'active',
      creditBalanceUsd: 0,
    });

    assert.equal(funded.queuePriority, 20);
    assert.equal(exhausted.queuePriority, 40);
    assert.equal(exhausted.creditState, 'exhausted');
  });

  it('drops inactive paid memberships to the free policy', () => {
    const scheduling = resolveAssistantRunScheduling({
      accountId: 'account-1',
      tier: 'priority',
      status: 'past_due',
      creditBalanceUsd: 10,
    });

    assert.equal(scheduling.membershipTier, 'free');
    assert.equal(scheduling.queuePriority, 60);
  });

  it('honors bounded manual priority overrides', () => {
    assert.equal(resolveAssistantRunScheduling({
      accountId: 'account-1',
      tier: 'free',
      status: 'active',
      creditBalanceUsd: 0,
      priorityOverride: 3,
    }).queuePriority, 3);
    assert.equal(normalizeQueuePriority(0), 1);
    assert.equal(normalizeQueuePriority(Number.MAX_SAFE_INTEGER), BULLMQ_MAX_PRIORITY);
  });
});
