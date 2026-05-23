import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'stream';
import { E2BCocoSandboxService, E2BSandboxDriver, E2BSandboxDriverHandle } from './e2bCocoSandboxService';

class FakeE2BDriver implements E2BSandboxDriver {
  readonly handles = new Map<string, E2BSandboxDriverHandle>();
  readonly killed: string[] = [];
  readonly commands: string[] = [];
  readonly commandOptions: Record<string, unknown>[] = [];

  async create(): Promise<E2BSandboxDriverHandle> {
    const handle = this.createHandle(`e2b-${this.handles.size + 1}`);
    this.handles.set(handle.id, handle);
    return handle;
  }

  async connect(sandboxId: string): Promise<E2BSandboxDriverHandle> {
    const handle = this.handles.get(sandboxId);
    if (!handle) {
      throw new Error(`Missing sandbox: ${sandboxId}`);
    }
    return handle;
  }

  createHandle(id: string): E2BSandboxDriverHandle {
    return {
      id,
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
      kill: async () => {
        this.killed.push(id);
        this.handles.delete(id);
      },
    };
  }
}

describe('E2BCocoSandboxService', () => {
  it('creates, starts commands, and destroys E2B sandboxes through the driver', async () => {
    const driver = new FakeE2BDriver();
    const service = new E2BCocoSandboxService(driver, { templateId: 'roomtalk-coco' }, () => new Date('2026-05-03T00:00:00.000Z'));

    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });
    assert.equal(handle.id, 'e2b-1');
    assert.equal(handle.provider, 'e2b');
    assert.equal(handle.workspace, '/workspace');
    assert.equal(handle.createdAt, '2026-05-03T00:00:00.000Z');
    assert.equal(handle.expiresAt, '2026-05-03T00:01:00.000Z');

    const runner = await service.startRunner({
      handle,
      command: 'python -m roomtalk_coco_runner',
      env: { PYTHONUNBUFFERED: '1' },
    });
    assert.equal(runner.pid, 42);
    assert.ok(runner.stdin);
    assert.ok(runner.stdout);
    assert.ok(runner.stderr);
    assert.deepEqual(await runner.completed, { exitCode: 0, signal: null });
    assert.deepEqual(driver.commands, ['python -m roomtalk_coco_runner']);
    assert.deepEqual(driver.commandOptions, [{ env: { PYTHONUNBUFFERED: '1' } }]);

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
