import { Message } from './types';

export interface CodeAgentWorkspaceSummary {
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

export interface CodeAgentWorkspaceChangedFileStat {
  path: string;
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
  headRef?: string;
  baseRef?: string;
}

export type CodeAgentWorkspaceDiffScope = 'branch' | 'unstaged';

export interface CodeAgentWorkspaceRef {
  name: string;
  kind: 'local' | 'remote';
  remoteName?: string;
}

export interface CodeAgentWorkspaceRefs {
  available: boolean;
  refs: CodeAgentWorkspaceRef[];
  headRef?: string;
}

export interface CodeAgentWorkspaceSnapshot {
  roomId: string;
  backend: 'code-agent';
  source: 'sandbox';
  generatedAt: string;
  workspaceRoot?: string;
  status: {
    sandboxStatus: string;
    agentStatus: string;
    hasSession: boolean;
  };
  summary: CodeAgentWorkspaceSummary;
  artifacts: CodeAgentWorkspaceArtifact[];
  changes: {
    available: boolean;
    changedFiles: string[];
    changedFileStats: CodeAgentWorkspaceChangedFileStat[];
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
    ...(typeof diff.headRef === 'string' && diff.headRef ? { headRef: diff.headRef } : {}),
    ...(typeof diff.baseRef === 'string' && diff.baseRef ? { baseRef: diff.baseRef } : {}),
  };
};

const validateWorkspaceRefs = (value: unknown): CodeAgentWorkspaceRefs => {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace refs response is invalid');
  }
  const refsValue = value as Partial<CodeAgentWorkspaceRefs>;
  if (typeof refsValue.available !== 'boolean' || !Array.isArray(refsValue.refs)) {
    throw new Error('Workspace refs response is invalid');
  }

  return {
    available: refsValue.available,
    refs: refsValue.refs.flatMap((ref): CodeAgentWorkspaceRef[] => {
      if (
        !ref ||
        typeof ref !== 'object' ||
        typeof ref.name !== 'string' ||
        (ref.kind !== 'local' && ref.kind !== 'remote')
      ) {
        return [];
      }
      return [{
        name: ref.name,
        kind: ref.kind,
        ...(typeof ref.remoteName === 'string' && ref.remoteName ? { remoteName: ref.remoteName } : {}),
      }];
    }),
    ...(typeof refsValue.headRef === 'string' && refsValue.headRef ? { headRef: refsValue.headRef } : {}),
  };
};

const sanitizeChangedFileStats = (value: unknown): CodeAgentWorkspaceChangedFileStat[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): CodeAgentWorkspaceChangedFileStat[] => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const stat = item as Partial<CodeAgentWorkspaceChangedFileStat>;
    if (
      typeof stat.path !== 'string' ||
      !stat.path.trim() ||
      typeof stat.additions !== 'number' ||
      typeof stat.deletions !== 'number' ||
      !Number.isFinite(stat.additions) ||
      !Number.isFinite(stat.deletions)
    ) {
      return [];
    }
    return [{
      path: stat.path,
      additions: stat.additions,
      deletions: stat.deletions,
    }];
  });
};

const sanitizeWorkspaceChanges = (
  value: Partial<CodeAgentWorkspaceSnapshot>['changes'],
): CodeAgentWorkspaceSnapshot['changes'] => {
  const changes = value as Partial<CodeAgentWorkspaceSnapshot['changes']> | undefined;
  const diffSummary = changes?.diffSummary && typeof changes.diffSummary === 'object'
    && typeof changes.diffSummary.files === 'number'
    && typeof changes.diffSummary.additions === 'number'
    && typeof changes.diffSummary.deletions === 'number'
    ? changes.diffSummary
    : null;

  return {
    available: typeof changes?.available === 'boolean' ? changes.available : false,
    changedFiles: Array.isArray(changes?.changedFiles)
      ? changes.changedFiles.filter((path): path is string => typeof path === 'string')
      : [],
    changedFileStats: sanitizeChangedFileStats(changes?.changedFileStats),
    diffSummary,
  };
};

export const summarizeCodeAgentMessages = (messages: Message[]): CodeAgentWorkspaceSummary => {
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
  options: { signal?: AbortSignal; ignoreWhitespace?: boolean; scope?: CodeAgentWorkspaceDiffScope; baseRef?: string | null } = {}
): Promise<CodeAgentWorkspaceDiff> => {
  if (options.signal?.aborted) {
    throw new Error('Workspace diff request aborted');
  }

  const { requestCodeWorkspaceDiff } = await import('./socket');
  const data = await requestCodeWorkspaceDiff(roomId, {
    ignoreWhitespace: options.ignoreWhitespace === true,
    scope: options.scope ?? 'branch',
    baseRef: typeof options.baseRef === 'string' && options.baseRef.trim() ? options.baseRef.trim() : undefined,
  });
  if (options.signal?.aborted) {
    throw new Error('Workspace diff request aborted');
  }

  return validateWorkspaceDiff(data);
};

export const loadCodeAgentWorkspaceRefs = async (
  roomId: string,
  options: { signal?: AbortSignal; query?: string; limit?: number } = {},
): Promise<CodeAgentWorkspaceRefs> => {
  if (options.signal?.aborted) {
    throw new Error('Workspace refs request aborted');
  }

  const { requestCodeWorkspaceRefs } = await import('./socket');
  const data = await requestCodeWorkspaceRefs(roomId, {
    query: options.query,
    limit: options.limit,
  });
  if (options.signal?.aborted) {
    throw new Error('Workspace refs request aborted');
  }

  return validateWorkspaceRefs(data);
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
    snapshot?.backend !== 'code-agent' ||
    snapshot?.source !== 'sandbox' ||
    !snapshot?.summary ||
    typeof snapshot?.status?.hasSession !== 'boolean' ||
    typeof snapshot.summary.toolCalls !== 'number' ||
    typeof snapshot.summary.toolResults !== 'number' ||
    typeof snapshot.summary.toolErrors !== 'number'
  ) {
    throw new Error('Workspace snapshot response is invalid');
  }

  const workspaceRoot = typeof snapshot.workspaceRoot === 'string' && snapshot.workspaceRoot.trim()
    ? snapshot.workspaceRoot.trim()
    : undefined;

  return {
    ...snapshot,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    artifacts: Array.isArray(snapshot.artifacts) ? snapshot.artifacts : [],
    changes: sanitizeWorkspaceChanges(snapshot.changes),
  } as CodeAgentWorkspaceSnapshot;
};
