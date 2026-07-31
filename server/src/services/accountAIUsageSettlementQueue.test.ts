import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AccountAIUsageInput } from '../repositories/store';
import { AccountAIUsageSettlementQueue } from './accountAIUsageSettlementQueue';

const usage = (overrides: Partial<AccountAIUsageInput> = {}): AccountAIUsageInput => ({
  id: 'code-agent-gateway:token-1:1',
  clientId: 'client-1',
  source: 'code_agent_gateway',
  costUsd: 0.01,
  provider: 'openai',
  modelId: 'gpt-5',
  roomId: 'room-1',
  turnId: 'turn-1',
  ...overrides,
});

const createFakeRedis = () => {
  const hashes = new Map<string, Map<string, string>>();
  const getHash = (key: string) => {
    let hash = hashes.get(key);
    if (!hash) {
      hash = new Map();
      hashes.set(key, hash);
    }
    return hash;
  };
  return {
    hashes,
    async hSetNX(key: string, field: string, value: string) {
      const hash = getHash(key);
      if (hash.has(field)) return false;
      hash.set(field, value);
      return true;
    },
    async hGet(key: string, field: string) {
      return getHash(key).get(field) ?? null;
    },
    async hDel(key: string, field: string) {
      return getHash(key).delete(field) ? 1 : 0;
    },
    async *hScanIterator(key: string) {
      yield [...getHash(key)].map(([field, value]) => ({ field, value }));
    },
  };
};

describe('AccountAIUsageSettlementQueue', () => {
  it('removes a recovery record after immediate PostgreSQL settlement', async () => {
    const redis = createFakeRedis();
    const settled: AccountAIUsageInput[] = [];
    const queue = new AccountAIUsageSettlementQueue(redis as any, async input => {
      settled.push(input);
      return {
        accountId: 'account-1',
        membershipTier: 'pro',
        costUsd: input.costUsd,
        creditAppliedUsd: input.costUsd,
        creditBalanceUsd: 1,
        duplicate: false,
      };
    });

    const result = await queue.settle(usage());
    assert.equal(result?.creditAppliedUsd, 0.01);
    assert.deepEqual(settled.map(item => item.id), ['code-agent-gateway:token-1:1']);
    assert.equal([...redis.hashes.values()].flatMap(hash => [...hash]).length, 0);
  });

  it('keeps failed settlement durably queued and drains it idempotently later', async () => {
    const redis = createFakeRedis();
    let available = false;
    let attempts = 0;
    const queue = new AccountAIUsageSettlementQueue(redis as any, async input => {
      attempts += 1;
      if (!available) throw new Error('PostgreSQL unavailable');
      return {
        accountId: 'account-1',
        membershipTier: 'priority',
        costUsd: input.costUsd,
        creditAppliedUsd: input.costUsd,
        creditBalanceUsd: 0.99,
        duplicate: false,
      };
    });

    assert.equal(await queue.settle(usage()), null);
    assert.equal([...redis.hashes.values()].flatMap(hash => [...hash]).length, 1);

    available = true;
    assert.deepEqual(await queue.drain(), { processed: 1, settled: 1, failed: 0 });
    assert.equal(attempts, 2);
    assert.equal([...redis.hashes.values()].flatMap(hash => [...hash]).length, 0);
  });

  it('rejects a usage-id collision with different billing data', async () => {
    const redis = createFakeRedis();
    const queue = new AccountAIUsageSettlementQueue(redis as any, async () => {
      throw new Error('PostgreSQL unavailable');
    });
    assert.equal(await queue.settle(usage()), null);

    await assert.rejects(
      queue.settle(usage({ costUsd: 0.02 })),
      /could not be persisted to Redis or PostgreSQL/,
    );
  });
});
