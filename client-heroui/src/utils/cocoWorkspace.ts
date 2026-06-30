import { Message } from './types';

export interface CocoWorkspaceSummary {
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  lastToolName?: string;
}

export interface CodeAgentWorkspaceCommand {
  id: string;
  name: string;
  status: 'started' | 'succeeded' | 'failed';
  exitCode?: number;
  preview?: string;
}

export interface CodeAgentWorkspaceDiffSummary {
  files: number;
  additions: number;
  deletions: number;
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
}

export interface CodeAgentWorkspaceDiff {
  available: boolean;
  patch: string;
  byteSize: number;
  truncated: boolean;
}

export interface CodeAgentWorkspaceSnapshot {
  roomId: string;
  backend: 'coco';
  source: 'sandbox';
  generatedAt: string;
  status: {
    sandboxStatus: string;
    agentStatus: string;
    hasSession: boolean;
  };
  summary: CocoWorkspaceSummary;
  artifacts: CodeAgentWorkspaceArtifact[];
  changes: {
    available: boolean;
    changedFiles: string[];
    diffSummary: CodeAgentWorkspaceDiffSummary | null;
  };
  commands: CodeAgentWorkspaceCommand[];
}

const validateWorkspaceDiff = (value: unknown): CodeAgentWorkspaceDiff => {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace diff response is invalid');
  }
  const diff = value as Partial<CodeAgentWorkspaceDiff>;
  if (
    typeof diff.available !== 'boolean' ||
    typeof diff.patch !== 'string' ||
    typeof diff.byteSize !== 'number' ||
    typeof diff.truncated !== 'boolean'
  ) {
    throw new Error('Workspace diff response is invalid');
  }

  return {
    available: diff.available,
    patch: diff.patch,
    byteSize: diff.byteSize,
    truncated: diff.truncated,
  };
};

export const summarizeCocoMessages = (messages: Message[]): CocoWorkspaceSummary => {
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

export const loadCodeAgentWorkspaceDiff = async (
  roomId: string,
  options: { signal?: AbortSignal; ignoreWhitespace?: boolean } = {}
): Promise<CodeAgentWorkspaceDiff> => {
  if (options.signal?.aborted) {
    throw new Error('Workspace diff request aborted');
  }

  const { requestCodeWorkspaceDiff } = await import('./socket');
  const data = await requestCodeWorkspaceDiff(roomId, {
    ignoreWhitespace: options.ignoreWhitespace === true,
  });
  if (options.signal?.aborted) {
    throw new Error('Workspace diff request aborted');
  }

  return validateWorkspaceDiff(data);
};

export const loadCodeAgentWorkspaceSnapshot = async (
  roomId: string,
  options: { signal?: AbortSignal } = {}
): Promise<CodeAgentWorkspaceSnapshot> => {
  if (options.signal?.aborted) {
    throw new Error('Workspace snapshot request aborted');
  }

  const { requestCodeAgentWorkspaceSnapshot } = await import('./socket');
  const data = await requestCodeAgentWorkspaceSnapshot(roomId);
  if (options.signal?.aborted) {
    throw new Error('Workspace snapshot request aborted');
  }
  const snapshot = data as Partial<CodeAgentWorkspaceSnapshot> | null | undefined;
  if (
    snapshot?.backend !== 'coco' ||
    snapshot?.source !== 'sandbox' ||
    !snapshot?.summary ||
    typeof snapshot?.status?.hasSession !== 'boolean' ||
    typeof snapshot.summary.toolCalls !== 'number' ||
    typeof snapshot.summary.toolResults !== 'number' ||
    typeof snapshot.summary.toolErrors !== 'number'
  ) {
    throw new Error('Workspace snapshot response is invalid');
  }

  return {
    ...snapshot,
    artifacts: Array.isArray(snapshot.artifacts) ? snapshot.artifacts : [],
  } as CodeAgentWorkspaceSnapshot;
};
