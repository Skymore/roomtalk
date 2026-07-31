import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresStore } from '../repositories/postgresStore';
import {
  backfillLifetimeAIUsage,
  mapLifetimeUsageBackfillPlan,
  parseLifetimeUsageBackfillCli,
} from './backfillLifetimeAIUsage';

describe('Lifetime AI usage backfill helpers', () => {
  it('maps a database plan without losing exact counts or costs', () => {
    assert.deepEqual(mapLifetimeUsageBackfillPlan({
      account_cutoff: '2026-07-31T10:00:00.000Z',
      gateway_cutoff: '2026-07-31T10:01:00.000Z',
      assistant_run_events: '7',
      model_gateway_events: '333',
      legacy_turn_events: '8',
      candidate_events: '348',
      affected_accounts: '1',
      candidate_cost_usd: '3.559054625',
      existing_usage_events: '0',
      existing_usage_cost_usd: '0',
      previous_stored_lifetime_usd: '0',
      next_stored_lifetime_usd: '3.559054625',
      balances_to_update: '1',
    }), {
      accountCutoff: '2026-07-31T10:00:00.000Z',
      gatewayCutoff: '2026-07-31T10:01:00.000Z',
      assistantRunEvents: 7,
      modelGatewayEvents: 333,
      legacyTurnEvents: 8,
      candidateEvents: 348,
      affectedAccounts: 1,
      candidateCostUsd: 3.559054625,
      existingUsageEvents: 0,
      existingUsageCostUsd: 0,
      previousStoredLifetimeUsd: 0,
      nextStoredLifetimeUsd: 3.559054625,
      balancesToUpdate: 1,
    });
  });

  it('is dry-run by default and requires the explicit execute flag', () => {
    assert.deepEqual(parseLifetimeUsageBackfillCli([]), { execute: false });
    assert.deepEqual(parseLifetimeUsageBackfillCli(['--execute']), { execute: true });
  });
});

const databaseUrl = process.env.ROOM_EVENT_TEST_DATABASE_URL?.trim();

describe('Lifetime AI usage PostgreSQL backfill', { skip: !databaseUrl }, () => {
  const logger = new Logger('LifetimeAIUsageBackfillTest');
  const schemaName = `lifetime_usage_backfill_${Date.now()}`;
  const adminPool = databaseUrl ? createPostgresPool(databaseUrl, logger) : null;
  let pool: ReturnType<typeof createPostgresPool>;

  before(async () => {
    if (!databaseUrl || !adminPool) return;
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    pool = createPostgresPool(scopedUrl.toString(), logger);
    await new PostgresStore(pool, logger).initializeSchema();

    const cutoff = await pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM schema_migrations WHERE id = '0014_account_memberships_and_ai_scheduling'",
    );
    const historicalAt = new Date(cutoff.rows[0].applied_at.getTime() - 86_400_000).toISOString();
    await pool.query(
      `INSERT INTO accounts (id, primary_client_id, created_at, updated_at)
      VALUES ('account-1', 'client-1', $1, $1)`,
      [historicalAt],
    );
    await pool.query(
      `INSERT INTO client_account_links (client_id, account_id, linked_at)
      VALUES ('client-1', 'account-1', $1)`,
      [historicalAt],
    );
    await pool.query(
      `INSERT INTO account_memberships (account_id, tier, status, created_at, updated_at)
      VALUES ('account-1', 'free', 'active', $1, $1)`,
      [historicalAt],
    );
    await pool.query(
      `INSERT INTO account_credit_balances (account_id, updated_at)
      VALUES ('account-1', $1)`,
      [historicalAt],
    );
    await pool.query(
      `INSERT INTO rooms (id, name, description, created_at, last_activity_at, creator_id, type)
      VALUES ('room-1', 'Backfill', '', $1, $1, 'client-1', 'chat')`,
      [historicalAt],
    );
    await pool.query(
      `INSERT INTO assistant_runs (
        id, room_id, requested_by_client_id, ai_message_id, status,
        model_id, api_model, provider, created_at, queued_at, started_at,
        completed_at, updated_at, terminal_payload
      ) VALUES (
        'historical-chat', 'room-1', 'client-1', 'historical-message', 'complete',
        'test-model', 'test-model', 'openai', $1, $1, $1, $1, $1,
        '{"schemaVersion":1,"outcome":"complete","message":{"cost":{"totalUsd":1}}}'::jsonb
      )`,
      [historicalAt],
    );
    await pool.query(
      `INSERT INTO observability_events (
        id, created_at, level, event, room_id, turn_id, client_id,
        provider, model, cost_usd, payload
      ) VALUES
        ('gateway-1', $1, 'info', 'code_agent.model_gateway.settled', 'room-1', 'turn-1', 'client-1', 'openai', 'test-model', 2, '{}'),
        ('turn-overlap', $1, 'info', 'code_agent.turn.completed', 'room-1', 'turn-1', 'client-1', 'openai', 'test-model', 2, '{}'),
        ('turn-fallback', $1, 'info', 'code_agent.turn.completed', 'room-1', 'turn-2', 'client-1', 'openai', 'test-model', 3, '{}'),
        ('gateway-unlinked', $1, 'info', 'code_agent.model_gateway.settled', 'room-1', 'turn-3', 'guest', 'openai', 'test-model', 10, '{}')`,
      [historicalAt],
    );
  });

  after(async () => {
    if (!databaseUrl || !adminPool) return;
    await pool?.end?.();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end?.();
  });

  it('backfills exact historical sources once without retroactively applying credits', async () => {
    const dryRun = await backfillLifetimeAIUsage(pool, false);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.plan.assistantRunEvents, 1);
    assert.equal(dryRun.plan.modelGatewayEvents, 1);
    assert.equal(dryRun.plan.legacyTurnEvents, 1);
    assert.equal(dryRun.plan.candidateEvents, 3);
    assert.equal(dryRun.plan.candidateCostUsd, 6);

    const executed = await backfillLifetimeAIUsage(pool, true);
    assert.equal(executed.dryRun, false);
    assert.equal(executed.insertedEvents, 3);
    assert.equal(executed.updatedBalances, 1);
    assert.equal(executed.storedLifetimeUsd, 6);
    assert.deepEqual((await pool.query(
      `SELECT COUNT(*)::int AS count,
        SUM(cost_usd)::float8 AS cost_usd,
        SUM(credit_applied_usd)::float8 AS credit_applied_usd
      FROM account_ai_usage_events`,
    )).rows[0], { count: 3, cost_usd: 6, credit_applied_usd: 0 });

    const rerun = await backfillLifetimeAIUsage(pool, true);
    assert.equal(rerun.alreadyCurrent, true);
    assert.equal(rerun.insertedEvents, 0);
    assert.equal(rerun.updatedBalances, 0);
    assert.equal(rerun.storedLifetimeUsd, 6);
  });
});
