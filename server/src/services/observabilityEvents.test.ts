import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PostgresClient, PostgresPool, PostgresQueryResult } from '../repositories/postgresStore';
import {
  PostgresObservabilityEventRecorder,
  sanitizeObservabilityPayload,
} from './observabilityEvents';

type QueryCall = {
  sql: string;
  params?: unknown[];
};

type ScriptedResult = {
  rows?: unknown[];
  rowCount?: number | null;
  assertCall?: (call: QueryCall) => void;
  error?: Error;
};

class ScriptedPool implements PostgresPool {
  calls: QueryCall[] = [];

  constructor(private readonly results: ScriptedResult[] = []) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<T>> {
    const call = { sql, params };
    this.calls.push(call);
    const result = this.results.shift() || {};
    result.assertCall?.(call);
    if (result.error) {
      throw result.error;
    }
    return {
      rows: (result.rows || []) as T[],
      rowCount: result.rowCount ?? ((result.rows || []).length),
    };
  }

  async connect(): Promise<PostgresClient> {
    throw new Error('connect not implemented');
  }
}

const logger = {
  error() {},
  warn() {},
};

describe('PostgresObservabilityEventRecorder', () => {
  it('writes normalized observability events to PostgreSQL', async () => {
    const pool = new ScriptedPool([{
      rows: [{
        id: 'event-1',
        created_at: '2026-07-01T00:00:00.000Z',
        level: 'warn',
        event: 'coco.turn.failed',
        room_id: 'room-1',
        turn_id: 'turn-1',
        session_id: 'session-1',
        client_id: 'client-1',
        provider: 'anthropic',
        model: 'claude-sonnet-4.6',
        duration_ms: 123,
        cost_usd: '0.42',
        error_code: 'turn_failed',
        error_message: 'failed',
        payload: { ok: true },
      }],
      assertCall: call => {
        assert.match(call.sql, /INSERT INTO observability_events/);
        assert.equal(call.params?.[0], 'event-1');
        assert.equal(call.params?.[2], 'warn');
        assert.equal(call.params?.[3], 'coco.turn.failed');
        assert.equal(call.params?.[10], 123);
        assert.equal(call.params?.[11], 0.42);
      },
    }]);
    const recorder = new PostgresObservabilityEventRecorder(pool, logger, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
      createId: () => 'event-1',
    });

    const record = await recorder.recordEvent({
      level: 'warn',
      event: 'coco.turn.failed',
      roomId: 'room-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      clientId: 'client-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4.6',
      durationMs: 123.4,
      costUsd: 0.42,
      errorCode: 'turn_failed',
      errorMessage: 'failed',
      payload: { error: new Error('boom') },
    });

    assert.equal(record?.id, 'event-1');
    assert.equal(record?.costUsd, 0.42);
    assert.equal(pool.calls.length, 1);
  });

  it('reads events with bounded filters and deletes old events', async () => {
    const pool = new ScriptedPool([
      {
        rows: [],
        assertCall: call => {
          assert.match(call.sql, /WHERE room_id = \$1 AND turn_id = \$2 AND created_at >= \$3/);
          assert.deepEqual(call.params, ['room-1', 'turn-1', '2026-07-01T00:00:00.000Z', 10]);
        },
      },
      {
        rowCount: 3,
        assertCall: call => {
          assert.match(call.sql, /DELETE FROM observability_events WHERE created_at < \$1/);
          assert.deepEqual(call.params, ['2026-06-01T00:00:00.000Z']);
        },
      },
    ]);
    const recorder = new PostgresObservabilityEventRecorder(pool, logger);

    const events = await recorder.readEvents({
      roomId: 'room-1',
      turnId: 'turn-1',
      since: '2026-07-01T00:00:00.000Z',
      limit: 10,
    });
    const deleted = await recorder.deleteEventsBefore('2026-06-01T00:00:00.000Z');

    assert.deepEqual(events, []);
    assert.equal(deleted, 3);
  });
});

describe('sanitizeObservabilityPayload', () => {
  it('turns errors and scalar values into JSONB-safe objects', () => {
    const errorPayload = sanitizeObservabilityPayload({ error: new Error('boom') });
    assert.deepEqual(Object.keys(errorPayload.error as Record<string, unknown>).sort(), ['message', 'name', 'stack']);

    assert.deepEqual(sanitizeObservabilityPayload('hello'), { value: 'hello' });
  });
});
