import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AIModelOption } from '../types';
import {
  buildMisroutedCocoModelStepPlan,
  MisroutedCocoMessageRow,
  MisroutedCocoSettlementRow,
  MisroutedCocoToolEventRow,
} from './backfillMisroutedCocoModelSteps';

const model: AIModelOption = {
  id: 'historical-model',
  apiModel: 'provider/historical-model',
  provider: 'openrouter',
  label: 'Historical',
  description: 'Historical',
  pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 },
};
const turns = [{ turn_id: 'turn-1', provider: 'openrouter', model: 'historical-model' }];
const settlement = (index: number, promptTokens: number, completionTokens: number): MisroutedCocoSettlementRow => ({
  turn_id: 'turn-1',
  event_id: `settlement-${index}`,
  created_at: `2026-07-09T00:00:0${index}.000Z`,
  cost_usd: promptTokens / 1_000_000 + completionTokens * 2 / 1_000_000,
  prompt_tokens: promptTokens,
  completion_tokens: completionTokens,
  cached_prompt_tokens: 0,
});
const toolEvent = (id: string, at: string): MisroutedCocoToolEventRow => ({
  turn_id: 'turn-1', event_id: `event-${id}`, created_at: at, tool_call_id: id,
});

describe('misrouted Coco model-step backfill', () => {
  it('anchors text hops on AI messages and tool-only hops on the first tool card', () => {
    const settlements = [settlement(1, 100, 10), settlement(2, 200, 20), settlement(3, 300, 30)];
    const totalCost = settlements.reduce((total, row) => total + Number(row.cost_usd), 0);
    const messages: MisroutedCocoMessageRow[] = [
      { turn_id: 'turn-1', message_id: 'ai-1', message_type: 'ai', position: 1, tool_call_id: null, existing_cost: null },
      { turn_id: 'turn-1', message_id: 'tool-1', message_type: 'tool_call', position: 2, tool_call_id: 'tool-1', existing_cost: null },
      { turn_id: 'turn-1', message_id: 'tool-2', message_type: 'tool_call', position: 4, tool_call_id: 'tool-2', existing_cost: null },
      { turn_id: 'turn-1', message_id: 'tool-3', message_type: 'tool_call', position: 5, tool_call_id: 'tool-3', existing_cost: null },
      { turn_id: 'turn-1', message_id: 'ai-3', message_type: 'ai', position: 7, tool_call_id: null, existing_cost: { totalUsd: totalCost } },
    ];
    const plan = buildMisroutedCocoModelStepPlan(turns, messages, settlements, [
      toolEvent('tool-1', '2026-07-09T00:00:01.050Z'),
      toolEvent('tool-2', '2026-07-09T00:00:01.990Z'),
      toolEvent('tool-3', '2026-07-09T00:00:02.020Z'),
    ], [model]);

    assert.equal(plan.costAnchors, 3);
    assert.equal(plan.aiCostAnchors, 2);
    assert.equal(plan.toolCostAnchors, 1);
    assert.equal(plan.messagesToUpdate, 5);
    assert.deepEqual(plan.items.filter(item => item.isCostAnchor).map(item => item.messageId), ['ai-1', 'tool-2', 'ai-3']);
    assert.equal(plan.items.find(item => item.messageId === 'tool-3')?.cost, undefined);
    assert.equal(plan.items.find(item => item.messageId === 'tool-3')?.modelStepId, 'turn-1:historical:2');
  });

  it('keeps a final tool-only hop billable', () => {
    const settlements = [settlement(1, 100, 10), settlement(2, 200, 20)];
    const totalCost = settlements.reduce((total, row) => total + Number(row.cost_usd), 0);
    const messages: MisroutedCocoMessageRow[] = [
      { turn_id: 'turn-1', message_id: 'ai-1', message_type: 'ai', position: 1, tool_call_id: null, existing_cost: { totalUsd: totalCost } },
      { turn_id: 'turn-1', message_id: 'tool-1', message_type: 'tool_call', position: 2, tool_call_id: 'tool-1', existing_cost: null },
      { turn_id: 'turn-1', message_id: 'tool-2', message_type: 'tool_call', position: 4, tool_call_id: 'tool-2', existing_cost: null },
    ];
    const plan = buildMisroutedCocoModelStepPlan(turns, messages, settlements, [
      toolEvent('tool-1', '2026-07-09T00:00:01.050Z'),
      toolEvent('tool-2', '2026-07-09T00:00:02.050Z'),
    ], [model]);

    const finalAnchor = plan.items.find(item => item.modelStepSequence === 2 && item.isCostAnchor);
    assert.equal(finalAnchor?.messageId, 'tool-2');
    assert.equal(finalAnchor?.messageType, 'tool_call');
    assert.ok((finalAnchor?.cost?.totalUsd || 0) > 0);
  });

  it('counts fully deleted turns without inventing message anchors', () => {
    const row = settlement(1, 100, 10);
    const plan = buildMisroutedCocoModelStepPlan(turns, [], [row], [], [model]);
    assert.equal(plan.turnsWithoutMessages, 1);
    assert.equal(plan.settlementsWithoutMessages, 1);
    assert.equal(plan.items.length, 0);
  });
});
