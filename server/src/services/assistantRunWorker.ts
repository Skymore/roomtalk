import type { Logger } from '../logger';
import type { AssistantRunClaim, RoomStore } from '../repositories/store';

export interface AssistantRunExecutionContext {
  signal: AbortSignal;
  maxAttempts: number;
}

export interface AssistantRunWorkerOptions {
  store: Required<Pick<RoomStore,
    | 'claimAssistantRun'
    | 'renewAssistantRunLease'
    | 'releaseAssistantRunClaim'
  >>;
  logger: Logger;
  workerId: string;
  execute: (claim: AssistantRunClaim, context: AssistantRunExecutionContext) => Promise<void>;
  pollIntervalMs?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
}

export class AssistantRunWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeController: AbortController | null = null;
  private activeTick: Promise<void> | null = null;
  private runImmediately = false;
  private stopped = true;

  constructor(private readonly options: AssistantRunWorkerOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.logger.info('Assistant run worker started', { workerId: this.options.workerId });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (this.stopped && !this.activeTick) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.activeController?.abort(new Error('Assistant run worker is stopping'));
    if (this.activeTick) await this.activeTick;
    this.options.logger.info('Assistant run worker stopped', { workerId: this.options.workerId });
  }

  wake(): void {
    if (this.stopped) return;
    if (this.activeTick) {
      this.runImmediately = true;
      return;
    }
    this.schedule(0);
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

  async tick(): Promise<void> {
    if (this.activeTick) return this.activeTick;
    if (this.stopped) return;
    const task = this.runTick();
    this.activeTick = task;
    try {
      await task;
    } finally {
      if (this.activeTick === task) this.activeTick = null;
      const immediate = this.runImmediately;
      this.runImmediately = false;
      if (!this.stopped) this.schedule(immediate ? 0 : undefined);
    }
  }

  private async runTick(): Promise<void> {
    try {
      const claim = await this.options.store.claimAssistantRun({
        workerId: this.options.workerId,
        leaseMs: this.options.leaseMs ?? 60_000,
      });
      if (!claim) return;
      this.runImmediately = true;
      if (this.stopped) {
        await this.options.store.releaseAssistantRunClaim(
          claim.run.id,
          claim.token,
          'Assistant run worker stopped before execution',
          0,
        );
        return;
      }
      await this.process(claim);
    } catch (error) {
      this.options.logger.error('Assistant run worker tick failed', {
        error,
        workerId: this.options.workerId,
      });
    }
  }

  private async process(claim: AssistantRunClaim): Promise<void> {
    const controller = new AbortController();
    this.activeController = controller;
    const leaseMs = this.options.leaseMs ?? 60_000;
    const renewalMs = Math.max(250, Math.floor(leaseMs / 3));
    let leaseLost = false;
    let renewalInFlight: Promise<void> | null = null;
    const renew = () => {
      if (leaseLost || renewalInFlight) return renewalInFlight;
      renewalInFlight = this.options.store.renewAssistantRunLease(
        claim.run.id,
        claim.token,
        leaseMs,
      ).then(renewed => {
        if (!renewed) {
          leaseLost = true;
          controller.abort(new Error('Assistant run lease was lost'));
        }
      }).catch(error => {
        leaseLost = true;
        controller.abort(error);
        this.options.logger.error('Assistant run lease renewal failed', {
          error,
          runId: claim.run.id,
          token: claim.token,
        });
      }).finally(() => {
        renewalInFlight = null;
      });
      return renewalInFlight;
    };
    const renewalTimer = setInterval(() => void renew(), renewalMs);
    renewalTimer.unref?.();

    try {
      await this.options.execute(claim, {
        signal: controller.signal,
        maxAttempts: this.options.maxAttempts ?? 10,
      });
      if (renewalInFlight) await renewalInFlight;
    } catch (error) {
      if (!leaseLost) {
        const released = await this.options.store.releaseAssistantRunClaim(
          claim.run.id,
          claim.token,
          error instanceof Error ? error.message : String(error),
          this.stopped ? 0 : (this.options.retryDelayMs ?? 30_000),
        );
        if (!released) {
          this.options.logger.warn('Assistant run retry release was rejected by its claim fence', {
            runId: claim.run.id,
            token: claim.token,
          });
        }
      }
      this.options.logger.error('Assistant run execution failed', {
        error,
        runId: claim.run.id,
        phase: claim.phase,
        token: claim.token,
      });
    } finally {
      clearInterval(renewalTimer);
      if (this.activeController === controller) this.activeController = null;
    }
  }
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const createAssistantRunWorkerFromEnv = (
  options: Omit<AssistantRunWorkerOptions, 'pollIntervalMs' | 'leaseMs' | 'retryDelayMs' | 'maxAttempts'>,
) => new AssistantRunWorker({
  ...options,
  pollIntervalMs: parsePositiveInt(process.env.ASSISTANT_RUN_WORKER_POLL_INTERVAL_MS, 1_000),
  leaseMs: parsePositiveInt(process.env.ASSISTANT_RUN_WORKER_LEASE_MS, 60_000),
  retryDelayMs: parsePositiveInt(process.env.ASSISTANT_RUN_WORKER_RETRY_DELAY_MS, 30_000),
  maxAttempts: parsePositiveInt(process.env.ASSISTANT_RUN_WORKER_MAX_ATTEMPTS, 10),
});
