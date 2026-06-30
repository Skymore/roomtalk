import { Message, Room, RoomCocoStatus, RoomSandboxStatus } from '../types';
import { CocoWorkspaceChanges } from './cocoSandboxService';

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

export interface CodeAgentWorkspaceSnapshot {
  roomId: string;
  backend: 'coco';
  source: 'sandbox';
  generatedAt: string;
  status: {
    sandboxStatus: RoomSandboxStatus;
    agentStatus: RoomCocoStatus;
    hasSession: boolean;
  };
  summary: CodeAgentWorkspaceSummary;
  changes: {
    available: boolean;
    changedFiles: string[];
    diffSummary: CocoWorkspaceChanges['diffSummary'];
  };
  commands: CodeAgentWorkspaceCommand[];
}

const MAX_COMMANDS = 20;
const MAX_PREVIEW_LENGTH = 240;
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
  changes: CocoWorkspaceChanges = {
    available: false,
    changedFiles: [],
    diffSummary: null,
  }
): CodeAgentWorkspaceSnapshot => {
  return {
    roomId: room.id,
    backend: 'coco',
    source: 'sandbox',
    generatedAt: now.toISOString(),
    status: {
      sandboxStatus: room.sandboxStatus || 'none',
      agentStatus: room.cocoStatus || 'idle',
      hasSession: Boolean(room.cocoSessionId),
    },
    summary: summarizeWorkspaceMessages(messages),
    changes,
    commands: buildCommandHistory(messages),
  };
};
