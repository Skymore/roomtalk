import { Readable, Writable } from 'stream';

export type CocoSandboxProvider = 'fake' | 'e2b';

export interface CocoSandboxHandle {
  id: string;
  provider: CocoSandboxProvider;
  roomId: string;
  creatorId: string;
  workspace: string;
  createdAt: string;
  expiresAt?: string;
}

export interface CocoRunnerProcess {
  pid?: number;
  command: string;
  stdin?: Writable;
  stdout?: Readable;
  stderr?: Readable;
  completed?: Promise<CocoRunnerProcessExit>;
  stop(): Promise<void>;
}

export interface CocoRunnerProcessExit {
  exitCode: number | null;
  signal?: string | null;
}

export interface CreateCocoSandboxInput {
  roomId: string;
  creatorId: string;
  ttlMs: number;
}

export interface StartCocoRunnerInput {
  handle: CocoSandboxHandle;
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ListCocoWorkspaceEntriesOptions {
  maxDepth?: number;
  maxEntries?: number;
}

export interface SearchCocoWorkspaceEntriesOptions extends ListCocoWorkspaceEntriesOptions {
  query: string;
}

export interface ListCocoWorkspaceRefsOptions {
  query?: string;
  maxRefs?: number;
}

export interface ReadCocoWorkspaceFileOptions {
  maxBytes?: number;
}

export type CocoWorkspaceDiffScope = 'branch' | 'unstaged';

export interface ReadCocoWorkspaceDiffOptions {
  maxBytes?: number;
  ignoreWhitespace?: boolean;
  scope?: CocoWorkspaceDiffScope;
  baseRef?: string;
}

export interface ReadCocoWorkspaceAssetOptions {
  maxBytes?: number;
}

export interface WriteCocoWorkspaceFileInput {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

export interface RenameCocoWorkspaceEntryInput {
  fromPath: string;
  toPath: string;
}

export interface CocoWorkspaceEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  updatedAt?: string;
}

export interface CocoWorkspaceFile {
  path: string;
  content: string;
  byteSize: number;
  truncated: boolean;
  encoding: 'utf-8' | 'base64';
}

export interface CocoWorkspaceAsset {
  path: string;
  body: Buffer;
  byteSize: number;
  truncated: boolean;
}

export interface CocoWorkspaceDiffSummary {
  files: number;
  additions: number;
  deletions: number;
}

export interface CocoWorkspaceChanges {
  available: boolean;
  changedFiles: string[];
  diffSummary: CocoWorkspaceDiffSummary | null;
}

export interface CocoWorkspaceDiff {
  available: boolean;
  patch: string;
  byteSize: number;
  truncated: boolean;
}

export interface CocoWorkspaceRef {
  name: string;
  kind: 'local' | 'remote';
  remoteName?: string;
}

export interface CocoWorkspaceRefs {
  available: boolean;
  refs: CocoWorkspaceRef[];
  headRef?: string;
}

export interface CocoSandboxService {
  create(input: CreateCocoSandboxInput): Promise<CocoSandboxHandle>;
  connect(sandboxId: string): Promise<CocoSandboxHandle>;
  initializeWorkspaceVersionControl?(handle: CocoSandboxHandle): Promise<void>;
  startRunner(input: StartCocoRunnerInput): Promise<CocoRunnerProcess>;
  getWorkspaceChanges?(handle: CocoSandboxHandle): Promise<CocoWorkspaceChanges>;
  getWorkspaceDiff?(handle: CocoSandboxHandle, options?: ReadCocoWorkspaceDiffOptions): Promise<CocoWorkspaceDiff>;
  listWorkspaceRefs?(handle: CocoSandboxHandle, options?: ListCocoWorkspaceRefsOptions): Promise<CocoWorkspaceRefs>;
  listWorkspaceEntries?(handle: CocoSandboxHandle, options?: ListCocoWorkspaceEntriesOptions): Promise<CocoWorkspaceEntry[]>;
  searchWorkspaceEntries?(handle: CocoSandboxHandle, options: SearchCocoWorkspaceEntriesOptions): Promise<CocoWorkspaceEntry[]>;
  readWorkspaceFile?(handle: CocoSandboxHandle, path: string, options?: ReadCocoWorkspaceFileOptions): Promise<CocoWorkspaceFile>;
  readWorkspaceAsset?(handle: CocoSandboxHandle, path: string, options?: ReadCocoWorkspaceAssetOptions): Promise<CocoWorkspaceAsset>;
  writeWorkspaceFile?(handle: CocoSandboxHandle, input: WriteCocoWorkspaceFileInput): Promise<CocoWorkspaceEntry>;
  createWorkspaceDirectory?(handle: CocoSandboxHandle, path: string): Promise<CocoWorkspaceEntry>;
  renameWorkspaceEntry?(handle: CocoSandboxHandle, input: RenameCocoWorkspaceEntryInput): Promise<CocoWorkspaceEntry>;
  deleteWorkspaceEntry?(handle: CocoSandboxHandle, path: string): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
  countActiveSandboxes?(): Promise<number | undefined>;
  countActiveSandboxesForUser?(creatorId: string): Promise<number | undefined>;
}

const normalizeWorkspaceSearchQuery = (query: string): string => (
  query.trim().toLowerCase().replace(/^[@./]+/, '')
);

const workspaceEntryBasename = (path: string): string => (
  path.split('/').pop() || path
);

const fuzzySubsequenceScore = (value: string, query: string): number | null => {
  if (!query) {
    return 0;
  }
  let valueIndex = 0;
  let score = 0;
  for (const queryChar of query) {
    const nextIndex = value.indexOf(queryChar, valueIndex);
    if (nextIndex < 0) {
      return null;
    }
    score += nextIndex - valueIndex;
    valueIndex = nextIndex + 1;
  }
  return score + Math.max(0, value.length - query.length);
};

const workspaceEntrySearchScore = (entry: CocoWorkspaceEntry, query: string): number | null => {
  if (!query) {
    return 0;
  }
  const path = entry.path.toLowerCase();
  const basename = workspaceEntryBasename(path);
  if (basename === query) {
    return 0;
  }
  const basenameIndex = basename.indexOf(query);
  if (basenameIndex >= 0) {
    return 100 + basenameIndex;
  }
  const pathIndex = path.indexOf(query);
  if (pathIndex >= 0) {
    return 200 + pathIndex;
  }
  const basenameFuzzy = fuzzySubsequenceScore(basename, query);
  if (basenameFuzzy !== null) {
    return 300 + basenameFuzzy;
  }
  const pathFuzzy = fuzzySubsequenceScore(path, query);
  if (pathFuzzy !== null) {
    return 400 + pathFuzzy;
  }
  return null;
};

const compareWorkspaceEntries = (left: CocoWorkspaceEntry, right: CocoWorkspaceEntry): number => {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.path.localeCompare(right.path, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
};

export const searchCocoWorkspaceEntries = (
  entries: readonly CocoWorkspaceEntry[],
  query: string,
  maxEntries: number,
): CocoWorkspaceEntry[] => {
  const normalizedQuery = normalizeWorkspaceSearchQuery(query);
  const uniqueEntries = new Map<string, CocoWorkspaceEntry>();
  for (const entry of entries) {
    if (entry.path.trim()) {
      uniqueEntries.set(entry.path, entry);
    }
  }

  return [...uniqueEntries.values()]
    .map((entry) => ({ entry, score: workspaceEntrySearchScore(entry, normalizedQuery) }))
    .filter((candidate): candidate is { entry: CocoWorkspaceEntry; score: number } => candidate.score !== null)
    .sort((left, right) => (
      left.score - right.score || compareWorkspaceEntries(left.entry, right.entry)
    ))
    .map((candidate) => candidate.entry)
    .slice(0, Math.max(0, maxEntries));
};
