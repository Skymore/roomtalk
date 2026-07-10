import { AICost, AIModelOption, AIUsage } from '../types';
import { calculateAICost } from './aiModels';
import { CodeAgentRunnerModelStepEvent } from './codeAgentRunnerProtocol';

export interface CocoModelStepCostRecord {
  stepId: string;
  sequence: number;
  usage: AIUsage;
  cost: AICost;
  anchorMessageId?: string;
}

export interface CocoModelStepCostSummary {
  usage: AIUsage;
  cost: AICost;
  stepCount: number;
}

const finiteNonNegative = (value: unknown, field: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
  return parsed;
};

export const mergeReportedUsage = (usages: AIUsage[]): AIUsage => {
  if (!usages.length || usages.some(usage => usage.source !== 'reported')) {
    throw new Error('Coco model-step accounting requires provider-reported usage');
  }
  const promptTokens = usages.reduce((total, usage) => total + finiteNonNegative(usage.promptTokens, 'prompt tokens'), 0);
  const completionTokens = usages.reduce((total, usage) => total + finiteNonNegative(usage.completionTokens, 'completion tokens'), 0);
  const cachedPromptTokens = usages.reduce(
    (total, usage) => total + finiteNonNegative(usage.cachedPromptTokens || 0, 'cached prompt tokens'),
    0
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens,
    cacheHitRate: promptTokens > 0 ? Math.min(cachedPromptTokens, promptTokens) / promptTokens : 0,
    source: 'reported',
  };
};

export const assertSameReportedUsage = (left: AIUsage, right: AIUsage) => {
  const fields: Array<keyof Pick<AIUsage, 'promptTokens' | 'completionTokens' | 'totalTokens' | 'cachedPromptTokens'>> = [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'cachedPromptTokens',
  ];
  for (const field of fields) {
    if (Number(left[field] || 0) !== Number(right[field] || 0)) {
      throw new Error(`Coco provider usage mismatch for ${field}: runner ${left[field] || 0}, steps ${right[field] || 0}`);
    }
  }
};

export const buildCocoModelStepCost = (
  event: CodeAgentRunnerModelStepEvent,
  model: AIModelOption
): CocoModelStepCostRecord => {
  if (event.usage.source !== 'reported') {
    throw new Error(`Coco model step ${event.stepId} did not report provider usage`);
  }
  const cost = calculateAICost(model, event.usage);
  if (!cost) {
    throw new Error(`Coco model pricing is unavailable: ${model.id}`);
  }
  return {
    stepId: event.stepId,
    sequence: event.sequence,
    usage: event.usage,
    cost,
  };
};

export const summarizeCocoModelStepCosts = (
  records: CocoModelStepCostRecord[],
  runnerUsage: AIUsage
): CocoModelStepCostSummary => {
  if (!records.length) {
    throw new Error('Coco runner completed without model-step accounting');
  }
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
  const stepIds = new Set<string>();
  for (const [index, record] of ordered.entries()) {
    if (record.sequence !== index + 1) {
      throw new Error(`Coco model-step sequence is not contiguous at ${record.stepId}`);
    }
    if (stepIds.has(record.stepId)) {
      throw new Error(`Duplicate Coco model step: ${record.stepId}`);
    }
    if (!record.anchorMessageId) {
      throw new Error(`Coco model step has no billable message anchor: ${record.stepId}`);
    }
    stepIds.add(record.stepId);
  }

  const usage = mergeReportedUsage(ordered.map(record => record.usage));
  assertSameReportedUsage(runnerUsage, usage);
  const firstCost = ordered[0].cost;
  for (const record of ordered.slice(1)) {
    if (
      record.cost.currency !== firstCost.currency ||
      record.cost.inputPerMillion !== firstCost.inputPerMillion ||
      record.cost.outputPerMillion !== firstCost.outputPerMillion ||
      record.cost.cachedInputPerMillion !== firstCost.cachedInputPerMillion
    ) {
      throw new Error(`Coco model-step pricing changed within one turn at ${record.stepId}`);
    }
  }
  const cost: AICost = {
    ...firstCost,
    inputUsd: ordered.reduce((total, record) => total + finiteNonNegative(record.cost.inputUsd, 'step input cost'), 0),
    outputUsd: ordered.reduce((total, record) => total + finiteNonNegative(record.cost.outputUsd, 'step output cost'), 0),
    totalUsd: ordered.reduce((total, record) => total + finiteNonNegative(record.cost.totalUsd, 'step total cost'), 0),
    estimated: false,
  };
  return { usage, cost, stepCount: ordered.length };
};
