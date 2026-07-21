import { RoomEventType } from '../types';

type JsonRecord = Record<string, unknown>;

class StoredRoomEventValidationError extends Error {}

const fail = (path: string, expected: string): never => {
  throw new StoredRoomEventValidationError(`${path} must be ${expected}`);
};

const record = (value: unknown, path: string): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'an object');
  return value as JsonRecord;
};

const exactKeys = (
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): JsonRecord => {
  const result = record(value, path);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const unexpected = Object.keys(result).find(key => !allowed.has(key));
  if (unexpected) fail(`${path}.${unexpected}`, 'absent for schemaVersion 1');
  const missing = requiredKeys.find(key => !Object.prototype.hasOwnProperty.call(result, key));
  if (missing) fail(`${path}.${missing}`, 'present');
  return result;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'a non-empty string');
  return value as string;
};

const text = (value: unknown, path: string): string => {
  if (typeof value !== 'string') fail(path, 'a string');
  return value as string;
};

const nullableString = (value: unknown, path: string): void => {
  if (value !== null && typeof value !== 'string') fail(path, 'a string or null');
};

const nullableNumber = (value: unknown, path: string): void => {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) fail(path, 'a finite number or null');
};

const nullableBoolean = (value: unknown, path: string): void => {
  if (value !== null && typeof value !== 'boolean') fail(path, 'a boolean or null');
};

const nullableRecord = (value: unknown, path: string): void => {
  if (value !== null) record(value, path);
};

const stringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'a non-empty string array');
  const result = (value as unknown[]).map((item, index) => string(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) fail(path, 'a string array without duplicates');
  return result;
};

const objectArray = (value: unknown, path: string): JsonRecord[] => {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'a non-empty object array');
  return (value as unknown[]).map((item, index) => record(item, `${path}[${index}]`));
};

const nullableStringArray = (value: unknown, path: string): void => {
  if (value === null) return;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail(path, 'a string array or null');
};

const oneOf = (value: unknown, path: string, values: readonly string[]): void => {
  if (typeof value !== 'string' || !values.includes(value)) fail(path, `one of ${values.join(', ')}`);
};

const MESSAGE_KEYS = [
  'id', 'room_id', 'client_id', 'client_message_id', 'client_batch_id', 'client_batch_index',
  'content', 'timestamp', 'updated_at', 'message_type', 'username', 'avatar', 'mime_type',
  'status', 'turn_id', 'model_step_id', 'model_step_sequence', 'tool_call_id', 'tool_name',
  'tool_args', 'tool_output_preview', 'exit_code', 'is_error', 'ai_model', 'usage', 'cost',
  'reply_to', 'ui_payload', 'code_agent_mode', 'code_agent_queued_input',
  'code_agent_image_message_ids',
] as const;

const validateMessageRow = (value: unknown, path: string, roomId: string): string => {
  const row = exactKeys(value, path, MESSAGE_KEYS);
  string(row.id, `${path}.id`);
  if (string(row.room_id, `${path}.room_id`) !== roomId) fail(`${path}.room_id`, `equal to ${roomId}`);
  string(row.client_id, `${path}.client_id`);
  // Empty content is valid for a streaming AI placeholder and for media-only
  // messages. The field must be present and typed, but it need not be non-empty.
  text(row.content, `${path}.content`);
  string(row.timestamp, `${path}.timestamp`);
  oneOf(row.message_type, `${path}.message_type`, [
    'text', 'ai', 'media', 'sticker', 'tool_call', 'tool_result', 'sandbox_status',
  ]);
  [
    'client_message_id', 'client_batch_id', 'updated_at', 'username', 'mime_type', 'turn_id',
    'model_step_id', 'tool_call_id', 'tool_name', 'tool_output_preview', 'code_agent_mode',
  ].forEach(key => nullableString(row[key], `${path}.${key}`));
  ['client_batch_index', 'model_step_sequence', 'exit_code'].forEach(key => (
    nullableNumber(row[key], `${path}.${key}`)
  ));
  nullableBoolean(row.is_error, `${path}.is_error`);
  if (row.status !== null) oneOf(row.status, `${path}.status`, ['streaming', 'complete', 'error']);
  ['avatar', 'tool_args', 'ai_model', 'usage', 'cost', 'reply_to', 'ui_payload', 'code_agent_queued_input']
    .forEach(key => nullableRecord(row[key], `${path}.${key}`));
  nullableStringArray(row.code_agent_image_message_ids, `${path}.code_agent_image_message_ids`);
  return row.id as string;
};

const validateMediaRow = (value: unknown, path: string, messageIds: Set<string>): void => {
  const row = exactKeys(
    value,
    path,
    ['id', 'message_id', 'kind', 'mime_type', 'byte_size', 'created_at'],
    ['filename', 'width', 'height', 'duration_ms'],
  );
  string(row.id, `${path}.id`);
  const messageId = string(row.message_id, `${path}.message_id`);
  if (!messageIds.has(messageId)) fail(`${path}.message_id`, 'a message in the same event');
  oneOf(row.kind, `${path}.kind`, ['image', 'video', 'audio', 'file']);
  string(row.mime_type, `${path}.mime_type`);
  if (typeof row.byte_size !== 'number' || !Number.isFinite(row.byte_size) || row.byte_size < 0) {
    fail(`${path}.byte_size`, 'a non-negative finite number');
  }
  string(row.created_at, `${path}.created_at`);
  if (row.filename !== undefined) nullableString(row.filename, `${path}.filename`);
  ['width', 'height', 'duration_ms'].forEach(key => {
    if (row[key] !== undefined) nullableNumber(row[key], `${path}.${key}`);
  });
};

const TURN_KEYS = [
  'id', 'room_id', 'status', 'started_at', 'completed_at', 'final_message_id', 'backend',
  'assistant_name', 'phase', 'phase_message', 'last_heartbeat_at', 'updated_at',
] as const;

const validateTurnRow = (value: unknown, path: string, roomId: string): void => {
  const row = exactKeys(value, path, TURN_KEYS);
  string(row.id, `${path}.id`);
  if (string(row.room_id, `${path}.room_id`) !== roomId) fail(`${path}.room_id`, `equal to ${roomId}`);
  oneOf(row.status, `${path}.status`, ['running', 'complete', 'error', 'cancelled']);
  string(row.started_at, `${path}.started_at`);
  nullableString(row.completed_at, `${path}.completed_at`);
  nullableString(row.final_message_id, `${path}.final_message_id`);
  oneOf(row.backend, `${path}.backend`, ['code-agent', 'codex', 'codex-app-server']);
  string(row.assistant_name, `${path}.assistant_name`);
  ['phase', 'phase_message', 'last_heartbeat_at'].forEach(key => nullableString(row[key], `${path}.${key}`));
  string(row.updated_at, `${path}.updated_at`);
};

const ROOM_KEYS = [
  'id', 'name', 'description', 'created_at', 'last_activity_at', 'creator_id', 'has_password',
  'posting_schedule', 'type', 'sandbox_id', 'sandbox_status', 'sandbox_updated_at',
  'sandbox_artifact_version', 'sandbox_code_agent_source_ref', 'code_agent_session_id',
  'code_agent_status', 'code_agent_access', 'code_agent_mode', 'code_agent_backend', 'updated_at',
] as const;

const validateRoomRow = (value: unknown, path: string, roomId: string): void => {
  const row = exactKeys(value, path, ROOM_KEYS);
  if (string(row.id, `${path}.id`) !== roomId) fail(`${path}.id`, `equal to ${roomId}`);
  string(row.name, `${path}.name`);
  nullableString(row.description, `${path}.description`);
  string(row.created_at, `${path}.created_at`);
  string(row.last_activity_at, `${path}.last_activity_at`);
  string(row.creator_id, `${path}.creator_id`);
  if (typeof row.has_password !== 'boolean') fail(`${path}.has_password`, 'a boolean');
  nullableRecord(row.posting_schedule, `${path}.posting_schedule`);
  oneOf(row.type, `${path}.type`, ['chat', 'codeAgent']);
  [
    'sandbox_id', 'sandbox_updated_at', 'sandbox_artifact_version', 'sandbox_code_agent_source_ref',
    'code_agent_session_id', 'code_agent_access', 'code_agent_mode', 'code_agent_backend', 'updated_at',
  ].forEach(key => nullableString(row[key], `${path}.${key}`));
  if (row.sandbox_status !== null) oneOf(row.sandbox_status, `${path}.sandbox_status`, ['none', 'creating', 'ready', 'expired', 'error']);
  if (row.code_agent_status !== null) oneOf(row.code_agent_status, `${path}.code_agent_status`, ['idle', 'running', 'error']);
};

export const validateStoredRoomEventPayload = (
  eventType: RoomEventType,
  payload: unknown,
  roomId: string,
): string | null => {
  try {
    switch (eventType) {
      case 'messages.upserted': {
        const value = exactKeys(payload, 'payload', ['messageRows', 'mediaAssets']);
        const messageRows = objectArray(value.messageRows, 'payload.messageRows');
        const ids = new Set(messageRows.map((row, index) => validateMessageRow(
          row,
          `payload.messageRows[${index}]`,
          roomId,
        )));
        if (ids.size !== messageRows.length) fail('payload.messageRows', 'free of duplicate message IDs');
        const mediaAssets = value.mediaAssets;
        if (!Array.isArray(mediaAssets)) fail('payload.mediaAssets', 'an array');
        (mediaAssets as unknown[]).forEach((row, index) => validateMediaRow(
          row,
          `payload.mediaAssets[${index}]`,
          ids,
        ));
        break;
      }
      case 'messages.deleted': {
        const value = exactKeys(payload, 'payload', ['messageIds', 'deletedAt']);
        stringArray(value.messageIds, 'payload.messageIds');
        string(value.deletedAt, 'payload.deletedAt');
        break;
      }
      case 'agent_turns.upserted': {
        const value = exactKeys(payload, 'payload', ['turnRows']);
        objectArray(value.turnRows, 'payload.turnRows').forEach((row, index) => (
          validateTurnRow(row, `payload.turnRows[${index}]`, roomId)
        ));
        break;
      }
      case 'agent_turns.deleted': {
        const value = exactKeys(payload, 'payload', ['turnIds', 'deletedAt']);
        stringArray(value.turnIds, 'payload.turnIds');
        string(value.deletedAt, 'payload.deletedAt');
        break;
      }
      case 'members.changed':
        exactKeys(payload, 'payload', []);
        break;
      case 'room.updated': {
        const value = exactKeys(payload, 'payload', ['roomRow']);
        validateRoomRow(value.roomRow, 'payload.roomRow', roomId);
        break;
      }
      case 'room.deleted': {
        const value = exactKeys(payload, 'payload', ['roomId', 'deletedAt']);
        if (string(value.roomId, 'payload.roomId') !== roomId) fail('payload.roomId', `equal to ${roomId}`);
        string(value.deletedAt, 'payload.deletedAt');
        break;
      }
      default:
        fail('eventType', 'a supported schemaVersion 1 event type');
    }
    return null;
  } catch (error) {
    return error instanceof StoredRoomEventValidationError
      ? error.message
      : 'payload validation failed unexpectedly';
  }
};
