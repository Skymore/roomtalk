import type { Logger } from '../logger';
import type { RoomStore, TaskDispatchRecord } from '../repositories/store';
import {
  ASSISTANT_RUN_JOB_NAME,
  assistantRunJobOptions,
  type AssistantRunJobDataV1,
} from './assistantRunQueue';

type RetriableJobState = 'failed' | 'completed';

interface ReconciliationJob {
  getState(): Promise<string>;
  retry(state: RetriableJobState, options?: {
    resetAttemptsMade?: boolean;
    resetAttemptsStarted?: boolean;
  }): Promise<void>;
}

interface AssistantRunQueueReconciliationTarget {
  getJob(runId: string): Promise<ReconciliationJob | undefined>;
  add(name: any, data: any, options?: any): Promise<unknown>;
}

export interface AssistantRunQueueReconcilerOptions {
  store: Required<Pick<RoomStore,
    | 'readActiveDispatchedTaskDispatches'
    | 'withMaintenanceLock'
  >>;
  queue: AssistantRunQueueReconciliationTarget;
  logger: Logger;
  pollIntervalMs?: number;
  graceMs?: number;
  batchSize?: number;
  jobOptions?: Record<string, unknown>;
}

export interface AssistantRunQueueReconcileMetrics {
  examined: number;
  healthy: number;
  missingRequeued: number;
  failedRetried: number;
  completedRetried: number;
  errors: number;
  cursor?: string;
  completedAt?: string;
}

const HEALTHY_JOB_STATES = new Set([
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

const emptyMetrics = (): AssistantRunQueueReconcileMetrics => ({
  examined: 0,
  healthy: 0,
  missingRequeued: 0,
  failedRetried: 0,
  completedRetried: 0,
  errors: 0,
});

/**
 * Repairs the narrow cross-store gap left after PostgreSQL has acknowledged a
 * dispatch but BullMQ no longer has a runnable job. PostgreSQL remains the
 * authority: only active assistant_runs are candidates, and duplicate queue
 * work is harmless because execution and terminal projection are fenced there.
 */
export class AssistantRunQueueReconciler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<AssistantRunQueueReconcileMetrics> | null = null;
  private stopped = true;
  private afterRunId: string | undefined;
  private metrics = emptyMetrics();

  constructor(private readonly options: AssistantRunQueueReconcilerOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.logger.info('Assistant run queue reconciler started');
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) await this.active;
    this.options.logger.info('Assistant run queue reconciler stopped');
  }

  getMetrics(): AssistantRunQueueReconcileMetrics {
    return { ...this.metrics };
  }

  async reconcileOnce(): Promise<AssistantRunQueueReconcileMetrics> {
    if (this.active) return this.active;
    const task = this.runReconciliation();
    this.active = task;
    try {
      return await task;
    } finally {
      if (this.active === task) this.active = null;
    }
  }

  private schedule(delayMs = this.options.pollIntervalMs ?? 30_000): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcileOnce().finally(() => {
        if (!this.stopped) this.schedule();
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async runReconciliation(): Promise<AssistantRunQueueReconcileMetrics> {
    const metrics = emptyMetrics();
    try {
      const maintenance = await this.options.store.withMaintenanceLock(
        'assistant-run-bullmq-reconcile',
        async () => {
          const batchSize = Math.min(1_000, Math.max(1, this.options.batchSize ?? 200));
          const candidates = await this.options.store.readActiveDispatchedTaskDispatches({
            afterRunId: this.afterRunId,
            graceMs: Math.max(0, this.options.graceMs ?? 30_000),
            limit: batchSize,
          });
          for (const dispatch of candidates) {
            await this.reconcileDispatch(dispatch, metrics);
          }
          this.afterRunId = candidates.length === batchSize
            ? candidates[candidates.length - 1]?.runId
            : undefined;
          return candidates.length;
        },
      );
      if (!maintenance.acquired) {
        this.options.logger.debug('Skipped assistant run queue reconciliation because another instance owns it');
      }
    } catch (error) {
      metrics.errors += 1;
      this.options.logger.error('Assistant run queue reconciliation failed', { error });
    }
    metrics.cursor = this.afterRunId;
    metrics.completedAt = new Date().toISOString();
    this.metrics = metrics;
    if (
      metrics.missingRequeued > 0
      || metrics.failedRetried > 0
      || metrics.completedRetried > 0
      || metrics.errors > 0
    ) {
      this.options.logger.info('Assistant run queue reconciliation completed', metrics);
    }
    return { ...metrics };
  }

  private async reconcileDispatch(
    dispatch: TaskDispatchRecord,
    metrics: AssistantRunQueueReconcileMetrics,
  ): Promise<void> {
    metrics.examined += 1;
    try {
      const job = await this.options.queue.getJob(dispatch.runId);
      if (!job) {
        const data: AssistantRunJobDataV1 = { schemaVersion: 1, runId: dispatch.runId };
        await this.options.queue.add(ASSISTANT_RUN_JOB_NAME, data, {
          ...assistantRunJobOptions(),
          ...this.options.jobOptions,
          jobId: dispatch.runId,
        });
        metrics.missingRequeued += 1;
        return;
      }

      const state = await job.getState();
      if (state === 'failed' || state === 'completed') {
        await job.retry(state, {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
        if (state === 'failed') metrics.failedRetried += 1;
        else metrics.completedRetried += 1;
        return;
      }
      if (HEALTHY_JOB_STATES.has(state)) {
        metrics.healthy += 1;
        return;
      }

      metrics.errors += 1;
      this.options.logger.warn('Assistant run queue job has an unknown state; deferring repair', {
        runId: dispatch.runId,
        state,
      });
    } catch (error) {
      metrics.errors += 1;
      this.options.logger.warn('Could not reconcile assistant run queue job', {
        error,
        runId: dispatch.runId,
      });
    }
  }
}
