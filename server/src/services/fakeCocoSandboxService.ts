import { randomUUID } from 'crypto';
import {
  CocoRunnerProcess,
  CocoSandboxHandle,
  CocoSandboxService,
  CocoWorkspaceEntry,
  CocoWorkspaceFile,
  CreateCocoSandboxInput,
  ListCocoWorkspaceEntriesOptions,
  ReadCocoWorkspaceFileOptions,
  StartCocoRunnerInput,
} from './cocoSandboxService';

type FakeSandboxFailure = 'create' | 'connect' | 'startRunner' | 'destroy';

export class FakeCocoSandboxService implements CocoSandboxService {
  private readonly sandboxes = new Map<string, CocoSandboxHandle>();
  private readonly failures = new Set<FakeSandboxFailure>();
  readonly destroyedSandboxIds: string[] = [];
  readonly startedRunnerCommands: string[] = [];
  readonly startedRunnerEnvs: Record<string, string>[] = [];
  readonly stoppedRunnerCommands: string[] = [];
  private readonly workspaceEntriesBySandboxId = new Map<string, CocoWorkspaceEntry[]>();
  private readonly workspaceFileContentsBySandboxId = new Map<string, Map<string, string>>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  failNext(operation: FakeSandboxFailure) {
    this.failures.add(operation);
  }

  private consumeFailure(operation: FakeSandboxFailure) {
    if (!this.failures.has(operation)) {
      return;
    }
    this.failures.delete(operation);
    throw new Error(`Fake Coco sandbox ${operation} failed`);
  }

  async create(input: CreateCocoSandboxInput): Promise<CocoSandboxHandle> {
    this.consumeFailure('create');
    const createdAt = this.now().toISOString();
    const handle: CocoSandboxHandle = {
      id: `fake-sandbox-${randomUUID()}`,
      provider: 'fake',
      roomId: input.roomId,
      creatorId: input.creatorId,
      workspace: `/workspace/${input.roomId}`,
      createdAt,
      expiresAt: new Date(this.now().getTime() + input.ttlMs).toISOString(),
    };
    this.sandboxes.set(handle.id, handle);
    this.workspaceEntriesBySandboxId.set(handle.id, []);
    this.workspaceFileContentsBySandboxId.set(handle.id, new Map());
    return handle;
  }

  async connect(sandboxId: string): Promise<CocoSandboxHandle> {
    this.consumeFailure('connect');
    const handle = this.sandboxes.get(sandboxId);
    if (!handle) {
      throw new Error(`Fake Coco sandbox not found: ${sandboxId}`);
    }
    return handle;
  }

  async startRunner(input: StartCocoRunnerInput): Promise<CocoRunnerProcess> {
    this.consumeFailure('startRunner');
    this.startedRunnerCommands.push(input.command);
    this.startedRunnerEnvs.push({ ...(input.env || {}) });
    return {
      command: input.command,
      stop: async () => {
        this.stoppedRunnerCommands.push(input.command);
      },
    };
  }

  setWorkspaceFiles(sandboxId: string, files: string[]) {
    this.setWorkspaceEntries(sandboxId, files.map(filePath => ({
      path: normalizeFakeWorkspacePath(filePath),
      name: normalizeFakeWorkspacePath(filePath).split('/').pop() || normalizeFakeWorkspacePath(filePath),
      type: 'file',
    })));
  }

  setWorkspaceEntries(sandboxId: string, entries: CocoWorkspaceEntry[]) {
    this.workspaceEntriesBySandboxId.set(sandboxId, entries.map(entry => ({
      ...entry,
      path: normalizeFakeWorkspacePath(entry.path),
      name: entry.name || normalizeFakeWorkspacePath(entry.path).split('/').pop() || normalizeFakeWorkspacePath(entry.path),
    })));
  }

  setWorkspaceFileContent(sandboxId: string, path: string, content: string) {
    const files = this.workspaceFileContentsBySandboxId.get(sandboxId) || new Map<string, string>();
    files.set(normalizeFakeWorkspacePath(path), content);
    this.workspaceFileContentsBySandboxId.set(sandboxId, files);
  }

  async listWorkspaceEntries(
    handle: CocoSandboxHandle,
    options: ListCocoWorkspaceEntriesOptions = {}
  ): Promise<CocoWorkspaceEntry[]> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake Coco sandbox not found: ${handle.id}`);
    }
    return [...(this.workspaceEntriesBySandboxId.get(handle.id) || [])]
      .sort(compareFakeWorkspaceEntries)
      .slice(0, options.maxEntries ?? 5000);
  }

  async readWorkspaceFile(
    handle: CocoSandboxHandle,
    path: string,
    options: ReadCocoWorkspaceFileOptions = {}
  ): Promise<CocoWorkspaceFile> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake Coco sandbox not found: ${handle.id}`);
    }
    const normalizedPath = normalizeFakeWorkspacePath(path);
    const content = this.workspaceFileContentsBySandboxId.get(handle.id)?.get(normalizedPath) || '';
    const buffer = Buffer.from(content, 'utf8');
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const truncated = buffer.byteLength > maxBytes;
    return {
      path: normalizedPath,
      content: (truncated ? buffer.subarray(0, maxBytes) : buffer).toString('utf8'),
      byteSize: buffer.byteLength,
      truncated,
      encoding: 'utf-8',
    };
  }

  async destroy(sandboxId: string): Promise<void> {
    this.consumeFailure('destroy');
    this.destroyedSandboxIds.push(sandboxId);
    this.sandboxes.delete(sandboxId);
    this.workspaceEntriesBySandboxId.delete(sandboxId);
    this.workspaceFileContentsBySandboxId.delete(sandboxId);
  }

  async countActiveSandboxes(): Promise<number> {
    return this.sandboxes.size;
  }

  async countActiveSandboxesForUser(creatorId: string): Promise<number> {
    return [...this.sandboxes.values()].filter(handle => handle.creatorId === creatorId).length;
  }
}

const normalizeFakeWorkspacePath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(part => part && part !== '.' && part !== '..');
  return parts.join('/');
};

const compareFakeWorkspaceEntries = (a: CocoWorkspaceEntry, b: CocoWorkspaceEntry) => {
  if (a.type !== b.type) {
    return a.type === 'directory' ? -1 : 1;
  }
  return a.path.localeCompare(b.path);
};
