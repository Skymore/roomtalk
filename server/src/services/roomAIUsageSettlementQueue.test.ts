import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoomAIUsageInput } from '../repositories/store';
import { RoomAIUsageSettlementQueue } from './roomAIUsageSettlementQueue';

const usage = (overrides: Partial<RoomAIUsageInput> = {}): RoomAIUsageInput => ({
  id: 'code-agent-gateway:token-1:1',
  roomId: 'room-1',
  turnId: 'turn-1',
  costUsd: 0.01,
  provider: 'deepseek',
  modelId: 'deepseek-v4-flash',
  promptTokens: 10,
  completionTokens: 2,
  totalTokens: 12,
  cachedPromptTokens: 4,
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

describe('RoomAIUsageSettlementQueue', () => {
  it('broadcasts and removes an immediately settled usage record', async () => {
    const redis = createFakeRedis();
    const broadcasts: number[] = [];
    const queue = new RoomAIUsageSettlementQueue(
      redis as any,
      async input => ({
        id: input.id,
        roomCostTotal: { roomId: input.roomId, currency: 'USD', totalUsd: 1.25 },
        duplicate: false,
      }),
      undefined,
      settlement => {
        broadcasts.push(settlement.roomCostTotal.totalUsd);
      },
    );

    const result = await queue.settle(usage());

    assert.equal(result?.roomCostTotal.totalUsd, 1.25);
    assert.deepEqual(broadcasts, [1.25]);
    assert.equal([...redis.hashes.values()].flatMap(hash => [...hash]).length, 0);
  });

  it('keeps unavailable PostgreSQL work queued and broadcasts after retry', async () => {
    const redis = createFakeRedis();
    let available = false;
    const broadcasts: string[] = [];
    const queue = new RoomAIUsageSettlementQueue(
      redis as any,
      async input => {
        if (!available) throw new Error('PostgreSQL unavailable');
        return {
          id: input.id,
          roomCostTotal: { roomId: input.roomId, currency: 'USD', totalUsd: 2 },
          duplicate: false,
        };
      },
      undefined,
      settlement => {
        broadcasts.push(settlement.id);
      },
    );

    assert.equal(await queue.settle(usage()), null);
    available = true;
    assert.deepEqual(await queue.drain(), { processed: 1, settled: 1, failed: 0 });
    assert.deepEqual(broadcasts, ['code-agent-gateway:token-1:1']);
  });
});
