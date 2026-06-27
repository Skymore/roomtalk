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

export interface ListCocoWorkspaceFilesOptions {
  maxDepth?: number;
  maxFiles?: number;
}

export interface CocoSandboxService {
  create(input: CreateCocoSandboxInput): Promise<CocoSandboxHandle>;
  connect(sandboxId: string): Promise<CocoSandboxHandle>;
  startRunner(input: StartCocoRunnerInput): Promise<CocoRunnerProcess>;
  listWorkspaceFiles?(handle: CocoSandboxHandle, options?: ListCocoWorkspaceFilesOptions): Promise<string[]>;
  destroy(sandboxId: string): Promise<void>;
  countActiveSandboxes?(): Promise<number | undefined>;
  countActiveSandboxesForUser?(creatorId: string): Promise<number | undefined>;
}
