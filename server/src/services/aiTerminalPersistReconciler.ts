import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { Message } from '../types';

export interface AITerminalPersistTaskContext {
  reason: string;
}

interface PendingTask {
  message: Message;
  reason: string;
  attempts: number;
  nextAttemptAt: number;
}

export interface AITerminalPersistReconcilerOptions {
  intervalMs?: number;
  minRetryMs?: number;
  maxRetryMs?: number;
  now?: () => number;
  onPersisted?: (message: Message) => void;
}

/**
 * Keeps terminal AI after-images retrying after the request path gives up.
 * Process death is covered separately by the stream-owner lease reconciler.
 */
export class AITerminalPersistReconciler {
  private readonly pending = new Map<string, PendingTask>();
  private readonly intervalMs: number;
  private readonly minRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly store: Pick<RoomStore, 'upsertMessage'>,
    private readonly logger: Logger,
    private readonly options: AITerminalPersistReconcilerOptions = {},
  ) {
    this.intervalMs = Math.max(100, options.intervalMs || 500);
    this.minRetryMs = Math.max(100, options.minRetryMs || 500);
    this.maxRetryMs = Math.max(this.minRetryMs, options.maxRetryMs || 30_000);
    this.now = options.now || Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.reconcileNow(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(message: Message, context: AITerminalPersistTaskContext): void {
    if (message.status !== 'complete' && message.status !== 'error') {
      throw new Error('Only terminal AI messages can be reconciled');
    }
    const previous = this.pending.get(message.id);
    this.pending.set(message.id, {
      message,
      reason: context.reason,
      attempts: previous?.attempts || 0,
      nextAttemptAt: this.now(),
    });
    this.start();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async reconcileNow(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let persisted = 0;
    try {
      const now = this.now();
      for (const [messageId, task] of Array.from(this.pending.entries())) {
        if (task.nextAttemptAt > now) continue;
        try {
          const room = await this.store.upsertMessage(task.message);
          if (room) {
            this.pending.delete(messageId);
            persisted++;
            this.options.onPersisted?.(task.message);
            this.logger.info('Persisted deferred AI terminal state', {
              roomId: task.message.roomId,
              messageId,
              attempts: task.attempts + 1,
              reason: task.reason,
            });
            continue;
          }
        } catch (error) {
          this.logger.warn('Deferred AI terminal persistence attempt failed', {
            error,
            roomId: task.message.roomId,
            messageId,
            attempts: task.attempts + 1,
            reason: task.reason,
          });
        }
        task.attempts += 1;
        task.nextAttemptAt = now + Math.min(this.maxRetryMs, this.minRetryMs * (2 ** Math.min(task.attempts - 1, 10)));
      }
    } finally {
      this.running = false;
    }
    return persisted;
  }
}
