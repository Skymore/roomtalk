import { RedisClientType } from 'redis';
import type { Logger } from '../logger';
import {
  AccountAIUsageInput,
  AccountAIUsageSettlement,
} from '../repositories/store';

type SettleAccountAIUsage = (
  input: AccountAIUsageInput,
) => Promise<AccountAIUsageSettlement | null>;

const DEFAULT_PENDING_KEY = 'roomtalk:account-ai-usage-settlement:pending:v1';

export class AccountAIUsageSettlementQueue {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly settleAccountAIUsage: SettleAccountAIUsage,
    private readonly logger?: Logger,
    private readonly pendingKey = DEFAULT_PENDING_KEY,
  ) {}

  private async enqueue(input: AccountAIUsageInput): Promise<void> {
    const serialized = JSON.stringify(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await this.redisClient.hSetNX(this.pendingKey, input.id, serialized)) {
        return;
      }
      const existing = await this.redisClient.hGet(this.pendingKey, input.id);
      if (existing === serialized) {
        return;
      }
      if (existing !== null) {
        throw new Error('Pending account AI usage id is already bound to different usage');
      }
    }
    throw new Error('Unable to persist pending account AI usage');
  }

  private async removeBestEffort(id: string): Promise<void> {
    await this.redisClient.hDel(this.pendingKey, id).catch(error => {
      this.logger?.error('Failed to remove settled account AI usage from Redis recovery queue', {
        error,
        usageId: id,
      });
    });
  }

  async settle(input: AccountAIUsageInput): Promise<AccountAIUsageSettlement | null> {
    let queued = false;
    let queueError: unknown;
    try {
      await this.enqueue(input);
      queued = true;
    } catch (error) {
      queueError = error;
      this.logger?.error('Failed to persist account AI usage in Redis recovery queue', {
        error,
        usageId: input.id,
        clientId: input.clientId,
      });
    }

    try {
      const settlement = await this.settleAccountAIUsage(input);
      if (queued) await this.removeBestEffort(input.id);
      return settlement;
    } catch (error) {
      if (!queued) {
        const combined = new Error('Account AI usage could not be persisted to Redis or PostgreSQL');
        (combined as Error & { queueError?: unknown; settlementError?: unknown }).queueError = queueError;
        (combined as Error & { queueError?: unknown; settlementError?: unknown }).settlementError = error;
        throw combined;
      }
      this.logger?.error('Account AI usage settlement deferred to Redis recovery queue', {
        error,
        usageId: input.id,
        clientId: input.clientId,
      });
      return null;
    }
  }

  async drain(limit = 100): Promise<{ processed: number; settled: number; failed: number }> {
    const safeLimit = Math.max(1, Math.floor(limit));
    let processed = 0;
    let settled = 0;
    let failed = 0;

    for await (const batch of this.redisClient.hScanIterator(this.pendingKey, {
      COUNT: safeLimit,
    })) {
      for (const entry of batch) {
        if (processed >= safeLimit) {
          return { processed, settled, failed };
        }
        processed += 1;
        let input: AccountAIUsageInput;
        try {
          input = JSON.parse(String(entry.value)) as AccountAIUsageInput;
          if (!input.id || input.id !== String(entry.field)) {
            throw new Error('Pending account AI usage has an invalid identity');
          }
        } catch (error) {
          failed += 1;
          this.logger?.error('Dropping malformed pending account AI usage', {
            error,
            usageId: String(entry.field),
          });
          await this.removeBestEffort(String(entry.field));
          continue;
        }

        try {
          await this.settleAccountAIUsage(input);
          await this.removeBestEffort(input.id);
          settled += 1;
        } catch (error) {
          failed += 1;
          this.logger?.error('Pending account AI usage settlement retry failed', {
            error,
            usageId: input.id,
            clientId: input.clientId,
          });
        }
      }
    }
    return { processed, settled, failed };
  }
}
