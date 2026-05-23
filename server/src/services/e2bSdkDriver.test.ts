import assert from 'assert/strict';
import { once } from 'events';
import { describe, it } from 'node:test';
import { createE2BSdkDriver } from './e2bSdkDriver';

class FakeCommandHandle {
  killed = false;

  constructor(readonly pid: number, private readonly exitCode = 0) {}

  async wait() {
    return { exitCode: this.exitCode, stdout: '', stderr: '' };
  }

  async kill() {
    this.killed = true;
    return true;
  }
}

const createFakeSandboxClass = () => {
  const calls = {
    create: [] as Array<{ template: string; options: Record<string, unknown> }>,
    connect: [] as Array<{ sandboxId: string; options: Record<string, unknown> }>,
    run: [] as Array<{ command: string; options: Record<string, unknown> }>,
    sentStdin: [] as Array<{ pid: number; data: string }>,
    closedStdin: [] as number[],
    killed: [] as string[],
    listed: [] as Record<string, unknown>[],
  };
  const sandboxes = new Map<string, any>();
  const commandHandles: FakeCommandHandle[] = [];

  const createSandbox = (sandboxId: string) => {
    const sandbox = {
      sandboxId,
      commands: {
        run: async (command: string, options: any) => {
          calls.run.push({ command, options });
          options.onStdout('{"type":"status"}\n');
          options.onStderr('runner warning\n');
          const handle = new FakeCommandHandle(77);
          commandHandles.push(handle);
          return handle;
        },
        sendStdin: async (pid: number, data: string | Uint8Array) => {
          calls.sentStdin.push({
            pid,
            data: typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
          });
        },
        closeStdin: async (pid: number) => {
          calls.closedStdin.push(pid);
        },
      },
      kill: async () => {
        calls.killed.push(sandboxId);
      },
    };
    sandboxes.set(sandboxId, sandbox);
    return sandbox;
  };

  const sandboxClass = {
    create: async (template: string, options: Record<string, unknown>) => {
      calls.create.push({ template, options });
      return createSandbox('sdk-created-1');
    },
    connect: async (sandboxId: string, options: Record<string, unknown>) => {
      calls.connect.push({ sandboxId, options });
      return sandboxes.get(sandboxId) || createSandbox(sandboxId);
    },
    list: (options: Record<string, unknown>) => {
      calls.listed.push(options);
      let done = false;
      const query = options.query as { metadata?: Record<string, string> } | undefined;
      return {
        get hasNext() {
          return !done;
        },
        nextItems: async () => {
          done = true;
          const items: Array<{ sandboxId: string; metadata: Record<string, string> }> = [
            { sandboxId: 'sdk-created-1', metadata: { creatorId: 'client-1' } },
            { sandboxId: 'sdk-created-2', metadata: { creatorId: 'client-2' } },
          ];
          return items.filter(item => Object.entries(query?.metadata || {}).every(([key, value]) => item.metadata[key] === value));
        },
      };
    },
  };

  return { calls, commandHandles, sandboxClass };
};

describe('E2B SDK driver', () => {
  it('wraps SDK create, connect, command streams, stdin, listing, and kill', async () => {
    const fake = createFakeSandboxClass();
    const driver = createE2BSdkDriver({
      sandboxClass: fake.sandboxClass,
      apiKey: 'e2b-test-key',
      requestTimeoutMs: 12_000,
    });

    const handle = await driver.create({
      templateId: 'roomtalk-coco',
      timeoutMs: 60_000,
      metadata: { roomId: 'room-1', creatorId: 'client-1' },
    });
    assert.equal(handle.id, 'sdk-created-1');
    assert.deepEqual(fake.calls.create[0], {
      template: 'roomtalk-coco',
      options: {
        apiKey: 'e2b-test-key',
        requestTimeoutMs: 12_000,
        timeoutMs: 60_000,
        metadata: { roomId: 'room-1', creatorId: 'client-1' },
      },
    });

    const connected = await driver.connect(handle.id);
    assert.equal(connected.id, 'sdk-created-1');
    assert.deepEqual(fake.calls.connect[0], {
      sandboxId: 'sdk-created-1',
      options: { apiKey: 'e2b-test-key', requestTimeoutMs: 12_000 },
    });

    const command = await connected.commands!.run('python -m roomtalk_coco_runner', {
      env: { PYTHONUNBUFFERED: '1' },
      timeoutMs: 300_000,
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    command.stdout!.on('data', chunk => stdoutChunks.push(String(chunk)));
    command.stderr!.on('data', chunk => stderrChunks.push(String(chunk)));
    command.stdin!.end('{"schemaVersion":1}\n');
    await once(command.stdin!, 'finish');

    assert.equal(command.pid, 77);
    assert.deepEqual(await command.completed, { exitCode: 0, signal: null });
    assert.deepEqual(fake.calls.run[0], {
      command: 'python -m roomtalk_coco_runner',
      options: {
        background: true,
        stdin: true,
        envs: { PYTHONUNBUFFERED: '1' },
        timeoutMs: 300_000,
        onStdout: fake.calls.run[0].options.onStdout,
        onStderr: fake.calls.run[0].options.onStderr,
      },
    });
    assert.deepEqual(stdoutChunks, ['{"type":"status"}\n']);
    assert.deepEqual(stderrChunks, ['runner warning\n']);
    assert.deepEqual(fake.calls.sentStdin, [{ pid: 77, data: '{"schemaVersion":1}\n' }]);
    assert.deepEqual(fake.calls.closedStdin, [77]);

    await command.stop!();
    assert.equal(fake.commandHandles[0].killed, true);

    assert.deepEqual(await driver.list!({ metadata: { creatorId: 'client-1' } }), [
      { id: 'sdk-created-1', metadata: { creatorId: 'client-1' } },
    ]);
    assert.deepEqual(fake.calls.listed[0], {
      apiKey: 'e2b-test-key',
      requestTimeoutMs: 12_000,
      query: { metadata: { creatorId: 'client-1' }, state: ['running'] },
    });

    await connected.kill!();
    assert.deepEqual(fake.calls.killed, ['sdk-created-1']);
  });

  it('finalizes stdin when the SDK no longer exposes closeStdin', async () => {
    const fake = createFakeSandboxClass();
    const sandboxClass = {
      ...fake.sandboxClass,
      connect: async (sandboxId: string, options: Record<string, unknown>) => {
        const sandbox = await fake.sandboxClass.connect(sandboxId, options);
        return {
          ...sandbox,
          commands: {
            ...sandbox.commands,
            closeStdin: undefined,
          },
        };
      },
    };
    const driver = createE2BSdkDriver({ sandboxClass });
    const connected = await driver.connect('sdk-existing-1');
    const command = await connected.commands!.run('python -m roomtalk_coco_runner');

    command.stdin!.end('{"schemaVersion":1}\n');
    await once(command.stdin!, 'finish');

    assert.deepEqual(fake.calls.sentStdin, [{ pid: 77, data: '{"schemaVersion":1}\n' }]);
    assert.deepEqual(fake.calls.closedStdin, []);
  });
});
