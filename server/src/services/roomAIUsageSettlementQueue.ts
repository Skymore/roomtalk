import { RedisClientType } from 'redis';
import type { Logger } from '../logger';
import type { RoomAIUsageInput, RoomAIUsageSettlement } from '../repositories/store';

type SettleRoomAIUsage = (input: RoomAIUsageInput) => Promise<RoomAIUsageSettlement>;
type OnSettled = (settlement: RoomAIUsageSettlement) => void | Promise<void>;

const DEFAULT_PENDING_KEY = 'roomtalk:room-ai-usage-settlement:pending:v1';

export class RoomAIUsageSettlementQueue {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly settleRoomAIUsage: SettleRoomAIUsage,
    private readonly logger?: Logger,
    private readonly onSettled?: OnSettled,
    private readonly pendingKey = DEFAULT_PENDING_KEY,
  ) {}

  private async enqueue(input: RoomAIUsageInput): Promise<void> {
    const serialized = JSON.stringify(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await this.redisClient.hSetNX(this.pendingKey, input.id, serialized)) return;
      const existing = await this.redisClient.hGet(this.pendingKey, input.id);
      if (existing === serialized) return;
      if (existing !== null) {
        throw new Error('Pending room AI usage id is already bound to different usage');
      }
    }
    throw new Error('Unable to persist pending room AI usage');
  }

  private async removeBestEffort(id: string): Promise<void> {
    await this.redisClient.hDel(this.pendingKey, id).catch(error => {
      this.logger?.error('Failed to remove settled room AI usage from Redis recovery queue', {
        error,
        usageId: id,
      });
    });
  }

  private async notifyBestEffort(settlement: RoomAIUsageSettlement): Promise<void> {
    if (!this.onSettled) return;
    try {
      await this.onSettled(settlement);
    } catch (error) {
      this.logger?.error('Failed to broadcast settled room AI usage', {
        error,
        usageId: settlement.id,
        roomId: settlement.roomCostTotal.roomId,
      });
    }
  }

  async settle(input: RoomAIUsageInput): Promise<RoomAIUsageSettlement | null> {
    let queued = false;
    let queueError: unknown;
    try {
      await this.enqueue(input);
      queued = true;
    } catch (error) {
      queueError = error;
      this.logger?.error('Failed to persist room AI usage in Redis recovery queue', {
        error,
        usageId: input.id,
        roomId: input.roomId,
      });
    }

    try {
      const settlement = await this.settleRoomAIUsage(input);
      if (queued) await this.removeBestEffort(input.id);
      await this.notifyBestEffort(settlement);
      return settlement;
    } catch (error) {
      if (!queued) {
        const combined = new Error('Room AI usage could not be persisted to Redis or PostgreSQL');
        (combined as Error & { queueError?: unknown; settlementError?: unknown }).queueError = queueError;
        (combined as Error & { queueError?: unknown; settlementError?: unknown }).settlementError = error;
        throw combined;
      }
      this.logger?.error('Room AI usage settlement deferred to Redis recovery queue', {
        error,
        usageId: input.id,
        roomId: input.roomId,
      });
      return null;
    }
  }

  async drain(limit = 100): Promise<{ processed: number; settled: number; failed: number }> {
    const safeLimit = Math.max(1, Math.floor(limit));
    let processed = 0;
    let settled = 0;
    let failed = 0;

    for await (const batch of this.redisClient.hScanIterator(this.pendingKey, { COUNT: safeLimit })) {
      for (const entry of batch) {
        if (processed >= safeLimit) return { processed, settled, failed };
        processed += 1;
        let input: RoomAIUsageInput;
        try {
          input = JSON.parse(String(entry.value)) as RoomAIUsageInput;
          if (!input.id || input.id !== String(entry.field)) {
            throw new Error('Pending room AI usage has an invalid identity');
          }
        } catch (error) {
          failed += 1;
          this.logger?.error('Dropping malformed pending room AI usage', {
            error,
            usageId: String(entry.field),
          });
          await this.removeBestEffort(String(entry.field));
          continue;
        }

        try {
          const settlement = await this.settleRoomAIUsage(input);
          await this.removeBestEffort(input.id);
          await this.notifyBestEffort(settlement);
          settled += 1;
        } catch (error) {
          failed += 1;
          this.logger?.error('Pending room AI usage settlement retry failed', {
            error,
            usageId: input.id,
            roomId: input.roomId,
          });
        }
      }
    }
    return { processed, settled, failed };
  }
}
