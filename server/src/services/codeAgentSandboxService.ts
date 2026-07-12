import { Readable, Writable } from 'stream';

export type CodeAgentSandboxProvider = 'fake' | 'e2b';

export interface CodeAgentSandboxHandle {
  id: string;
  provider: CodeAgentSandboxProvider;
  roomId: string;
  creatorId: string;
  workspace: string;
  createdAt: string;
  expiresAt?: string;
}

export interface CodeAgentRunnerProcess {
  pid?: number;
  command: string;
  stdin?: Writable;
  stdout?: Readable;
  stderr?: Readable;
  completed?: Promise<CodeAgentRunnerProcessExit>;
  stop(): Promise<void>;
  terminate?(): Promise<void>;
}

export interface CodeAgentRunnerProcessExit {
  exitCode: number | null;
  signal?: string | null;
}

export interface CreateCodeAgentSandboxInput {
  roomId: string;
  creatorId: string;
  ttlMs: number;
}

export interface StartCodeAgentRunnerInput {
  handle: CodeAgentSandboxHandle;
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface StartCodeAgentWorkspaceCommandInput {
  handle: CodeAgentSandboxHandle;
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface StartCodeAgentWorkspaceTerminalInput {
  handle: CodeAgentSandboxHandle;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  timeoutMs?: number;
  onData(data: Uint8Array): void | Promise<void>;
}

export interface CodeAgentWorkspaceTerminal {
  pid?: number;
  write(data: string | Uint8Array): Promise<void>;
  resize(size: { cols: number; rows: number }): Promise<void>;
  stop(): Promise<void>;
}

export interface ListCodeAgentWorkspaceEntriesOptions {
  maxDepth?: number;
  maxEntries?: number;
}

export interface SearchCodeAgentWorkspaceEntriesOptions extends ListCodeAgentWorkspaceEntriesOptions {
  query: string;
}

export interface ListCodeAgentWorkspaceRefsOptions {
  query?: string;
  maxRefs?: number;
}

export interface ReadCodeAgentWorkspaceFileOptions {
  maxBytes?: number;
}

export type CodeAgentWorkspaceDiffScope = 'branch' | 'unstaged';

export interface ReadCodeAgentWorkspaceDiffOptions {
  maxBytes?: number;
  ignoreWhitespace?: boolean;
  scope?: CodeAgentWorkspaceDiffScope;
  baseRef?: string;
}

export interface ReadCodeAgentWorkspaceAssetOptions {
  maxBytes?: number;
}

export interface ExportCodeAgentWorkspaceArchiveOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export interface ImportCodeAgentWorkspaceArchiveOptions {
  timeoutMs?: number;
}

export interface WriteCodeAgentWorkspaceFileInput {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

export interface WriteCodeAgentSandboxSecretFileInput {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

export interface ReadCodeAgentSandboxSecretFileOptions {
  maxBytes?: number;
}

export interface RenameCodeAgentWorkspaceEntryInput {
  fromPath: string;
  toPath: string;
}

export interface ResolveCodeAgentWorkspacePreviewTargetInput {
  kind: 'environment-port';
  port: number;
  protocol?: 'http' | 'https';
  path?: string;
}

export interface CodeAgentWorkspacePreviewTargetResolution {
  requestedUrl: string;
  resolvedUrl: string;
  resolutionKind: 'e2b-port-host';
}

export interface CodeAgentWorkspacePreviewServer {
  host: string;
  port: number;
  url: string;
  processName?: string | null;
  pid?: number | null;
}

export interface CodeAgentWorkspaceEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  updatedAt?: string;
}

export interface CodeAgentWorkspaceFile {
  path: string;
  content: string;
  byteSize: number;
  truncated: boolean;
  encoding: 'utf-8' | 'base64';
}

export interface CodeAgentWorkspaceAsset {
  path: string;
  body: Buffer;
  byteSize: number;
  truncated: boolean;
}

export interface CodeAgentWorkspaceArchive {
  body: Buffer;
  byteSize: number;
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

export interface CodeAgentWorkspaceChanges {
  available: boolean;
  changedFiles: string[];
  changedFileStats: CodeAgentWorkspaceChangedFileStat[];
  diffSummary: CodeAgentWorkspaceDiffSummary | null;
}

export interface CodeAgentWorkspaceDiff {
  available: boolean;
  patch: string;
  byteSize: number;
  truncated: boolean;
  headRef?: string;
  baseRef?: string;
}

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

export interface CodeAgentSandboxService {
  create(input: CreateCodeAgentSandboxInput): Promise<CodeAgentSandboxHandle>;
  connect(sandboxId: string): Promise<CodeAgentSandboxHandle>;
  initializeWorkspaceVersionControl?(handle: CodeAgentSandboxHandle): Promise<void>;
  setSandboxTimeout?(handle: CodeAgentSandboxHandle, ttlMs: number): Promise<CodeAgentSandboxHandle>;
  startRunner(input: StartCodeAgentRunnerInput): Promise<CodeAgentRunnerProcess>;
  startWorkspaceCommand?(input: StartCodeAgentWorkspaceCommandInput): Promise<CodeAgentRunnerProcess>;
  startWorkspaceTerminal?(input: StartCodeAgentWorkspaceTerminalInput): Promise<CodeAgentWorkspaceTerminal>;
  getWorkspaceChanges?(handle: CodeAgentSandboxHandle): Promise<CodeAgentWorkspaceChanges>;
  getWorkspaceDiff?(handle: CodeAgentSandboxHandle, options?: ReadCodeAgentWorkspaceDiffOptions): Promise<CodeAgentWorkspaceDiff>;
  listWorkspaceRefs?(handle: CodeAgentSandboxHandle, options?: ListCodeAgentWorkspaceRefsOptions): Promise<CodeAgentWorkspaceRefs>;
  listWorkspaceEntries?(handle: CodeAgentSandboxHandle, options?: ListCodeAgentWorkspaceEntriesOptions): Promise<CodeAgentWorkspaceEntry[]>;
  searchWorkspaceEntries?(handle: CodeAgentSandboxHandle, options: SearchCodeAgentWorkspaceEntriesOptions): Promise<CodeAgentWorkspaceEntry[]>;
  readWorkspaceFile?(handle: CodeAgentSandboxHandle, path: string, options?: ReadCodeAgentWorkspaceFileOptions): Promise<CodeAgentWorkspaceFile>;
  readWorkspaceAsset?(handle: CodeAgentSandboxHandle, path: string, options?: ReadCodeAgentWorkspaceAssetOptions): Promise<CodeAgentWorkspaceAsset>;
  exportWorkspaceArchive?(handle: CodeAgentSandboxHandle, options?: ExportCodeAgentWorkspaceArchiveOptions): Promise<CodeAgentWorkspaceArchive>;
  importWorkspaceArchive?(handle: CodeAgentSandboxHandle, archive: CodeAgentWorkspaceArchive, options?: ImportCodeAgentWorkspaceArchiveOptions): Promise<void>;
  resolveWorkspacePreviewTarget?(handle: CodeAgentSandboxHandle, input: ResolveCodeAgentWorkspacePreviewTargetInput): Promise<CodeAgentWorkspacePreviewTargetResolution>;
  listWorkspacePreviewServers?(handle: CodeAgentSandboxHandle): Promise<CodeAgentWorkspacePreviewServer[]>;
  writeWorkspaceFile?(handle: CodeAgentSandboxHandle, input: WriteCodeAgentWorkspaceFileInput): Promise<CodeAgentWorkspaceEntry>;
  writeSecretFile?(handle: CodeAgentSandboxHandle, input: WriteCodeAgentSandboxSecretFileInput): Promise<void>;
  readSecretFile?(handle: CodeAgentSandboxHandle, path: string, options?: ReadCodeAgentSandboxSecretFileOptions): Promise<string>;
  deleteSecretFile?(handle: CodeAgentSandboxHandle, path: string): Promise<void>;
  createWorkspaceDirectory?(handle: CodeAgentSandboxHandle, path: string): Promise<CodeAgentWorkspaceEntry>;
  renameWorkspaceEntry?(handle: CodeAgentSandboxHandle, input: RenameCodeAgentWorkspaceEntryInput): Promise<CodeAgentWorkspaceEntry>;
  deleteWorkspaceEntry?(handle: CodeAgentSandboxHandle, path: string): Promise<void>;
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

const workspaceEntrySearchScore = (entry: CodeAgentWorkspaceEntry, query: string): number | null => {
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

const compareWorkspaceEntries = (left: CodeAgentWorkspaceEntry, right: CodeAgentWorkspaceEntry): number => {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.path.localeCompare(right.path, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
};

export const searchCodeAgentWorkspaceEntries = (
  entries: readonly CodeAgentWorkspaceEntry[],
  query: string,
  maxEntries: number,
): CodeAgentWorkspaceEntry[] => {
  const normalizedQuery = normalizeWorkspaceSearchQuery(query);
  const uniqueEntries = new Map<string, CodeAgentWorkspaceEntry>();
  for (const entry of entries) {
    if (entry.path.trim()) {
      uniqueEntries.set(entry.path, entry);
    }
  }

  return [...uniqueEntries.values()]
    .map((entry) => ({ entry, score: workspaceEntrySearchScore(entry, normalizedQuery) }))
    .filter((candidate): candidate is { entry: CodeAgentWorkspaceEntry; score: number } => candidate.score !== null)
    .sort((left, right) => (
      left.score - right.score || compareWorkspaceEntries(left.entry, right.entry)
    ))
    .map((candidate) => candidate.entry)
    .slice(0, Math.max(0, maxEntries));
};
