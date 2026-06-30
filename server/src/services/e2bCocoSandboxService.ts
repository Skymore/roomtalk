import {
  CocoRunnerProcess,
  CocoRunnerProcessExit,
  CocoSandboxHandle,
  CocoSandboxService,
  CocoWorkspaceChanges,
  CocoWorkspaceAsset,
  CocoWorkspaceEntry,
  CocoWorkspaceFile,
  CreateCocoSandboxInput,
  ListCocoWorkspaceEntriesOptions,
  RenameCocoWorkspaceEntryInput,
  ReadCocoWorkspaceAssetOptions,
  ReadCocoWorkspaceFileOptions,
  StartCocoRunnerInput,
  WriteCocoWorkspaceFileInput,
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
    read?(path: string, options?: { format?: 'text' | 'bytes' | 'stream' }): Promise<string | Uint8Array | ReadableStream<Uint8Array>>;
    write?(path: string, data: string | Uint8Array): Promise<unknown>;
    makeDir?(path: string): Promise<unknown>;
    rename?(oldPath: string, newPath: string): Promise<E2BFileEntry | unknown>;
    remove?(path: string): Promise<void>;
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

  async initializeWorkspaceVersionControl(handle: CocoSandboxHandle): Promise<void> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.commands?.run) {
      throw new Error('E2B sandbox driver handle does not support command execution');
    }

    const workspace = shellQuote(handle.workspace || this.options.workspace || '/workspace');
    const command = [
      'set -eu',
      `cd ${workspace}`,
      'if ! command -v git >/dev/null 2>&1; then exit 0; fi',
      'git config --global --add safe.directory "$PWD" >/dev/null 2>&1 || true',
      'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
      '  git init -b main >/dev/null 2>&1 || git init >/dev/null',
      'fi',
      'git config user.email "roomtalk-coco@example.invalid"',
      'git config user.name "RoomTalk Coco"',
      'git add -A',
      'if git rev-parse --verify HEAD >/dev/null 2>&1; then',
      '  if ! git diff --cached --quiet; then',
      '    git commit -m "workspace baseline" >/dev/null',
      '  fi',
      'else',
      '  git commit --allow-empty -m "workspace baseline" >/dev/null',
      'fi',
    ].join('\n');
    const result = await connected.commands.run(command, { timeoutMs: 30_000 });
    const completed = await result.completed;
    if (completed && completed.exitCode !== 0) {
      throw new Error(`E2B workspace version control initialization failed with exit code ${completed.exitCode}`);
    }
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

  async getWorkspaceChanges(handle: CocoSandboxHandle): Promise<CocoWorkspaceChanges> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.commands?.run) {
      throw new Error('E2B sandbox driver handle does not support command execution');
    }

    const workspace = shellQuote(handle.workspace || this.options.workspace || '/workspace');
    const command = [
      'set -u',
      `cd ${workspace}`,
      'if ! command -v git >/dev/null 2>&1; then',
      '  printf "__ROOMTALK_CHANGES_UNAVAILABLE__\\n"',
      '  exit 0',
      'fi',
      'git config --global --add safe.directory "$PWD" >/dev/null 2>&1 || true',
      'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
      '  printf "__ROOMTALK_CHANGES_UNAVAILABLE__\\n"',
      '  exit 0',
      'fi',
      'printf "__ROOMTALK_STATUS__\\n"',
      'git status --porcelain=v1 || true',
      'printf "__ROOMTALK_NUMSTAT__\\n"',
      'if git rev-parse --verify HEAD >/dev/null 2>&1; then',
      '  git diff --numstat HEAD -- || true',
      'fi',
    ].join('\n');
    const result = await connected.commands.run(command, { timeoutMs: 10_000 });
    const stdout = await collectReadableText(result.stdout);
    const completed = await result.completed;
    if (completed && completed.exitCode !== 0) {
      throw new Error(`E2B workspace changes query failed with exit code ${completed.exitCode}`);
    }
    return parseWorkspaceChanges(stdout);
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
    const { buffer, truncated, byteSize } = await readWorkspaceFileBytes(connected.files.read, absolutePath, maxBytes);
    const contentBuffer = truncated ? buffer.subarray(0, maxBytes) : buffer;
    const textContent = decodeUtf8(contentBuffer);
    return {
      path: relativePath,
      content: textContent ?? contentBuffer.toString('base64'),
      byteSize,
      truncated,
      encoding: textContent === null ? 'base64' : 'utf-8',
    };
  }

  async readWorkspaceAsset(
    handle: CocoSandboxHandle,
    workspacePath: string,
    options: ReadCocoWorkspaceAssetOptions = {}
  ): Promise<CocoWorkspaceAsset> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.read) {
      throw new Error('E2B sandbox driver handle does not support filesystem reads');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const relativePath = normalizeWorkspaceInputPath(workspacePath, workspacePrefix);
    const absolutePath = `${workspacePrefix}/${relativePath}`;
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    const { buffer, truncated, byteSize } = await readWorkspaceFileBytes(connected.files.read, absolutePath, maxBytes);
    return {
      path: relativePath,
      body: truncated ? buffer.subarray(0, maxBytes) : buffer,
      byteSize,
      truncated,
    };
  }

  async writeWorkspaceFile(handle: CocoSandboxHandle, input: WriteCocoWorkspaceFileInput): Promise<CocoWorkspaceEntry> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.write) {
      throw new Error('E2B sandbox driver handle does not support filesystem writes');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const relativePath = normalizeWorkspaceInputPath(input.path, workspacePrefix);
    const absolutePath = `${workspacePrefix}/${relativePath}`;
    const content = input.encoding === 'base64'
      ? Buffer.from(input.content, 'base64')
      : input.content;
    await connected.files.write(absolutePath, content);
    return {
      path: relativePath,
      name: relativePath.split('/').pop() || relativePath,
      type: 'file',
      size: Buffer.isBuffer(content) ? content.byteLength : Buffer.byteLength(content),
    };
  }

  async createWorkspaceDirectory(handle: CocoSandboxHandle, workspacePath: string): Promise<CocoWorkspaceEntry> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.makeDir) {
      throw new Error('E2B sandbox driver handle does not support directory creation');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const relativePath = normalizeWorkspaceInputPath(workspacePath, workspacePrefix);
    await connected.files.makeDir(`${workspacePrefix}/${relativePath}`);
    return {
      path: relativePath,
      name: relativePath.split('/').pop() || relativePath,
      type: 'directory',
    };
  }

  async renameWorkspaceEntry(handle: CocoSandboxHandle, input: RenameCocoWorkspaceEntryInput): Promise<CocoWorkspaceEntry> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.rename) {
      throw new Error('E2B sandbox driver handle does not support filesystem rename');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const fromPath = normalizeWorkspaceInputPath(input.fromPath, workspacePrefix);
    const toPath = normalizeWorkspaceInputPath(input.toPath, workspacePrefix);
    const result = await connected.files.rename(`${workspacePrefix}/${fromPath}`, `${workspacePrefix}/${toPath}`);
    const normalizedResult = result && typeof result === 'object' && 'path' in result
      ? normalizeWorkspaceEntry(result as E2BFileEntry, workspacePrefix)
      : null;
    return normalizedResult || {
      path: toPath,
      name: toPath.split('/').pop() || toPath,
      type: 'file',
    };
  }

  async deleteWorkspaceEntry(handle: CocoSandboxHandle, workspacePath: string): Promise<void> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.remove) {
      throw new Error('E2B sandbox driver handle does not support filesystem deletion');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const relativePath = normalizeWorkspaceInputPath(workspacePath, workspacePrefix);
    await connected.files.remove(`${workspacePrefix}/${relativePath}`);
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

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const collectReadableText = async (stream: Readable | undefined, maxBytes = 256 * 1024): Promise<string> => {
  if (!stream) {
    return '';
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteSize = 0;
    let settled = false;

    const settle = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    stream.on('data', (chunk: Buffer | string) => {
      if (byteSize >= maxBytes) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remainingBytes = maxBytes - byteSize;
      chunks.push(buffer.byteLength > remainingBytes ? buffer.subarray(0, remainingBytes) : buffer);
      byteSize += buffer.byteLength;
    });
    stream.on('end', () => settle(Buffer.concat(chunks).toString('utf8')));
    stream.on('close', () => settle(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
};

const parseWorkspaceChanges = (stdout: string): CocoWorkspaceChanges => {
  if (!stdout || stdout.includes('__ROOMTALK_CHANGES_UNAVAILABLE__')) {
    return {
      available: false,
      changedFiles: [],
      diffSummary: null,
    };
  }

  const statusOutput = sectionBetween(stdout, '__ROOMTALK_STATUS__', '__ROOMTALK_NUMSTAT__');
  const numstatOutput = sectionAfter(stdout, '__ROOMTALK_NUMSTAT__');
  const changedFiles = parseGitStatusFiles(statusOutput);
  const diffStats = parseGitNumstat(numstatOutput);

  return {
    available: true,
    changedFiles,
    diffSummary: {
      files: changedFiles.length,
      additions: diffStats.additions,
      deletions: diffStats.deletions,
    },
  };
};

const sectionBetween = (value: string, startMarker: string, endMarker: string): string => {
  const start = value.indexOf(startMarker);
  if (start < 0) {
    return '';
  }
  const contentStart = start + startMarker.length;
  const end = value.indexOf(endMarker, contentStart);
  return (end < 0 ? value.slice(contentStart) : value.slice(contentStart, end)).trim();
};

const sectionAfter = (value: string, marker: string): string => {
  const start = value.indexOf(marker);
  return start < 0 ? '' : value.slice(start + marker.length).trim();
};

const parseGitStatusFiles = (statusOutput: string): string[] => {
  const files = new Set<string>();
  for (const line of statusOutput.split(/\r?\n/)) {
    const match = /^[ MADRCU?!]{1,2}\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const rawPath = match[1].trim();
    if (!rawPath) {
      continue;
    }
    const renamedPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() || rawPath : rawPath;
    files.add(unquoteGitPath(renamedPath));
  }
  return [...files].sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  }));
};

const parseGitNumstat = (numstatOutput: string): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;
  for (const line of numstatOutput.split(/\r?\n/)) {
    const [added, deleted] = line.split('\t');
    const addedCount = Number.parseInt(added || '', 10);
    const deletedCount = Number.parseInt(deleted || '', 10);
    if (Number.isFinite(addedCount)) {
      additions += addedCount;
    }
    if (Number.isFinite(deletedCount)) {
      deletions += deletedCount;
    }
  }
  return { additions, deletions };
};

const unquoteGitPath = (path: string): string => path
  .replace(/^"|"$/g, '')
  .replace(/\\"/g, '"')
  .replace(/\\\\/g, '\\');

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

const readWorkspaceFileBytes = async (
  read: NonNullable<NonNullable<E2BSandboxDriverHandle['files']>['read']>,
  absolutePath: string,
  maxBytes: number
): Promise<{ buffer: Buffer; truncated: boolean; byteSize: number }> => {
  const raw = await read(absolutePath, { format: 'stream' }).catch(() => read(absolutePath, { format: 'bytes' }));
  if (isReadableStream(raw)) {
    return readLimitedStream(raw, maxBytes);
  }

  const buffer = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
  const truncated = buffer.byteLength > maxBytes;
  return {
    buffer: truncated ? buffer.subarray(0, maxBytes) : buffer,
    truncated,
    byteSize: buffer.byteLength,
  };
};

const isReadableStream = (value: unknown): value is ReadableStream<Uint8Array> => (
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as { getReader?: unknown }).getReader === 'function'
);

const readLimitedStream = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ buffer: Buffer; truncated: boolean; byteSize: number }> => {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let byteSize = 0;
  let truncated = false;

  try {
    while (byteSize <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      byteSize += chunk.byteLength;
      chunks.push(chunk);
      if (byteSize > maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks);
  return {
    buffer: truncated ? buffer.subarray(0, maxBytes) : buffer,
    truncated,
    byteSize,
  };
};

const decodeUtf8 = (buffer: Buffer): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
};

const compareWorkspaceEntries = (a: CocoWorkspaceEntry, b: CocoWorkspaceEntry) => {
  if (a.type !== b.type) {
    return a.type === 'directory' ? -1 : 1;
  }
  return a.path.localeCompare(b.path);
};
