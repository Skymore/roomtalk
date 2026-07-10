import dotenv from 'dotenv';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresClient, PostgresPool } from '../repositories/postgresStore';
import { calculateAICost, createAIModelRegistry, getMessageAIModel } from '../services/aiModels';
import { AIModelOption, AIUsage, Message } from '../types';

dotenv.config();

const BACKFILL_EVENT = 'code_agent.misrouted_coco_model_steps.applied';
const BACKFILL_VERSION = 'v1';
const COST_EPSILON_USD = 0.000001;

export interface MisroutedCocoTurnIdentityRow {
  turn_id: string;
  provider: string;
  model: string;
}

export interface MisroutedCocoMessageRow {
  turn_id: string;
  message_id: string;
  message_type: 'ai' | 'tool_call';
  position: string | number;
  tool_call_id: string | null;
  existing_cost: unknown;
}

export interface MisroutedCocoSettlementRow {
  turn_id: string;
  event_id: string;
  created_at: string | Date;
  cost_usd: string | number;
  prompt_tokens: string | number;
  completion_tokens: string | number;
  cached_prompt_tokens: string | number;
}

export interface MisroutedCocoToolEventRow {
  turn_id: string;
  event_id: string;
  created_at: string | Date;
  tool_call_id: string;
}

export interface MisroutedCocoModelStepPlanItem {
  turnId: string;
  messageId: string;
  messageType: 'ai' | 'tool_call';
  modelStepId: string;
  modelStepSequence: number;
  aiModel?: NonNullable<Message['aiModel']>;
  usage?: AIUsage;
  cost?: NonNullable<Message['cost']>;
  isCostAnchor: boolean;
}

export interface MisroutedCocoModelStepPlan {
  affectedTurns: number;
  turnsToUpdate: number;
  turnsWithoutMessages: number;
  messagesToUpdate: number;
  costAnchors: number;
  aiCostAnchors: number;
  toolCostAnchors: number;
  settlementsAssigned: number;
  settlementsWithoutMessages: number;
  totalCostUsd: number;
  distributedCostUsd: number;
  items: MisroutedCocoModelStepPlanItem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const numberFrom = (value: unknown, field: string) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
  return parsed;
};

const timestampMs = (value: string | Date, field: string) => {
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${String(value)}`);
  return parsed;
};

const existingCostUsd = (value: unknown) => {
  if (value === null || value === undefined) return 0;
  if (!isRecord(value)) throw new Error('Invalid existing message cost metadata');
  return numberFrom(value.totalUsd, 'existing message cost');
};

const usageFromSettlement = (row: MisroutedCocoSettlementRow): AIUsage => {
  const promptTokens = numberFrom(row.prompt_tokens, 'prompt tokens');
  const completionTokens = numberFrom(row.completion_tokens, 'completion tokens');
  const cachedPromptTokens = numberFrom(row.cached_prompt_tokens, 'cached prompt tokens');
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens,
    cacheHitRate: promptTokens > 0 ? Math.min(cachedPromptTokens, promptTokens) / promptTokens : 0,
    source: 'reported',
  };
};

const groupToolEventsByNearestSettlement = (
  settlements: MisroutedCocoSettlementRow[],
  toolEvents: MisroutedCocoToolEventRow[]
) => {
  const groups = settlements.map(() => [] as MisroutedCocoToolEventRow[]);
  let previousSettlementIndex = -1;
  for (const toolEvent of toolEvents) {
    const eventAt = timestampMs(toolEvent.created_at, 'tool event timestamp');
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let tied = false;
    settlements.forEach((settlement, index) => {
      const distance = Math.abs(eventAt - timestampMs(settlement.created_at, 'settlement timestamp'));
      if (distance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = distance;
        tied = false;
      } else if (distance === nearestDistance) {
        tied = true;
      }
    });
    if (nearestIndex < 0 || tied) {
      throw new Error(`Unable to uniquely match historical tool event ${toolEvent.event_id}`);
    }
    if (nearestIndex < previousSettlementIndex) {
      throw new Error(`Historical tool events map to non-monotonic model steps at ${toolEvent.event_id}`);
    }
    previousSettlementIndex = nearestIndex;
    groups[nearestIndex].push(toolEvent);
  }
  return groups;
};

export const buildMisroutedCocoModelStepPlan = (
  turns: MisroutedCocoTurnIdentityRow[],
  messageRows: MisroutedCocoMessageRow[],
  settlementRows: MisroutedCocoSettlementRow[],
  toolEventRows: MisroutedCocoToolEventRow[],
  modelOptions: AIModelOption[] = createAIModelRegistry().modelOptions
): MisroutedCocoModelStepPlan => {
  const turnById = new Map<string, MisroutedCocoTurnIdentityRow>();
  for (const turn of turns) {
    const previous = turnById.get(turn.turn_id);
    if (previous && (previous.provider !== turn.provider || previous.model !== turn.model)) {
      throw new Error(`Conflicting historical models for turn ${turn.turn_id}`);
    }
    turnById.set(turn.turn_id, turn);
  }

  const messagesByTurn = new Map<string, MisroutedCocoMessageRow[]>();
  for (const message of messageRows) {
    if (!turnById.has(message.turn_id)) throw new Error(`Unknown message turn: ${message.turn_id}`);
    const grouped = messagesByTurn.get(message.turn_id) || [];
    grouped.push(message);
    messagesByTurn.set(message.turn_id, grouped);
  }
  const settlementsByTurn = new Map<string, MisroutedCocoSettlementRow[]>();
  for (const settlement of settlementRows) {
    if (!turnById.has(settlement.turn_id)) throw new Error(`Unknown settlement turn: ${settlement.turn_id}`);
    const grouped = settlementsByTurn.get(settlement.turn_id) || [];
    grouped.push(settlement);
    settlementsByTurn.set(settlement.turn_id, grouped);
  }
  const toolEventsByTurn = new Map<string, MisroutedCocoToolEventRow[]>();
  for (const toolEvent of toolEventRows) {
    if (!turnById.has(toolEvent.turn_id)) throw new Error(`Unknown tool event turn: ${toolEvent.turn_id}`);
    const grouped = toolEventsByTurn.get(toolEvent.turn_id) || [];
    grouped.push(toolEvent);
    toolEventsByTurn.set(toolEvent.turn_id, grouped);
  }

  const items: MisroutedCocoModelStepPlanItem[] = [];
  let turnsWithoutMessages = 0;
  let settlementsWithoutMessages = 0;
  let totalCostUsd = 0;

  for (const turn of turnById.values()) {
    const model = modelOptions.find(option => option.id === turn.model && option.provider === turn.provider);
    if (!model) throw new Error(`Unknown historical model for turn ${turn.turn_id}: ${turn.provider}:${turn.model}`);
    const aiModel = getMessageAIModel(model);
    if (!aiModel) throw new Error(`Unable to build message model metadata for turn ${turn.turn_id}`);

    const messages = [...(messagesByTurn.get(turn.turn_id) || [])].sort(
      (left, right) => numberFrom(left.position, 'message position') - numberFrom(right.position, 'message position')
    );
    const settlements = [...(settlementsByTurn.get(turn.turn_id) || [])].sort((left, right) => (
      timestampMs(left.created_at, 'settlement timestamp') - timestampMs(right.created_at, 'settlement timestamp') ||
      left.event_id.localeCompare(right.event_id)
    ));
    const toolEvents = [...(toolEventsByTurn.get(turn.turn_id) || [])].sort((left, right) => (
      timestampMs(left.created_at, 'tool event timestamp') - timestampMs(right.created_at, 'tool event timestamp') ||
      left.event_id.localeCompare(right.event_id)
    ));
    if (!settlements.length) throw new Error(`Turn ${turn.turn_id} has no provider settlements`);
    const turnCostUsd = settlements.reduce((total, settlement) => total + numberFrom(settlement.cost_usd, 'settlement cost'), 0);
    totalCostUsd += turnCostUsd;

    if (!messages.length) {
      turnsWithoutMessages += 1;
      settlementsWithoutMessages += settlements.length;
      continue;
    }
    const currentMessageCostUsd = messages.reduce((total, message) => total + existingCostUsd(message.existing_cost), 0);
    if (Math.abs(currentMessageCostUsd - turnCostUsd) > COST_EPSILON_USD) {
      throw new Error(`Existing message cost mismatch for turn ${turn.turn_id}: messages ${currentMessageCostUsd}, settlements ${turnCostUsd}`);
    }

    const toolMessageByCallId = new Map(
      messages.filter(message => message.message_type === 'tool_call' && message.tool_call_id)
        .map(message => [message.tool_call_id!, message])
    );
    const aiMessages = messages.filter(message => message.message_type === 'ai');
    const groupedToolEvents = groupToolEventsByNearestSettlement(settlements, toolEvents);
    const usedMessageIds = new Set<string>();
    let previousLastToolPosition = -1;

    settlements.forEach((settlement, index) => {
      const sequence = index + 1;
      const modelStepId = `${turn.turn_id}:historical:${sequence}`;
      const stepToolMessages = groupedToolEvents[index].map(toolEvent => {
        const message = toolMessageByCallId.get(toolEvent.tool_call_id);
        if (!message) throw new Error(`Historical tool message is missing for ${toolEvent.tool_call_id} in turn ${turn.turn_id}`);
        return message;
      });
      const firstToolPosition = stepToolMessages.length
        ? Math.min(...stepToolMessages.map(message => numberFrom(message.position, 'tool position')))
        : Number.POSITIVE_INFINITY;
      const textCandidates = aiMessages.filter(message => {
        const position = numberFrom(message.position, 'AI message position');
        return !usedMessageIds.has(message.message_id) && position > previousLastToolPosition && position < firstToolPosition;
      });
      if (textCandidates.length > 1) {
        throw new Error(`Historical model step ${modelStepId} has ${textCandidates.length} possible AI message anchors`);
      }
      const anchor = textCandidates[0] || stepToolMessages[0];
      if (!anchor) {
        throw new Error(`Historical model step has no message anchor: ${modelStepId}`);
      }

      const usage = usageFromSettlement(settlement);
      const calculatedCost = calculateAICost(model, usage);
      if (!calculatedCost) throw new Error(`Coco model pricing is unavailable: ${model.id}`);
      const settledCostUsd = numberFrom(settlement.cost_usd, 'settlement cost');
      if (Math.abs(calculatedCost.totalUsd - settledCostUsd) > COST_EPSILON_USD) {
        throw new Error(`Historical model-step cost mismatch for ${modelStepId}: calculated ${calculatedCost.totalUsd}, settled ${settledCostUsd}`);
      }
      const cost = { ...calculatedCost, totalUsd: settledCostUsd };

      if (textCandidates[0]) {
        const message = textCandidates[0];
        usedMessageIds.add(message.message_id);
        items.push({
          turnId: turn.turn_id,
          messageId: message.message_id,
          messageType: 'ai',
          modelStepId,
          modelStepSequence: sequence,
          aiModel,
          usage,
          cost,
          isCostAnchor: true,
        });
      }
      stepToolMessages.forEach((message, toolIndex) => {
        if (usedMessageIds.has(message.message_id)) throw new Error(`Historical message belongs to multiple model steps: ${message.message_id}`);
        usedMessageIds.add(message.message_id);
        const isCostAnchor = !textCandidates[0] && toolIndex === 0;
        items.push({
          turnId: turn.turn_id,
          messageId: message.message_id,
          messageType: 'tool_call',
          modelStepId,
          modelStepSequence: sequence,
          aiModel: isCostAnchor ? aiModel : undefined,
          usage: isCostAnchor ? usage : undefined,
          cost: isCostAnchor ? cost : undefined,
          isCostAnchor,
        });
      });
      if (stepToolMessages.length) {
        previousLastToolPosition = Math.max(
          ...stepToolMessages.map(message => numberFrom(message.position, 'tool position'))
        );
      }
    });

    const unmapped = messages.filter(message => !usedMessageIds.has(message.message_id));
    if (unmapped.length) {
      throw new Error(`Historical messages have no model-step match in turn ${turn.turn_id}: ${unmapped.map(message => message.message_id).join(', ')}`);
    }
  }

  const anchorItems = items.filter(item => item.isCostAnchor);
  return {
    affectedTurns: turnById.size,
    turnsToUpdate: new Set(items.map(item => item.turnId)).size,
    turnsWithoutMessages,
    messagesToUpdate: items.length,
    costAnchors: anchorItems.length,
    aiCostAnchors: anchorItems.filter(item => item.messageType === 'ai').length,
    toolCostAnchors: anchorItems.filter(item => item.messageType === 'tool_call').length,
    settlementsAssigned: anchorItems.length,
    settlementsWithoutMessages,
    totalCostUsd,
    distributedCostUsd: anchorItems.reduce((total, item) => total + (item.cost?.totalUsd || 0), 0),
    items,
  };
};

const AFFECTED_TURNS_CTE = `
WITH affected AS (
  SELECT DISTINCT started.turn_id, started.provider, started.model
  FROM observability_events started
  WHERE started.room_id = $1
    AND started.event = 'code_agent.turn.started'
    AND started.payload->>'backend' = 'codex-app-server'
    AND EXISTS (
      SELECT 1 FROM observability_events dispatched
      WHERE dispatched.turn_id = started.turn_id
        AND dispatched.event = 'code_agent.runner.status'
        AND dispatched.payload->>'message' = 'sandbox daemon dispatching code-agent'
    )
)`;

const LOAD_TURNS_SQL = `${AFFECTED_TURNS_CTE}
SELECT turn_id, provider, model FROM affected ORDER BY turn_id`;

const LOAD_MESSAGES_SQL = `${AFFECTED_TURNS_CTE}
SELECT message.turn_id, message.id AS message_id, message.message_type, message.position,
  message.tool_call_id, message.cost AS existing_cost
FROM affected
JOIN room_messages message ON message.room_id = $1 AND message.turn_id = affected.turn_id
WHERE message.message_type IN ('ai', 'tool_call')
ORDER BY message.turn_id, message.position`;

const LOAD_SETTLEMENTS_SQL = `${AFFECTED_TURNS_CTE}
SELECT event.turn_id, event.id AS event_id, event.created_at, event.cost_usd,
  (event.payload->>'promptTokens')::bigint AS prompt_tokens,
  (event.payload->>'completionTokens')::bigint AS completion_tokens,
  COALESCE((event.payload->>'cachedPromptTokens')::bigint, 0) AS cached_prompt_tokens
FROM observability_events event
JOIN affected ON affected.turn_id = event.turn_id
WHERE event.event = 'code_agent.model_gateway.settled'
ORDER BY event.turn_id, event.created_at, event.id`;

const LOAD_TOOL_EVENTS_SQL = `${AFFECTED_TURNS_CTE}
SELECT event.turn_id, event.id AS event_id, event.created_at,
  event.payload->>'toolCallId' AS tool_call_id
FROM observability_events event
JOIN affected ON affected.turn_id = event.turn_id
WHERE event.event = 'code_agent.runner.tool_call'
ORDER BY event.turn_id, event.created_at, event.id`;

export interface BackfillMisroutedCocoModelStepsResult {
  roomId: string;
  dryRun: boolean;
  alreadyApplied: boolean;
  roomCostUsd: number;
  plan: MisroutedCocoModelStepPlan;
}

const markerIdForRoom = (roomId: string) => `misrouted_coco_model_steps_${roomId}_${BACKFILL_VERSION}`;
const rollbackQuietly = async (client: PostgresClient) => client.query('ROLLBACK').catch(() => {});
const emptyPlan = (): MisroutedCocoModelStepPlan => ({
  affectedTurns: 0,
  turnsToUpdate: 0,
  turnsWithoutMessages: 0,
  messagesToUpdate: 0,
  costAnchors: 0,
  aiCostAnchors: 0,
  toolCostAnchors: 0,
  settlementsAssigned: 0,
  settlementsWithoutMessages: 0,
  totalCostUsd: 0,
  distributedCostUsd: 0,
  items: [],
});

export const backfillMisroutedCocoModelSteps = async (
  pool: PostgresPool,
  roomId: string,
  execute: boolean
): Promise<BackfillMisroutedCocoModelStepsResult> => {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const markerId = markerIdForRoom(roomId);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [markerId]);
    const marker = await client.query('SELECT 1 FROM observability_events WHERE id = $1', [markerId]);
    const currentCost = await client.query<{ total_usd: string | number }>(
      'SELECT total_usd FROM room_ai_cost_totals WHERE room_id = $1', [roomId]
    );
    const roomCostUsd = numberFrom(currentCost.rows[0]?.total_usd || 0, 'room cost');
    if (marker.rows.length > 0) {
      await rollbackQuietly(client);
      transactionOpen = false;
      return { roomId, dryRun: !execute, alreadyApplied: true, roomCostUsd, plan: emptyPlan() };
    }
    const room = await client.query('SELECT 1 FROM rooms WHERE id = $1', [roomId]);
    if (!room.rowCount) throw new Error(`Room not found: ${roomId}`);

    const turns = await client.query<MisroutedCocoTurnIdentityRow>(LOAD_TURNS_SQL, [roomId]);
    const messages = await client.query<MisroutedCocoMessageRow>(LOAD_MESSAGES_SQL, [roomId]);
    const settlements = await client.query<MisroutedCocoSettlementRow>(LOAD_SETTLEMENTS_SQL, [roomId]);
    const toolEvents = await client.query<MisroutedCocoToolEventRow>(LOAD_TOOL_EVENTS_SQL, [roomId]);
    const plan = buildMisroutedCocoModelStepPlan(turns.rows, messages.rows, settlements.rows, toolEvents.rows);

    if (!execute) {
      await rollbackQuietly(client);
      transactionOpen = false;
      return { roomId, dryRun: true, alreadyApplied: false, roomCostUsd, plan };
    }

    for (const item of plan.items) {
      const update = await client.query(
        `UPDATE room_messages SET
          model_step_id = $2,
          model_step_sequence = $3,
          ai_model = $4::jsonb,
          usage = $5::jsonb,
          cost = $6::jsonb,
          updated_at = NOW()
        WHERE id = $1 AND room_id = $7 AND turn_id = $8 AND message_type = $9`,
        [
          item.messageId,
          item.modelStepId,
          item.modelStepSequence,
          item.aiModel ? JSON.stringify(item.aiModel) : null,
          item.usage ? JSON.stringify(item.usage) : null,
          item.cost ? JSON.stringify(item.cost) : null,
          roomId,
          item.turnId,
          item.messageType,
        ]
      );
      if (update.rowCount !== 1) throw new Error(`Unable to update model-step message ${item.messageId}`);
    }
    if (plan.messagesToUpdate > 0) {
      await client.query(
        `UPDATE rooms SET message_version = message_version + 1,
          room_version = room_version + 1, updated_at = NOW() WHERE id = $1`,
        [roomId]
      );
    }
    await client.query(
      `INSERT INTO observability_events (id, created_at, level, event, room_id, payload)
      VALUES ($1, NOW(), 'info', $2, $3, $4::jsonb)`,
      [markerId, BACKFILL_EVENT, roomId, JSON.stringify({
        version: BACKFILL_VERSION,
        affectedTurns: plan.affectedTurns,
        turnsUpdated: plan.turnsToUpdate,
        turnsWithoutMessages: plan.turnsWithoutMessages,
        messagesUpdated: plan.messagesToUpdate,
        costAnchors: plan.costAnchors,
        aiCostAnchors: plan.aiCostAnchors,
        toolCostAnchors: plan.toolCostAnchors,
        settlementsAssigned: plan.settlementsAssigned,
        settlementsWithoutMessages: plan.settlementsWithoutMessages,
        distributedCostUsd: plan.distributedCostUsd,
        roomCostUsd,
      })]
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return { roomId, dryRun: false, alreadyApplied: false, roomCostUsd, plan };
  } catch (error) {
    if (transactionOpen) await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
};

const parseCli = (args: string[]) => {
  const roomIndex = args.indexOf('--room');
  const roomId = roomIndex >= 0 ? args[roomIndex + 1]?.trim() : '';
  if (!roomId) throw new Error('Usage: npm run backfill:misrouted-coco-model-steps -- --room <roomId> [--execute]');
  return { roomId, execute: args.includes('--execute') };
};

const main = async () => {
  const { roomId, execute } = parseCli(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const logger = new Logger('MisroutedCocoModelStepBackfill');
  const pool = createPostgresPool(databaseUrl, logger);
  try {
    console.log(JSON.stringify(await backfillMisroutedCocoModelSteps(pool, roomId, execute), null, 2));
  } finally {
    await pool.end?.();
  }
};

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
