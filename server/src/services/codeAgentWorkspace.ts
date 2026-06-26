import { Message, Room, RoomCocoStatus, RoomSandboxStatus } from '../types';

export interface CodeAgentWorkspaceCommand {
  id: string;
  name: string;
  status: 'started' | 'succeeded' | 'failed';
  exitCode?: number;
  preview?: string;
}

export interface CodeAgentWorkspaceSummary {
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  touchedFiles: string[];
  lastToolName?: string;
}

export interface CodeAgentWorkspaceSnapshot {
  roomId: string;
  backend: 'coco';
  source: 'messages';
  generatedAt: string;
  status: {
    sandboxStatus: RoomSandboxStatus;
    agentStatus: RoomCocoStatus;
    hasSession: boolean;
  };
  summary: CodeAgentWorkspaceSummary;
  files: {
    touched: string[];
    hiddenCount: number;
  };
  changes: {
    available: false;
    changedFiles: string[];
    diffSummary: null;
  };
  commands: CodeAgentWorkspaceCommand[];
}

const fileArgKeys = ['file_path', 'path', 'filename', 'target_file'];
const MAX_VISIBLE_FILES = 40;
const MAX_COMMANDS = 20;
const MAX_PREVIEW_LENGTH = 240;
const MAX_PATH_LENGTH = 140;
const SECRET_VALUE = '[redacted]';

const truncateMiddle = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }
  const prefixLength = Math.max(1, Math.floor((maxLength - 3) / 2));
  const suffixLength = Math.max(1, maxLength - 3 - prefixLength);
  return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
};

const sanitizeRelativeFileRef = (value: string): string => {
  const parts = value
    .replace(/^\.\//, '')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..');
  return parts.length > 0 ? parts.join('/') : '.';
};

export const sanitizeWorkspaceFileRef = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized) return '';

  let sanitized: string;
  if (normalized === '/workspace') {
    sanitized = '.';
  } else if (normalized.startsWith('/workspace/')) {
    sanitized = sanitizeRelativeFileRef(normalized.slice('/workspace/'.length));
  } else if (normalized.startsWith('/')) {
    const parts = normalized.split('/').filter(Boolean).slice(-3);
    sanitized = parts.length > 0 ? `.../${parts.join('/')}` : '.';
  } else {
    sanitized = sanitizeRelativeFileRef(normalized);
  }

  return truncateMiddle(sanitized, MAX_PATH_LENGTH);
};

const readFileRef = (args: Record<string, unknown> | undefined): string | null => {
  if (!args) return null;

  for (const key of fileArgKeys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return sanitizeWorkspaceFileRef(value);
    }
  }

  return null;
};

const truncatePreview = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  const singleLine = redactSecretLikeText(value).replace(/\s+/g, ' ').trim();
  return truncateMiddle(singleLine, MAX_PREVIEW_LENGTH);
};

export const redactSecretLikeText = (value: string): string => value
  .replace(/(".*?(?:api[_-]?key|token|secret|password).*?"\s*:\s*)("[^"]*"|[^,}\s]+)/gi, `$1"${SECRET_VALUE}"`)
  .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+["']?/gi, `$1=${SECRET_VALUE}`)
  .replace(/\b(sk-[A-Za-z0-9_-]{16,}|e2b_[A-Za-z0-9_-]{16,})\b/g, SECRET_VALUE);

const buildCommandHistory = (messages: Message[]): CodeAgentWorkspaceCommand[] => {
  const commands = new Map<string, CodeAgentWorkspaceCommand>();

  for (const message of messages) {
    if (message.messageType === 'tool_call' && message.toolCallId) {
      commands.set(message.toolCallId, {
        id: message.toolCallId,
        name: message.toolName || 'Tool',
        status: 'started',
        preview: truncatePreview(
          typeof message.toolArgs?.command === 'string'
            ? message.toolArgs.command
            : JSON.stringify(message.toolArgs || {})
        ),
      });
    }

    if (message.messageType === 'tool_result' && message.toolCallId) {
      commands.set(message.toolCallId, {
        id: message.toolCallId,
        name: message.toolName || commands.get(message.toolCallId)?.name || 'Tool',
        status: message.isError ? 'failed' : 'succeeded',
        exitCode: message.exitCode,
        preview: truncatePreview(message.toolOutputPreview || message.content),
      });
    }
  }

  return Array.from(commands.values()).slice(-MAX_COMMANDS);
};

export const summarizeWorkspaceMessages = (messages: Message[]): CodeAgentWorkspaceSummary => {
  const touchedFiles = new Set<string>();
  let toolCalls = 0;
  let toolResults = 0;
  let toolErrors = 0;
  let lastToolName: string | undefined;

  for (const message of messages) {
    if (message.messageType === 'tool_call') {
      toolCalls += 1;
      lastToolName = message.toolName || lastToolName;

      const fileRef = readFileRef(message.toolArgs);
      if (fileRef) {
        touchedFiles.add(fileRef);
      }
    }

    if (message.messageType === 'tool_result') {
      toolResults += 1;
      lastToolName = message.toolName || lastToolName;
      if (message.isError) {
        toolErrors += 1;
      }
    }
  }

  return {
    toolCalls,
    toolResults,
    toolErrors,
    touchedFiles: Array.from(touchedFiles).sort((a, b) => a.localeCompare(b)),
    lastToolName,
  };
};

export const buildCodeAgentWorkspaceSnapshot = (
  room: Room,
  messages: Message[],
  now = new Date()
): CodeAgentWorkspaceSnapshot => {
  const summary = summarizeWorkspaceMessages(messages);
  const visibleFiles = summary.touchedFiles.slice(0, MAX_VISIBLE_FILES);

  return {
    roomId: room.id,
    backend: 'coco',
    source: 'messages',
    generatedAt: now.toISOString(),
    status: {
      sandboxStatus: room.sandboxStatus || 'none',
      agentStatus: room.cocoStatus || 'idle',
      hasSession: Boolean(room.cocoSessionId),
    },
    summary,
    files: {
      touched: visibleFiles,
      hiddenCount: Math.max(0, summary.touchedFiles.length - visibleFiles.length),
    },
    changes: {
      available: false,
      changedFiles: [],
      diffSummary: null,
    },
    commands: buildCommandHistory(messages),
  };
};
