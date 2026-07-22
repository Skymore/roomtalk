import type { RedisClientType } from 'redis';

export const ASSISTANT_RUN_TRANSIENT_CHANNEL = 'roomtalk:assistant-runs:transient:v1';
export const ASSISTANT_RUN_TRANSIENT_MAX_BYTES = 512 * 1024;

export type AssistantRunEventName =
  | 'ai_chunk'
  | 'a2ui_update'
  | 'ai_stream_end'
  | 'ai_stream_error'
  | 'ai_cost_total'
  | 'room_updated';

export type AssistantRunEventTarget =
  | { kind: 'room'; id: string }
  | { kind: 'client'; id: string };

export interface AssistantRunEventEnvelopeV1 {
  schemaVersion: 1;
  target: AssistantRunEventTarget;
  event: AssistantRunEventName;
  payload: Record<string, unknown>;
}

export interface AssistantRunEventPublisher {
  emit(
    target: AssistantRunEventTarget,
    event: AssistantRunEventName,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

const EVENT_NAMES = new Set<AssistantRunEventName>([
  'ai_chunk',
  'a2ui_update',
  'ai_stream_end',
  'ai_stream_error',
  'ai_cost_total',
  'room_updated',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const decodeAssistantRunEventEnvelope = (
  value: string,
): AssistantRunEventEnvelopeV1 | null => {
  if (Buffer.byteLength(value, 'utf8') > ASSISTANT_RUN_TRANSIENT_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) return null;
  if (!isRecord(parsed.target) || (parsed.target.kind !== 'room' && parsed.target.kind !== 'client')) return null;
  if (typeof parsed.target.id !== 'string' || parsed.target.id.length === 0) return null;
  if (typeof parsed.event !== 'string' || !EVENT_NAMES.has(parsed.event as AssistantRunEventName)) return null;
  if (!isRecord(parsed.payload)) return null;
  if (Object.keys(parsed).some(key => !['schemaVersion', 'target', 'event', 'payload'].includes(key))) return null;
  return parsed as unknown as AssistantRunEventEnvelopeV1;
};

export class RedisAssistantRunEventPublisher implements AssistantRunEventPublisher {
  constructor(private readonly redis: Pick<RedisClientType, 'publish'>) {}

  async emit(
    target: AssistantRunEventTarget,
    event: AssistantRunEventName,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const encoded = JSON.stringify({ schemaVersion: 1, target, event, payload });
    if (Buffer.byteLength(encoded, 'utf8') > ASSISTANT_RUN_TRANSIENT_MAX_BYTES) {
      throw new Error(`Assistant run transient event ${event} exceeds ${ASSISTANT_RUN_TRANSIENT_MAX_BYTES} bytes`);
    }
    await this.redis.publish(ASSISTANT_RUN_TRANSIENT_CHANNEL, encoded);
  }
}

export const subscribeToAssistantRunEvents = async (
  redis: Pick<RedisClientType, 'subscribe' | 'unsubscribe'>,
  handler: (event: AssistantRunEventEnvelopeV1) => void | Promise<void>,
  onInvalid?: (value: string) => void,
  onError?: (error: unknown, event: AssistantRunEventEnvelopeV1) => void,
): Promise<() => Promise<void>> => {
  await redis.subscribe(ASSISTANT_RUN_TRANSIENT_CHANNEL, value => {
    const event = decodeAssistantRunEventEnvelope(value);
    if (!event) {
      onInvalid?.(value);
      return;
    }
    void Promise.resolve(handler(event)).catch(error => onError?.(error, event));
  });
  return async () => {
    await redis.unsubscribe(ASSISTANT_RUN_TRANSIENT_CHANNEL);
  };
};
