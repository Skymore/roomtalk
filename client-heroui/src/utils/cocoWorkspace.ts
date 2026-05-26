import { Message } from './types';

export interface CocoWorkspaceSummary {
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  touchedFiles: string[];
  lastToolName?: string;
}

const fileArgKeys = ['file_path', 'path', 'filename', 'target_file'];

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
    return sanitizeRelativeFileRef(normalized.slice('/workspace/'.length));
  }

  if (normalized.startsWith('/')) {
    const parts = normalized.split('/').filter(Boolean).slice(-3);
    return parts.length > 0 ? `.../${parts.join('/')}` : '.';
  }

  return sanitizeRelativeFileRef(normalized);
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
