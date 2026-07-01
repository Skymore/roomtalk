import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'stream';
import { E2BCocoSandboxService, E2BSandboxDriver, E2BSandboxDriverHandle } from './e2bCocoSandboxService';

class FakeE2BDriver implements E2BSandboxDriver {
  readonly handles = new Map<string, E2BSandboxDriverHandle>();
  readonly metadata = new Map<string, Record<string, string>>();
  readonly killed: string[] = [];
  readonly commands: string[] = [];
  readonly commandOptions: Record<string, unknown>[] = [];
  readonly createInputs: unknown[] = [];
  readonly fileListRequests: Array<{ path: string; options?: { depth?: number } }> = [];
  readonly fileReadRequests: Array<{ path: string; options?: { format?: 'text' | 'bytes' | 'stream' } }> = [];
  readonly fileWriteRequests: Array<{ path: string; data: string | Uint8Array }> = [];
  readonly fileMakeDirRequests: string[] = [];
  readonly fileRenameRequests: Array<{ oldPath: string; newPath: string }> = [];
  readonly fileRemoveRequests: string[] = [];
  failList = false;

  async create(input: { templateId: string; timeoutMs: number; metadata: Record<string, string> }): Promise<E2BSandboxDriverHandle> {
    this.createInputs.push(input);
    const handle = this.createHandle(`e2b-${this.handles.size + 1}`);
    this.handles.set(handle.id, handle);
    this.metadata.set(handle.id, input.metadata);
    return handle;
  }

  async connect(sandboxId: string): Promise<E2BSandboxDriverHandle> {
    const handle = this.handles.get(sandboxId);
    if (!handle) {
      throw new Error(`Missing sandbox: ${sandboxId}`);
    }
    return handle;
  }

  async list(input: { metadata?: Record<string, string> } = {}) {
    if (this.failList) {
      throw new Error('E2B list unavailable');
    }
    return [...this.handles.keys()]
      .map(id => ({ id, metadata: this.metadata.get(id) || {} }))
      .filter(item => Object.entries(input.metadata || {}).every(([key, value]) => item.metadata[key] === value));
  }

  createHandle(id: string): E2BSandboxDriverHandle {
    return {
      id,
      getHost: (port: number) => `${port}-${id}.sandbox.e2b.dev`,
      commands: {
        run: async (command, options) => {
          this.commands.push(command);
          this.commandOptions.push(options || {});
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          setTimeout(() => {
            if (command.includes('__ROOMTALK_DIFF__')) {
              stdout.end([
                '__ROOMTALK_DIFF__',
                'diff --git a/src/App.tsx b/src/App.tsx',
                'index 1111111..2222222 100644',
                '--- a/src/App.tsx',
                '+++ b/src/App.tsx',
                '@@ -1 +1 @@',
                '-export default {}',
                '+export default function App() {}',
                '',
              ].join('\n'));
            } else if (command.includes('__ROOMTALK_STATUS__')) {
              stdout.end([
                '__ROOMTALK_STATUS__',
                ' M src/App.tsx',
                '?? src/New File.tsx',
                'R  src/Old.tsx -> src/New.tsx',
                '__ROOMTALK_NUMSTAT__',
                '10\t2\tsrc/App.tsx',
                '5\t0\tsrc/New.tsx',
                '-\t-\tpublic/logo.png',
                '',
              ].join('\n'));
            } else if (command.includes('__ROOMTALK_REFS__')) {
              stdout.end([
                '__ROOMTALK_HEAD_REF__',
                'feature/search',
                '__ROOMTALK_REFS__',
                'main\trefs/heads/main',
                'feature/search\trefs/heads/feature/search',
                'origin/HEAD\trefs/remotes/origin/HEAD',
                'origin/main\trefs/remotes/origin/main',
                'upstream/main\trefs/remotes/upstream/main',
                '',
              ].join('\n'));
            } else {
              stdout.end();
            }
            stderr.end();
          }, 0);
          return {
            pid: 42,
            stdin: new PassThrough(),
            stdout,
            stderr,
            completed: Promise.resolve({ exitCode: 0, signal: null }),
          };
        },
      },
      files: {
        list: async (path, options) => {
          this.fileListRequests.push({ path, options });
          return [
            { path: '/workspace/plot_output.png', type: 'file', size: 42, modifiedAt: '2026-05-03T00:00:02.000Z' },
            { path: '/workspace/output', type: 'dir' },
            { path: '/workspace/output/report.html', type: 'file' },
          ];
        },
        read: async (path, options) => {
          this.fileReadRequests.push({ path, options });
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from('<h1>Report</h1>', 'utf8'));
              controller.close();
            },
          });
        },
        write: async (path, data) => {
          this.fileWriteRequests.push({ path, data });
          return {};
        },
        makeDir: async (path) => {
          this.fileMakeDirRequests.push(path);
          return true;
        },
        rename: async (oldPath, newPath) => {
          this.fileRenameRequests.push({ oldPath, newPath });
          return { path: newPath, type: 'file' };
        },
        remove: async (path) => {
          this.fileRemoveRequests.push(path);
        },
      },
      kill: async () => {
        this.killed.push(id);
        this.handles.delete(id);
        this.metadata.delete(id);
      },
    };
  }
}

describe('E2BCocoSandboxService', () => {
  it('creates, starts commands, and destroys E2B sandboxes through the driver', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, {
      templateId: 'roomtalk-coco',
      artifactVersion: 'roomtalk-coco-2026-06-28-a4e70e6',
      cocoSourceRef: 'a4e70e674e46d59a63874371276f5fec0fcd3f41',
      lifecycle: { onTimeout: 'pause', autoResume: true, keepMemory: true },
    }, () => new Date('2026-05-03T00:00:00.000Z'));

    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });
    assert.equal(handle.id, 'e2b-1');
    assert.equal(handle.provider, 'e2b');
    assert.equal(handle.workspace, '/workspace');
    assert.equal(handle.createdAt, '2026-05-03T00:00:00.000Z');
    assert.equal(handle.expiresAt, '2026-05-03T00:01:00.000Z');
    assert.deepEqual(driver.createInputs[0], {
      templateId: 'roomtalk-coco',
      timeoutMs: 60_000,
      metadata: {
        roomId: 'room-1',
        creatorId: 'client-1',
        artifactVersion: 'roomtalk-coco-2026-06-28-a4e70e6',
        cocoSourceRef: 'a4e70e674e46d59a63874371276f5fec0fcd3f41',
      },
      lifecycle: { onTimeout: 'pause', autoResume: true, keepMemory: true },
    });

    const runner = await service.startRunner({
      handle,
      command: 'python -m roomtalk_coco_runner',
      env: { PYTHONUNBUFFERED: '1' },
      timeoutMs: 300_000,
    });
    assert.equal(runner.pid, 42);
    assert.ok(runner.stdin);
    assert.ok(runner.stdout);
    assert.ok(runner.stderr);
    assert.deepEqual(await runner.completed, { exitCode: 0, signal: null });
    assert.deepEqual(driver.commands, ['python -m roomtalk_coco_runner']);
    assert.deepEqual(driver.commandOptions, [{
      env: {
        PYTHONUNBUFFERED: '1',
        ROOMTALK_E2B_PORT_HOST_TEMPLATE: '{port}-e2b-1.sandbox.e2b.dev',
      },
      timeoutMs: 300_000,
    }]);
    assert.deepEqual(await service.listWorkspaceEntries(handle, { maxDepth: 3 }), [
      { path: 'output', name: 'output', type: 'directory' },
      { path: 'output/report.html', name: 'report.html', type: 'file' },
      {
        path: 'plot_output.png',
        name: 'plot_output.png',
        type: 'file',
        size: 42,
        updatedAt: '2026-05-03T00:00:02.000Z',
      },
    ]);
    assert.deepEqual(driver.fileListRequests, [{ path: '/workspace', options: { depth: 3 } }]);
    assert.deepEqual(await service.readWorkspaceFile(handle, 'output/report.html'), {
      path: 'output/report.html',
      content: '<h1>Report</h1>',
      byteSize: 15,
      truncated: false,
      encoding: 'utf-8',
    });
    assert.deepEqual(driver.fileReadRequests, [{ path: '/workspace/output/report.html', options: { format: 'stream' } }]);
    assert.equal((await service.readWorkspaceFile(handle, '/workspace/plot_output.png')).path, 'plot_output.png');
    assert.deepEqual(driver.fileReadRequests[1], { path: '/workspace/plot_output.png', options: { format: 'stream' } });
    assert.deepEqual(await service.writeWorkspaceFile(handle, {
      path: 'src/App.tsx',
      content: 'export default {}',
      encoding: 'utf-8',
    }), {
      path: 'src/App.tsx',
      name: 'App.tsx',
      type: 'file',
      size: 17,
    });
    assert.deepEqual(driver.fileWriteRequests, [{ path: '/workspace/src/App.tsx', data: 'export default {}' }]);
    assert.deepEqual(await service.createWorkspaceDirectory(handle, 'src/components'), {
      path: 'src/components',
      name: 'components',
      type: 'directory',
    });
    assert.deepEqual(driver.fileMakeDirRequests, ['/workspace/src/components']);
    assert.deepEqual(await service.renameWorkspaceEntry(handle, { fromPath: 'src/App.tsx', toPath: 'src/Main.tsx' }), {
      path: 'src/Main.tsx',
      name: 'Main.tsx',
      type: 'file',
    });
    assert.deepEqual(driver.fileRenameRequests, [{ oldPath: '/workspace/src/App.tsx', newPath: '/workspace/src/Main.tsx' }]);
    await service.deleteWorkspaceEntry(handle, 'src/Main.tsx');
    assert.deepEqual(driver.fileRemoveRequests, ['/workspace/src/Main.tsx']);
    assert.equal(await service.countActiveSandboxes(), 1);
    assert.equal(await service.countActiveSandboxesForUser('client-1'), 1);
    assert.equal(await service.countActiveSandboxesForUser('client-2'), 0);

    const warnings: unknown[] = [];
    const serviceWithLogger = new E2BCocoSandboxService(driver, {
      templateId: 'roomtalk-coco',
      logger: { warn: (_message, meta) => warnings.push(meta) },
    });
    driver.failList = true;
    assert.equal(await serviceWithLogger.countActiveSandboxes(), undefined);
    assert.equal(await serviceWithLogger.countActiveSandboxesForUser('client-1'), undefined);
    assert.equal(warnings.length, 2);

    await service.destroy(handle.id);
    assert.deepEqual(driver.killed, [handle.id]);
  });

  it('initializes workspace version control with a baseline commit', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' });
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });

    await service.initializeWorkspaceVersionControl(handle);

    assert.equal(driver.commands.length, 1);
    assert.match(driver.commands[0], /cd '\/workspace'/);
    assert.match(driver.commands[0], /git init -b main/);
    assert.match(driver.commands[0], /git add -A/);
    assert.match(driver.commands[0], /git commit --allow-empty -m "workspace baseline"/);
    assert.deepEqual(driver.commandOptions, [{ timeoutMs: 30_000 }]);
  });

  it('reads workspace changed files from git status output', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' });
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });

    assert.deepEqual(await service.getWorkspaceChanges(handle), {
      available: true,
      changedFiles: ['src/App.tsx', 'src/New File.tsx', 'src/New.tsx'],
      diffSummary: { files: 3, additions: 15, deletions: 2 },
    });
    assert.match(driver.commands[0], /git status --porcelain=v1/);
    assert.match(driver.commands[0], /git diff --numstat HEAD --/);
    assert.match(driver.commands[0], /git add -N -- \./);
    assert.deepEqual(driver.commandOptions, [{ timeoutMs: 10_000 }]);
  });

  it('reads workspace diffs from git patch output', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' });
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });

    const patch = [
      'diff --git a/src/App.tsx b/src/App.tsx',
      'index 1111111..2222222 100644',
      '--- a/src/App.tsx',
      '+++ b/src/App.tsx',
      '@@ -1 +1 @@',
      '-export default {}',
      '+export default function App() {}',
      '',
    ].join('\n');

    assert.deepEqual(await service.getWorkspaceDiff(handle), {
      available: true,
      patch,
      byteSize: Buffer.byteLength(patch),
      truncated: false,
    });
    assert.match(driver.commands[0], /git diff --no-ext-diff --src-prefix=a\/ --dst-prefix=b\/ HEAD --/);
    assert.match(driver.commands[0], /git add -N -- \./);
    assert.deepEqual(driver.commandOptions, [{ timeoutMs: 10_000 }]);
  });

  it('uses git whitespace filtering when reading workspace diffs with the T3 option', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' });
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });

    await service.getWorkspaceDiff(handle, { ignoreWhitespace: true });

    assert.match(driver.commands[0], /git diff --no-ext-diff -w --src-prefix=a\/ --dst-prefix=b\/ HEAD --/);
  });

  it('reads T3 working tree diffs without the HEAD comparison target', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' });
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });

    await service.getWorkspaceDiff(handle, { scope: 'unstaged' });

    assert.match(driver.commands[0], /git diff --no-ext-diff --src-prefix=a\/ --dst-prefix=b\/ --/);
    assert.doesNotMatch(driver.commands[0], /git diff --no-ext-diff --src-prefix=a\/ --dst-prefix=b\/ HEAD --/);
  });

  it('reads T3 branch diffs against a selected base ref', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' });
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });

    await service.getWorkspaceDiff(handle, { baseRef: 'origin/main' });

    assert.match(driver.commands[0], /git diff --no-ext-diff --src-prefix=a\/ --dst-prefix=b\/ 'origin\/main' --/);
  });

  it('lists T3-style local and remote workspace refs from git', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' });
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });

    assert.deepEqual(await service.listWorkspaceRefs(handle, { query: 'main', maxRefs: 3 }), {
      available: true,
      headRef: 'feature/search',
      refs: [
        { name: 'main', kind: 'local' },
        { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
        { name: 'upstream/main', kind: 'remote', remoteName: 'upstream' },
      ],
    });
    assert.match(driver.commands[0], /git for-each-ref --format="%\(refname:short\)%09%\(refname\)" refs\/heads refs\/remotes/);
    assert.doesNotMatch(JSON.stringify(await service.listWorkspaceRefs(handle)), /origin\/HEAD/);
  });

  it('searches workspace entries with T3-style fuzzy path ranking', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' });
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });

    const results = await service.searchWorkspaceEntries(handle, {
      query: '@rpt',
      maxDepth: 24,
      maxEntries: 2,
    });

    assert.deepEqual(results.map(entry => entry.path), ['output/report.html']);
    assert.deepEqual(driver.fileListRequests, [{ path: '/workspace', options: { depth: 24 } }]);
  });

  it('fails loudly when the driver cannot execute commands or kill sandboxes', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' });
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });
    driver.handles.set(handle.id, { id: handle.id });

    await assert.rejects(() => service.initializeWorkspaceVersionControl(handle), /command execution/);
    await assert.rejects(() => service.getWorkspaceChanges(handle), /command execution/);
    await assert.rejects(() => service.startRunner({ handle, command: 'python -m roomtalk_coco_runner' }), /command execution/);
    await assert.rejects(() => service.destroy(handle.id), /kill/);
  });
});
