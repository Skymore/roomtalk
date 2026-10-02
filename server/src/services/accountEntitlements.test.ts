import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BULLMQ_MAX_PRIORITY,
  MONTHLY_CREDIT_USD,
  getAIModelAccessError,
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

  it('gives administrators the highest service class without a credit limit', () => {
    assert.deepEqual(resolveAssistantRunScheduling({
      accountId: 'admin-account',
      tier: 'free',
      status: 'active',
      creditBalanceUsd: 0,
      creditUnlimited: true,
      priorityOverride: 80,
    }), {
      accountId: 'admin-account',
      membershipTier: 'priority',
      creditState: 'available',
      queuePriority: 1,
    });
  });
});

describe('AI model access policy', () => {
  const account = (balance: number, effectiveTier: 'free' | 'pro' | 'priority' = 'free') => ({
    effectiveTier, creditBalanceUsd: balance,
  });
  const cheap = { id: 'gpt-6-luna', pricing: { inputPerMillion: 0.1 } };
  it('sets monthly allowances to 5, 20, and 50 dollars', () => {
    assert.deepEqual(MONTHLY_CREDIT_USD, { free: 5, pro: 20, priority: 50 });
  });
  it('requires sign-in and active membership for Astra and Fable, even with credits', () => {
    assert.match(getAIModelAccessError(null, cheap)!, /Sign in/);
    for (const id of ['gpt-6-astra', 'claude-fable-5.1']) {
      const model = { id, pricing: { inputPerMillion: 10 } };
      assert.match(getAIModelAccessError(account(50), model)!, /membership/);
      assert.equal(getAIModelAccessError(account(20, 'pro'), model), undefined);
      assert.equal(getAIModelAccessError(account(50, 'priority'), model), undefined);
      assert.match(getAIModelAccessError(account(0, 'pro'), model)!, /exhausted/);
    }
  });
  it('allows all other models with positive credits, and strictly cheap models until -5', () => {
    assert.equal(getAIModelAccessError(account(0.000001), { id: 'opus', pricing: { inputPerMillion: 4 } }), undefined);
    for (const balance of [0, -1, -4.999999]) {
      assert.equal(getAIModelAccessError(account(balance), cheap), undefined);
      assert.match(getAIModelAccessError(account(balance), { id: 'exact-dollar', pricing: { inputPerMillion: 1 } })!, /exhausted/);
      assert.match(getAIModelAccessError(account(balance), { id: 'unknown-price' })!, /exhausted/);
    }
    assert.match(getAIModelAccessError(account(-5), cheap)!, /-\$5 limit/);
    assert.match(getAIModelAccessError(account(-6), cheap)!, /-\$5 limit/);
    assert.equal(getAIModelAccessError({ ...account(-5), creditUnlimited: true }, { id: 'gpt-6-astra' }), undefined);
  });
});
