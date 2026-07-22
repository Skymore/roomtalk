import type { Logger } from '../logger';
import type { RoomStore, TaskDispatchRecord } from '../repositories/store';
import {
  ASSISTANT_RUN_JOB_NAME,
  type AssistantRunJobDataV1,
  assistantRunJobOptions,
} from './assistantRunQueue';

interface AssistantRunQueueProducer {
  add(name: any, data: any, options?: any): Promise<unknown>;
}

export interface TaskDispatchRelayOptions {
  store: Required<Pick<RoomStore,
    | 'claimTaskDispatches'
    | 'markTaskDispatchDispatched'
    | 'releaseTaskDispatch'
  >>;
  queue: AssistantRunQueueProducer;
  logger: Logger;
  relayId: string;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  lockMs?: number;
  batchSize?: number;
  jobOptions?: Record<string, unknown>;
}

export class TaskDispatchRelay {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private runAgain = false;
  private stopped = true;

  constructor(private readonly options: TaskDispatchRelayOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.logger.info('Assistant run dispatch relay started', { relayId: this.options.relayId });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) await this.active;
    this.options.logger.info('Assistant run dispatch relay stopped', { relayId: this.options.relayId });
  }

  wake(): void {
    if (this.stopped) return;
    if (this.active) {
      this.runAgain = true;
      return;
    }
    this.schedule(0);
  }

  async tick(): Promise<void> {
    if (this.active) return this.active;
    if (this.stopped) return;
    const task = this.runTick();
    this.active = task;
    try {
      await task;
    } finally {
      if (this.active === task) this.active = null;
      const immediate = this.runAgain;
      this.runAgain = false;
      if (!this.stopped) this.schedule(immediate ? 0 : undefined);
    }
  }

  private schedule(delayMs = this.options.pollIntervalMs ?? 1_000): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runTick(): Promise<void> {
    try {
      const dispatches = await this.options.store.claimTaskDispatches({
        workerId: this.options.relayId,
        limit: this.options.batchSize ?? 20,
        lockMs: this.options.lockMs ?? 60_000,
      });
      if (dispatches.length === 0) return;
      this.runAgain = true;
      for (const dispatch of dispatches) {
        await this.dispatch(dispatch);
      }
    } catch (error) {
      this.options.logger.error('Assistant run dispatch relay tick failed', {
        error,
        relayId: this.options.relayId,
      });
    }
  }

  private async dispatch(dispatch: TaskDispatchRecord): Promise<void> {
    const claim = { workerId: this.options.relayId, attempt: dispatch.attempts };
    try {
      await this.options.queue.add(
        ASSISTANT_RUN_JOB_NAME,
        { schemaVersion: 1, runId: dispatch.runId },
        {
          ...assistantRunJobOptions(),
          ...this.options.jobOptions,
          jobId: dispatch.runId,
        },
      );
      const marked = await this.options.store.markTaskDispatchDispatched(dispatch.runId, claim);
      if (!marked) {
        this.options.logger.warn('Assistant run was enqueued but its dispatch claim was replaced', {
          runId: dispatch.runId,
          relayId: this.options.relayId,
          attempt: dispatch.attempts,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const released = await this.options.store.releaseTaskDispatch(
        dispatch.runId,
        claim,
        message,
        this.options.retryDelayMs ?? 5_000,
      );
      this.options.logger.warn('Deferred assistant run dispatch after queue failure', {
        error: message,
        runId: dispatch.runId,
        relayId: this.options.relayId,
        released,
      });
    }
  }
}
