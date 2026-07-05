import { randomUUID } from 'crypto';
import {
  CodeAgentRunnerProcess,
  CodeAgentSandboxHandle,
  CodeAgentSandboxService,
  CodeAgentWorkspaceChanges,
  CodeAgentWorkspaceAsset,
  CodeAgentWorkspaceDiff,
  CodeAgentWorkspaceEntry,
  CodeAgentWorkspaceFile,
  CodeAgentWorkspaceArchive,
  CodeAgentWorkspacePreviewServer,
  CodeAgentWorkspaceRef,
  CodeAgentWorkspaceRefs,
  CreateCodeAgentSandboxInput,
  ExportCodeAgentWorkspaceArchiveOptions,
  ImportCodeAgentWorkspaceArchiveOptions,
  ListCodeAgentWorkspaceRefsOptions,
  ListCodeAgentWorkspaceEntriesOptions,
  RenameCodeAgentWorkspaceEntryInput,
  ReadCodeAgentWorkspaceAssetOptions,
  ReadCodeAgentSandboxSecretFileOptions,
  ReadCodeAgentWorkspaceDiffOptions,
  ReadCodeAgentWorkspaceFileOptions,
  SearchCodeAgentWorkspaceEntriesOptions,
  StartCodeAgentRunnerInput,
  WriteCodeAgentSandboxSecretFileInput,
  WriteCodeAgentWorkspaceFileInput,
  searchCodeAgentWorkspaceEntries,
} from './codeAgentSandboxService';

type FakeSandboxFailure = 'create' | 'connect' | 'initializeWorkspaceVersionControl' | 'startRunner' | 'exportWorkspaceArchive' | 'importWorkspaceArchive' | 'destroy';

interface FakeWorkspaceArchivePayload {
  entries: CodeAgentWorkspaceEntry[];
  files: Array<{ path: string; bodyBase64: string }>;
}

export class FakeCodeAgentSandboxService implements CodeAgentSandboxService {
  private readonly sandboxes = new Map<string, CodeAgentSandboxHandle>();
  private readonly failures = new Set<FakeSandboxFailure>();
  readonly destroyedSandboxIds: string[] = [];
  readonly initializedWorkspaceVersionControlSandboxIds: string[] = [];
  readonly startedRunnerCommands: string[] = [];
  readonly startedRunnerEnvs: Record<string, string>[] = [];
  readonly stoppedRunnerCommands: string[] = [];
  readonly deletedSecretFilePaths: string[] = [];
  readonly exportedWorkspaceArchiveSandboxIds: string[] = [];
  readonly importedWorkspaceArchiveSandboxIds: string[] = [];
  private readonly workspaceEntriesBySandboxId = new Map<string, CodeAgentWorkspaceEntry[]>();
  private readonly workspaceFileContentsBySandboxId = new Map<string, Map<string, string>>();
  private readonly workspaceFileBytesBySandboxId = new Map<string, Map<string, Buffer>>();
  private readonly secretFileContentsBySandboxId = new Map<string, Map<string, Buffer>>();
  private readonly workspaceChangesBySandboxId = new Map<string, CodeAgentWorkspaceChanges>();
  private readonly workspaceDiffBySandboxId = new Map<string, string>();
  private readonly workspacePreviewServersBySandboxId = new Map<string, CodeAgentWorkspacePreviewServer[]>();
  private readonly workspaceRefsBySandboxId = new Map<string, CodeAgentWorkspaceRefs>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  failNext(operation: FakeSandboxFailure) {
    this.failures.add(operation);
  }

  private consumeFailure(operation: FakeSandboxFailure) {
    if (!this.failures.has(operation)) {
      return;
    }
    this.failures.delete(operation);
    throw new Error(`Fake code-agent sandbox ${operation} failed`);
  }

  async create(input: CreateCodeAgentSandboxInput): Promise<CodeAgentSandboxHandle> {
    this.consumeFailure('create');
    const createdAt = this.now().toISOString();
    const handle: CodeAgentSandboxHandle = {
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
    this.workspaceFileBytesBySandboxId.set(handle.id, new Map());
    return handle;
  }

  async connect(sandboxId: string): Promise<CodeAgentSandboxHandle> {
    this.consumeFailure('connect');
    const handle = this.sandboxes.get(sandboxId);
    if (!handle) {
      throw new Error(`Fake code-agent sandbox not found: ${sandboxId}`);
    }
    return handle;
  }

  async initializeWorkspaceVersionControl(handle: CodeAgentSandboxHandle): Promise<void> {
    this.consumeFailure('initializeWorkspaceVersionControl');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    this.initializedWorkspaceVersionControlSandboxIds.push(handle.id);
  }

  async startRunner(input: StartCodeAgentRunnerInput): Promise<CodeAgentRunnerProcess> {
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

  setWorkspaceChanges(sandboxId: string, changes: CodeAgentWorkspaceChanges) {
    this.workspaceChangesBySandboxId.set(sandboxId, changes);
  }

  async getWorkspaceChanges(handle: CodeAgentSandboxHandle): Promise<CodeAgentWorkspaceChanges> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    return this.workspaceChangesBySandboxId.get(handle.id) || {
      available: false,
      changedFiles: [],
      changedFileStats: [],
      diffSummary: null,
    };
  }

  setWorkspaceDiff(sandboxId: string, patch: string) {
    this.workspaceDiffBySandboxId.set(sandboxId, patch);
  }

  async getWorkspaceDiff(
    handle: CodeAgentSandboxHandle,
    options: ReadCodeAgentWorkspaceDiffOptions = {}
  ): Promise<CodeAgentWorkspaceDiff> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const patch = this.workspaceDiffBySandboxId.get(handle.id) || '';
    const buffer = Buffer.from(patch, 'utf8');
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    const truncated = buffer.byteLength > maxBytes;
    return {
      available: true,
      patch: (truncated ? buffer.subarray(0, maxBytes) : buffer).toString('utf8'),
      byteSize: buffer.byteLength,
      truncated,
    };
  }

  setWorkspaceRefs(sandboxId: string, refs: CodeAgentWorkspaceRef[], headRef?: string) {
    this.workspaceRefsBySandboxId.set(sandboxId, {
      available: true,
      refs,
      ...(headRef ? { headRef } : {}),
    });
  }

  async listWorkspaceRefs(
    handle: CodeAgentSandboxHandle,
    options: ListCodeAgentWorkspaceRefsOptions = {}
  ): Promise<CodeAgentWorkspaceRefs> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const refs = this.workspaceRefsBySandboxId.get(handle.id) || {
      available: false,
      refs: [],
    };
    if (!refs.available) {
      return refs;
    }
    const query = options.query?.trim().toLowerCase() || '';
    const maxRefs = options.maxRefs ?? 200;
    return {
      ...refs,
      refs: refs.refs
        .filter((ref) => (
          !query ||
          ref.name.toLowerCase().includes(query) ||
          ref.remoteName?.toLowerCase().includes(query) === true
        ))
        .slice(0, maxRefs),
    };
  }

  setWorkspaceFiles(sandboxId: string, files: string[]) {
    this.setWorkspaceEntries(sandboxId, files.map(filePath => ({
      path: normalizeFakeWorkspacePath(filePath),
      name: normalizeFakeWorkspacePath(filePath).split('/').pop() || normalizeFakeWorkspacePath(filePath),
      type: 'file',
    })));
  }

  setWorkspaceEntries(sandboxId: string, entries: CodeAgentWorkspaceEntry[]) {
    this.workspaceEntriesBySandboxId.set(sandboxId, entries.map(entry => ({
      ...entry,
      path: normalizeFakeWorkspacePath(entry.path),
      name: entry.name || normalizeFakeWorkspacePath(entry.path).split('/').pop() || normalizeFakeWorkspacePath(entry.path),
    })));
  }

  setWorkspaceFileContent(sandboxId: string, path: string, content: string) {
    const files = this.workspaceFileContentsBySandboxId.get(sandboxId) || new Map<string, string>();
    const fileBytes = this.workspaceFileBytesBySandboxId.get(sandboxId) || new Map<string, Buffer>();
    const normalizedPath = normalizeFakeWorkspacePath(path);
    files.set(normalizedPath, content);
    fileBytes.set(normalizedPath, Buffer.from(content, 'utf8'));
    this.workspaceFileContentsBySandboxId.set(sandboxId, files);
    this.workspaceFileBytesBySandboxId.set(sandboxId, fileBytes);
    this.upsertWorkspaceEntry(sandboxId, {
      path: normalizedPath,
      name: normalizedPath.split('/').pop() || normalizedPath,
      type: 'file',
      size: Buffer.byteLength(content),
    });
  }

  async listWorkspaceEntries(
    handle: CodeAgentSandboxHandle,
    options: ListCodeAgentWorkspaceEntriesOptions = {}
  ): Promise<CodeAgentWorkspaceEntry[]> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    return [...(this.workspaceEntriesBySandboxId.get(handle.id) || [])]
      .sort(compareFakeWorkspaceEntries)
      .slice(0, options.maxEntries ?? 5000);
  }

  async searchWorkspaceEntries(
    handle: CodeAgentSandboxHandle,
    options: SearchCodeAgentWorkspaceEntriesOptions
  ): Promise<CodeAgentWorkspaceEntry[]> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    return searchCodeAgentWorkspaceEntries(
      this.workspaceEntriesBySandboxId.get(handle.id) || [],
      options.query,
      options.maxEntries ?? 200,
    );
  }

  async readWorkspaceFile(
    handle: CodeAgentSandboxHandle,
    path: string,
    options: ReadCodeAgentWorkspaceFileOptions = {}
  ): Promise<CodeAgentWorkspaceFile> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const normalizedPath = normalizeFakeWorkspacePath(path);
    const content = this.workspaceFileContentsBySandboxId.get(handle.id)?.get(normalizedPath) || '';
    const buffer = Buffer.from(content, 'utf8');
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    const truncated = buffer.byteLength > maxBytes;
    return {
      path: normalizedPath,
      content: (truncated ? buffer.subarray(0, maxBytes) : buffer).toString('utf8'),
      byteSize: buffer.byteLength,
      truncated,
      encoding: 'utf-8',
    };
  }

  async readWorkspaceAsset(
    handle: CodeAgentSandboxHandle,
    path: string,
    options: ReadCodeAgentWorkspaceAssetOptions = {}
  ): Promise<CodeAgentWorkspaceAsset> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const normalizedPath = normalizeFakeWorkspacePath(path);
    const body = this.workspaceFileBytesBySandboxId.get(handle.id)?.get(normalizedPath) || Buffer.alloc(0);
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    const truncated = body.byteLength > maxBytes;
    return {
      path: normalizedPath,
      body: truncated ? body.subarray(0, maxBytes) : body,
      byteSize: body.byteLength,
      truncated,
    };
  }

  async exportWorkspaceArchive(
    handle: CodeAgentSandboxHandle,
    options: ExportCodeAgentWorkspaceArchiveOptions = {}
  ): Promise<CodeAgentWorkspaceArchive> {
    this.consumeFailure('exportWorkspaceArchive');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const files = this.workspaceFileBytesBySandboxId.get(handle.id) || new Map<string, Buffer>();
    const payload: FakeWorkspaceArchivePayload = {
      entries: (this.workspaceEntriesBySandboxId.get(handle.id) || []).map(entry => ({ ...entry })),
      files: [...files.entries()].map(([path, body]) => ({
        path,
        bodyBase64: body.toString('base64'),
      })),
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    if (options.maxBytes !== undefined && body.byteLength > options.maxBytes) {
      throw new Error(`Fake code-agent workspace archive exceeds maxBytes: ${body.byteLength}`);
    }
    this.exportedWorkspaceArchiveSandboxIds.push(handle.id);
    return { body, byteSize: body.byteLength };
  }

  async importWorkspaceArchive(
    handle: CodeAgentSandboxHandle,
    archive: CodeAgentWorkspaceArchive,
    _options: ImportCodeAgentWorkspaceArchiveOptions = {}
  ): Promise<void> {
    this.consumeFailure('importWorkspaceArchive');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const payload = JSON.parse(archive.body.toString('utf8')) as FakeWorkspaceArchivePayload;
    const fileContents = new Map<string, string>();
    const fileBytes = new Map<string, Buffer>();
    for (const file of payload.files || []) {
      const normalizedPath = normalizeFakeWorkspacePath(file.path);
      const body = Buffer.from(file.bodyBase64, 'base64');
      fileBytes.set(normalizedPath, body);
      fileContents.set(normalizedPath, body.toString('utf8'));
    }
    this.workspaceEntriesBySandboxId.set(handle.id, (payload.entries || []).map(entry => ({
      ...entry,
      path: normalizeFakeWorkspacePath(entry.path),
    })));
    this.workspaceFileContentsBySandboxId.set(handle.id, fileContents);
    this.workspaceFileBytesBySandboxId.set(handle.id, fileBytes);
    this.importedWorkspaceArchiveSandboxIds.push(handle.id);
  }

  setWorkspacePreviewServers(sandboxId: string, servers: CodeAgentWorkspacePreviewServer[]) {
    this.workspacePreviewServersBySandboxId.set(sandboxId, servers.map(server => ({ ...server })));
  }

  async listWorkspacePreviewServers(handle: CodeAgentSandboxHandle): Promise<CodeAgentWorkspacePreviewServer[]> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    return (this.workspacePreviewServersBySandboxId.get(handle.id) || []).map(server => ({ ...server }));
  }

  async writeWorkspaceFile(
    handle: CodeAgentSandboxHandle,
    input: WriteCodeAgentWorkspaceFileInput
  ): Promise<CodeAgentWorkspaceEntry> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const normalizedPath = normalizeFakeWorkspacePath(input.path);
    const buffer = input.encoding === 'base64'
      ? Buffer.from(input.content, 'base64')
      : Buffer.from(input.content, 'utf8');
    const content = input.encoding === 'base64' ? buffer.toString('binary') : input.content;
    const files = this.workspaceFileContentsBySandboxId.get(handle.id) || new Map<string, string>();
    const fileBytes = this.workspaceFileBytesBySandboxId.get(handle.id) || new Map<string, Buffer>();
    files.set(normalizedPath, content);
    fileBytes.set(normalizedPath, buffer);
    this.workspaceFileContentsBySandboxId.set(handle.id, files);
    this.workspaceFileBytesBySandboxId.set(handle.id, fileBytes);
    const entry = {
      path: normalizedPath,
      name: normalizedPath.split('/').pop() || normalizedPath,
      type: 'file' as const,
      size: buffer.byteLength,
    };
    this.upsertWorkspaceEntry(handle.id, entry);
    return entry;
  }

  async writeSecretFile(handle: CodeAgentSandboxHandle, input: WriteCodeAgentSandboxSecretFileInput): Promise<void> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const secretPath = normalizeFakeSecretPath(input.path);
    const files = this.secretFileContentsBySandboxId.get(handle.id) || new Map<string, Buffer>();
    files.set(secretPath, input.encoding === 'base64' ? Buffer.from(input.content, 'base64') : Buffer.from(input.content, 'utf8'));
    this.secretFileContentsBySandboxId.set(handle.id, files);
  }

  async readSecretFile(
    handle: CodeAgentSandboxHandle,
    filePath: string,
    options: ReadCodeAgentSandboxSecretFileOptions = {}
  ): Promise<string> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const secretPath = normalizeFakeSecretPath(filePath);
    const content = this.secretFileContentsBySandboxId.get(handle.id)?.get(secretPath);
    if (!content) {
      throw new Error(`Fake code-agent secret file not found: ${secretPath}`);
    }
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    if (content.byteLength > maxBytes) {
      throw new Error(`Fake code-agent secret file is too large: ${secretPath}`);
    }
    return content.toString('utf8');
  }

  async deleteSecretFile(handle: CodeAgentSandboxHandle, filePath: string): Promise<void> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const secretPath = normalizeFakeSecretPath(filePath);
    this.deletedSecretFilePaths.push(secretPath);
    this.secretFileContentsBySandboxId.get(handle.id)?.delete(secretPath);
  }

  async createWorkspaceDirectory(handle: CodeAgentSandboxHandle, path: string): Promise<CodeAgentWorkspaceEntry> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const normalizedPath = normalizeFakeWorkspacePath(path);
    const entry = {
      path: normalizedPath,
      name: normalizedPath.split('/').pop() || normalizedPath,
      type: 'directory' as const,
    };
    this.upsertWorkspaceEntry(handle.id, entry);
    return entry;
  }

  async renameWorkspaceEntry(
    handle: CodeAgentSandboxHandle,
    input: RenameCodeAgentWorkspaceEntryInput
  ): Promise<CodeAgentWorkspaceEntry> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const fromPath = normalizeFakeWorkspacePath(input.fromPath);
    const toPath = normalizeFakeWorkspacePath(input.toPath);
    const entries = this.workspaceEntriesBySandboxId.get(handle.id) || [];
    const nextEntries = entries.map(entry => {
      if (entry.path !== fromPath && !entry.path.startsWith(`${fromPath}/`)) {
        return entry;
      }
      const suffix = entry.path === fromPath ? '' : entry.path.slice(fromPath.length);
      const path = `${toPath}${suffix}`;
      return {
        ...entry,
        path,
        name: path.split('/').pop() || path,
      };
    });
    this.workspaceEntriesBySandboxId.set(handle.id, nextEntries);

    const files = this.workspaceFileContentsBySandboxId.get(handle.id) || new Map<string, string>();
    const fileBytes = this.workspaceFileBytesBySandboxId.get(handle.id) || new Map<string, Buffer>();
    for (const [path, content] of [...files.entries()]) {
      if (path !== fromPath && !path.startsWith(`${fromPath}/`)) {
        continue;
      }
      const suffix = path === fromPath ? '' : path.slice(fromPath.length);
      files.delete(path);
      files.set(`${toPath}${suffix}`, content);
    }
    for (const [path, body] of [...fileBytes.entries()]) {
      if (path !== fromPath && !path.startsWith(`${fromPath}/`)) {
        continue;
      }
      const suffix = path === fromPath ? '' : path.slice(fromPath.length);
      fileBytes.delete(path);
      fileBytes.set(`${toPath}${suffix}`, body);
    }
    this.workspaceFileContentsBySandboxId.set(handle.id, files);
    this.workspaceFileBytesBySandboxId.set(handle.id, fileBytes);

    const renamed = nextEntries.find(entry => entry.path === toPath);
    return renamed || {
      path: toPath,
      name: toPath.split('/').pop() || toPath,
      type: 'file',
    };
  }

  async deleteWorkspaceEntry(handle: CodeAgentSandboxHandle, path: string): Promise<void> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake code-agent sandbox not found: ${handle.id}`);
    }
    const normalizedPath = normalizeFakeWorkspacePath(path);
    this.workspaceEntriesBySandboxId.set(
      handle.id,
      (this.workspaceEntriesBySandboxId.get(handle.id) || [])
        .filter(entry => entry.path !== normalizedPath && !entry.path.startsWith(`${normalizedPath}/`))
    );
    const files = this.workspaceFileContentsBySandboxId.get(handle.id) || new Map<string, string>();
    const fileBytes = this.workspaceFileBytesBySandboxId.get(handle.id) || new Map<string, Buffer>();
    for (const filePath of [...files.keys()]) {
      if (filePath === normalizedPath || filePath.startsWith(`${normalizedPath}/`)) {
        files.delete(filePath);
      }
    }
    for (const filePath of [...fileBytes.keys()]) {
      if (filePath === normalizedPath || filePath.startsWith(`${normalizedPath}/`)) {
        fileBytes.delete(filePath);
      }
    }
    this.workspaceFileContentsBySandboxId.set(handle.id, files);
    this.workspaceFileBytesBySandboxId.set(handle.id, fileBytes);
  }

  async destroy(sandboxId: string): Promise<void> {
    this.consumeFailure('destroy');
    this.destroyedSandboxIds.push(sandboxId);
    this.sandboxes.delete(sandboxId);
    this.workspaceEntriesBySandboxId.delete(sandboxId);
    this.workspaceFileContentsBySandboxId.delete(sandboxId);
    this.workspaceFileBytesBySandboxId.delete(sandboxId);
    this.secretFileContentsBySandboxId.delete(sandboxId);
    this.workspaceChangesBySandboxId.delete(sandboxId);
    this.workspaceDiffBySandboxId.delete(sandboxId);
    this.workspacePreviewServersBySandboxId.delete(sandboxId);
  }

  async countActiveSandboxes(): Promise<number> {
    return this.sandboxes.size;
  }

  async countActiveSandboxesForUser(creatorId: string): Promise<number> {
    return [...this.sandboxes.values()].filter(handle => handle.creatorId === creatorId).length;
  }

  private upsertWorkspaceEntry(sandboxId: string, entry: CodeAgentWorkspaceEntry) {
    const entries = this.workspaceEntriesBySandboxId.get(sandboxId) || [];
    const ancestorEntries = workspaceAncestorDirectories(entry.path)
      .filter(path => !entries.some(candidate => candidate.path === path))
      .map(path => ({
        path,
        name: path.split('/').pop() || path,
        type: 'directory' as const,
      }));
    this.workspaceEntriesBySandboxId.set(sandboxId, [
      ...entries.filter(candidate => candidate.path !== entry.path),
      ...ancestorEntries,
      entry,
    ]);
  }
}

const normalizeFakeWorkspacePath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(part => part && part !== '.' && part !== '..');
  return parts.join('/');
};

const normalizeFakeSecretPath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized.startsWith('/tmp/roomtalk-codex/')) {
    throw new Error('Fake code-agent secret file path must stay under /tmp/roomtalk-codex');
  }
  const parts = normalized.slice('/tmp/roomtalk-codex/'.length).split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
    throw new Error('Fake code-agent secret file path is invalid');
  }
  return `/tmp/roomtalk-codex/${parts.join('/')}`;
};

const compareFakeWorkspaceEntries = (a: CodeAgentWorkspaceEntry, b: CodeAgentWorkspaceEntry) => {
  if (a.type !== b.type) {
    return a.type === 'directory' ? -1 : 1;
  }
  return a.path.localeCompare(b.path);
};

const workspaceAncestorDirectories = (path: string): string[] => {
  const parts = path.split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join('/'));
  }
  return ancestors;
};
