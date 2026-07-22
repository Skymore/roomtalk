import type { Logger } from '../logger';
import type { AssistantRunClaim, RoomStore } from '../repositories/store';
import type { AssistantRunExecutionContext } from './assistantRunExecution';
import type { AssistantRunJobDataV1 } from './assistantRunQueue';

export interface AssistantRunBullProcessorOptions {
  store: Required<Pick<RoomStore,
    | 'getAssistantRun'
    | 'claimAssistantRunById'
    | 'renewAssistantRunLease'
    | 'releaseAssistantRunClaim'
  >>;
  logger: Logger;
  workerId: string;
  execute: (claim: AssistantRunClaim, context: AssistantRunExecutionContext) => Promise<void>;
  leaseMs?: number;
  maxAttempts?: number;
}

export class AssistantRunClaimUnavailableError extends Error {
  constructor(runId: string, status: string) {
    super(`Assistant run ${runId} is not claimable while status is ${status}`);
    this.name = 'AssistantRunClaimUnavailableError';
  }
}

export const processAssistantRunJob = async (
  data: AssistantRunJobDataV1,
  options: AssistantRunBullProcessorOptions,
): Promise<'executed' | 'already-terminal' | 'missing'> => {
  const existing = await options.store.getAssistantRun(data.runId);
  if (!existing) {
    options.logger.warn('BullMQ assistant run job has no PostgreSQL aggregate', { runId: data.runId });
    return 'missing';
  }
  if (existing.status === 'complete' || existing.status === 'error' || existing.status === 'cancelled') {
    return 'already-terminal';
  }

  const leaseMs = options.leaseMs ?? 60_000;
  const claim = await options.store.claimAssistantRunById(data.runId, {
    workerId: options.workerId,
    leaseMs,
  });
  if (!claim) {
    const latest = await options.store.getAssistantRun(data.runId);
    if (!latest || latest.status === 'complete' || latest.status === 'error' || latest.status === 'cancelled') {
      return latest ? 'already-terminal' : 'missing';
    }
    throw new AssistantRunClaimUnavailableError(data.runId, latest.status);
  }

  const controller = new AbortController();
  const renewalMs = Math.max(250, Math.floor(leaseMs / 3));
  let leaseLost = false;
  let renewal: Promise<void> | null = null;
  const renew = () => {
    if (leaseLost || renewal) return;
    renewal = options.store.renewAssistantRunLease(data.runId, claim.token, leaseMs)
      .then(renewed => {
        if (!renewed) {
          leaseLost = true;
          controller.abort(new Error('Assistant run PostgreSQL generation lease was lost'));
        }
      })
      .catch(error => {
        leaseLost = true;
        controller.abort(error);
      })
      .finally(() => {
        renewal = null;
      });
  };
  const timer = setInterval(renew, renewalMs);
  timer.unref?.();

  try {
    await options.execute(claim, {
      signal: controller.signal,
      maxAttempts: options.maxAttempts ?? 10,
    });
    if (renewal) await renewal;
    return 'executed';
  } catch (error) {
    if (!leaseLost) {
      const released = await options.store.releaseAssistantRunClaim(
        data.runId,
        claim.token,
        error instanceof Error ? error.message : String(error),
        0,
      );
      if (!released) {
        options.logger.warn('BullMQ worker could not release its PostgreSQL assistant run claim', {
          runId: data.runId,
          generation: claim.token.generation,
          workerId: options.workerId,
        });
      }
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
};
