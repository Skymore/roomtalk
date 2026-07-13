import {
  CodeAgentRunnerProcess,
  CodeAgentRunnerProcessExit,
  CodeAgentSandboxHandle,
  CodeAgentSandboxService,
  CodeAgentWorkspaceChanges,
  CodeAgentWorkspaceAsset,
  CodeAgentWorkspaceArchive,
  CodeAgentWorkspaceDiff,
  CodeAgentWorkspaceEntry,
  CodeAgentWorkspaceFile,
  CodeAgentWorkspaceRef,
  CodeAgentWorkspaceRefs,
  CreateCodeAgentSandboxInput,
  ListCodeAgentWorkspaceRefsOptions,
  ListCodeAgentWorkspaceEntriesOptions,
  RenameCodeAgentWorkspaceEntryInput,
  ExportCodeAgentWorkspaceArchiveOptions,
  ImportCodeAgentWorkspaceArchiveOptions,
  ReadCodeAgentWorkspaceAssetOptions,
  ReadCodeAgentSandboxSecretFileOptions,
  ReadCodeAgentWorkspaceDiffOptions,
  ReadCodeAgentWorkspaceFileOptions,
  ResolveCodeAgentWorkspacePreviewTargetInput,
  CodeAgentWorkspacePreviewServer,
  CodeAgentWorkspacePreviewTargetResolution,
  CodeAgentWorkspaceTerminal,
  SearchCodeAgentWorkspaceEntriesOptions,
  StartCodeAgentRunnerInput,
  StartCodeAgentWorkspaceCommandInput,
  StartCodeAgentWorkspaceTerminalInput,
  WriteCodeAgentSandboxSecretFileInput,
  WriteCodeAgentWorkspaceFileInput,
  searchCodeAgentWorkspaceEntries,
} from './codeAgentSandboxService';
import { Readable, Writable } from 'stream';

export interface E2BSandboxDriverHandle {
  id: string;
  getHost?(port: number): string;
  setTimeout?(timeoutMs: number): Promise<void>;
  commands?: {
    run(command: string, options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<E2BCommandResult>;
  };
  pty?: {
    create(options: E2BTerminalCreateOptions): Promise<E2BTerminalResult>;
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
  completed?: Promise<CodeAgentRunnerProcessExit>;
  stop?(): Promise<void>;
}

export interface E2BTerminalCreateOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onData(data: Uint8Array): void | Promise<void>;
}

export interface E2BTerminalResult {
  pid?: number;
  write(data: string | Uint8Array): Promise<void>;
  resize(size: { cols: number; rows: number }): Promise<void>;
  stop(): Promise<void>;
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

export interface E2BCodeAgentSandboxServiceOptions {
  templateId: string;
  workspace?: string;
  artifactVersion?: string;
  codeAgentSourceRef?: string;
  lifecycle?: E2BSandboxLifecyclePolicy;
  logger?: {
    warn(message: string, meta?: unknown): void;
  };
}

export class E2BCodeAgentSandboxService implements CodeAgentSandboxService {
  constructor(
    private readonly driver: E2BSandboxDriver,
    private readonly options: E2BCodeAgentSandboxServiceOptions,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!options.templateId) {
      throw new Error('E2B code-agent sandbox templateId is required');
    }
  }

  async create(input: CreateCodeAgentSandboxInput): Promise<CodeAgentSandboxHandle> {
    const handle = await this.driver.create({
      templateId: this.options.templateId,
      timeoutMs: input.ttlMs,
      metadata: {
        roomId: input.roomId,
        creatorId: input.creatorId,
        ...(this.options.artifactVersion ? { artifactVersion: this.options.artifactVersion } : {}),
        ...(this.options.codeAgentSourceRef ? { codeAgentSourceRef: this.options.codeAgentSourceRef } : {}),
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

  async connect(sandboxId: string): Promise<CodeAgentSandboxHandle> {
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

  async initializeWorkspaceVersionControl(handle: CodeAgentSandboxHandle): Promise<void> {
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
      'workspace_has_entries=false',
      'for entry in ./* ./.[!.]* ./..?*; do',
      '  if [ -e "$entry" ] || [ -L "$entry" ]; then',
      '    workspace_has_entries=true',
      '    break',
      '  fi',
      'done',
      'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
      '  git config user.email "roomtalk-code-agent@example.invalid"',
      '  git config user.name "RoomTalk Coco Agent"',
      '  if git rev-parse --verify HEAD >/dev/null 2>&1; then',
      '    exit 0',
      '  fi',
      'else',
      '  git init -b main >/dev/null 2>&1 || git init >/dev/null',
      '  git config user.email "roomtalk-code-agent@example.invalid"',
      '  git config user.name "RoomTalk Coco Agent"',
      'fi',
      'mkdir -p .git/info',
      'touch .git/info/exclude',
      'for pattern in node_modules/ .npm/ .pnpm-store/ .yarn/ dist/ build/ .next/ .nuxt/ coverage/ .cache/; do',
      '  if ! grep -qxF "$pattern" .git/info/exclude; then',
      '    printf "%s\\n" "$pattern" >> .git/info/exclude',
      '  fi',
      'done',
      'if [ "$workspace_has_entries" = "false" ]; then',
      '  git commit --allow-empty -m "workspace baseline" >/dev/null',
      'else',
      '  git add -A',
      '  if git diff --cached --quiet; then',
      '    git commit --allow-empty -m "workspace baseline" >/dev/null',
      '  else',
      '    git commit -m "workspace baseline" >/dev/null',
      '  fi',
      'fi',
    ].join('\n');
    const result = await connected.commands.run(command, { timeoutMs: 30_000 });
    const completed = await result.completed;
    if (completed && completed.exitCode !== 0) {
      throw new Error(`E2B workspace version control initialization failed with exit code ${completed.exitCode}`);
    }
  }

  async setSandboxTimeout(handle: CodeAgentSandboxHandle, ttlMs: number): Promise<CodeAgentSandboxHandle> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.setTimeout) {
      throw new Error('E2B sandbox driver handle does not support timeout updates');
    }
    await connected.setTimeout(ttlMs);
    return {
      ...handle,
      expiresAt: new Date(this.now().getTime() + ttlMs).toISOString(),
    };
  }

  async startRunner(input: StartCodeAgentRunnerInput): Promise<CodeAgentRunnerProcess> {
    return this.startCommand(input);
  }

  async startWorkspaceCommand(input: StartCodeAgentWorkspaceCommandInput): Promise<CodeAgentRunnerProcess> {
    return this.startCommand({
      ...input,
      timeoutMs: input.timeoutMs ?? 0,
    });
  }

  async startWorkspaceTerminal(input: StartCodeAgentWorkspaceTerminalInput): Promise<CodeAgentWorkspaceTerminal> {
    const connected = await this.driver.connect(input.handle.id);
    if (!connected.pty?.create) {
      throw new Error('E2B sandbox driver handle does not support terminal PTYs');
    }
    return connected.pty.create({
      cols: input.cols,
      rows: input.rows,
      cwd: input.handle.workspace || this.options.workspace || '/workspace',
      env: workspaceProcessEnv(connected, input.env),
      timeoutMs: input.timeoutMs ?? 0,
      onData: input.onData,
    });
  }

  private async startCommand(input: StartCodeAgentRunnerInput | StartCodeAgentWorkspaceCommandInput): Promise<CodeAgentRunnerProcess> {
    const handle = await this.driver.connect(input.handle.id);
    if (!handle.commands?.run) {
      throw new Error('E2B sandbox driver handle does not support command execution');
    }
    const commandResult = await handle.commands.run(input.command, {
      env: workspaceProcessEnv(handle, input.env),
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

  async getWorkspaceChanges(handle: CodeAgentSandboxHandle): Promise<CodeAgentWorkspaceChanges> {
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
      'git status --porcelain=v1 -z || true',
      'printf "__ROOMTALK_NUMSTAT__\\n"',
      'if git rev-parse --verify HEAD >/dev/null 2>&1; then',
      '  git diff --numstat HEAD -- || true',
      'fi',
      'git ls-files --others --exclude-standard -z | xargs -0 -r -I{} sh -c \'git diff --no-index --numstat -- /dev/null "$1" || true\' sh {}',
    ].join('\n');
    const result = await connected.commands.run(command, { timeoutMs: 10_000 });
    const stdout = await collectReadableText(result.stdout);
    const completed = await result.completed;
    if (completed && completed.exitCode !== 0) {
      throw new Error(`E2B workspace changes query failed with exit code ${completed.exitCode}`);
    }
    return parseWorkspaceChanges(stdout);
  }

  async getWorkspaceDiff(
    handle: CodeAgentSandboxHandle,
    options: ReadCodeAgentWorkspaceDiffOptions = {}
  ): Promise<CodeAgentWorkspaceDiff> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.commands?.run) {
      throw new Error('E2B sandbox driver handle does not support command execution');
    }

    const workspace = shellQuote(handle.workspace || this.options.workspace || '/workspace');
    const whitespaceFlag = options.ignoreWhitespace ? ' --ignore-all-space' : '';
    const trimmedBaseRef = typeof options.baseRef === 'string' && options.baseRef.trim()
      ? options.baseRef.trim()
      : '';
    const isBranchScope = options.scope !== 'unstaged';
    const isExplicitBranchRange = isBranchScope && Boolean(trimmedBaseRef);
    const diffTarget = options.scope === 'unstaged' ? '--' : 'HEAD --';
    const fallbackDiffCommand = `git diff --no-ext-diff --patch --minimal${whitespaceFlag} --src-prefix=a/ --dst-prefix=b/ ${diffTarget} || true`;
    const untrackedDiffCommand = `git ls-files --others --exclude-standard -z | xargs -0 -r -I{} sh -c 'git diff --no-index --patch --minimal${whitespaceFlag} --src-prefix=a/ --dst-prefix=b/ -- /dev/null "$1" || true' sh {}`;
    const printDiffMetadataLines = [
      'printf "__ROOMTALK_HEAD_REF__\\n%s\\n" "$head_ref"',
      'printf "__ROOMTALK_BASE_REF__\\n%s\\n" "$base_ref"',
      'printf "__ROOMTALK_DIFF__\\n"',
    ];
    const automaticBaseRefLines = [
      'if [ -n "$current_branch" ]; then',
      '  configured_base=$(git config --get "branch.$current_branch.gh-merge-base" 2>/dev/null || true)',
      '  primary_remote=""',
      '  if git remote get-url origin >/dev/null 2>&1; then',
      '    primary_remote="origin"',
      '  else',
      '    primary_remote=$(git remote | sed -n "1p" || true)',
      '  fi',
      '  default_branch=""',
      '  if [ -n "$primary_remote" ]; then',
      '    default_branch=$(git symbolic-ref --quiet "refs/remotes/$primary_remote/HEAD" 2>/dev/null | sed "s#^refs/remotes/$primary_remote/##" || true)',
      '  fi',
      '  for candidate in "$configured_base" "$default_branch" main master; do',
      '    if [ -z "$candidate" ]; then continue; fi',
      '    normalized="$candidate"',
      '    case "$normalized" in origin/*) normalized="${normalized#origin/}" ;; esac',
      '    if [ -n "$primary_remote" ] && [ "$primary_remote" != "origin" ]; then',
      '      remote_prefix="$primary_remote/"',
      '      case "$normalized" in "$remote_prefix"*) normalized="${normalized#$remote_prefix}" ;; esac',
      '    fi',
      '    if [ -z "$normalized" ] || [ "$normalized" = "$current_branch" ]; then continue; fi',
      '    if [ -n "$primary_remote" ] && git show-ref --verify --quiet "refs/remotes/$primary_remote/$normalized"; then',
      '      base_ref="$primary_remote/$normalized"',
      '      break',
      '    fi',
      '    if git show-ref --verify --quiet "refs/heads/$normalized"; then',
      '      base_ref="$normalized"',
      '      break',
      '    fi',
      '  done',
      'fi',
    ];
    const diffLines = isExplicitBranchRange
      ? [
        `base_ref=${shellQuote(trimmedBaseRef)}`,
        ...printDiffMetadataLines,
        `git diff --no-ext-diff --patch --minimal${whitespaceFlag} --src-prefix=a/ --dst-prefix=b/ ${shellQuote(trimmedBaseRef)}...HEAD || true`,
      ]
      : isBranchScope
        ? [
          ...automaticBaseRefLines,
          ...printDiffMetadataLines,
          'if [ -n "$base_ref" ]; then',
          `  git diff --no-ext-diff --patch --minimal${whitespaceFlag} --src-prefix=a/ --dst-prefix=b/ "\${base_ref}...HEAD" || true`,
          'else',
          `  ${fallbackDiffCommand}`,
          `  ${untrackedDiffCommand}`,
          'fi',
        ]
        : [
          ...printDiffMetadataLines,
          fallbackDiffCommand,
          untrackedDiffCommand,
        ];
    const command = [
      'set -u',
      `cd ${workspace}`,
      'if ! command -v git >/dev/null 2>&1; then',
      '  printf "__ROOMTALK_DIFF_UNAVAILABLE__\\n"',
      '  exit 0',
      'fi',
      'git config --global --add safe.directory "$PWD" >/dev/null 2>&1 || true',
      'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
      '  printf "__ROOMTALK_DIFF_UNAVAILABLE__\\n"',
      '  exit 0',
      'fi',
      'if ! git rev-parse --verify HEAD >/dev/null 2>&1; then',
      '  printf "__ROOMTALK_DIFF_UNAVAILABLE__\\n"',
      '  exit 0',
      'fi',
      'current_branch=$(git branch --show-current 2>/dev/null || true)',
      'head_ref="$current_branch"',
      'if [ -z "$head_ref" ]; then head_ref=$(git rev-parse --short HEAD 2>/dev/null || true); fi',
      'base_ref=""',
      ...diffLines,
    ].join('\n');
    const result = await connected.commands.run(command, { timeoutMs: 10_000 });
    const stdout = await collectReadableTextWithLimit(result.stdout, options.maxBytes ?? 10 * 1024 * 1024);
    const completed = await result.completed;
    if (completed && completed.exitCode !== 0) {
      throw new Error(`E2B workspace diff query failed with exit code ${completed.exitCode}`);
    }
    return parseWorkspaceDiff(stdout.text, stdout.truncated, stdout.byteSize);
  }

  async listWorkspaceRefs(
    handle: CodeAgentSandboxHandle,
    options: ListCodeAgentWorkspaceRefsOptions = {}
  ): Promise<CodeAgentWorkspaceRefs> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.commands?.run) {
      throw new Error('E2B sandbox driver handle does not support command execution');
    }

    const workspace = shellQuote(handle.workspace || this.options.workspace || '/workspace');
    const command = [
      'set -u',
      `cd ${workspace}`,
      'if ! command -v git >/dev/null 2>&1; then',
      '  printf "__ROOMTALK_REFS_UNAVAILABLE__\\n"',
      '  exit 0',
      'fi',
      'git config --global --add safe.directory "$PWD" >/dev/null 2>&1 || true',
      'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
      '  printf "__ROOMTALK_REFS_UNAVAILABLE__\\n"',
      '  exit 0',
      'fi',
      'printf "__ROOMTALK_HEAD_REF__\\n"',
      'git branch --show-current || true',
      'primary_remote=""',
      'if git remote get-url origin >/dev/null 2>&1; then',
      '  primary_remote="origin"',
      'else',
      '  primary_remote=$(git remote | sed -n "1p" || true)',
      'fi',
      'printf "__ROOMTALK_DEFAULT_REF__\\n"',
      'if [ -n "$primary_remote" ]; then',
      '  git symbolic-ref --quiet "refs/remotes/$primary_remote/HEAD" 2>/dev/null | sed "s#^refs/remotes/$primary_remote/##" || true',
      'fi',
      'printf "__ROOMTALK_REFS__\\n"',
      'git for-each-ref --format="%(refname:short)%09%(refname)%09%(committerdate:unix)" refs/heads refs/remotes || true',
    ].join('\n');
    const result = await connected.commands.run(command, { timeoutMs: 10_000 });
    const stdout = await collectReadableText(result.stdout);
    const completed = await result.completed;
    if (completed && completed.exitCode !== 0) {
      throw new Error(`E2B workspace refs query failed with exit code ${completed.exitCode}`);
    }
    return filterWorkspaceRefs(parseWorkspaceRefs(stdout), options);
  }

  async listWorkspaceEntries(handle: CodeAgentSandboxHandle, options: ListCodeAgentWorkspaceEntriesOptions = {}): Promise<CodeAgentWorkspaceEntry[]> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.list) {
      throw new Error('E2B sandbox driver handle does not support filesystem listing');
    }

    const entries = await connected.files.list(handle.workspace, {
      depth: options.maxDepth ?? 5,
    });
    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const maxEntries = options.maxEntries ?? 5000;
    const normalizedEntries = normalizeRawWorkspaceEntries(entries, workspacePrefix);
    const ignoredPaths = await this.loadIgnoredWorkspacePaths(connected, handle, normalizedEntries);
    return prepareWorkspaceEntries(normalizedEntries, maxEntries, ignoredPaths);
  }

  async searchWorkspaceEntries(
    handle: CodeAgentSandboxHandle,
    options: SearchCodeAgentWorkspaceEntriesOptions
  ): Promise<CodeAgentWorkspaceEntry[]> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.list) {
      throw new Error('E2B sandbox driver handle does not support filesystem listing');
    }

    const entries = await connected.files.list(handle.workspace, {
      depth: options.maxDepth ?? 24,
    });
    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const normalizedEntries = normalizeRawWorkspaceEntries(entries, workspacePrefix);
    const ignoredPaths = await this.loadIgnoredWorkspacePaths(connected, handle, normalizedEntries);

    return searchCodeAgentWorkspaceEntries(
      prepareWorkspaceEntries(normalizedEntries, undefined, ignoredPaths),
      options.query,
      options.maxEntries ?? 200,
    );
  }

  async readWorkspaceFile(
    handle: CodeAgentSandboxHandle,
    workspacePath: string,
    options: ReadCodeAgentWorkspaceFileOptions = {}
  ): Promise<CodeAgentWorkspaceFile> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.read) {
      throw new Error('E2B sandbox driver handle does not support filesystem reads');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const relativePath = normalizeWorkspaceInputPath(workspacePath, workspacePrefix);
    const absolutePath = `${workspacePrefix}/${relativePath}`;
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    await this.assertCanonicalWorkspaceFile(connected, handle, workspacePrefix, absolutePath, relativePath);
    const { buffer, truncated, byteSize } = await readWorkspaceFileBytes(connected.files.read, absolutePath, maxBytes);
    const contentBuffer = truncated ? buffer.subarray(0, maxBytes) : buffer;
    const textContent = contentBuffer.includes(0) ? null : decodeUtf8(contentBuffer);
    return {
      path: relativePath,
      content: textContent ?? contentBuffer.toString('base64'),
      byteSize,
      truncated,
      encoding: textContent === null ? 'base64' : 'utf-8',
    };
  }

  async readWorkspaceAsset(
    handle: CodeAgentSandboxHandle,
    workspacePath: string,
    options: ReadCodeAgentWorkspaceAssetOptions = {}
  ): Promise<CodeAgentWorkspaceAsset> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.read) {
      throw new Error('E2B sandbox driver handle does not support filesystem reads');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const relativePath = normalizeWorkspaceInputPath(workspacePath, workspacePrefix);
    const absolutePath = `${workspacePrefix}/${relativePath}`;
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    await this.assertCanonicalWorkspaceFile(connected, handle, workspacePrefix, absolutePath, relativePath);
    const { buffer, truncated, byteSize } = await readWorkspaceFileBytes(connected.files.read, absolutePath, maxBytes);
    return {
      path: relativePath,
      body: truncated ? buffer.subarray(0, maxBytes) : buffer,
      byteSize,
      truncated,
    };
  }

  async exportWorkspaceArchive(
    handle: CodeAgentSandboxHandle,
    options: ExportCodeAgentWorkspaceArchiveOptions = {}
  ): Promise<CodeAgentWorkspaceArchive> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.commands?.run || !connected.files?.read) {
      throw new Error('E2B sandbox driver handle does not support workspace archive export');
    }

    const workspace = shellQuote(handle.workspace || this.options.workspace || '/workspace');
    const archivePath = `/tmp/roomtalk-codex/workspace-export-${Date.now()}.tar.gz`;
    const quotedArchive = shellQuote(archivePath);
    const command = [
      'set -eu',
      `workspace=${workspace}`,
      `archive=${quotedArchive}`,
      'export ROOMTALK_WORKSPACE="$workspace"',
      'export ROOMTALK_ARCHIVE="$archive"',
      'mkdir -p "$(dirname "$archive")"',
      'rm -f "$archive"',
      'if [ ! -d "$workspace" ]; then mkdir -p "$workspace"; fi',
      'python - <<\'PY\'',
      'import os',
      'import stat',
      'import sys',
      'import tarfile',
      'from pathlib import Path',
      '',
      'workspace = Path(os.environ["ROOMTALK_WORKSPACE"])',
      'archive = os.environ["ROOMTALK_ARCHIVE"]',
      'skip_dir_names = {".git", "node_modules", ".npm", ".npm-cache", ".pnpm-store"}',
      'skipped = 0',
      '',
      'def to_arcname(path: Path) -> str:',
      '    relative = path.relative_to(workspace)',
      '    return "." if str(relative) == "." else relative.as_posix()',
      '',
      'def add_entry(tar: tarfile.TarFile, path: Path) -> None:',
      '    global skipped',
      '    try:',
      '        mode = os.lstat(path).st_mode',
      '        if stat.S_ISSOCK(mode) or stat.S_ISFIFO(mode) or stat.S_ISCHR(mode) or stat.S_ISBLK(mode):',
      '            skipped += 1',
      '            return',
      '        tar.add(path, arcname=to_arcname(path), recursive=False)',
      '    except (FileNotFoundError, PermissionError, OSError) as exc:',
      '        skipped += 1',
      '        print(f"skipped {path}: {exc}", file=sys.stderr)',
      '',
      'with tarfile.open(archive, "w:gz", dereference=False) as tar:',
      '    for root, dirs, files in os.walk(workspace, topdown=True, followlinks=False):',
      '        root_path = Path(root)',
      '        dirs[:] = [dirname for dirname in dirs if dirname not in skip_dir_names]',
      '        if root_path != workspace:',
      '            add_entry(tar, root_path)',
      '        for dirname in list(dirs):',
      '            dir_path = root_path / dirname',
      '            if dir_path.is_symlink():',
      '                add_entry(tar, dir_path)',
      '        for filename in files:',
      '            add_entry(tar, root_path / filename)',
      '',
      'if skipped:',
      '    print(f"__ROOMTALK_WORKSPACE_ARCHIVE_SKIPPED__ {skipped}", file=sys.stderr)',
      'PY',
      'printf "__ROOMTALK_WORKSPACE_ARCHIVE_BYTES__\\n"',
      'wc -c < "$archive" | tr -d " "',
      'printf "\\n"',
    ].join('\n');

    try {
      const result = await connected.commands.run(command, { timeoutMs: options.timeoutMs ?? 120_000 });
      const stdoutPromise = collectReadableText(result.stdout, 64 * 1024);
      const stderrPromise = collectReadableText(result.stderr, 64 * 1024);
      const completed = await result.completed;
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      if (completed && completed.exitCode !== 0) {
        throw new Error(formatE2BCommandFailure('E2B workspace archive export', completed.exitCode, stdout, stderr));
      }
      const maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
      const archive = await readWorkspaceFileBytes(connected.files.read, archivePath, maxBytes);
      if (archive.truncated || archive.byteSize > maxBytes) {
        throw new Error(`E2B workspace archive exceeds max size: ${archive.byteSize} bytes`);
      }
      return {
        body: archive.buffer,
        byteSize: archive.byteSize,
      };
    } finally {
      await connected.files.remove?.(archivePath).catch(error => {
        this.options.logger?.warn('Unable to delete E2B workspace export archive', { error, sandboxId: handle.id, archivePath });
      });
    }
  }

  async importWorkspaceArchive(
    handle: CodeAgentSandboxHandle,
    archive: CodeAgentWorkspaceArchive,
    options: ImportCodeAgentWorkspaceArchiveOptions = {}
  ): Promise<void> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.commands?.run || !connected.files?.write) {
      throw new Error('E2B sandbox driver handle does not support workspace archive import');
    }

    const archivePath = `/tmp/roomtalk-codex/workspace-import-${Date.now()}.tar.gz`;
    await this.ensureSecretDirectory(connected, archivePath);
    await connected.files.write(archivePath, archive.body);

    const workspace = shellQuote(handle.workspace || this.options.workspace || '/workspace');
    const quotedArchive = shellQuote(archivePath);
    const command = [
      'set -eu',
      `workspace=${workspace}`,
      `archive=${quotedArchive}`,
      'export ROOMTALK_WORKSPACE="$workspace"',
      'export ROOMTALK_ARCHIVE="$archive"',
      'mkdir -p "$workspace"',
      'python - <<\'PY\'',
      'import os',
      'import shutil',
      'import tarfile',
      'from pathlib import Path',
      '',
      'workspace = Path(os.environ["ROOMTALK_WORKSPACE"])',
      'archive = os.environ["ROOMTALK_ARCHIVE"]',
      '',
      'for entry in workspace.iterdir():',
      '    if entry.is_dir() and not entry.is_symlink():',
      '        shutil.rmtree(entry)',
      '    else:',
      '        entry.unlink()',
      '',
      'def safe_members(tar: tarfile.TarFile):',
      '    root = workspace.resolve()',
      '    for member in tar.getmembers():',
      '        member_path = Path(member.name)',
      '        if member_path.is_absolute() or ".." in member_path.parts:',
      '            raise RuntimeError(f"Unsafe archive member: {member.name}")',
      '        target = (workspace / member.name).resolve()',
      '        if root != target and root not in target.parents:',
      '            raise RuntimeError(f"Archive member escapes workspace: {member.name}")',
      '        yield member',
      '',
      'with tarfile.open(archive, "r:gz") as tar:',
      '    tar.extractall(workspace, members=safe_members(tar))',
      'PY',
    ].join('\n');

    try {
      const result = await connected.commands.run(command, { timeoutMs: options.timeoutMs ?? 120_000 });
      const stdoutPromise = collectReadableText(result.stdout, 64 * 1024);
      const stderrPromise = collectReadableText(result.stderr, 64 * 1024);
      const completed = await result.completed;
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      if (completed && completed.exitCode !== 0) {
        throw new Error(formatE2BCommandFailure('E2B workspace archive import', completed.exitCode, stdout, stderr));
      }
    } finally {
      await connected.files.remove?.(archivePath).catch(error => {
        this.options.logger?.warn('Unable to delete E2B workspace import archive', { error, sandboxId: handle.id, archivePath });
      });
    }
  }

  async resolveWorkspacePreviewTarget(
    handle: CodeAgentSandboxHandle,
    input: ResolveCodeAgentWorkspacePreviewTargetInput
  ): Promise<CodeAgentWorkspacePreviewTargetResolution> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.getHost) {
      throw new Error('E2B sandbox driver handle does not support preview port URLs');
    }
    const host = connected.getHost(input.port);
    if (!host || typeof host !== 'string') {
      throw new Error('E2B sandbox driver returned an invalid preview host');
    }
    const path = normalizePreviewPortPath(input.path);
    const requestedProtocol = input.protocol ?? 'http';
    return {
      requestedUrl: `${requestedProtocol}://localhost:${input.port}${path}`,
      resolvedUrl: resolveE2BPreviewHostUrl(host, path),
      resolutionKind: 'e2b-port-host',
    };
  }

  async listWorkspacePreviewServers(handle: CodeAgentSandboxHandle): Promise<CodeAgentWorkspacePreviewServer[]> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.commands?.run) {
      throw new Error('E2B sandbox driver handle does not support command execution');
    }

    const command = [
      'set -u',
      'printf "__ROOMTALK_PREVIEW_SERVERS__\\n"',
      'if command -v ss >/dev/null 2>&1; then',
      '  ss -H -ltnp 2>/dev/null || ss -H -ltn 2>/dev/null || true',
      'elif command -v netstat >/dev/null 2>&1; then',
      '  netstat -ltnp 2>/dev/null || netstat -ltn 2>/dev/null || true',
      'else',
      '  true',
      'fi',
    ].join('\n');
    const result = await connected.commands.run(command, { timeoutMs: 10_000 });
    const stdout = await collectReadableText(result.stdout);
    const candidates = parseWorkspacePreviewServers(stdout);
    if (candidates.length === 0) {
      return [];
    }
    const previewablePorts = await probeWorkspacePreviewServerPorts(
      connected,
      candidates.map((server) => server.port),
    );
    return candidates.filter((server) => previewablePorts.has(server.port));
  }

  async writeWorkspaceFile(handle: CodeAgentSandboxHandle, input: WriteCodeAgentWorkspaceFileInput): Promise<CodeAgentWorkspaceEntry> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.write) {
      throw new Error('E2B sandbox driver handle does not support filesystem writes');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const relativePath = normalizeWorkspaceInputPath(input.path, workspacePrefix);
    const absolutePath = `${workspacePrefix}/${relativePath}`;
    await this.assertCanonicalWorkspaceMutationPath(
      connected,
      workspacePrefix,
      absolutePath,
      relativePath,
      false
    );
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

  async writeSecretFile(handle: CodeAgentSandboxHandle, input: WriteCodeAgentSandboxSecretFileInput): Promise<void> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.write) {
      throw new Error('E2B sandbox driver handle does not support secret file writes');
    }
    const secretPath = normalizeSecretFilePath(input.path);
    await this.ensureSecretDirectory(connected, secretPath);
    const content = input.encoding === 'base64'
      ? Buffer.from(input.content, 'base64')
      : input.content;
    await connected.files.write(secretPath, content);
    await this.chmodSecretFile(connected, secretPath);
  }

  async readSecretFile(
    handle: CodeAgentSandboxHandle,
    filePath: string,
    options: ReadCodeAgentSandboxSecretFileOptions = {}
  ): Promise<string> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.read) {
      throw new Error('E2B sandbox driver handle does not support secret file reads');
    }
    const secretPath = normalizeSecretFilePath(filePath);
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const { buffer, truncated, byteSize } = await readWorkspaceFileBytes(connected.files.read, secretPath, maxBytes);
    if (truncated || byteSize > maxBytes) {
      throw new Error(`Secret file is too large: ${secretPath}`);
    }
    const content = decodeUtf8(buffer);
    if (content === null) {
      throw new Error(`Secret file is not valid UTF-8: ${secretPath}`);
    }
    return content;
  }

  async deleteSecretFile(handle: CodeAgentSandboxHandle, filePath: string): Promise<void> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.remove) {
      return;
    }
    const secretPath = normalizeSecretFilePath(filePath);
    await connected.files.remove(secretPath).catch(error => {
      this.options.logger?.warn('Unable to delete E2B secret file', { error, sandboxId: handle.id, path: secretPath });
    });
  }

  async createWorkspaceDirectory(handle: CodeAgentSandboxHandle, workspacePath: string): Promise<CodeAgentWorkspaceEntry> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.makeDir) {
      throw new Error('E2B sandbox driver handle does not support directory creation');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const relativePath = normalizeWorkspaceInputPath(workspacePath, workspacePrefix);
    const absolutePath = `${workspacePrefix}/${relativePath}`;
    await this.assertCanonicalWorkspaceMutationPath(connected, workspacePrefix, absolutePath, relativePath, false);
    await connected.files.makeDir(absolutePath);
    return {
      path: relativePath,
      name: relativePath.split('/').pop() || relativePath,
      type: 'directory',
    };
  }

  async renameWorkspaceEntry(handle: CodeAgentSandboxHandle, input: RenameCodeAgentWorkspaceEntryInput): Promise<CodeAgentWorkspaceEntry> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.rename) {
      throw new Error('E2B sandbox driver handle does not support filesystem rename');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const fromPath = normalizeWorkspaceInputPath(input.fromPath, workspacePrefix);
    const toPath = normalizeWorkspaceInputPath(input.toPath, workspacePrefix);
    const absoluteFromPath = `${workspacePrefix}/${fromPath}`;
    const absoluteToPath = `${workspacePrefix}/${toPath}`;
    await this.assertCanonicalWorkspaceMutationPath(connected, workspacePrefix, absoluteFromPath, fromPath, true);
    await this.assertCanonicalWorkspaceMutationPath(connected, workspacePrefix, absoluteToPath, toPath, false);
    const result = await connected.files.rename(absoluteFromPath, absoluteToPath);
    const normalizedResult = result && typeof result === 'object' && 'path' in result
      ? normalizeWorkspaceEntry(result as E2BFileEntry, workspacePrefix)
      : null;
    return normalizedResult || {
      path: toPath,
      name: toPath.split('/').pop() || toPath,
      type: 'file',
    };
  }

  async deleteWorkspaceEntry(handle: CodeAgentSandboxHandle, workspacePath: string): Promise<void> {
    const connected = await this.driver.connect(handle.id);
    if (!connected.files?.remove) {
      throw new Error('E2B sandbox driver handle does not support filesystem deletion');
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const relativePath = normalizeWorkspaceInputPath(workspacePath, workspacePrefix);
    const absolutePath = `${workspacePrefix}/${relativePath}`;
    await this.assertCanonicalWorkspaceMutationPath(connected, workspacePrefix, absolutePath, relativePath, true);
    await connected.files.remove(absolutePath);
  }

  private async loadIgnoredWorkspacePaths(
    connected: E2BSandboxDriverHandle,
    handle: CodeAgentSandboxHandle,
    entries: readonly CodeAgentWorkspaceEntry[]
  ): Promise<ReadonlySet<string>> {
    if (!connected.commands?.run || entries.length === 0) {
      return new Set();
    }

    const workspacePrefix = handle.workspace.replace(/\/+$/, '');
    const workspace = shellQuote(handle.workspace || this.options.workspace || '/workspace');
    const command = [
      'set -u',
      `cd ${workspace}`,
      'if ! command -v git >/dev/null 2>&1; then exit 0; fi',
      'git config --global --add safe.directory "$PWD" >/dev/null 2>&1 || true',
      'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then exit 0; fi',
      'git check-ignore --no-index -z --stdin || true',
    ].join('\n');

    try {
      const result = await connected.commands.run(command, { timeoutMs: 10_000 });
      result.stdin?.end(entries.map(entry => entry.path).join('\0') + '\0');
      const stdout = await collectReadableTextWithLimit(result.stdout, 2 * 1024 * 1024);
      const completed = await result.completed;
      if (completed && completed.exitCode !== 0) {
        return new Set();
      }
      return parseGitIgnoredWorkspacePaths(stdout.text, workspacePrefix);
    } catch (error) {
      this.options.logger?.warn('Unable to load ignored E2B workspace paths', { error, sandboxId: handle.id });
      return new Set();
    }
  }

  private async assertCanonicalWorkspaceFile(
    connected: E2BSandboxDriverHandle,
    handle: CodeAgentSandboxHandle,
    workspacePrefix: string,
    absolutePath: string,
    relativePath: string
  ): Promise<void> {
    if (!connected.commands?.run) {
      throw new Error('E2B sandbox driver handle does not support canonical workspace file checks');
    }

    const command = [
      'set -u',
      `workspace=${shellQuote(workspacePrefix)}`,
      `target=${shellQuote(absolutePath)}`,
      'if ! command -v realpath >/dev/null 2>&1; then',
      '  printf "__ROOMTALK_WORKSPACE_FILE_UNAVAILABLE__\\n"',
      '  exit 0',
      'fi',
      'root_real=$(realpath -e -- "$workspace" 2>/dev/null) || { printf "__ROOMTALK_WORKSPACE_FILE_NOT_FOUND__\\n"; exit 0; }',
      'target_real=$(realpath -e -- "$target" 2>/dev/null) || { printf "__ROOMTALK_WORKSPACE_FILE_NOT_FOUND__\\n"; exit 0; }',
      'case "$target_real" in',
      '  "$root_real"/*) ;;',
      '  *) printf "__ROOMTALK_WORKSPACE_FILE_OUTSIDE__\\n"; exit 0 ;;',
      'esac',
      'if [ ! -f "$target_real" ]; then',
      '  printf "__ROOMTALK_WORKSPACE_FILE_NOT_FILE__\\n"',
      '  exit 0',
      'fi',
      'printf "__ROOMTALK_WORKSPACE_FILE_OK__\\n"',
    ].join('\n');

    const result = await connected.commands.run(command, { timeoutMs: 10_000 });
    const stdout = await collectReadableText(result.stdout, 4096);
    const completed = await result.completed;
    if (completed && completed.exitCode !== 0) {
      throw new Error(`E2B workspace file inspection failed with exit code ${completed.exitCode}`);
    }

    if (stdout.includes('__ROOMTALK_WORKSPACE_FILE_OK__')) {
      return;
    }
    if (stdout.includes('__ROOMTALK_WORKSPACE_FILE_OUTSIDE__')) {
      throw new Error(`Workspace file path resolves outside workspace root: ${relativePath}`);
    }
    if (stdout.includes('__ROOMTALK_WORKSPACE_FILE_NOT_FILE__')) {
      throw new Error(`Workspace path is not a file: ${relativePath}`);
    }
    if (stdout.includes('__ROOMTALK_WORKSPACE_FILE_NOT_FOUND__')) {
      throw new Error(`Workspace file was not found: ${relativePath}`);
    }
    if (stdout.includes('__ROOMTALK_WORKSPACE_FILE_UNAVAILABLE__')) {
      throw new Error('E2B sandbox does not support canonical workspace file checks');
    }

    this.options.logger?.warn('Unexpected E2B workspace file inspection output', {
      sandboxId: handle.id,
      relativePath,
      stdout,
    });
    throw new Error(`Unable to inspect workspace file path: ${relativePath}`);
  }

  private async assertCanonicalWorkspaceMutationPath(
    connected: E2BSandboxDriverHandle,
    workspacePrefix: string,
    absolutePath: string,
    relativePath: string,
    requireExisting: boolean
  ): Promise<void> {
    if (!connected.commands?.run) {
      throw new Error('E2B sandbox driver handle does not support canonical workspace mutation checks');
    }
    const command = [
      'set -u',
      `workspace=${shellQuote(workspacePrefix)}`,
      `target=${shellQuote(absolutePath)}`,
      `require_existing=${requireExisting ? '1' : '0'}`,
      'if ! command -v realpath >/dev/null 2>&1; then',
      '  printf "__ROOMTALK_WORKSPACE_MUTATION_UNAVAILABLE__\\n"',
      '  exit 0',
      'fi',
      'root_real=$(realpath -e -- "$workspace" 2>/dev/null) || { printf "__ROOMTALK_WORKSPACE_MUTATION_UNAVAILABLE__\\n"; exit 0; }',
      'probe="$target"',
      'if [ "$require_existing" = "1" ]; then',
      '  probe_real=$(realpath -e -- "$probe" 2>/dev/null) || { printf "__ROOMTALK_WORKSPACE_MUTATION_NOT_FOUND__\\n"; exit 0; }',
      'else',
      '  while [ ! -e "$probe" ] && [ ! -L "$probe" ]; do',
      '    parent=$(dirname -- "$probe")',
      '    [ "$parent" != "$probe" ] || { printf "__ROOMTALK_WORKSPACE_MUTATION_OUTSIDE__\\n"; exit 0; }',
      '    probe="$parent"',
      '  done',
      '  probe_real=$(realpath -e -- "$probe" 2>/dev/null) || { printf "__ROOMTALK_WORKSPACE_MUTATION_NOT_FOUND__\\n"; exit 0; }',
      'fi',
      'case "$probe_real" in',
      '  "$root_real"|"$root_real"/*) ;;',
      '  *) printf "__ROOMTALK_WORKSPACE_MUTATION_OUTSIDE__\\n"; exit 0 ;;',
      'esac',
      'printf "__ROOMTALK_WORKSPACE_MUTATION_OK__\\n"',
    ].join('\n');
    const result = await connected.commands.run(command, { timeoutMs: 10_000 });
    const stdout = await collectReadableText(result.stdout, 4096);
    const completed = await result.completed;
    if (completed && completed.exitCode !== 0) {
      throw new Error(`E2B workspace mutation inspection failed with exit code ${completed.exitCode}`);
    }
    if (stdout.includes('__ROOMTALK_WORKSPACE_MUTATION_OK__')) return;
    if (stdout.includes('__ROOMTALK_WORKSPACE_MUTATION_OUTSIDE__')) {
      throw new Error(`Workspace mutation path resolves outside workspace root: ${relativePath}`);
    }
    if (stdout.includes('__ROOMTALK_WORKSPACE_MUTATION_NOT_FOUND__')) {
      throw new Error(`Workspace mutation path was not found: ${relativePath}`);
    }
    if (stdout.includes('__ROOMTALK_WORKSPACE_MUTATION_UNAVAILABLE__')) {
      throw new Error('E2B sandbox does not support canonical workspace mutation checks');
    }
    throw new Error(`Unable to inspect workspace mutation path: ${relativePath}`);
  }

  async destroy(sandboxId: string): Promise<void> {
    const handle = await this.driver.connect(sandboxId);
    if (!handle.kill) {
      throw new Error('E2B sandbox driver handle does not support kill');
    }
    await handle.kill();
  }

  private async ensureSecretDirectory(connected: E2BSandboxDriverHandle, filePath: string): Promise<void> {
    const directory = filePath.slice(0, filePath.lastIndexOf('/')) || CODEX_SECRET_ROOT;
    if (connected.commands?.run) {
      const result = await connected.commands.run([
        'set -eu',
        `mkdir -p ${shellQuote(directory)}`,
        `chmod 700 ${shellQuote(CODEX_SECRET_ROOT)} ${shellQuote(directory)}`,
      ].join('\n'), { timeoutMs: 10_000 });
      const completed = await result.completed;
      if (completed && completed.exitCode !== 0) {
        throw new Error(`E2B secret directory setup failed with exit code ${completed.exitCode}`);
      }
      return;
    }
    if (connected.files?.makeDir) {
      await connected.files.makeDir(directory);
    }
  }

  private async chmodSecretFile(connected: E2BSandboxDriverHandle, filePath: string): Promise<void> {
    if (!connected.commands?.run) {
      return;
    }
    const result = await connected.commands.run(`chmod 600 ${shellQuote(filePath)}`, { timeoutMs: 10_000 });
    const completed = await result.completed;
    if (completed && completed.exitCode !== 0) {
      throw new Error(`E2B secret file chmod failed with exit code ${completed.exitCode}`);
    }
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
  const normalizedHost = host.trim().replace(/\.$/, '');
  const firstDot = normalizedHost.indexOf('.');
  return {
    ROOMTALK_E2B_PORT_HOST_TEMPLATE: normalizedHost.replace(String(placeholderPort), '{port}'),
    ...(firstDot > 0 ? {
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: normalizedHost.slice(firstDot),
    } : {}),
  };
};

const workspaceProcessEnv = (
  handle: E2BSandboxDriverHandle,
  env: Record<string, string> = {}
): Record<string, string> => {
  const hostEnv = portHostTemplateEnv(handle);
  return {
    ...env,
    ...hostEnv,
    ...('__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS' in env ? {
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS,
    } : {}),
  };
};

const CODEX_SECRET_ROOT = '/tmp/roomtalk-codex';

const normalizeSecretFilePath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized.startsWith(`${CODEX_SECRET_ROOT}/`)) {
    throw new Error(`Secret file path must stay under ${CODEX_SECRET_ROOT}`);
  }
  const parts = normalized.slice(CODEX_SECRET_ROOT.length + 1).split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
    throw new Error('Secret file path is invalid');
  }
  return `${CODEX_SECRET_ROOT}/${parts.join('/')}`;
};

const normalizePreviewPortPath = (value: string | undefined): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return '/';
  }
  if (trimmed.startsWith('?') || trimmed.startsWith('#')) {
    return `/${trimmed}`;
  }
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/^\/{2,}/, '/');
};

const resolveE2BPreviewHostUrl = (host: string, path: string): string => {
  const trimmedHost = host.trim();
  const baseUrl = /^https?:\/\//i.test(trimmedHost)
    ? trimmedHost
    : `https://${trimmedHost}`;
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
};

const parseWorkspacePreviewServers = (stdout: string): CodeAgentWorkspacePreviewServer[] => {
  const marker = '__ROOMTALK_PREVIEW_SERVERS__';
  const body = stdout.includes(marker) ? stdout.slice(stdout.indexOf(marker) + marker.length) : stdout;
  const servers = new Map<number, CodeAgentWorkspacePreviewServer>();
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^Proto\b/i.test(trimmed)) {
      continue;
    }
    const address = parseListeningAddress(trimmed);
    if (!address) {
      continue;
    }
    const process = parseListeningProcess(trimmed);
    const existing = servers.get(address.port);
    servers.set(address.port, {
      host: existing?.host || 'localhost',
      port: address.port,
      url: `http://localhost:${address.port}/`,
      processName: process.processName ?? existing?.processName ?? null,
      pid: process.pid ?? existing?.pid ?? null,
    });
  }
  return [...servers.values()].sort((a, b) => a.port - b.port);
};

const probeWorkspacePreviewServerPorts = async (
  handle: E2BSandboxDriverHandle,
  ports: readonly number[],
): Promise<Set<number>> => {
  if (!handle.commands?.run || ports.length === 0) {
    return new Set();
  }
  const uniquePorts = [...new Set(ports)]
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
    .slice(0, 32);
  if (uniquePorts.length === 0) {
    return new Set();
  }
  const command = [
    'set -u',
    'printf "__ROOMTALK_PREVIEW_SERVER_PROBE__\\n"',
    `ports=${shellQuote(uniquePorts.join(' '))}`,
    'if command -v curl >/dev/null 2>&1; then',
    '  for port in $ports; do',
    '    code="$(curl --max-time 1 --silent --output /dev/null --write-out "%{http_code}" "http://127.0.0.1:${port}/" 2>/dev/null || true)"',
    '    case "$code" in',
    '      [1-5][0-9][0-9]) printf "%s\\t%s\\n" "$port" "$code" ;;',
    '    esac',
    '  done',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  python3 - "$ports" <<\'PY\'',
    'import http.client',
    'import socket',
    'import sys',
    'for raw_port in sys.argv[1].split():',
    '    try:',
    '        port = int(raw_port)',
    '        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)',
    '        conn.request("GET", "/")',
    '        response = conn.getresponse()',
    '        print(f"{port}\\t{response.status}")',
    '        conn.close()',
    '    except (OSError, ValueError, http.client.HTTPException, socket.timeout):',
    '        pass',
    'PY',
    'fi',
  ].join('\n');
  const result = await handle.commands.run(command, { timeoutMs: 10_000 });
  const stdout = await collectReadableText(result.stdout);
  return parseWorkspacePreviewServerProbePorts(stdout);
};

const parseWorkspacePreviewServerProbePorts = (stdout: string): Set<number> => {
  const marker = '__ROOMTALK_PREVIEW_SERVER_PROBE__';
  const body = stdout.includes(marker) ? stdout.slice(stdout.indexOf(marker) + marker.length) : stdout;
  const ports = new Set<number>();
  for (const line of body.split(/\r?\n/)) {
    const [rawPort, rawStatus] = line.trim().split(/\s+/, 2);
    const port = Number.parseInt(rawPort || '', 10);
    const status = Number.parseInt(rawStatus || '', 10);
    if (
      Number.isInteger(port)
      && port > 0
      && port < 65536
      && Number.isInteger(status)
      && status >= 100
      && status < 600
    ) {
      ports.add(port);
    }
  }
  return ports;
};

const parseListeningAddress = (line: string): { port: number } | null => {
  for (const token of line.split(/\s+/)) {
    const parsed = parseListeningAddressToken(token);
    if (parsed) {
      return parsed;
    }
  }
  return null;
};

const parseListeningAddressToken = (token: string): { port: number } | null => {
  const cleaned = token.trim().replace(/,$/, '');
  const bracketed = cleaned.match(/^\[([^\]]+)\]:(\d{1,5})$/);
  const generic = bracketed ? null : cleaned.match(/^(.*):(\d{1,5})$/);
  const host = bracketed ? bracketed[1] : generic?.[1];
  const rawPort = bracketed ? bracketed[2] : generic?.[2];
  if (!host || !rawPort) {
    return null;
  }
  const normalizedHost = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalizedHost === '127.0.0.11') {
    return null;
  }
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    return null;
  }
  return { port };
};

const parseListeningProcess = (line: string): { processName: string | null; pid: number | null } => {
  const ssProcess = line.match(/\("([^"]+)".*?pid=(\d+)/);
  if (ssProcess) {
    return {
      processName: ssProcess[1] || null,
      pid: Number.parseInt(ssProcess[2], 10) || null,
    };
  }
  const netstatProcess = line.match(/\b(\d+)\/([^\s/]+)\b/);
  if (netstatProcess) {
    return {
      processName: netstatProcess[2] === '-' ? null : netstatProcess[2],
      pid: Number.parseInt(netstatProcess[1], 10) || null,
    };
  }
  return { processName: null, pid: null };
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const collectReadableText = async (stream: Readable | undefined, maxBytes = 256 * 1024): Promise<string> => {
  const result = await collectReadableTextWithLimit(stream, maxBytes);
  return result.text;
};

const formatE2BCommandFailure = (action: string, exitCode: number | null | undefined, stdout: string, stderr: string): string => {
  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').slice(0, 4096);
  return `${action} failed with exit code ${exitCode ?? 'unknown'}${details ? `: ${details}` : ''}`;
};

const collectReadableTextWithLimit = async (
  stream: Readable | undefined,
  maxBytes: number
): Promise<{ text: string; byteSize: number; truncated: boolean }> => {
  if (!stream) {
    return { text: '', byteSize: 0, truncated: false };
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteSize = 0;
    let truncated = false;
    let settled = false;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        text: Buffer.concat(chunks).toString('utf8'),
        byteSize,
        truncated,
      });
    };

    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += buffer.byteLength;
      if (truncated) {
        return;
      }
      const currentBytes = chunks.reduce((total, item) => total + item.byteLength, 0);
      const remainingBytes = maxBytes - currentBytes;
      if (remainingBytes <= 0) {
        truncated = true;
        return;
      }
      if (buffer.byteLength > remainingBytes) {
        chunks.push(buffer.subarray(0, remainingBytes));
        truncated = true;
        return;
      }
      chunks.push(buffer);
    });
    stream.on('end', settle);
    stream.on('close', settle);
    stream.on('error', reject);
  });
};

const parseWorkspaceChanges = (stdout: string): CodeAgentWorkspaceChanges => {
  if (!stdout || stdout.includes('__ROOMTALK_CHANGES_UNAVAILABLE__')) {
    return {
      available: false,
      changedFiles: [],
      changedFileStats: [],
      diffSummary: null,
    };
  }

  const statusOutput = sectionBetweenRaw(stdout, '__ROOMTALK_STATUS__', '__ROOMTALK_NUMSTAT__');
  const numstatOutput = sectionAfter(stdout, '__ROOMTALK_NUMSTAT__');
  const changedFiles = parseGitStatusFiles(statusOutput);
  const diffStats = parseGitNumstat(numstatOutput);
  const fileStatMap = new Map(diffStats.files.map((file) => [file.path, file]));
  const changedFileStats = changedFiles.map((path) => {
    const stat = fileStatMap.get(path);
    return {
      path,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
    };
  });

  return {
    available: true,
    changedFiles,
    changedFileStats,
    diffSummary: {
      files: changedFiles.length,
      additions: diffStats.additions,
      deletions: diffStats.deletions,
    },
  };
};

const parseWorkspaceDiff = (stdout: string, truncated: boolean, stdoutByteSize: number): CodeAgentWorkspaceDiff => {
  if (!stdout || stdout.includes('__ROOMTALK_DIFF_UNAVAILABLE__')) {
    return {
      available: false,
      patch: '',
      byteSize: 0,
      truncated: false,
    };
  }

  const patch = sectionAfterRaw(stdout, '__ROOMTALK_DIFF__');
  const hasDiffMetadata = stdout.includes('__ROOMTALK_HEAD_REF__') && stdout.includes('__ROOMTALK_BASE_REF__');
  const headRef = hasDiffMetadata
    ? sectionBetween(stdout, '__ROOMTALK_HEAD_REF__', '__ROOMTALK_BASE_REF__').trim()
    : '';
  const baseRef = hasDiffMetadata
    ? sectionBetween(stdout, '__ROOMTALK_BASE_REF__', '__ROOMTALK_DIFF__').trim()
    : '';
  return {
    available: true,
    patch,
    byteSize: truncated ? stdoutByteSize : Buffer.byteLength(patch, 'utf8'),
    truncated,
    ...(headRef ? { headRef } : {}),
    ...(baseRef ? { baseRef } : {}),
  };
};

const parseWorkspaceRefs = (stdout: string): CodeAgentWorkspaceRefs => {
  if (!stdout || stdout.includes('__ROOMTALK_REFS_UNAVAILABLE__')) {
    return {
      available: false,
      refs: [],
    };
  }

  const hasDefaultRefMarker = stdout.includes('__ROOMTALK_DEFAULT_REF__');
  const headRef = sectionBetween(
    stdout,
    '__ROOMTALK_HEAD_REF__',
    hasDefaultRefMarker ? '__ROOMTALK_DEFAULT_REF__' : '__ROOMTALK_REFS__',
  ).trim();
  const defaultBranch = hasDefaultRefMarker
    ? sectionBetween(stdout, '__ROOMTALK_DEFAULT_REF__', '__ROOMTALK_REFS__').trim()
    : '';
  const refs = sectionAfter(stdout, '__ROOMTALK_REFS__')
    .split(/\r?\n/)
    .flatMap((line): ParsedWorkspaceRef[] => {
      const [shortName, fullName, lastCommitValue] = line.split('\t');
      const name = shortName?.trim();
      const refName = fullName?.trim();
      if (!name || !refName) {
        return [];
      }
      const lastCommit = parseRefLastCommit(lastCommitValue);
      if (refName.startsWith('refs/remotes/')) {
        if (name.endsWith('/HEAD')) {
          return [];
        }
        const remoteName = name.split('/', 1)[0];
        return [{
          name,
          kind: 'remote',
          ...(remoteName ? { remoteName } : {}),
          current: false,
          isDefault: false,
          lastCommit,
        }];
      }
      if (refName.startsWith('refs/heads/')) {
        return [{
          name,
          kind: 'local',
          current: name === headRef,
          isDefault: name === defaultBranch,
          lastCommit,
        }];
      }
      return [];
    });

  return {
    available: true,
    refs: refs.sort(compareWorkspaceRefs).map(stripParsedWorkspaceRef),
    ...(headRef ? { headRef } : {}),
  };
};

const filterWorkspaceRefs = (
  value: CodeAgentWorkspaceRefs,
  options: ListCodeAgentWorkspaceRefsOptions,
): CodeAgentWorkspaceRefs => {
  if (!value.available) {
    return value;
  }
  const query = options.query?.trim().toLowerCase() || '';
  const maxRefs = Math.max(0, options.maxRefs ?? 200);
  const refs = value.refs
    .filter((ref) => (
      !query ||
      ref.name.toLowerCase().includes(query) ||
      ref.remoteName?.toLowerCase().includes(query) === true
    ))
    .slice(0, maxRefs);

  return {
    ...value,
    refs,
  };
};

type ParsedWorkspaceRef = CodeAgentWorkspaceRef & {
  current: boolean;
  isDefault: boolean;
  lastCommit: number;
};

const parseRefLastCommit = (value: string | undefined): number => {
  const timestamp = Number.parseInt(value?.trim() || '', 10);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
};

const stripParsedWorkspaceRef = (ref: ParsedWorkspaceRef): CodeAgentWorkspaceRef => ({
  name: ref.name,
  kind: ref.kind,
  ...(ref.remoteName ? { remoteName: ref.remoteName } : {}),
});

const compareWorkspaceRefs = (left: ParsedWorkspaceRef, right: ParsedWorkspaceRef): number => {
  if (left.kind !== right.kind) {
    return left.kind === 'local' ? -1 : 1;
  }
  if (left.kind === 'local') {
    const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
    const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
  }
  if (left.lastCommit !== right.lastCommit) {
    return right.lastCommit - left.lastCommit;
  }
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
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

const sectionBetweenRaw = (value: string, startMarker: string, endMarker: string): string => {
  const start = value.indexOf(startMarker);
  if (start < 0) {
    return '';
  }
  const contentStart = start + startMarker.length;
  const end = value.indexOf(endMarker, contentStart);
  const raw = end < 0 ? value.slice(contentStart) : value.slice(contentStart, end);
  return raw.startsWith('\r\n') ? raw.slice(2) : raw.startsWith('\n') ? raw.slice(1) : raw;
};

const sectionAfter = (value: string, marker: string): string => {
  const start = value.indexOf(marker);
  return start < 0 ? '' : value.slice(start + marker.length).trim();
};

const sectionAfterRaw = (value: string, marker: string): string => {
  const start = value.indexOf(marker);
  if (start < 0) {
    return '';
  }
  const rest = value.slice(start + marker.length);
  return rest.startsWith('\r\n') ? rest.slice(2) : rest.startsWith('\n') ? rest.slice(1) : rest;
};

const parseGitStatusFiles = (statusOutput: string): string[] => {
  const files = new Set<string>();
  if (statusOutput.includes('\0')) {
    const records = statusOutput.split('\0');
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.length < 4 || record[2] !== ' ') {
        continue;
      }
      const status = record.slice(0, 2);
      if (!/^[ MADRCU?!]{2}$/.test(status)) {
        continue;
      }
      const rawPath = record.slice(3);
      if (rawPath) {
        files.add(rawPath);
      }
      if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
        index += 1;
      }
    }
    return [...files].sort((left, right) => left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: 'base',
    }));
  }

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

const parseGitNumstat = (numstatOutput: string): {
  additions: number;
  deletions: number;
  files: Array<{ path: string; additions: number; deletions: number }>;
} => {
  let additions = 0;
  let deletions = 0;
  const fileStats = new Map<string, { path: string; additions: number; deletions: number }>();
  for (const line of numstatOutput.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [added, deleted, ...pathParts] = line.split('\t');
    const rawPath = pathParts.length > 1
      ? (pathParts.at(-1) || '').trim()
      : pathParts.join('\t').trim();
    if (!rawPath) {
      continue;
    }
    const addedCount = Number.parseInt(added || '', 10);
    const deletedCount = Number.parseInt(deleted || '', 10);
    const fileAdditions = Number.isFinite(addedCount) ? addedCount : 0;
    const fileDeletions = Number.isFinite(deletedCount) ? deletedCount : 0;
    const renameArrowIndex = rawPath.indexOf(' => ');
    const normalizedPath = renameArrowIndex >= 0
      ? rawPath.slice(renameArrowIndex + ' => '.length).trim()
      : rawPath;
    const path = normalizedPath || rawPath;
    additions += fileAdditions;
    deletions += fileDeletions;
    const existing = fileStats.get(path) || { path, additions: 0, deletions: 0 };
    existing.additions += fileAdditions;
    existing.deletions += fileDeletions;
    fileStats.set(path, existing);
  }
  return {
    additions,
    deletions,
    files: [...fileStats.values()].sort((left, right) => left.path.localeCompare(right.path, undefined, {
      numeric: true,
      sensitivity: 'base',
    })),
  };
};

const unquoteGitPath = (path: string): string => path
  .replace(/^"|"$/g, '')
  .replace(/\\"/g, '"')
  .replace(/\\\\/g, '\\');

const normalizeWorkspaceEntry = (entry: E2BFileEntry, workspacePrefix: string): CodeAgentWorkspaceEntry | null => {
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

const normalizeEntryType = (type: string | undefined): CodeAgentWorkspaceEntry['type'] => {
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

const T3_WORKSPACE_INDEX_EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules', '.convex']);

const isT3WorkspaceIndexNoise = (entryPath: string): boolean => (
  entryPath.split('/').some(part => T3_WORKSPACE_INDEX_EXCLUDED_SEGMENTS.has(part))
);

const isGitIgnoredWorkspaceEntry = (entryPath: string, ignoredPaths: ReadonlySet<string>): boolean => {
  if (ignoredPaths.size === 0) {
    return false;
  }
  const parts = entryPath.split('/').filter(Boolean);
  for (let index = 1; index <= parts.length; index += 1) {
    if (ignoredPaths.has(parts.slice(0, index).join('/'))) {
      return true;
    }
  }
  return false;
};

const workspaceAncestorDirectories = (entryPath: string): CodeAgentWorkspaceEntry[] => {
  const parts = entryPath.split('/').filter(Boolean);
  const ancestors: CodeAgentWorkspaceEntry[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    const path = parts.slice(0, index).join('/');
    if (!isT3WorkspaceIndexNoise(path)) {
      ancestors.push({
        path,
        name: parts[index - 1],
        type: 'directory',
      });
    }
  }
  return ancestors;
};

const normalizeRawWorkspaceEntries = (
  entries: readonly E2BFileEntry[],
  workspacePrefix: string,
): CodeAgentWorkspaceEntry[] => {
  return entries
    .map(entry => normalizeWorkspaceEntry(entry, workspacePrefix))
    .filter((entry): entry is CodeAgentWorkspaceEntry => Boolean(entry));
};

const prepareWorkspaceEntries = (
  entries: readonly CodeAgentWorkspaceEntry[],
  maxEntries?: number,
  ignoredPaths: ReadonlySet<string> = new Set()
): CodeAgentWorkspaceEntry[] => {
  const uniqueEntries = new Map<string, CodeAgentWorkspaceEntry>();
  for (const entry of entries) {
    if (isT3WorkspaceIndexNoise(entry.path) || isGitIgnoredWorkspaceEntry(entry.path, ignoredPaths)) {
      continue;
    }
    for (const ancestor of workspaceAncestorDirectories(entry.path)) {
      if (!uniqueEntries.has(ancestor.path)) {
        uniqueEntries.set(ancestor.path, ancestor);
      }
    }
    uniqueEntries.set(entry.path, entry);
  }

  const sorted = Array.from(uniqueEntries.values()).sort(compareWorkspaceEntries);
  return maxEntries === undefined ? sorted : sorted.slice(0, maxEntries);
};

const parseGitIgnoredWorkspacePaths = (stdout: string, workspacePrefix: string): ReadonlySet<string> => {
  const paths = new Set<string>();
  for (const rawPath of stdout.split('\0')) {
    const path = normalizeWorkspaceEntryPath(rawPath, workspacePrefix);
    if (path && !isT3WorkspaceIndexNoise(path)) {
      paths.add(path);
    }
  }
  return paths;
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

const compareWorkspaceEntries = (a: CodeAgentWorkspaceEntry, b: CodeAgentWorkspaceEntry) => {
  if (a.type !== b.type) {
    return a.type === 'directory' ? -1 : 1;
  }
  return a.path.localeCompare(b.path);
};
