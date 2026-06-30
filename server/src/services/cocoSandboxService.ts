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

export interface ReadCocoWorkspaceFileOptions {
  maxBytes?: number;
}

export interface ReadCocoWorkspaceDiffOptions {
  maxBytes?: number;
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

export interface CocoSandboxService {
  create(input: CreateCocoSandboxInput): Promise<CocoSandboxHandle>;
  connect(sandboxId: string): Promise<CocoSandboxHandle>;
  initializeWorkspaceVersionControl?(handle: CocoSandboxHandle): Promise<void>;
  startRunner(input: StartCocoRunnerInput): Promise<CocoRunnerProcess>;
  getWorkspaceChanges?(handle: CocoSandboxHandle): Promise<CocoWorkspaceChanges>;
  getWorkspaceDiff?(handle: CocoSandboxHandle, options?: ReadCocoWorkspaceDiffOptions): Promise<CocoWorkspaceDiff>;
  listWorkspaceEntries?(handle: CocoSandboxHandle, options?: ListCocoWorkspaceEntriesOptions): Promise<CocoWorkspaceEntry[]>;
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
