import {
  CODE_AGENT_RUNNER_SCHEMA_VERSION,
  CodeAgentRunnerControlRequest,
  CodeAgentRunnerEvent,
  CodeAgentRunnerProtocolError,
  CodeAgentRunnerRunRequest,
  CodeAgentRunnerThreadListRequest,
  CodeAgentRunnerThreadReadRequest,
  parseCodeAgentRunnerEventLine,
} from './codeAgentRunnerProtocol';

export type CodeAgentDaemonBackend = 'code-agent' | 'codex' | 'codex-app-server';

export interface CodeAgentDaemonHealthRequest {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'health';
  requestId: string;
}

export interface CodeAgentDaemonShutdownRequest {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'shutdown';
  reason?: string;
}

export type CodeAgentDaemonRunRequest = CodeAgentRunnerRunRequest & {
  backend: CodeAgentDaemonBackend;
  env?: Record<string, string>;
};

export type CodeAgentDaemonThreadListRequest = CodeAgentRunnerThreadListRequest & {
  backend?: 'codex-app-server';
  env?: Record<string, string>;
};

export type CodeAgentDaemonThreadReadRequest = CodeAgentRunnerThreadReadRequest & {
  backend?: 'codex-app-server';
  env?: Record<string, string>;
};

export type CodeAgentDaemonThreadQueryRequest =
  | CodeAgentDaemonThreadListRequest
  | CodeAgentDaemonThreadReadRequest;

export type CodeAgentDaemonRequest =
  | CodeAgentDaemonHealthRequest
  | CodeAgentDaemonShutdownRequest
  | CodeAgentDaemonRunRequest
  | CodeAgentRunnerControlRequest
  | CodeAgentDaemonThreadQueryRequest;

export interface CodeAgentDaemonReadyEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'daemon_ready';
  daemonId: string;
  pid?: number;
  backends: CodeAgentDaemonBackend[];
}

export interface CodeAgentDaemonHealthResultEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'health_result';
  requestId?: string | null;
  status: 'ok';
  activeTurnId?: string | null;
}

export interface CodeAgentDaemonStoppingEvent {
  schemaVersion: typeof CODE_AGENT_RUNNER_SCHEMA_VERSION;
  type: 'daemon_stopping';
  reason?: string;
}

export type CodeAgentDaemonControlEvent =
  | CodeAgentDaemonReadyEvent
  | CodeAgentDaemonHealthResultEvent
  | CodeAgentDaemonStoppingEvent;

export type CodeAgentDaemonOutputEvent = CodeAgentRunnerEvent | CodeAgentDaemonControlEvent;

export const serializeCodeAgentDaemonRequest = (request: CodeAgentDaemonRequest): string => {
  return `${JSON.stringify(request)}\n`;
};

export const createCodeAgentDaemonRunRequest = (
  request: CodeAgentRunnerRunRequest,
  backend: CodeAgentDaemonBackend,
  env?: Record<string, string>
): CodeAgentDaemonRunRequest => ({
  ...request,
  backend,
  ...(env ? { env } : {}),
});

export const createCodeAgentDaemonThreadQueryRequest = (
  request: CodeAgentRunnerThreadListRequest | CodeAgentRunnerThreadReadRequest,
  env?: Record<string, string>
): CodeAgentDaemonThreadQueryRequest => ({
  ...request,
  backend: 'codex-app-server',
  ...(env ? { env } : {}),
});

export const parseCodeAgentDaemonEventLine = (line: string): CodeAgentDaemonOutputEvent => {
  const raw = parseRawEvent(line);
  const type = raw.type;
  switch (type) {
    case 'daemon_ready':
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        daemonId: readRequiredString(raw, 'daemonId'),
        pid: readOptionalNumber(raw, 'pid'),
        backends: readBackends(raw),
      };
    case 'health_result':
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        requestId: raw.requestId === null ? null : readOptionalString(raw, 'requestId'),
        status: readHealthStatus(raw),
        activeTurnId: raw.activeTurnId === null ? null : readOptionalString(raw, 'activeTurnId'),
      };
    case 'daemon_stopping':
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type,
        reason: readOptionalString(raw, 'reason'),
      };
    default:
      return parseCodeAgentRunnerEventLine(line);
  }
};

export class CodeAgentDaemonJsonlParser {
  private buffer = '';

  push(chunk: string): CodeAgentDaemonOutputEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    return lines.filter(line => line.trim() !== '').map(parseCodeAgentDaemonEventLine);
  }

  flush(): CodeAgentDaemonOutputEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const event = parseCodeAgentDaemonEventLine(this.buffer);
    this.buffer = '';
    return [event];
  }
}

const parseRawEvent = (line: string): Record<string, unknown> => {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new CodeAgentRunnerProtocolError('Cannot parse an empty code agent daemon event line.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    throw new CodeAgentRunnerProtocolError(`Invalid code agent daemon JSON event: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) {
    throw new CodeAgentRunnerProtocolError('code agent daemon event must be a JSON object.');
  }
  if (raw.schemaVersion !== CODE_AGENT_RUNNER_SCHEMA_VERSION) {
    throw new CodeAgentRunnerProtocolError(`Unsupported code agent daemon schemaVersion: ${String(raw.schemaVersion)}.`);
  }
  return raw;
};

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

const readHealthStatus = (value: Record<string, unknown>): 'ok' => {
  const status = value.status;
  if (status !== 'ok') {
    throw new CodeAgentRunnerProtocolError(`Invalid daemon health status: ${String(status)}.`);
  }
  return status;
};

const readBackends = (value: Record<string, unknown>): CodeAgentDaemonBackend[] => {
  const backends = value.backends;
  if (!Array.isArray(backends) || backends.some(backend => !isCodeAgentDaemonBackend(backend))) {
    throw new CodeAgentRunnerProtocolError('Expected daemon backends to be a supported backend array.');
  }
  return backends;
};

const isCodeAgentDaemonBackend = (value: unknown): value is CodeAgentDaemonBackend => (
  value === 'code-agent' || value === 'codex' || value === 'codex-app-server'
);

export const isCodeAgentDaemonControlEvent = (
  event: CodeAgentDaemonOutputEvent
): event is CodeAgentDaemonControlEvent => (
  event.type === 'daemon_ready' || event.type === 'health_result' || event.type === 'daemon_stopping'
);

export const isCodeAgentDaemonRunnerEvent = (
  event: CodeAgentDaemonOutputEvent
): event is CodeAgentRunnerEvent => !isCodeAgentDaemonControlEvent(event);
