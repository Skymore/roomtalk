import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { FakeCocoSandboxService } from './fakeCocoSandboxService';

describe('FakeCocoSandboxService', () => {
  it('creates, connects, starts runners, counts, and destroys fake sandboxes', async () => {
    const service = new FakeCocoSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));

    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });
    assert.equal(handle.provider, 'fake');
    assert.equal(handle.roomId, 'room-1');
    assert.equal(handle.creatorId, 'client-1');
    assert.equal(handle.workspace, '/workspace/room-1');
    assert.equal(handle.createdAt, '2026-05-03T00:00:00.000Z');
    assert.equal(handle.expiresAt, '2026-05-03T00:01:00.000Z');

    assert.deepEqual(await service.connect(handle.id), handle);
    assert.equal(await service.countActiveSandboxes(), 1);
    assert.equal(await service.countActiveSandboxesForUser('client-1'), 1);

    const runner = await service.startRunner({
      handle,
      command: 'python -m roomtalk_coco_runner',
      env: { PYTHONUNBUFFERED: '1' },
    });
    assert.equal(runner.command, 'python -m roomtalk_coco_runner');
    assert.deepEqual(service.startedRunnerCommands, ['python -m roomtalk_coco_runner']);
    assert.deepEqual(service.startedRunnerEnvs, [{ PYTHONUNBUFFERED: '1' }]);

    await service.destroy(handle.id);
    assert.deepEqual(service.destroyedSandboxIds, [handle.id]);
    assert.equal(await service.countActiveSandboxes(), 0);
    await assert.rejects(() => service.connect(handle.id), /not found/);
  });

  it('can fail the next requested operation for lifecycle tests', async () => {
    const service = new FakeCocoSandboxService();

    service.failNext('create');
    await assert.rejects(() => service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 }), /create failed/);

    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });
    service.failNext('connect');
    await assert.rejects(() => service.connect(handle.id), /connect failed/);

    service.failNext('destroy');
    await assert.rejects(() => service.destroy(handle.id), /destroy failed/);

    service.failNext('startRunner');
    await assert.rejects(() => service.startRunner({ handle, command: 'python -m roomtalk_coco_runner' }), /startRunner failed/);
  });

  it('lists configured workspace refs with T3-style filtering', async () => {
    const service = new FakeCocoSandboxService();
    const handle = await service.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60_000 });
    service.setWorkspaceRefs(handle.id, [
      { name: 'main', kind: 'local' },
      { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
      { name: 'origin/feature/search', kind: 'remote', remoteName: 'origin' },
    ], 'feature/search');

    assert.deepEqual(await service.listWorkspaceRefs(handle, { query: 'main', maxRefs: 2 }), {
      available: true,
      headRef: 'feature/search',
      refs: [
        { name: 'main', kind: 'local' },
        { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
      ],
    });
  });
});
