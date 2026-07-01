import { randomUUID } from 'crypto';
import { Logger } from '../logger';
import { AIModelProvider } from '../types';
import { PostgresPool } from '../repositories/postgresStore';

export type ObservabilityEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ObservabilityEventInput {
  id?: string;
  createdAt?: string;
  level: ObservabilityEventLevel;
  event: string;
  roomId?: string | null;
  turnId?: string | null;
  sessionId?: string | null;
  clientId?: string | null;
  provider?: AIModelProvider | string | null;
  model?: string | null;
  durationMs?: number | null;
  costUsd?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  payload?: unknown;
}

export interface ObservabilityEventRecord extends Required<Pick<ObservabilityEventInput, 'id' | 'createdAt' | 'level' | 'event'>> {
  roomId?: string;
  turnId?: string;
  sessionId?: string;
  clientId?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  costUsd?: number;
  errorCode?: string;
  errorMessage?: string;
  payload: Record<string, unknown>;
}

export interface ObservabilityEventReadOptions {
  roomId?: string;
  turnId?: string;
  sessionId?: string;
  event?: string;
  level?: ObservabilityEventLevel;
  since?: string;
  limit?: number;
}

export interface ObservabilityEventRecorder {
  recordEvent(event: ObservabilityEventInput): Promise<ObservabilityEventRecord | null>;
}

type ObservabilityEventRow = {
  id: string;
  created_at: string | Date;
  level: ObservabilityEventLevel;
  event: string;
  room_id: string | null;
  turn_id: string | null;
  session_id: string | null;
  client_id: string | null;
  provider: string | null;
  model: string | null;
  duration_ms: number | string | null;
  cost_usd: number | string | null;
  error_code: string | null;
  error_message: string | null;
  payload: unknown;
};

const OBSERVABILITY_EVENT_COLUMNS = [
  'id',
  'created_at',
  'level',
  'event',
  'room_id',
  'turn_id',
  'session_id',
  'client_id',
  'provider',
  'model',
  'duration_ms',
  'cost_usd',
  'error_code',
  'error_message',
  'payload',
].join(', ');

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const errorAwareReplacer = (_key: string, value: unknown) =>
  value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack }
    : value;

export const sanitizeObservabilityPayload = (payload: unknown): Record<string, unknown> => {
  if (payload === undefined || payload === null) {
    return {};
  }

  try {
    const normalized = JSON.parse(JSON.stringify(payload, errorAwareReplacer));
    return isRecord(normalized) ? normalized : { value: normalized };
  } catch {
    return { value: String(payload) };
  }
};

const toIsoString = (value: string | Date) => (
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()
);

const finiteNumberOrNull = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const positiveIntegerOrNull = (value: unknown) => {
  const numberValue = finiteNumberOrNull(value);
  return numberValue === null || numberValue < 0 ? null : Math.round(numberValue);
};

const nonEmptyStringOrNull = (value: unknown) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const mapObservabilityEvent = (row: ObservabilityEventRow): ObservabilityEventRecord => {
  const durationMs = row.duration_ms === null ? undefined : Number(row.duration_ms);
  const costUsd = row.cost_usd === null ? undefined : Number(row.cost_usd);
  return {
    id: row.id,
    createdAt: toIsoString(row.created_at),
    level: row.level,
    event: row.event,
    ...(row.room_id ? { roomId: row.room_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.client_id ? { clientId: row.client_id } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    ...(Number.isFinite(costUsd) ? { costUsd } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    payload: sanitizeObservabilityPayload(row.payload),
  };
};

export class NoopObservabilityEventRecorder implements ObservabilityEventRecorder {
  async recordEvent(): Promise<ObservabilityEventRecord | null> {
    return null;
  }
}

export class PostgresObservabilityEventRecorder implements ObservabilityEventRecorder {
  constructor(
    private readonly pool: PostgresPool,
    private readonly logger: Pick<Logger, 'error' | 'warn'>,
    private readonly options: { now?: () => Date; createId?: () => string } = {}
  ) {}

  async recordEvent(input: ObservabilityEventInput): Promise<ObservabilityEventRecord | null> {
    const record = {
      id: input.id || this.options.createId?.() || randomUUID(),
      createdAt: input.createdAt || (this.options.now?.() || new Date()).toISOString(),
      level: input.level,
      event: input.event,
      roomId: nonEmptyStringOrNull(input.roomId),
      turnId: nonEmptyStringOrNull(input.turnId),
      sessionId: nonEmptyStringOrNull(input.sessionId),
      clientId: nonEmptyStringOrNull(input.clientId),
      provider: nonEmptyStringOrNull(input.provider),
      model: nonEmptyStringOrNull(input.model),
      durationMs: positiveIntegerOrNull(input.durationMs),
      costUsd: finiteNumberOrNull(input.costUsd),
      errorCode: nonEmptyStringOrNull(input.errorCode),
      errorMessage: nonEmptyStringOrNull(input.errorMessage),
      payload: sanitizeObservabilityPayload(input.payload),
    };

    try {
      const result = await this.pool.query<ObservabilityEventRow>(
        `INSERT INTO observability_events (
          id,
          created_at,
          level,
          event,
          room_id,
          turn_id,
          session_id,
          client_id,
          provider,
          model,
          duration_ms,
          cost_usd,
          error_code,
          error_message,
          payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING ${OBSERVABILITY_EVENT_COLUMNS}`,
        [
          record.id,
          record.createdAt,
          record.level,
          record.event,
          record.roomId,
          record.turnId,
          record.sessionId,
          record.clientId,
          record.provider,
          record.model,
          record.durationMs,
          record.costUsd,
          record.errorCode,
          record.errorMessage,
          record.payload,
        ]
      );
      return result.rows[0] ? mapObservabilityEvent(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Failed to persist observability event', {
        error,
        event: input.event,
        roomId: input.roomId,
        turnId: input.turnId,
      });
      return null;
    }
  }

  async readEvents(options: ObservabilityEventReadOptions = {}): Promise<ObservabilityEventRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const addCondition = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(`${sql} $${params.length}`);
    };

    if (options.roomId) addCondition('room_id =', options.roomId);
    if (options.turnId) addCondition('turn_id =', options.turnId);
    if (options.sessionId) addCondition('session_id =', options.sessionId);
    if (options.event) addCondition('event =', options.event);
    if (options.level) addCondition('level =', options.level);
    if (options.since) addCondition('created_at >=', options.since);

    const limit = Number.isFinite(options.limit) && options.limit && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 100;
    params.push(limit);

    try {
      const result = await this.pool.query<ObservabilityEventRow>(
        `SELECT ${OBSERVABILITY_EVENT_COLUMNS}
        FROM observability_events
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY created_at ASC, id ASC
        LIMIT $${params.length}`,
        params
      );
      return result.rows.map(mapObservabilityEvent);
    } catch (error) {
      this.logger.error('Failed to read observability events', { error, options });
      return [];
    }
  }

  async deleteEventsBefore(cutoff: string): Promise<number> {
    try {
      const result = await this.pool.query(
        'DELETE FROM observability_events WHERE created_at < $1',
        [cutoff]
      );
      return result.rowCount || 0;
    } catch (error) {
      this.logger.error('Failed to delete old observability events', { error, cutoff });
      return 0;
    }
  }
}
