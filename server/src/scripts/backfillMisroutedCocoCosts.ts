import dotenv from 'dotenv';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresClient, PostgresPool } from '../repositories/postgresStore';
import { calculateAICost, createAIModelRegistry, getMessageAIModel } from '../services/aiModels';
import { AICost, AIModelOption, AIUsage, Message } from '../types';

dotenv.config();

const BACKFILL_EVENT = 'code_agent.misrouted_coco_cost_backfill.applied';
const BACKFILL_VERSION = 'v1';

export interface MisroutedCocoTurnRow {
  turn_id: string;
  provider: string;
  model: string;
  settled_cost_usd: string | number;
  prompt_tokens: string | number;
  completion_tokens: string | number;
  cached_prompt_tokens: string | number;
  request_count: string | number;
  cost_count: string | number;
  usage_count: string | number;
  final_message_id: string | null;
  existing_cost: unknown;
}

export interface MisroutedCocoCostPlanItem {
  turnId: string;
  finalMessageId: string | null;
  aiModel: NonNullable<Message['aiModel']>;
  usage: AIUsage;
  cost: AICost;
}

export interface MisroutedCocoCostPlan {
  affectedTurns: number;
  messagesToUpdate: number;
  turnsWithoutMessages: number;
  totalCostUsd: number;
  items: MisroutedCocoCostPlanItem[];
}

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

export const buildMisroutedCocoCostPlan = (
  rows: MisroutedCocoTurnRow[],
  modelOptions: AIModelOption[] = createAIModelRegistry().modelOptions
): MisroutedCocoCostPlan => {
  const items = rows.map(row => {
    if (row.existing_cost !== null && row.existing_cost !== undefined) {
      throw new Error(`Turn ${row.turn_id} already has message cost metadata`);
    }
    const model = modelOptions.find(option => option.id === row.model && option.provider === row.provider);
    if (!model) {
      throw new Error(`Unknown historical model for turn ${row.turn_id}: ${row.provider}:${row.model}`);
    }
    const requestCount = numberFrom(row.request_count, 'request count');
    const costCount = numberFrom(row.cost_count, 'cost count');
    const usageCount = numberFrom(row.usage_count, 'usage count');
    if (requestCount < 1 || costCount !== requestCount || usageCount !== requestCount) {
      throw new Error(
        `Incomplete provider telemetry for turn ${row.turn_id}: ${requestCount} requests, ${costCount} costs, ${usageCount} usage records`
      );
    }
    const usage: AIUsage = {
      promptTokens: numberFrom(row.prompt_tokens, 'prompt tokens'),
      completionTokens: numberFrom(row.completion_tokens, 'completion tokens'),
      totalTokens: numberFrom(row.prompt_tokens, 'prompt tokens') + numberFrom(row.completion_tokens, 'completion tokens'),
      cachedPromptTokens: numberFrom(row.cached_prompt_tokens, 'cached prompt tokens'),
      source: 'reported',
    };
    usage.cacheHitRate = usage.promptTokens > 0
      ? Math.min(usage.cachedPromptTokens || 0, usage.promptTokens) / usage.promptTokens
      : 0;
    const calculatedCost = calculateAICost(model, usage);
    if (!calculatedCost) {
      throw new Error(`Historical model has no pricing for turn ${row.turn_id}: ${row.provider}:${row.model}`);
    }
    const settledCostUsd = numberFrom(row.settled_cost_usd, 'settled cost');
    if (Math.abs(calculatedCost.totalUsd - settledCostUsd) > 0.000001) {
      throw new Error(
        `Historical cost mismatch for turn ${row.turn_id}: calculated ${calculatedCost.totalUsd}, settled ${settledCostUsd}`
      );
    }
    return {
      turnId: row.turn_id,
      finalMessageId: row.final_message_id,
      aiModel: getMessageAIModel(model)!,
      usage,
      cost: { ...calculatedCost, totalUsd: settledCostUsd },
    };
  });

  return {
    affectedTurns: items.length,
    messagesToUpdate: items.filter(item => item.finalMessageId).length,
    turnsWithoutMessages: items.filter(item => !item.finalMessageId).length,
    totalCostUsd: items.reduce((total, item) => total + item.cost.totalUsd, 0),
    items,
  };
};

const LOAD_TURNS_SQL = `
WITH affected AS (
  SELECT DISTINCT
    started.turn_id,
    started.provider,
    started.model
  FROM observability_events started
  WHERE started.room_id = $1
    AND started.event = 'code_agent.turn.started'
    AND started.payload->>'backend' = 'codex-app-server'
    AND EXISTS (
      SELECT 1
      FROM observability_events dispatched
      WHERE dispatched.turn_id = started.turn_id
        AND dispatched.event = 'code_agent.runner.status'
        AND dispatched.payload->>'message' = 'sandbox daemon dispatching code-agent'
    )
), settled AS (
  SELECT
    event.turn_id,
    SUM(event.cost_usd) AS settled_cost_usd,
    SUM((event.payload->>'promptTokens')::bigint) AS prompt_tokens,
    SUM((event.payload->>'completionTokens')::bigint) AS completion_tokens,
    SUM(COALESCE((event.payload->>'cachedPromptTokens')::bigint, 0)) AS cached_prompt_tokens,
    COUNT(*) AS request_count,
    COUNT(event.cost_usd) AS cost_count,
    COUNT(*) FILTER (
      WHERE event.payload->>'promptTokens' IS NOT NULL
        AND event.payload->>'completionTokens' IS NOT NULL
    ) AS usage_count
  FROM observability_events event
  JOIN affected ON affected.turn_id = event.turn_id
  WHERE event.event = 'code_agent.model_gateway.settled'
  GROUP BY event.turn_id
), ranked_messages AS (
  SELECT
    message.id,
    message.turn_id,
    message.cost,
    ROW_NUMBER() OVER (
      PARTITION BY message.turn_id
      ORDER BY (message.usage IS NOT NULL) DESC, message.position DESC
    ) AS rank
  FROM room_messages message
  JOIN affected ON affected.turn_id = message.turn_id
  WHERE message.message_type = 'ai'
)
SELECT
  affected.turn_id,
  affected.provider,
  affected.model,
  settled.settled_cost_usd,
  settled.prompt_tokens,
  settled.completion_tokens,
  settled.cached_prompt_tokens,
  settled.request_count,
  settled.cost_count,
  settled.usage_count,
  ranked_messages.id AS final_message_id,
  ranked_messages.cost AS existing_cost
FROM affected
JOIN settled ON settled.turn_id = affected.turn_id
LEFT JOIN ranked_messages
  ON ranked_messages.turn_id = affected.turn_id
  AND ranked_messages.rank = 1
ORDER BY affected.turn_id`;

export interface BackfillMisroutedCocoCostsResult {
  roomId: string;
  dryRun: boolean;
  alreadyApplied: boolean;
  previousRoomCostUsd: number;
  nextRoomCostUsd: number;
  plan: MisroutedCocoCostPlan;
}

const markerIdForRoom = (roomId: string) => `misrouted_coco_cost_${roomId}_${BACKFILL_VERSION}`;

const rollbackQuietly = async (client: PostgresClient) => {
  await client.query('ROLLBACK').catch(() => {});
};

export const backfillMisroutedCocoCosts = async (
  pool: PostgresPool,
  roomId: string,
  execute: boolean
): Promise<BackfillMisroutedCocoCostsResult> => {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const markerId = markerIdForRoom(roomId);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [markerId]);

    const marker = await client.query('SELECT 1 FROM observability_events WHERE id = $1', [markerId]);
    const currentCost = await client.query<{ total_usd: string | number }>(
      'SELECT total_usd FROM room_ai_cost_totals WHERE room_id = $1',
      [roomId]
    );
    const previousRoomCostUsd = numberFrom(currentCost.rows[0]?.total_usd || 0, 'room cost');
    if (marker.rows.length > 0) {
      await rollbackQuietly(client);
      transactionOpen = false;
      return {
        roomId,
        dryRun: !execute,
        alreadyApplied: true,
        previousRoomCostUsd,
        nextRoomCostUsd: previousRoomCostUsd,
        plan: { affectedTurns: 0, messagesToUpdate: 0, turnsWithoutMessages: 0, totalCostUsd: 0, items: [] },
      };
    }

    const room = await client.query('SELECT 1 FROM rooms WHERE id = $1', [roomId]);
    if (!room.rowCount) {
      throw new Error(`Room not found: ${roomId}`);
    }
    const rows = await client.query<MisroutedCocoTurnRow>(LOAD_TURNS_SQL, [roomId]);
    const plan = buildMisroutedCocoCostPlan(rows.rows);
    const nextRoomCostUsd = previousRoomCostUsd + plan.totalCostUsd;

    if (!execute) {
      await rollbackQuietly(client);
      transactionOpen = false;
      return { roomId, dryRun: true, alreadyApplied: false, previousRoomCostUsd, nextRoomCostUsd, plan };
    }

    for (const item of plan.items) {
      if (!item.finalMessageId) continue;
      const update = await client.query(
        `UPDATE room_messages
        SET ai_model = $2::jsonb,
          usage = $3::jsonb,
          cost = $4::jsonb,
          updated_at = NOW()
        WHERE id = $1
          AND cost IS NULL`,
        [item.finalMessageId, JSON.stringify(item.aiModel), JSON.stringify(item.usage), JSON.stringify(item.cost)]
      );
      if (update.rowCount !== 1) {
        throw new Error(`Unable to update historical cost for message ${item.finalMessageId}`);
      }
    }

    await client.query(
      `INSERT INTO room_ai_cost_totals (room_id, total_usd)
      VALUES ($1, $2)
      ON CONFLICT (room_id) DO UPDATE SET
        total_usd = room_ai_cost_totals.total_usd + EXCLUDED.total_usd,
        updated_at = NOW()`,
      [roomId, plan.totalCostUsd]
    );
    await client.query(
      `UPDATE rooms
      SET message_version = message_version + 1,
        room_version = room_version + 1,
        updated_at = NOW()
      WHERE id = $1`,
      [roomId]
    );
    await client.query(
      `INSERT INTO observability_events (
        id, created_at, level, event, room_id, payload
      ) VALUES ($1, NOW(), 'info', $2, $3, $4::jsonb)`,
      [markerId, BACKFILL_EVENT, roomId, JSON.stringify({
        version: BACKFILL_VERSION,
        affectedTurns: plan.affectedTurns,
        messagesUpdated: plan.messagesToUpdate,
        turnsWithoutMessages: plan.turnsWithoutMessages,
        addedCostUsd: plan.totalCostUsd,
        previousRoomCostUsd,
        nextRoomCostUsd,
      })]
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return { roomId, dryRun: false, alreadyApplied: false, previousRoomCostUsd, nextRoomCostUsd, plan };
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
  if (!roomId) {
    throw new Error('Usage: npm run backfill:misrouted-coco-costs -- --room <roomId> [--execute]');
  }
  return { roomId, execute: args.includes('--execute') };
};

const main = async () => {
  const { roomId, execute } = parseCli(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const logger = new Logger('MisroutedCocoCostBackfill');
  const pool = createPostgresPool(databaseUrl, logger);
  try {
    const result = await backfillMisroutedCocoCosts(pool, roomId, execute);
    console.log(JSON.stringify(result, null, 2));
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
