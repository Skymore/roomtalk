import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AIModelOption } from '../types';
import {
  buildCocoModelStepCost,
  summarizeCocoModelStepCosts,
} from './codeAgentModelStepCosts';

const model: AIModelOption = {
  id: 'test-model',
  apiModel: 'provider/test-model',
  provider: 'openrouter',
  label: 'Test',
  description: 'Test',
  pricing: {
    currency: 'USD',
    inputPerMillion: 1,
    outputPerMillion: 2,
    cachedInputPerMillion: 0.5,
  },
};

const event = (sequence: number, promptTokens: number, completionTokens: number) => ({
  schemaVersion: 1 as const,
  type: 'model_step' as const,
  turnId: 'turn-1',
  stepId: `turn-1:step:${sequence}`,
  sequence,
  hasText: sequence === 2,
  toolCallIds: sequence === 1 ? ['tool-1'] : [],
  usage: {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens: 0,
    source: 'reported' as const,
  },
});

describe('Coco model-step costs', () => {
  it('sums independently priced steps and verifies aggregate runner usage', () => {
    const first = { ...buildCocoModelStepCost(event(1, 100, 10), model), anchorMessageId: 'tool-1' };
    const second = { ...buildCocoModelStepCost(event(2, 200, 20), model), anchorMessageId: 'ai-2' };

    const summary = summarizeCocoModelStepCosts([second, first], {
      promptTokens: 300,
      completionTokens: 30,
      totalTokens: 330,
      cachedPromptTokens: 0,
      source: 'reported',
    });

    assert.equal(summary.stepCount, 2);
    assert.equal(summary.usage.promptTokens, 300);
    assert.equal(summary.cost.totalUsd, first.cost.totalUsd + second.cost.totalUsd);
    assert.equal(summary.cost.estimated, false);
  });

  it('rejects unanchored steps and aggregate usage mismatches', () => {
    const first = buildCocoModelStepCost(event(1, 100, 10), model);
    const runnerUsage = {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      source: 'reported' as const,
    };
    assert.throws(() => summarizeCocoModelStepCosts([first], runnerUsage), /no billable message anchor/);
    assert.throws(() => summarizeCocoModelStepCosts([
      { ...first, anchorMessageId: 'tool-1' },
    ], { ...runnerUsage, promptTokens: 101, totalTokens: 111 }), /provider usage mismatch/);
  });
});
