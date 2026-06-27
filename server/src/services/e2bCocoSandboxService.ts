import {
  CocoRunnerProcess,
  CocoRunnerProcessExit,
  CocoSandboxHandle,
  CocoSandboxService,
  CreateCocoSandboxInput,
  ListCocoWorkspaceFilesOptions,
  StartCocoRunnerInput,
} from './cocoSandboxService';
import { Readable, Writable } from 'stream';

export interface E2BSandboxDriverHandle {
  id: string;
  commands?: {
    run(command: string, options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<E2BCommandResult>;
  };
  files?: {
    list(path: string, options?: { depth?: number }): Promise<E2BFileEntry[]>;
  };
  kill?(): Promise<void>;
}

export interface E2BFileEntry {
  name?: string;
  path: string;
  type?: string;
}

export interface E2BListedSandbox {
  id: string;
  metadata: Record<string, string>;
}

export interface E2BCommandResult {
  pid?: number;
  stdin?: Writable;
  stdout?: Readable;
  stderr?: Readable;
  completed?: Promise<CocoRunnerProcessExit>;
  stop?(): Promise<void>;
}

export interface E2BSandboxDriver {
  create(input: { templateId: string; timeoutMs: number; metadata: Record<string, string> }): Promise<E2BSandboxDriverHandle>;
  connect(sandboxId: string): Promise<E2BSandboxDriverHandle>;
  list?(input?: { metadata?: Record<string, string> }): Promise<E2BListedSandbox[]>;
}

export interface E2BCocoSandboxServiceOptions {
  templateId: string;
  workspace?: string;
  artifactVersion?: string;
  cocoSourceRef?: string;
  logger?: {
    warn(message: string, meta?: unknown): void;
  };
}

export class E2BCocoSandboxService implements CocoSandboxService {
  constructor(
    private readonly driver: E2BSandboxDriver,
    private readonly options: E2BCocoSandboxServiceOptions,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!options.templateId) {
      throw new Error('E2B Coco sandbox templateId is required');
    }
  }

  async create(input: CreateCocoSandboxInput): Promise<CocoSandboxHandle> {
    const handle = await this.driver.create({
      templateId: this.options.templateId,
      timeoutMs: input.ttlMs,
      metadata: {
        roomId: input.roomId,
        creatorId: input.creatorId,
        ...(this.options.artifactVersion ? { artifactVersion: this.options.artifactVersion } : {}),
        ...(this.options.cocoSourceRef ? { cocoSourceRef: this.options.cocoSourceRef } : {}),
      },
    });
    const createdAt = this.now().toISOString();
    return {
      id: handle.id,
      provider: 'e2b',
      roomId: input.roomId,
      creatorId: input.creatorId,
      workspace: this.options.workspace || '/workspace',
      createdAt,
      expiresAt: new Date(this.now().getTime() + input.ttlMs).toISOString(),
    };
  }

  async connect(sandboxId: string): Promise<CocoSandboxHandle> {
    const handle = await this.driver.connect(sandboxId);
    const connectedAt = this.now().toISOString();
    return {
      id: handle.id,
      provider: 'e2b',
      roomId: '',
      creatorId: '',
      workspace: this.options.workspace || '/workspace',
      createdAt: connectedAt,
    };
  }

  async startRunner(input: StartCocoRunnerInput): Promise<CocoRunnerProcess> {
    const handle = await this.driver.connect(input.handle.id);
    if (!handle.commands?.run) {
      throw new Error('E2B sandbox driver handle does not support command execution');
    }
    const commandResult = await handle.commands.run(input.command, {
      env: input.env || {},
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    return {
      pid: commandResult?.pid,
      command: input.command,
      stdin: commandResult?.stdin,
      stdout: commandResult?.stdout,
      stderr: commandResult?.stderr,
      completed: commandResult?.completed,
      stop: async () => {
        await commandResult?.stop?.();
      },
    };
  }

  async listWorkspaceFiles(handle: CocoSandboxHandle, options: ListCocoWorkspaceFilesOptions = {}): Promise<string[]> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.list) {
      throw new Error('E2B sandbox driver handle does not support filesystem listing');
    }

    const entries = await connected.files.list(handle.workspace, {
      depth: options.maxDepth ?? 5,
    });
    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const maxFiles = options.maxFiles ?? 200;
    const files = entries
      .filter(entry => !entry.type || entry.type === 'file')
      .map(entry => normalizeWorkspaceEntryPath(entry.path, workspacePrefix))
      .filter((value): value is string => Boolean(value));

    return Array.from(new Set(files))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, maxFiles);
  }

  async destroy(sandboxId: string): Promise<void> {
    const handle = await this.driver.connect(sandboxId);
    if (!handle.kill) {
      throw new Error('E2B sandbox driver handle does not support kill');
    }
    await handle.kill();
  }

  async countActiveSandboxes(): Promise<number | undefined> {
    const sandboxes = await this.listActiveSandboxes();
    return sandboxes?.length;
  }

  async countActiveSandboxesForUser(creatorId: string): Promise<number | undefined> {
    const sandboxes = await this.listActiveSandboxes({ metadata: { creatorId } });
    return sandboxes?.length;
  }

  private async listActiveSandboxes(input?: { metadata?: Record<string, string> }): Promise<E2BListedSandbox[] | undefined> {
    try {
      return await this.driver.list?.(input);
    } catch (error) {
      this.options.logger?.warn('Unable to count active E2B sandboxes', {
        error,
        metadata: input?.metadata,
      });
      return undefined;
    }
  }
}

const normalizeWorkspaceEntryPath = (entryPath: string, workspacePrefix: string): string | null => {
  const normalized = entryPath.trim().replace(/\\/g, '/');
  if (!normalized || normalized === workspacePrefix) {
    return null;
  }
  const relative = normalized.startsWith(`${workspacePrefix}/`)
    ? normalized.slice(workspacePrefix.length + 1)
    : normalized.replace(/^\/+/, '');
  const parts = relative.split('/').filter(part => part && part !== '.' && part !== '..');
  return parts.length > 0 ? parts.join('/') : null;
};
