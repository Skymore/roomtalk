import { AIModelProvider, AIUsage, CodexPermissionMode, CodexReasoningEffort } from '../types';

export const CODE_AGENT_RUNNER_SCHEMA_VERSION = 1 as const;

export type CodeAgentRunnerMode = 'plan' | 'edit' | 'approveForMe' | 'fullAccess' | 'acceptEdits';

export type CodeAgentRunnerPriorContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface CodeAgentRunnerPriorMessage {
  role: 'user' | 'assistant';
  content: string | CodeAgentRunnerPriorContentBlock[];
}

export interface CodeAgentRunnerRunRequest {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'run';
  roomId: string;
  clientId?: string;
  turnId: string;
  sessionId?: string | null;
  prompt: string;
  mode: CodeAgentRunnerMode;
  provider: AIModelProvider;
  modelId: string;
  apiModel: string;
  codexModel?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexPermissionMode?: CodexPermissionMode;
  workspace: string;
  allowedPaths: string[];
  priorMessages?: CodeAgentRunnerPriorMessage[];
}

export interface CodeAgentRunnerInterruptRequest {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'interrupt';
  turnId: string;
  reason?: string;
}

export interface CodeAgentRunnerSteerRequest {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'steer';
  turnId: string;
  prompt: string;
}

export type CodeAgentRunnerApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CodeAgentRunnerApprovalResponseRequest {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'approval_response';
  turnId: string;
  approvalId: string;
  decision: CodeAgentRunnerApprovalDecision;
}

export interface CodeAgentRunnerThreadListRequest {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'thread_list';
  roomId: string;
  clientId?: string;
  workspace: string;
  cursor?: string | null;
  limit?: number;
  searchTerm?: string;
}

export interface CodeAgentRunnerThreadReadRequest {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'thread_read';
  roomId: string;
  clientId?: string;
  workspace: string;
  threadId: string;
  includeTurns?: boolean;
}

export type CodeAgentRunnerControlRequest =
  | CodeAgentRunnerInterruptRequest
  | CodeAgentRunnerSteerRequest
  | CodeAgentRunnerApprovalResponseRequest;

export type CodeAgentRunnerRequest =
  | CodeAgentRunnerRunRequest
  | CodeAgentRunnerControlRequest
  | CodeAgentRunnerThreadListRequest
  | CodeAgentRunnerThreadReadRequest;

export interface CodeAgentRunnerStatusEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'status';
  turnId: string;
  status: 'starting' | 'ready' | 'running' | 'complete' | 'error';
  message?: string;
}

export interface CodeAgentRunnerTextDeltaEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'text_delta';
  messageId: string;
  delta: string;
}

export interface CodeAgentRunnerToolCallEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
  messageId?: string;
}

export interface CodeAgentRunnerToolResultEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
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

export interface CodeAgentRunnerFinalEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'final';
  messageId: string;
  answer: string;
  sessionId: string;
  usage?: AIUsage;
}

export interface CodeAgentRunnerErrorEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'error';
  message: string;
  turnId?: string;
  code?: string;
  retryable?: boolean;
}

export interface CodeAgentRunnerApprovalRequestEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'approval_request';
  turnId: string;
  id: string;
  approvalType: 'command' | 'file_change' | 'permissions' | 'exec_command' | 'apply_patch';
  title: string;
  message?: string;
  args: Record<string, unknown>;
  messageId?: string;
}

export interface CodeAgentRunnerThreadListResultEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'thread_list_result';
  roomId: string;
  threads: unknown[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface CodeAgentRunnerThreadReadResultEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'thread_read_result';
  roomId: string;
  thread: unknown;
}

export type CodeAgentRunnerEvent =
  | CodeAgentRunnerStatusEvent
  | CodeAgentRunnerTextDeltaEvent
  | CodeAgentRunnerToolCallEvent
  | CodeAgentRunnerToolResultEvent
  | CodeAgentRunnerFinalEvent
  | CodeAgentRunnerErrorEvent
  | CodeAgentRunnerApprovalRequestEvent
  | CodeAgentRunnerThreadListResultEvent
  | CodeAgentRunnerThreadReadResultEvent;

export class CodeAgentRunnerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeAgentRunnerProtocolError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readRequiredString = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new CodeAgentRunnerProtocolError(`Expected non-empty string field "${key}".`);
  }
  return field;
};

const readString = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new CodeAgentRunnerProtocolError(`Expected string field "${key}".`);
  }
  return field;
};

const readRequiredBoolean = (value: Record<string, unknown>, key: string): boolean => {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new CodeAgentRunnerProtocolError(`Expected boolean field "${key}".`);
  }
  return field;
};

const readOptionalString = (value: Record<string, unknown>, key: string): string | undefined => {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== 'string' || field.length === 0) {
    throw new CodeAgentRunnerProtocolError(`Expected non-empty string field "${key}".`);
  }
  return field;
};

const readOptionalNumber = (value: Record<string, unknown>, key: string): number | undefined => {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw new CodeAgentRunnerProtocolError(`Expected finite number field "${key}".`);
  }
  return field;
};

const readOptionalBoolean = (value: Record<string, unknown>, key: string): boolean | undefined => {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== 'boolean') {
    throw new CodeAgentRunnerProtocolError(`Expected boolean field "${key}".`);
  }
  return field;
};

const readRecord = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const field = value[key];
  if (!isRecord(field)) {
    throw new CodeAgentRunnerProtocolError(`Expected object field "${key}".`);
  }
  return field;
};

const readOptionalUsage = (value: Record<string, unknown>): AIUsage | undefined => {
  const usage = value.usage;
  if (usage === undefined) {
    return undefined;
  }
  if (!isRecord(usage)) {
    throw new CodeAgentRunnerProtocolError('Expected object field "usage".');
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
    throw new CodeAgentRunnerProtocolError('Invalid usage payload.');
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
  if (value.schemaVersion !== CODE_AGENT_RUNNER_SCHEMA_VERSION) {
    throw new CodeAgentRunnerProtocolError(`Unsupported code agent runner schemaVersion: ${String(value.schemaVersion)}.`);
  }
};

export const serializeCodeAgentRunnerRequest = (request: CodeAgentRunnerRequest): string => {
  return `${JSON.stringify(request)}\n`;
};

export const parseCodeAgentRunnerEventLine = (line: string): CodeAgentRunnerEvent => {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new CodeAgentRunnerProtocolError('Cannot parse an empty code agent runner event line.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    throw new CodeAgentRunnerProtocolError(`Invalid code agent runner JSON event: ${(error as Error).message}`);
  }

  if (!isRecord(raw)) {
    throw new CodeAgentRunnerProtocolError('code agent runner event must be a JSON object.');
  }
  assertSchemaVersion(raw);

  const type = raw.type;
  switch (type) {
    case 'status': {
      const status = readRequiredString(raw, 'status');
      if (!['starting', 'ready', 'running', 'complete', 'error'].includes(status)) {
        throw new CodeAgentRunnerProtocolError(`Invalid status event value: ${status}.`);
      }
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        turnId: readRequiredString(raw, 'turnId'),
        status: status as CodeAgentRunnerStatusEvent['status'],
        message: readOptionalString(raw, 'message'),
      };
    }
    case 'text_delta':
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        messageId: readRequiredString(raw, 'messageId'),
        delta: readString(raw, 'delta'),
      };
    case 'tool_call':
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        id: readRequiredString(raw, 'id'),
        name: readRequiredString(raw, 'name'),
        args: readRecord(raw, 'args'),
        messageId: readOptionalString(raw, 'messageId'),
      };
    case 'tool_result':
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
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
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        messageId: readRequiredString(raw, 'messageId'),
        answer: readString(raw, 'answer'),
        sessionId: readRequiredString(raw, 'sessionId'),
        usage: readOptionalUsage(raw),
      };
    case 'error':
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        message: readRequiredString(raw, 'message'),
        turnId: readOptionalString(raw, 'turnId'),
        code: readOptionalString(raw, 'code'),
        retryable: readOptionalBoolean(raw, 'retryable'),
      };
    case 'approval_request': {
      const approvalType = readRequiredString(raw, 'approvalType');
      if (!['command', 'file_change', 'permissions', 'exec_command', 'apply_patch'].includes(approvalType)) {
        throw new CodeAgentRunnerProtocolError(`Invalid approval request type: ${approvalType}.`);
      }
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        turnId: readRequiredString(raw, 'turnId'),
        id: readRequiredString(raw, 'id'),
        approvalType: approvalType as CodeAgentRunnerApprovalRequestEvent['approvalType'],
        title: readRequiredString(raw, 'title'),
        message: readOptionalString(raw, 'message'),
        args: readRecord(raw, 'args'),
        messageId: readOptionalString(raw, 'messageId'),
      };
    }
    case 'thread_list_result': {
      const threads = raw.threads;
      if (!Array.isArray(threads)) {
        throw new CodeAgentRunnerProtocolError('Expected array field "threads".');
      }
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        roomId: readRequiredString(raw, 'roomId'),
        threads,
        nextCursor: raw.nextCursor === null ? null : readOptionalString(raw, 'nextCursor'),
        backwardsCursor: raw.backwardsCursor === null ? null : readOptionalString(raw, 'backwardsCursor'),
      };
    }
    case 'thread_read_result':
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        roomId: readRequiredString(raw, 'roomId'),
        thread: raw.thread,
      };
    default:
      throw new CodeAgentRunnerProtocolError(`Unknown code agent runner event type: ${String(type)}.`);
  }
};

export class CodeAgentRunnerJsonlParser {
  private buffer = '';

  push(chunk: string): CodeAgentRunnerEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    // Fail fast: one malformed line aborts the current turn and the caller must surface that protocol error.
    return lines.filter(line => line.trim() !== '').map(parseCodeAgentRunnerEventLine);
  }

  flush(): CodeAgentRunnerEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const event = parseCodeAgentRunnerEventLine(this.buffer);
    this.buffer = '';
    return [event];
  }
}
