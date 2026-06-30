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

export interface CocoSandboxService {
  create(input: CreateCocoSandboxInput): Promise<CocoSandboxHandle>;
  connect(sandboxId: string): Promise<CocoSandboxHandle>;
  startRunner(input: StartCocoRunnerInput): Promise<CocoRunnerProcess>;
  listWorkspaceEntries?(handle: CocoSandboxHandle, options?: ListCocoWorkspaceEntriesOptions): Promise<CocoWorkspaceEntry[]>;
  readWorkspaceFile?(handle: CocoSandboxHandle, path: string, options?: ReadCocoWorkspaceFileOptions): Promise<CocoWorkspaceFile>;
  destroy(sandboxId: string): Promise<void>;
  countActiveSandboxes?(): Promise<number | undefined>;
  countActiveSandboxesForUser?(creatorId: string): Promise<number | undefined>;
}
