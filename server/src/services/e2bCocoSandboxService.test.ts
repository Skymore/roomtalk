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
          return {
            pid: 42,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            completed: Promise.resolve({ exitCode: 0, signal: null }),
          };
        },
      },
      files: {
        list: async (path, options) => {
          this.fileListRequests.push({ path, options });
          return [
            { path: '/workspace/plot_output.png', type: 'file' },
            { path: '/workspace/output', type: 'dir' },
            { path: '/workspace/output/report.html', type: 'file' },
          ];
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
    assert.deepEqual(await service.listWorkspaceFiles(handle, { maxDepth: 3 }), ['output/report.html', 'plot_output.png']);
    assert.deepEqual(driver.fileListRequests, [{ path: '/workspace', options: { depth: 3 } }]);
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

  it('fails loudly when the driver cannot execute commands or kill sandboxes', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' });
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });
    driver.handles.set(handle.id, { id: handle.id });

    await assert.rejects(() => service.startRunner({ handle, command: 'python -m roomtalk_coco_runner' }), /command execution/);
    await assert.rejects(() => service.destroy(handle.id), /kill/);
  });
});
