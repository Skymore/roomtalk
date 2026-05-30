import { Message } from './types';

export interface CocoWorkspaceSummary {
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  touchedFiles: string[];
  lastToolName?: string;
}

export interface CodeAgentWorkspaceCommand {
  id: string;
  name: string;
  status: 'started' | 'succeeded' | 'failed';
  exitCode?: number;
  preview?: string;
}

export interface CodeAgentWorkspaceSnapshot {
  roomId: string;
  backend: 'coco';
  source: 'messages';
  generatedAt: string;
  status: {
    sandboxStatus: string;
    agentStatus: string;
    hasSession: boolean;
  };
  summary: CocoWorkspaceSummary;
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
const MAX_PATH_LENGTH = 140;

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

const sanitizeFileRef = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized) return '';

  if (normalized === '/workspace') return '.';
  if (normalized.startsWith('/workspace/')) {
    return truncateMiddle(sanitizeRelativeFileRef(normalized.slice('/workspace/'.length)), MAX_PATH_LENGTH);
  }

  if (normalized.startsWith('/')) {
    const parts = normalized.split('/').filter(Boolean).slice(-3);
    return truncateMiddle(parts.length > 0 ? `.../${parts.join('/')}` : '.', MAX_PATH_LENGTH);
  }

  return truncateMiddle(sanitizeRelativeFileRef(normalized), MAX_PATH_LENGTH);
};

const readFileRef = (args: Record<string, unknown> | undefined): string | null => {
  if (!args) return null;

  for (const key of fileArgKeys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return sanitizeFileRef(value);
    }
  }

  return null;
};

export const summarizeCocoMessages = (messages: Message[]): CocoWorkspaceSummary => {
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

export const mergeCocoWorkspaceSummaries = (
  messageSummary: CocoWorkspaceSummary,
  snapshotSummary?: CocoWorkspaceSummary | null
): CocoWorkspaceSummary => {
  if (!snapshotSummary) {
    return messageSummary;
  }

  const touchedFiles = new Set([
    ...snapshotSummary.touchedFiles,
    ...messageSummary.touchedFiles,
  ]);

  return {
    toolCalls: Math.max(messageSummary.toolCalls, snapshotSummary.toolCalls),
    toolResults: Math.max(messageSummary.toolResults, snapshotSummary.toolResults),
    toolErrors: Math.max(messageSummary.toolErrors, snapshotSummary.toolErrors),
    touchedFiles: Array.from(touchedFiles).sort((a, b) => a.localeCompare(b)),
    lastToolName: messageSummary.lastToolName || snapshotSummary.lastToolName,
  };
};

const getApiBaseUrl = () => {
  const socketUrl = import.meta.env.VITE_SOCKET_URL;

  if (!socketUrl || socketUrl === '/') {
    return '';
  }

  return socketUrl.replace(/\/$/, '');
};

export const fetchCodeAgentWorkspaceSnapshot = async (
  clientId: string,
  roomId: string,
  options: { signal?: AbortSignal } = {}
): Promise<CodeAgentWorkspaceSnapshot> => {
  const response = await fetch(
    `${getApiBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/rooms/${encodeURIComponent(roomId)}/workspace`,
    { signal: options.signal }
  );

  if (!response.ok) {
    throw new Error(`Failed to load workspace snapshot: ${response.status}`);
  }

  const data = await response.json();
  if (
    data?.backend !== 'coco' ||
    data?.source !== 'messages' ||
    !data?.summary ||
    typeof data?.status?.hasSession !== 'boolean' ||
    !Array.isArray(data.summary.touchedFiles)
  ) {
    throw new Error('Workspace snapshot response is invalid');
  }

  return data as CodeAgentWorkspaceSnapshot;
};
