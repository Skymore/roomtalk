import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMisroutedCocoCostPlan, MisroutedCocoTurnRow } from './backfillMisroutedCocoCosts';

describe('buildMisroutedCocoCostPlan', () => {
  it('builds per-turn message costs and includes turns whose messages were deleted', () => {
    const rows: MisroutedCocoTurnRow[] = [
      {
        turn_id: 'turn-glm',
        provider: 'openrouter',
        model: 'glm-5.2',
        settled_cost_usd: 0.000153,
        prompt_tokens: 100,
        completion_tokens: 20,
        cached_prompt_tokens: 0,
        request_count: 1,
        cost_count: 1,
        usage_count: 1,
        final_message_id: 'message-glm',
        existing_cost: null,
      },
      {
        turn_id: 'turn-deleted',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        settled_cost_usd: 0.0000609,
        prompt_tokens: 100,
        completion_tokens: 20,
        cached_prompt_tokens: 0,
        request_count: 1,
        cost_count: 1,
        usage_count: 1,
        final_message_id: null,
        existing_cost: null,
      },
    ];

    const plan = buildMisroutedCocoCostPlan(rows);

    assert.equal(plan.affectedTurns, 2);
    assert.equal(plan.messagesToUpdate, 1);
    assert.equal(plan.turnsWithoutMessages, 1);
    assert.equal(plan.totalCostUsd, 0.0002139);
    assert.equal(plan.items[0].aiModel.id, 'glm-5.2');
    assert.equal(plan.items[0].cost.estimated, false);
  });

  it('refuses to double-apply message cost metadata', () => {
    assert.throws(() => buildMisroutedCocoCostPlan([{
      turn_id: 'turn-1',
      provider: 'openrouter',
      model: 'glm-5.2',
      settled_cost_usd: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_prompt_tokens: 0,
      request_count: 1,
      cost_count: 1,
      usage_count: 1,
      final_message_id: 'message-1',
      existing_cost: { totalUsd: 1 },
    }]), /already has message cost metadata/);
  });

  it('refuses incomplete provider telemetry', () => {
    assert.throws(() => buildMisroutedCocoCostPlan([{
      turn_id: 'turn-1',
      provider: 'openrouter',
      model: 'glm-5.2',
      settled_cost_usd: 0.000153,
      prompt_tokens: 100,
      completion_tokens: 20,
      cached_prompt_tokens: 0,
      request_count: 2,
      cost_count: 1,
      usage_count: 2,
      final_message_id: 'message-1',
      existing_cost: null,
    }]), /Incomplete provider telemetry/);
  });
});
