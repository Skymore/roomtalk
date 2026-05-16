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
  stop(): Promise<void>;
}

export interface CreateCocoSandboxInput {
  roomId: string;
  creatorId: string;
  ttlMs: number;
}

export interface StartCocoRunnerInput {
  handle: CocoSandboxHandle;
  command: string;
}

export interface CocoSandboxService {
  create(input: CreateCocoSandboxInput): Promise<CocoSandboxHandle>;
  connect(sandboxId: string): Promise<CocoSandboxHandle>;
  startRunner(input: StartCocoRunnerInput): Promise<CocoRunnerProcess>;
  destroy(sandboxId: string): Promise<void>;
  countActiveSandboxes?(): Promise<number>;
  countActiveSandboxesForUser?(creatorId: string): Promise<number>;
}
