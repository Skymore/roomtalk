import path from 'path';
import { AIUsage } from '../types';
import {
  COCO_RUNNER_SCHEMA_VERSION,
  CocoRunnerEvent,
  CocoRunnerFinalEvent,
} from './cocoRunnerProtocol';

export interface CodexExecItem {
  id: string;
  type: string;
  status?: string;
  text?: string;
  command?: string;
  exit_code?: number | null;
  aggregated_output?: string;
  changes?: Array<{ path: string; kind: string }>;
}

export interface CodexExecUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
}

export interface CodexExecEvent {
  type: string;
  thread_id?: string;
  item?: CodexExecItem;
  message?: string;
  error?: string;
  usage?: CodexExecUsage;
}

export interface CodexCliEventMapperOptions {
  turnId: string;
  messageId: string;
  workspace: string;
  fallbackSessionId?: string;
}

export interface CodexCliEventMapperSnapshot {
  sessionId?: string;
  usage?: AIUsage;
  ignoredItemTypes: Record<string, number>;
}

export class CodexCliEventMapperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexCliEventMapperError';
  }
}

export class CodexExecJsonlParser {
  private buffer = '';

  push(chunk: string): CodexExecEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    return lines.filter(line => line.trim() !== '').map((line, index) => parseCodexExecEventLine(line, index + 1));
  }

  flush(): CodexExecEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const event = parseCodexExecEventLine(this.buffer, 1);
    this.buffer = '';
    return [event];
  }
}

export class CodexCliDiagnosticsTail {
  private tail = '';

  constructor(private readonly maxChars = 4000) {}

  push(chunk: string | Buffer) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    this.tail = `${this.tail}${text}`.slice(-this.maxChars);
  }

  getTail() {
    return this.tail.trim();
  }
}

export class CodexCliEventMapper {
  private sessionId?: string;
  private usage?: AIUsage;
  private readonly ignoredItemTypes: Record<string, number> = {};
  private readonly commandToolNames: Record<string, string> = {};

  constructor(private readonly options: CodexCliEventMapperOptions) {}

  mapEvent(event: CodexExecEvent): CocoRunnerEvent[] {
    if (event.type === 'thread.started') {
      this.sessionId = event.thread_id || this.sessionId;
      return [{
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'status',
        turnId: this.options.turnId,
        status: 'starting',
        message: 'codex thread started',
      }];
    }

    if (event.type === 'turn.started') {
      return [{
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'status',
        turnId: this.options.turnId,
        status: 'running',
        message: 'codex turn started',
      }];
    }

    if (event.type === 'turn.completed') {
      this.usage = toAIUsage(event.usage) || this.usage;
      return [{
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'status',
        turnId: this.options.turnId,
        status: 'complete',
        message: 'codex turn completed',
      }];
    }

    if (event.type === 'turn.failed' || event.type === 'error') {
      return [{
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'error',
        turnId: this.options.turnId,
        message: event.message || event.error || 'Codex CLI turn failed',
        code: 'codex_cli_error',
        retryable: false,
      }];
    }

    const item = event.item;
    if (!item) {
      return [];
    }

    if (item.type === 'agent_message' && event.type === 'item.completed') {
      return [{
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'text_delta',
        messageId: this.options.messageId,
        delta: `${normalizeWorkspaceText(this.options.workspace, item.text || '')}\n\n`,
      }];
    }

    if (item.type === 'command_execution' && event.type === 'item.started') {
      const command = item.command || '';
      const toolName = roomtalkToolName(command) || 'shell';
      this.commandToolNames[item.id] = toolName;
      return [{
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'tool_call',
        id: item.id,
        name: toolName,
        args: { command },
        messageId: `codex_tool_${item.id}`,
      }];
    }

    if (item.type === 'command_execution' && event.type === 'item.completed') {
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
      const command = item.command || '';
      const toolName = roomtalkToolName(command) || this.commandToolNames[item.id] || 'shell';
      return [{
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'tool_result',
        id: item.id,
        name: toolName,
        success: item.status === 'completed' && (exitCode === undefined || exitCode === 0),
        output: normalizeWorkspaceText(this.options.workspace, item.aggregated_output || ''),
        messageId: `codex_tool_result_${item.id}`,
        exitCode,
      }];
    }

    if (item.type === 'file_change' && event.type === 'item.started') {
      const changes = normalizeChanges(this.options.workspace, item.changes);
      return [{
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'tool_call',
        id: item.id,
        name: 'file_change',
        args: { changes },
        messageId: `codex_tool_${item.id}`,
      }];
    }

    if (item.type === 'file_change' && event.type === 'item.completed') {
      const changes = normalizeChanges(this.options.workspace, item.changes);
      return [{
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'tool_result',
        id: item.id,
        name: 'file_change',
        success: item.status === 'completed',
        output: summarizeFileChanges(changes),
        messageId: `codex_tool_result_${item.id}`,
      }];
    }

    if (event.type === 'item.started' || event.type === 'item.completed') {
      this.ignoredItemTypes[item.type] = (this.ignoredItemTypes[item.type] || 0) + 1;
    }
    return [];
  }

  createFinalEvent(answer: string): CocoRunnerFinalEvent {
    return {
      schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
      type: 'final',
      messageId: this.options.messageId,
      answer: normalizeWorkspaceText(this.options.workspace, answer),
      sessionId: this.sessionId || this.options.fallbackSessionId || 'codex-cli-session',
      usage: this.usage,
    };
  }

  snapshot(): CodexCliEventMapperSnapshot {
    return {
      sessionId: this.sessionId,
      usage: this.usage,
      ignoredItemTypes: { ...this.ignoredItemTypes },
    };
  }
}

export const parseCodexExecEventLine = (line: string, lineNumber = 1): CodexExecEvent => {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new CodexCliEventMapperError('Cannot parse an empty Codex exec JSONL line.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    throw new CodexCliEventMapperError(`Invalid Codex exec JSONL at line ${lineNumber}: ${(error as Error).message}`);
  }

  if (!isRecord(raw)) {
    throw new CodexCliEventMapperError(`Invalid Codex exec JSONL at line ${lineNumber}: event must be an object.`);
  }
  if (typeof raw.type !== 'string' || raw.type.length === 0) {
    throw new CodexCliEventMapperError(`Invalid Codex exec JSONL at line ${lineNumber}: missing event type.`);
  }

  return raw as unknown as CodexExecEvent;
};

export const normalizeWorkspacePath = (workspace: string, value: string) => {
  if (!path.isAbsolute(value)) {
    return value;
  }
  const relative = path.relative(workspace, value);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return value;
  }
  return relative;
};

export const normalizeWorkspaceText = (workspace: string, value: string) => {
  const normalizedWorkspace = workspace.replace(/\/+$/, '');
  if (!normalizedWorkspace) {
    return value;
  }
  const workspacePattern = new RegExp(`${escapeRegExp(normalizedWorkspace)}/`, 'g');
  return value.replace(workspacePattern, '');
};

const normalizeChanges = (workspace: string, changes: Array<{ path: string; kind: string }> = []) => {
  return changes.map(change => ({
    ...change,
    path: normalizeWorkspacePath(workspace, change.path),
  }));
};

const summarizeFileChanges = (changes: Array<{ path: string; kind: string }> = []) => {
  return changes.map(change => `${change.kind} ${change.path}`).join('\n');
};

const roomtalkToolName = (command: string) => {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized.includes('roomtalk publish-static-site') || normalized.includes('platform_tools publish-static-site')) {
    return 'PublishStaticSite';
  }
  if (normalized.includes('roomtalk background-shell') || normalized.includes('platform_tools background-shell')) {
    return 'BackgroundShell';
  }
  return undefined;
};

const toAIUsage = (usage: CodexExecUsage | undefined): AIUsage | undefined => {
  if (!usage) {
    return undefined;
  }
  const promptTokens = usage.input_tokens;
  const completionTokens = usage.output_tokens;
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') {
    return undefined;
  }
  const totalTokens = typeof usage.total_tokens === 'number'
    ? usage.total_tokens
    : promptTokens + completionTokens;
  const parsed: AIUsage = {
    promptTokens,
    completionTokens,
    totalTokens,
    source: 'reported',
  };
  if (typeof usage.cached_input_tokens === 'number') {
    parsed.cachedPromptTokens = usage.cached_input_tokens;
    parsed.cacheHitRate = promptTokens > 0 ? usage.cached_input_tokens / promptTokens : 0;
  }
  return parsed;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};
