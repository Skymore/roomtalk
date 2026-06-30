import {
  CocoRunnerProcess,
  CocoRunnerProcessExit,
  CocoSandboxHandle,
  CocoSandboxService,
  CocoWorkspaceEntry,
  CocoWorkspaceFile,
  CreateCocoSandboxInput,
  ListCocoWorkspaceEntriesOptions,
  ReadCocoWorkspaceFileOptions,
  StartCocoRunnerInput,
} from './cocoSandboxService';
import { Readable, Writable } from 'stream';

export interface E2BSandboxDriverHandle {
  id: string;
  getHost?(port: number): string;
  commands?: {
    run(command: string, options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<E2BCommandResult>;
  };
  files?: {
    list(path: string, options?: { depth?: number }): Promise<E2BFileEntry[]>;
    read?(path: string, options?: { format?: 'text' | 'bytes' }): Promise<string | Uint8Array>;
  };
  kill?(): Promise<void>;
}

export interface E2BFileEntry {
  name?: string;
  path: string;
  type?: string;
  size?: number;
  modifiedAt?: string | Date;
  updatedAt?: string | Date;
}

export interface E2BListedSandbox {
  id: string;
  metadata: Record<string, string>;
}

export interface E2BSandboxLifecyclePolicy {
  onTimeout: 'kill' | 'pause';
  autoResume?: boolean;
  keepMemory?: boolean;
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
  create(input: {
    templateId: string;
    timeoutMs: number;
    metadata: Record<string, string>;
    lifecycle?: E2BSandboxLifecyclePolicy;
  }): Promise<E2BSandboxDriverHandle>;
  connect(sandboxId: string, input?: { timeoutMs?: number }): Promise<E2BSandboxDriverHandle>;
  list?(input?: { metadata?: Record<string, string> }): Promise<E2BListedSandbox[]>;
}

export interface E2BCocoSandboxServiceOptions {
  templateId: string;
  workspace?: string;
  artifactVersion?: string;
  cocoSourceRef?: string;
  lifecycle?: E2BSandboxLifecyclePolicy;
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
      ...(this.options.lifecycle ? { lifecycle: this.options.lifecycle } : {}),
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
      env: {
        ...(input.env || {}),
        ...portHostTemplateEnv(handle),
      },
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

  async listWorkspaceEntries(handle: CocoSandboxHandle, options: ListCocoWorkspaceEntriesOptions = {}): Promise<CocoWorkspaceEntry[]> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.list) {
      throw new Error('E2B sandbox driver handle does not support filesystem listing');
    }

    const entries = await connected.files.list(handle.workspace, {
      depth: options.maxDepth ?? 5,
    });
    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const maxEntries = options.maxEntries ?? 5000;
    const normalizedEntries = entries
      .map(entry => normalizeWorkspaceEntry(entry, workspacePrefix))
      .filter((entry): entry is CocoWorkspaceEntry => Boolean(entry));

    const uniqueEntries = new Map<string, CocoWorkspaceEntry>();
    for (const entry of normalizedEntries) {
      uniqueEntries.set(entry.path, entry);
    }

    return Array.from(uniqueEntries.values())
      .sort(compareWorkspaceEntries)
      .slice(0, maxEntries);
  }

  async readWorkspaceFile(
    handle: CocoSandboxHandle,
    workspacePath: string,
    options: ReadCocoWorkspaceFileOptions = {}
  ): Promise<CocoWorkspaceFile> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.read) {
      throw new Error('E2B sandbox driver handle does not support filesystem reads');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const relativePath = normalizeWorkspaceInputPath(workspacePath, workspacePrefix);
    const absolutePath = `${workspacePrefix}/${relativePath}`;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const raw = await connected.files.read(absolutePath, { format: 'bytes' });
    const buffer = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
    const truncated = buffer.byteLength > maxBytes;
    const contentBuffer = truncated ? buffer.subarray(0, maxBytes) : buffer;
    const isBinary = contentBuffer.includes(0);
    return {
      path: relativePath,
      content: isBinary ? contentBuffer.toString('base64') : contentBuffer.toString('utf8'),
      byteSize: buffer.byteLength,
      truncated,
      encoding: isBinary ? 'base64' : 'utf-8',
    };
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

const portHostTemplateEnv = (handle: E2BSandboxDriverHandle): Record<string, string> => {
  if (!handle.getHost) {
    return {};
  }
  const placeholderPort = 45999;
  const host = handle.getHost(placeholderPort);
  if (!host || !host.includes(String(placeholderPort))) {
    return {};
  }
  return {
    ROOMTALK_E2B_PORT_HOST_TEMPLATE: host.replace(String(placeholderPort), '{port}'),
  };
};

const normalizeWorkspaceEntry = (entry: E2BFileEntry, workspacePrefix: string): CocoWorkspaceEntry | null => {
  const entryPath = normalizeWorkspaceEntryPath(entry.path, workspacePrefix);
  if (!entryPath) {
    return null;
  }

  const entryType = normalizeEntryType(entry.type);
  return {
    path: entryPath,
    name: entry.name || entryPath.split('/').pop() || entryPath,
    type: entryType,
    ...(typeof entry.size === 'number' && entryType === 'file' ? { size: entry.size } : {}),
    ...(normalizeEntryDate(entry.updatedAt || entry.modifiedAt) ? { updatedAt: normalizeEntryDate(entry.updatedAt || entry.modifiedAt) } : {}),
  };
};

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

const normalizeEntryType = (type: string | undefined): CocoWorkspaceEntry['type'] => {
  const normalized = (type || 'file').toLowerCase();
  return normalized === 'dir' || normalized === 'directory' || normalized === 'folder' ? 'directory' : 'file';
};

const normalizeEntryDate = (value: string | Date | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const normalizeWorkspaceInputPath = (value: string, workspacePrefix: string): string => {
  const normalizedValue = value.trim().replace(/\\/g, '/');
  const normalized = normalizedValue.startsWith(`${workspacePrefix}/`)
    ? normalizedValue.slice(workspacePrefix.length + 1)
    : normalizedValue.replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!normalized || parts.some(part => part === '.' || part === '..')) {
    throw new Error('Workspace file path is invalid');
  }
  return parts.join('/');
};

const compareWorkspaceEntries = (a: CocoWorkspaceEntry, b: CocoWorkspaceEntry) => {
  if (a.type !== b.type) {
    return a.type === 'directory' ? -1 : 1;
  }
  return a.path.localeCompare(b.path);
};
