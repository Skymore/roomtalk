import { Message, Room, RoomCodeAgentStatus, RoomSandboxStatus } from '../types';
import { CodeAgentWorkspaceChanges } from './codeAgentSandboxService';

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
  lastToolName?: string;
}

export interface CodeAgentWorkspaceArtifact {
  slug: string;
  url: string;
  entry: string;
  versionId: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
  title?: string;
  versions: CodeAgentWorkspaceArtifactVersion[];
}

export interface CodeAgentWorkspaceArtifactVersion {
  versionId: string;
  url: string;
  entry: string;
  fileCount: number;
  totalBytes: number;
  publishedAt: string;
  isCurrent: boolean;
}

export interface CodeAgentWorkspaceSnapshot {
  roomId: string;
  backend: 'code-agent';
  source: 'sandbox';
  generatedAt: string;
  workspaceRoot?: string;
  status: {
    sandboxStatus: RoomSandboxStatus;
    agentStatus: RoomCodeAgentStatus;
    hasSession: boolean;
  };
  summary: CodeAgentWorkspaceSummary;
  artifacts: CodeAgentWorkspaceArtifact[];
  changes: {
    available: boolean;
    changedFiles: string[];
    changedFileStats: CodeAgentWorkspaceChanges['changedFileStats'];
    diffSummary: CodeAgentWorkspaceChanges['diffSummary'];
  };
  commands: CodeAgentWorkspaceCommand[];
}

const MAX_COMMANDS = 20;
const MAX_PREVIEW_LENGTH = 240;
const MAX_PREVIEW_REDACTION_LENGTH = 4_096;
const SECRET_VALUE = '[redacted]';

const truncateMiddle = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }
  const prefixLength = Math.max(1, Math.floor((maxLength - 3) / 2));
  const suffixLength = Math.max(1, maxLength - 3 - prefixLength);
  return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
};

const truncatePreview = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  const bounded = truncateMiddle(value, MAX_PREVIEW_REDACTION_LENGTH);
  const singleLine = redactSecretLikeText(bounded).replace(/\s+/g, ' ').trim();
  return truncateMiddle(singleLine, MAX_PREVIEW_LENGTH);
};

export const redactSecretLikeText = (value: string): string => value
  .replace(/(".*?(?:api[_-]?key|token|secret|password).*?"\s*:\s*)("[^"]*"|[^,}\s]+)/gi, `$1"${SECRET_VALUE}"`)
  .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+["']?/gi, `$1=${SECRET_VALUE}`)
  .replace(/\b(sk-[A-Za-z0-9_-]{16,}|e2b_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,})\b/g, SECRET_VALUE);

const buildCommandHistory = (messages: Message[]): CodeAgentWorkspaceCommand[] => {
  const commandOrder: string[] = [];
  const seenCommandIds = new Set<string>();
  for (const message of messages) {
    if (
      (message.messageType === 'tool_call' || message.messageType === 'tool_result') &&
      message.toolCallId &&
      !seenCommandIds.has(message.toolCallId)
    ) {
      seenCommandIds.add(message.toolCallId);
      commandOrder.push(message.toolCallId);
    }
  }
  const selectedCommandIds = new Set(commandOrder.slice(-MAX_COMMANDS));
  const commands = new Map<string, CodeAgentWorkspaceCommand>();

  for (const message of messages) {
    if (!message.toolCallId || !selectedCommandIds.has(message.toolCallId)) continue;
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

  return commandOrder
    .slice(-MAX_COMMANDS)
    .map(toolCallId => commands.get(toolCallId))
    .filter((command): command is CodeAgentWorkspaceCommand => Boolean(command));
};

export const summarizeWorkspaceMessages = (messages: Message[]): CodeAgentWorkspaceSummary => {
  let toolCalls = 0;
  let toolResults = 0;
  let toolErrors = 0;
  let lastToolName: string | undefined;

  for (const message of messages) {
    if (message.messageType === 'tool_call') {
      toolCalls += 1;
      lastToolName = message.toolName || lastToolName;
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
    lastToolName,
  };
};

export const buildCodeAgentWorkspaceSnapshot = (
  room: Room,
  messages: Message[],
  now = new Date(),
  changes: CodeAgentWorkspaceChanges = {
    available: false,
    changedFiles: [],
    changedFileStats: [],
    diffSummary: null,
  },
  artifacts: CodeAgentWorkspaceArtifact[] = [],
  workspaceRoot?: string | null
): CodeAgentWorkspaceSnapshot => {
  return {
    roomId: room.id,
    backend: 'code-agent',
    source: 'sandbox',
    generatedAt: now.toISOString(),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    status: {
      sandboxStatus: room.sandboxStatus || 'none',
      agentStatus: room.codeAgentStatus || 'idle',
      hasSession: Boolean(room.codeAgentSessionId),
    },
    summary: summarizeWorkspaceMessages(messages),
    artifacts,
    changes,
    commands: buildCommandHistory(messages),
  };
};
