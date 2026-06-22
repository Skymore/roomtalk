import { Logger } from '../logger';
import { OutboxEventRecord, RoomStore } from '../repositories/store';

export type OutboxEventHandler = (event: OutboxEventRecord) => Promise<void>;

export interface OutboxWorkerOptions {
  store: RoomStore;
  logger: Logger;
  workerId: string;
  handlers: Record<string, OutboxEventHandler>;
  eventTypes?: string[];
  pollIntervalMs?: number;
  batchSize?: number;
  lockMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
}

export class OutboxWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = true;

  constructor(private readonly options: OutboxWorkerOptions) {}

  start() {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.schedule(0);
    this.options.logger.info('Outbox worker started', {
      workerId: this.options.workerId,
      eventTypes: this.options.eventTypes,
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.options.logger.info('Outbox worker stopped', { workerId: this.options.workerId });
  }

  private schedule(delayMs = this.options.pollIntervalMs ?? 1000) {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch(error => {
        this.options.logger.error('Outbox worker tick failed', { error, workerId: this.options.workerId });
      });
    }, delayMs);
  }

  async tick() {
    if (this.running || this.stopped) {
      return;
    }

    this.running = true;
    try {
      const events = await this.claimEvents();

      for (const event of events) {
        await this.processEvent(event);
      }
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async claimEvents(): Promise<OutboxEventRecord[]> {
    if (!this.options.store.claimOutboxEvents) {
      this.options.logger.error('Outbox worker cannot run because the configured store does not support outbox claims', {
        workerId: this.options.workerId,
      });
      return [];
    }
    return this.options.store.claimOutboxEvents({
      workerId: this.options.workerId,
      eventTypes: this.options.eventTypes,
      limit: this.options.batchSize ?? 10,
      lockMs: this.options.lockMs ?? 60_000,
    });
  }

  private async processEvent(event: OutboxEventRecord) {
    const handler = this.options.handlers[event.eventType];
    if (!handler) {
      await this.options.store.markOutboxEventFailed?.(event.id, `No handler registered for ${event.eventType}`, {
        retryDelayMs: this.options.retryDelayMs,
        maxAttempts: 1,
      });
      this.options.logger.warn('Outbox event has no handler', { eventId: event.id, eventType: event.eventType });
      return;
    }

    try {
      await handler(event);
      await this.options.store.markOutboxEventProcessed?.(event.id);
    } catch (error) {
      await this.options.store.markOutboxEventFailed?.(
        event.id,
        error instanceof Error ? error.message : String(error),
        {
          retryDelayMs: this.options.retryDelayMs,
          maxAttempts: this.options.maxAttempts,
        }
      );
      this.options.logger.error('Outbox event handler failed', {
        eventId: event.id,
        eventType: event.eventType,
        error,
      });
    }
  }
}

export const createOutboxWorkerFromEnv = (options: Omit<OutboxWorkerOptions, 'pollIntervalMs' | 'batchSize' | 'lockMs' | 'retryDelayMs' | 'maxAttempts'>) => (
  new OutboxWorker({
    ...options,
    pollIntervalMs: parsePositiveInt(process.env.OUTBOX_WORKER_POLL_INTERVAL_MS, 1000),
    batchSize: parsePositiveInt(process.env.OUTBOX_WORKER_BATCH_SIZE, 10),
    lockMs: parsePositiveInt(process.env.OUTBOX_WORKER_LOCK_MS, 60_000),
    retryDelayMs: parsePositiveInt(process.env.OUTBOX_WORKER_RETRY_DELAY_MS, 30_000),
    maxAttempts: parsePositiveInt(process.env.OUTBOX_WORKER_MAX_ATTEMPTS, 10),
  })
);

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
