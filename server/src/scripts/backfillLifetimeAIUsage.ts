import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresClient, PostgresPool } from '../repositories/postgresStore';

dotenv.config();

const BACKFILL_VERSION = 'v1';
const ACCOUNT_CUTOFF_MIGRATION = '0014_account_memberships_and_ai_scheduling';
const GATEWAY_CUTOFF_MIGRATION = '0015_account_usage_sources';
const BACKFILL_EVENT = 'account.lifetime_ai_usage_backfill.applied';

const HISTORICAL_USAGE_CTES = `
cutoffs AS (
  SELECT
    MAX(applied_at) FILTER (WHERE id = '${ACCOUNT_CUTOFF_MIGRATION}') AS account_cutoff,
    MAX(applied_at) FILTER (WHERE id = '${GATEWAY_CUTOFF_MIGRATION}') AS gateway_cutoff
  FROM schema_migrations
),
effective_memberships AS (
  SELECT
    membership.account_id,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM account_roles AS role
        WHERE role.account_id = membership.account_id
          AND role.role = 'admin'
      ) THEN 'priority'
      WHEN membership.status = 'active' THEN membership.tier
      ELSE 'free'
    END AS membership_tier
  FROM account_memberships AS membership
),
chat_cost_rows AS (
  SELECT
    run.id AS source_id,
    run.id AS usage_id,
    link.account_id,
    COALESCE(
      NULLIF(run.charged_cost_usd, 0),
      NULLIF((run.terminal_payload->'message'->'cost'->>'totalUsd')::numeric, 0),
      NULLIF((message.cost->>'totalUsd')::numeric, 0),
      0
    ) AS cost_usd,
    membership.membership_tier,
    run.provider,
    run.model_id,
    run.room_id,
    NULL::text AS turn_id,
    run.ai_message_id AS message_id,
    COALESCE(run.completed_at, run.updated_at) AS created_at
  FROM assistant_runs AS run
  JOIN client_account_links AS link
    ON link.client_id = run.requested_by_client_id
  JOIN effective_memberships AS membership
    ON membership.account_id = link.account_id
  LEFT JOIN room_messages AS message
    ON message.id = run.ai_message_id
  LEFT JOIN account_ai_usage_events AS usage
    ON usage.assistant_run_id = run.id
  CROSS JOIN cutoffs
  WHERE run.status IN ('complete', 'error')
    AND run.completed_at < cutoffs.account_cutoff
    AND usage.assistant_run_id IS NULL
),
historical_chat AS (
  SELECT
    source_id,
    usage_id,
    account_id,
    cost_usd,
    membership_tier,
    provider,
    model_id,
    'assistant_run'::text AS source,
    room_id,
    turn_id,
    message_id,
    created_at,
    'assistant_run'::text AS provenance
  FROM chat_cost_rows
  WHERE cost_usd > 0
),
historical_gateway_rows AS (
  SELECT
    event.id AS source_id,
    'lifetime-backfill:gateway:' || event.id AS usage_id,
    link.account_id,
    event.cost_usd,
    membership.membership_tier,
    COALESCE(NULLIF(event.provider, ''), 'unknown') AS provider,
    COALESCE(NULLIF(event.model, ''), 'unknown') AS model_id,
    'code_agent_gateway'::text AS source,
    event.room_id,
    event.turn_id,
    NULL::text AS message_id,
    event.created_at,
    'model_gateway'::text AS provenance
  FROM observability_events AS event
  JOIN client_account_links AS link
    ON link.client_id = event.client_id
  JOIN effective_memberships AS membership
    ON membership.account_id = link.account_id
  CROSS JOIN cutoffs
  WHERE event.event = 'code_agent.model_gateway.settled'
    AND event.created_at < cutoffs.gateway_cutoff
    AND event.cost_usd > 0
),
historical_gateway AS (
  SELECT gateway.*
  FROM historical_gateway_rows AS gateway
  WHERE NOT EXISTS (
    SELECT 1
    FROM account_ai_usage_events AS usage
    WHERE usage.assistant_run_id = gateway.usage_id
  )
),
historical_gateway_turns AS (
  SELECT DISTINCT event.turn_id
  FROM observability_events AS event
  CROSS JOIN cutoffs
  WHERE event.event = 'code_agent.model_gateway.settled'
    AND event.created_at < cutoffs.gateway_cutoff
    AND event.cost_usd > 0
    AND event.turn_id IS NOT NULL
),
historical_turn_rows AS (
  SELECT
    event.id AS source_id,
    'lifetime-backfill:turn:' || event.id AS usage_id,
    link.account_id,
    event.cost_usd,
    membership.membership_tier,
    COALESCE(NULLIF(event.provider, ''), 'unknown') AS provider,
    COALESCE(NULLIF(event.model, ''), 'unknown') AS model_id,
    'code_agent_gateway'::text AS source,
    event.room_id,
    event.turn_id,
    NULL::text AS message_id,
    event.created_at,
    'legacy_turn'::text AS provenance
  FROM observability_events AS event
  JOIN client_account_links AS link
    ON link.client_id = event.client_id
  JOIN effective_memberships AS membership
    ON membership.account_id = link.account_id
  CROSS JOIN cutoffs
  LEFT JOIN historical_gateway_turns AS gateway_turn
    ON gateway_turn.turn_id = event.turn_id
  WHERE event.event = 'code_agent.turn.completed'
    AND event.created_at < cutoffs.gateway_cutoff
    AND event.cost_usd > 0
    AND gateway_turn.turn_id IS NULL
),
historical_turn AS (
  SELECT turn.*
  FROM historical_turn_rows AS turn
  WHERE NOT EXISTS (
    SELECT 1
    FROM account_ai_usage_events AS usage
    WHERE usage.assistant_run_id = turn.usage_id
  )
),
historical_candidates AS (
  SELECT * FROM historical_chat
  UNION ALL
  SELECT * FROM historical_gateway
  UNION ALL
  SELECT * FROM historical_turn
)
`;

type LifetimeUsageBackfillPlanRow = {
  account_cutoff: string | Date;
  gateway_cutoff: string | Date;
  assistant_run_events: string | number;
  model_gateway_events: string | number;
  legacy_turn_events: string | number;
  candidate_events: string | number;
  affected_accounts: string | number;
  candidate_cost_usd: string | number;
  existing_usage_events: string | number;
  existing_usage_cost_usd: string | number;
  previous_stored_lifetime_usd: string | number;
  next_stored_lifetime_usd: string | number;
  balances_to_update: string | number;
};

export interface LifetimeUsageBackfillPlan {
  accountCutoff: string;
  gatewayCutoff: string;
  assistantRunEvents: number;
  modelGatewayEvents: number;
  legacyTurnEvents: number;
  candidateEvents: number;
  affectedAccounts: number;
  candidateCostUsd: number;
  existingUsageEvents: number;
  existingUsageCostUsd: number;
  previousStoredLifetimeUsd: number;
  nextStoredLifetimeUsd: number;
  balancesToUpdate: number;
}

export interface BackfillLifetimeAIUsageResult {
  version: string;
  dryRun: boolean;
  alreadyCurrent: boolean;
  plan: LifetimeUsageBackfillPlan;
  insertedEvents: number;
  updatedBalances: number;
  storedLifetimeUsd: number;
}

const finiteNumber = (value: unknown, field: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
  return parsed;
};

const isoString = (value: string | Date, field: string): string => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
  return parsed.toISOString();
};

export const mapLifetimeUsageBackfillPlan = (
  row: LifetimeUsageBackfillPlanRow,
): LifetimeUsageBackfillPlan => ({
  accountCutoff: isoString(row.account_cutoff, 'account cutoff'),
  gatewayCutoff: isoString(row.gateway_cutoff, 'gateway cutoff'),
  assistantRunEvents: finiteNumber(row.assistant_run_events, 'assistant run event count'),
  modelGatewayEvents: finiteNumber(row.model_gateway_events, 'model gateway event count'),
  legacyTurnEvents: finiteNumber(row.legacy_turn_events, 'legacy turn event count'),
  candidateEvents: finiteNumber(row.candidate_events, 'candidate event count'),
  affectedAccounts: finiteNumber(row.affected_accounts, 'affected account count'),
  candidateCostUsd: finiteNumber(row.candidate_cost_usd, 'candidate cost'),
  existingUsageEvents: finiteNumber(row.existing_usage_events, 'existing usage event count'),
  existingUsageCostUsd: finiteNumber(row.existing_usage_cost_usd, 'existing usage cost'),
  previousStoredLifetimeUsd: finiteNumber(row.previous_stored_lifetime_usd, 'previous lifetime usage'),
  nextStoredLifetimeUsd: finiteNumber(row.next_stored_lifetime_usd, 'next lifetime usage'),
  balancesToUpdate: finiteNumber(row.balances_to_update, 'balance update count'),
});

const loadPlan = async (client: PostgresClient): Promise<LifetimeUsageBackfillPlan> => {
  const result = await client.query<LifetimeUsageBackfillPlanRow>(`
    WITH ${HISTORICAL_USAGE_CTES},
    expected_account_usage AS (
      SELECT account_id, SUM(cost_usd) AS cost_usd
      FROM (
        SELECT account_id, cost_usd
        FROM account_ai_usage_events
        UNION ALL
        SELECT account_id, cost_usd
        FROM historical_candidates
      ) AS expected
      GROUP BY account_id
    )
    SELECT
      cutoffs.account_cutoff,
      cutoffs.gateway_cutoff,
      COUNT(*) FILTER (WHERE candidate.provenance = 'assistant_run') AS assistant_run_events,
      COUNT(*) FILTER (WHERE candidate.provenance = 'model_gateway') AS model_gateway_events,
      COUNT(*) FILTER (WHERE candidate.provenance = 'legacy_turn') AS legacy_turn_events,
      COUNT(candidate.usage_id) AS candidate_events,
      COUNT(DISTINCT candidate.account_id) AS affected_accounts,
      COALESCE(SUM(candidate.cost_usd), 0) AS candidate_cost_usd,
      (SELECT COUNT(*) FROM account_ai_usage_events) AS existing_usage_events,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM account_ai_usage_events) AS existing_usage_cost_usd,
      (SELECT COALESCE(SUM(lifetime_usage_usd), 0) FROM account_credit_balances) AS previous_stored_lifetime_usd,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM expected_account_usage) AS next_stored_lifetime_usd,
      (
        SELECT COUNT(*)
        FROM account_credit_balances AS balance
        LEFT JOIN expected_account_usage AS expected
          ON expected.account_id = balance.account_id
        WHERE balance.lifetime_usage_usd IS DISTINCT FROM COALESCE(expected.cost_usd, 0)
      ) AS balances_to_update
    FROM cutoffs
    LEFT JOIN historical_candidates AS candidate ON TRUE
    GROUP BY cutoffs.account_cutoff, cutoffs.gateway_cutoff
  `);
  if (!result.rows[0]?.account_cutoff || !result.rows[0]?.gateway_cutoff) {
    throw new Error('Required account usage migrations have not been applied');
  }
  return mapLifetimeUsageBackfillPlan(result.rows[0]);
};

const rollbackQuietly = async (client: PostgresClient) => {
  await client.query('ROLLBACK').catch(() => {});
};

export const backfillLifetimeAIUsage = async (
  pool: PostgresPool,
  execute: boolean,
): Promise<BackfillLifetimeAIUsageResult> => {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('roomtalk_lifetime_ai_usage_backfill_v1'))",
    );

    if (execute) {
      // Account settlement locks the balance before inserting its usage event.
      // These short table locks make the historical insert + total recompute an
      // atomic boundary without racing a live settlement or account creation.
      await client.query('LOCK TABLE account_credit_balances IN SHARE ROW EXCLUSIVE MODE');
      await client.query('LOCK TABLE account_ai_usage_events IN SHARE ROW EXCLUSIVE MODE');
    }

    const plan = await loadPlan(client);
    if (!execute) {
      await rollbackQuietly(client);
      transactionOpen = false;
      return {
        version: BACKFILL_VERSION,
        dryRun: true,
        alreadyCurrent: plan.candidateEvents === 0 && plan.balancesToUpdate === 0,
        plan,
        insertedEvents: 0,
        updatedBalances: 0,
        storedLifetimeUsd: plan.previousStoredLifetimeUsd,
      };
    }

    const inserted = await client.query<{ inserted_events: string | number; inserted_cost_usd: string | number }>(`
      WITH ${HISTORICAL_USAGE_CTES},
      inserted AS (
        INSERT INTO account_ai_usage_events (
          assistant_run_id,
          account_id,
          cost_usd,
          credit_applied_usd,
          membership_tier,
          provider,
          model_id,
          source,
          room_id,
          turn_id,
          message_id,
          created_at
        )
        SELECT
          candidate.usage_id,
          candidate.account_id,
          candidate.cost_usd,
          0,
          candidate.membership_tier,
          candidate.provider,
          candidate.model_id,
          candidate.source,
          candidate.room_id,
          candidate.turn_id,
          candidate.message_id,
          candidate.created_at
        FROM historical_candidates AS candidate
        ORDER BY candidate.created_at, candidate.usage_id
        ON CONFLICT (assistant_run_id) DO NOTHING
        RETURNING cost_usd
      )
      SELECT
        COUNT(*) AS inserted_events,
        COALESCE(SUM(cost_usd), 0) AS inserted_cost_usd
      FROM inserted
    `);
    const insertedEvents = finiteNumber(inserted.rows[0]?.inserted_events || 0, 'inserted event count');
    const insertedCostUsd = finiteNumber(inserted.rows[0]?.inserted_cost_usd || 0, 'inserted cost');
    if (
      insertedEvents !== plan.candidateEvents
      || Math.abs(insertedCostUsd - plan.candidateCostUsd) >= 0.0000000005
    ) {
      throw new Error(
        `Historical usage changed during backfill: planned ${plan.candidateEvents} events/${plan.candidateCostUsd}, inserted ${insertedEvents}/${insertedCostUsd}`,
      );
    }

    const updated = await client.query(`
      WITH totals AS (
        SELECT account_id, SUM(cost_usd) AS cost_usd
        FROM account_ai_usage_events
        GROUP BY account_id
      )
      UPDATE account_credit_balances AS balance
      SET lifetime_usage_usd = COALESCE(totals.cost_usd, 0),
        updated_at = clock_timestamp()
      FROM accounts AS account
      LEFT JOIN totals ON totals.account_id = account.id
      WHERE balance.account_id = account.id
        AND balance.lifetime_usage_usd IS DISTINCT FROM COALESCE(totals.cost_usd, 0)
    `);

    const stored = await client.query<{ total_usd: string | number }>(
      'SELECT COALESCE(SUM(lifetime_usage_usd), 0) AS total_usd FROM account_credit_balances',
    );
    const storedLifetimeUsd = finiteNumber(stored.rows[0]?.total_usd || 0, 'stored lifetime usage');
    if (Math.abs(storedLifetimeUsd - plan.nextStoredLifetimeUsd) >= 0.0000000005) {
      throw new Error(
        `Lifetime usage total mismatch: expected ${plan.nextStoredLifetimeUsd}, stored ${storedLifetimeUsd}`,
      );
    }

    await client.query(
      `INSERT INTO observability_events (
        id, created_at, level, event, payload
      ) VALUES ($1, clock_timestamp(), 'info', $2, $3::jsonb)`,
      [
        `lifetime_ai_usage_backfill_${BACKFILL_VERSION}_${randomUUID()}`,
        BACKFILL_EVENT,
        JSON.stringify({
          version: BACKFILL_VERSION,
          assistantRunEvents: plan.assistantRunEvents,
          modelGatewayEvents: plan.modelGatewayEvents,
          legacyTurnEvents: plan.legacyTurnEvents,
          insertedEvents,
          insertedCostUsd,
          previousStoredLifetimeUsd: plan.previousStoredLifetimeUsd,
          nextStoredLifetimeUsd: storedLifetimeUsd,
          updatedBalances: updated.rowCount || 0,
          creditsRetroactivelyAppliedUsd: 0,
        }),
      ],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return {
      version: BACKFILL_VERSION,
      dryRun: false,
      alreadyCurrent: insertedEvents === 0 && (updated.rowCount || 0) === 0,
      plan,
      insertedEvents,
      updatedBalances: updated.rowCount || 0,
      storedLifetimeUsd,
    };
  } catch (error) {
    if (transactionOpen) await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
};

export const parseLifetimeUsageBackfillCli = (args: string[]) => ({
  execute: args.includes('--execute'),
});

const main = async () => {
  const { execute } = parseLifetimeUsageBackfillCli(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const logger = new Logger('LifetimeAIUsageBackfill');
  const pool = createPostgresPool(databaseUrl, logger);
  try {
    const result = await backfillLifetimeAIUsage(pool, execute);
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
