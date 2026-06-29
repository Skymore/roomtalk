import { AIModelProvider, AIUsage } from '../types';

export const COCO_RUNNER_SCHEMA_VERSION = 1 as const;

export type CocoRunnerMode = 'plan' | 'acceptEdits';

export type CocoRunnerPriorContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface CocoRunnerPriorMessage {
  role: 'user' | 'assistant';
  content: string | CocoRunnerPriorContentBlock[];
}

export interface CocoRunnerRunRequest {
  schemaVersion: typeof COCO_RUNNER_SCHEMA_VERSION;
  type: 'run';
  roomId: string;
  turnId: string;
  sessionId?: string | null;
  prompt: string;
  mode: CocoRunnerMode;
  provider: AIModelProvider;
  modelId: string;
  apiModel: string;
  workspace: string;
  allowedPaths: string[];
  priorMessages?: CocoRunnerPriorMessage[];
}

export interface CocoRunnerStatusEvent {
  schemaVersion: typeof COCO_RUNNER_SCHEMA_VERSION;
  type: 'status';
  turnId: string;
  status: 'starting' | 'ready' | 'running' | 'complete' | 'error';
  message?: string;
}

export interface CocoRunnerTextDeltaEvent {
  schemaVersion: typeof COCO_RUNNER_SCHEMA_VERSION;
  type: 'text_delta';
  messageId: string;
  delta: string;
}

export interface CocoRunnerToolCallEvent {
  schemaVersion: typeof COCO_RUNNER_SCHEMA_VERSION;
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
  messageId?: string;
}

export interface CocoRunnerToolResultEvent {
  schemaVersion: typeof COCO_RUNNER_SCHEMA_VERSION;
  type: 'tool_result';
  id: string;
  name: string;
  success: boolean;
  output: string;
  messageId?: string;
  exitCode?: number;
  elapsedMs?: number;
  truncated?: boolean;
}

export interface CocoRunnerFinalEvent {
  schemaVersion: typeof COCO_RUNNER_SCHEMA_VERSION;
  type: 'final';
  messageId: string;
  answer: string;
  sessionId: string;
  usage?: AIUsage;
}

export interface CocoRunnerErrorEvent {
  schemaVersion: typeof COCO_RUNNER_SCHEMA_VERSION;
  type: 'error';
  message: string;
  turnId?: string;
  code?: string;
  retryable?: boolean;
}

export type CocoRunnerEvent =
  | CocoRunnerStatusEvent
  | CocoRunnerTextDeltaEvent
  | CocoRunnerToolCallEvent
  | CocoRunnerToolResultEvent
  | CocoRunnerFinalEvent
  | CocoRunnerErrorEvent;

export class CocoRunnerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CocoRunnerProtocolError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readRequiredString = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new CocoRunnerProtocolError(`Expected non-empty string field "${key}".`);
  }
  return field;
};

const readString = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new CocoRunnerProtocolError(`Expected string field "${key}".`);
  }
  return field;
};

const readRequiredBoolean = (value: Record<string, unknown>, key: string): boolean => {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new CocoRunnerProtocolError(`Expected boolean field "${key}".`);
  }
  return field;
};

const readOptionalString = (value: Record<string, unknown>, key: string): string | undefined => {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== 'string' || field.length === 0) {
    throw new CocoRunnerProtocolError(`Expected non-empty string field "${key}".`);
  }
  return field;
};

const readOptionalNumber = (value: Record<string, unknown>, key: string): number | undefined => {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw new CocoRunnerProtocolError(`Expected finite number field "${key}".`);
  }
  return field;
};

const readOptionalBoolean = (value: Record<string, unknown>, key: string): boolean | undefined => {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== 'boolean') {
    throw new CocoRunnerProtocolError(`Expected boolean field "${key}".`);
  }
  return field;
};

const readRecord = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const field = value[key];
  if (!isRecord(field)) {
    throw new CocoRunnerProtocolError(`Expected object field "${key}".`);
  }
  return field;
};

const readOptionalUsage = (value: Record<string, unknown>): AIUsage | undefined => {
  const usage = value.usage;
  if (usage === undefined) {
    return undefined;
  }
  if (!isRecord(usage)) {
    throw new CocoRunnerProtocolError('Expected object field "usage".');
  }

  const promptTokens = usage.promptTokens;
  const completionTokens = usage.completionTokens;
  const totalTokens = usage.totalTokens;
  const source = usage.source;

  if (
    typeof promptTokens !== 'number' ||
    typeof completionTokens !== 'number' ||
    typeof totalTokens !== 'number' ||
    (source !== 'reported' && source !== 'estimated')
  ) {
    throw new CocoRunnerProtocolError('Invalid usage payload.');
  }

  const parsed: AIUsage = {
    promptTokens,
    completionTokens,
    totalTokens,
    source,
  };

  if (typeof usage.cachedPromptTokens === 'number') {
    parsed.cachedPromptTokens = usage.cachedPromptTokens;
  }
  if (typeof usage.cacheHitRate === 'number') {
    parsed.cacheHitRate = usage.cacheHitRate;
  }

  return parsed;
};

const assertSchemaVersion = (value: Record<string, unknown>) => {
  if (value.schemaVersion !== COCO_RUNNER_SCHEMA_VERSION) {
    throw new CocoRunnerProtocolError(`Unsupported Coco runner schemaVersion: ${String(value.schemaVersion)}.`);
  }
};

export const serializeCocoRunnerRequest = (request: CocoRunnerRunRequest): string => {
  return `${JSON.stringify(request)}\n`;
};

export const parseCocoRunnerEventLine = (line: string): CocoRunnerEvent => {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new CocoRunnerProtocolError('Cannot parse an empty Coco runner event line.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    throw new CocoRunnerProtocolError(`Invalid Coco runner JSON event: ${(error as Error).message}`);
  }

  if (!isRecord(raw)) {
    throw new CocoRunnerProtocolError('Coco runner event must be a JSON object.');
  }
  assertSchemaVersion(raw);

  const type = raw.type;
  switch (type) {
    case 'status': {
      const status = readRequiredString(raw, 'status');
      if (!['starting', 'ready', 'running', 'complete', 'error'].includes(status)) {
        throw new CocoRunnerProtocolError(`Invalid status event value: ${status}.`);
      }
      return {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type,
        turnId: readRequiredString(raw, 'turnId'),
        status: status as CocoRunnerStatusEvent['status'],
        message: readOptionalString(raw, 'message'),
      };
    }
    case 'text_delta':
      return {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type,
        messageId: readRequiredString(raw, 'messageId'),
        delta: readString(raw, 'delta'),
      };
    case 'tool_call':
      return {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type,
        id: readRequiredString(raw, 'id'),
        name: readRequiredString(raw, 'name'),
        args: readRecord(raw, 'args'),
        messageId: readOptionalString(raw, 'messageId'),
      };
    case 'tool_result':
      return {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type,
        id: readRequiredString(raw, 'id'),
        name: readRequiredString(raw, 'name'),
        success: readRequiredBoolean(raw, 'success'),
        output: readString(raw, 'output'),
        messageId: readOptionalString(raw, 'messageId'),
        exitCode: readOptionalNumber(raw, 'exitCode'),
        elapsedMs: readOptionalNumber(raw, 'elapsedMs'),
        truncated: readOptionalBoolean(raw, 'truncated'),
      };
    case 'final':
      return {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type,
        messageId: readRequiredString(raw, 'messageId'),
        answer: readString(raw, 'answer'),
        sessionId: readRequiredString(raw, 'sessionId'),
        usage: readOptionalUsage(raw),
      };
    case 'error':
      return {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type,
        message: readRequiredString(raw, 'message'),
        turnId: readOptionalString(raw, 'turnId'),
        code: readOptionalString(raw, 'code'),
        retryable: readOptionalBoolean(raw, 'retryable'),
      };
    default:
      throw new CocoRunnerProtocolError(`Unknown Coco runner event type: ${String(type)}.`);
  }
};

export class CocoRunnerJsonlParser {
  private buffer = '';

  push(chunk: string): CocoRunnerEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    // Fail fast: one malformed line aborts the current turn and the caller must surface that protocol error.
    return lines.filter(line => line.trim() !== '').map(parseCocoRunnerEventLine);
  }

  flush(): CocoRunnerEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const event = parseCocoRunnerEventLine(this.buffer);
    this.buffer = '';
    return [event];
  }
}
