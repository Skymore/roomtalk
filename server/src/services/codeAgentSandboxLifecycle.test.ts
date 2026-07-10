import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { AICost, Message, Room, RoomAICostTotal, RoomSandboxStatus } from '../types';
import { CodeAgentSandboxLifecycleOptions, CodeAgentSandboxLifecycleService, CodeAgentSandboxLifecycleStore } from './codeAgentSandboxLifecycle';
import { FakeCodeAgentSandboxService } from './fakeCodeAgentSandboxService';

class MemoryRoomStore implements CodeAgentSandboxLifecycleStore {
  rooms = new Map<string, Room>();
  messages = new Map<string, Message[]>();
  failNextSaveRoom = false;
  failNextReplaceRoomSandbox = false;
  forceStatusBeforeNextSandboxCas: RoomSandboxStatus | null = null;
  forceSandboxIdBeforeNextReplace: string | null = null;

  constructor(initialRooms: Room[] = []) {
    initialRooms.forEach(room => this.rooms.set(room.id, room));
  }

  async generateUniqueRoomId() { return 'room-1'; }
  async appendMessage(message: Message) { return this.appendMessageWithAtomicPosition(message); }
  async appendMessageWithAtomicPosition(message: Message) {
    const room = this.rooms.get(message.roomId);
    if (!room) return null;
    this.messages.set(message.roomId, [...(this.messages.get(message.roomId) || []), message]);
    return room;
  }
  async upsertMessage(message: Message) {
    const room = this.rooms.get(message.roomId);
    if (!room) return null;
    const messages = this.messages.get(message.roomId) || [];
    const index = messages.findIndex(item => item.id === message.id);
    if (index === -1) messages.push(message);
    else messages[index] = message;
    this.messages.set(message.roomId, messages);
    return room;
  }
  async updateMessageContent() { return null; }
  async deleteMessageById() { return null; }
  async truncateBeforeMessage() { return null; }
  async truncateAfterMessage() { return null; }
  async updateMessageAndTruncateAfter() { return null; }
  async saveMessageHistory(roomId: string, messages: Message[]) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    this.messages.set(roomId, messages);
    return room;
  }
  async clearRoomMessages(roomId: string) { const count = this.messages.get(roomId)?.length || 0; this.messages.delete(roomId); return count; }
  async readMessagesByRoom(roomId: string) { return this.messages.get(roomId) || []; }
  async readRoomAICost(roomId: string): Promise<RoomAICostTotal> { return { roomId, currency: 'USD', totalUsd: 0 }; }
  async incrementRoomAICost(roomId: string, _cost: AICost | null): Promise<RoomAICostTotal> { return { roomId, currency: 'USD', totalUsd: 0 }; }
  async saveRoom(room: Room) {
    if (this.failNextSaveRoom) {
      this.failNextSaveRoom = false;
      return null;
    }
    const savedRoom = { ...(this.rooms.get(room.id) || {}), ...room };
    this.rooms.set(room.id, savedRoom as Room);
    return savedRoom as Room;
  }
  async readRoomsByUser(clientId: string) { return [...this.rooms.values()].filter(room => room.creatorId === clientId); }
  async getRoomById(roomId: string) { return this.rooms.get(roomId) || null; }
  async updateRoomName(roomId: string, creatorId: string, name: string) {
    const room = this.rooms.get(roomId);
    if (!room || room.creatorId !== creatorId) return null;
    return this.saveRoom({ ...room, name });
  }
  async deleteRoom(roomId: string, _creatorId: string) { this.rooms.delete(roomId); this.messages.delete(roomId); }
  async countRooms() { return this.rooms.size; }
  async compareAndSetRoomSandboxStatus(roomId: string, expectedStatuses: RoomSandboxStatus[], nextStatus: RoomSandboxStatus, updatedAt = new Date().toISOString()) {
    let room = this.rooms.get(roomId);
    if (!room) return null;
    if (this.forceStatusBeforeNextSandboxCas) {
      room = { ...room, sandboxStatus: this.forceStatusBeforeNextSandboxCas };
      this.rooms.set(roomId, room);
      this.forceStatusBeforeNextSandboxCas = null;
    }
    const current = room.sandboxStatus || 'none';
    if (!expectedStatuses.includes(current)) return null;
    const updatedRoom = { ...room, sandboxStatus: nextStatus, sandboxUpdatedAt: updatedAt };
    this.rooms.set(roomId, updatedRoom);
    return updatedRoom;
  }
  async replaceRoomSandbox(roomId: string, expectedSandboxId: string, next: {
    sandboxId: string;
    sandboxStatus: RoomSandboxStatus;
    sandboxUpdatedAt: string;
    sandboxArtifactVersion?: string;
    sandboxCodeAgentSourceRef?: string;
  }) {
    if (this.failNextReplaceRoomSandbox) {
      this.failNextReplaceRoomSandbox = false;
      return null;
    }
    let room = this.rooms.get(roomId);
    if (!room) return null;
    if (this.forceSandboxIdBeforeNextReplace) {
      room = { ...room, sandboxId: this.forceSandboxIdBeforeNextReplace };
      this.rooms.set(roomId, room);
      this.forceSandboxIdBeforeNextReplace = null;
    }
    if (room.sandboxId !== expectedSandboxId) return null;
    const updatedRoom = { ...room, ...next };
    this.rooms.set(roomId, updatedRoom);
    return updatedRoom;
  }
  async findInterruptedCodeAgentRooms() {
    return [...this.rooms.values()].filter(room => room.type === 'codeAgent' && (room.sandboxStatus === 'creating' || room.codeAgentStatus === 'running'));
  }
  async findDanglingToolCalls() { return []; }
  async updateRoomMemberCount() { return 0; }
  async getRoomMemberCount() { return 0; }
  async storeClientSession() {}
  async getClientId() { return null; }
  async removeClientSession() {}
  async storeUserRooms() {}
  async getUserRooms() { return []; }
}

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  lastActivityAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  type: 'codeAgent',
  ...overrides,
});

const createLifecycle = (
  store: MemoryRoomStore,
  sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z')),
  now = () => new Date('2026-05-03T00:00:00.000Z'),
  options: Partial<CodeAgentSandboxLifecycleOptions> = {},
) => ({
  sandboxService,
  lifecycle: new CodeAgentSandboxLifecycleService(store, sandboxService, logger as any, {
    sandboxTtlMs: 60 * 60 * 1000,
    creatingStaleMs: 2 * 60 * 1000,
    maxActiveSandboxes: 10,
    maxActiveSandboxesPerUser: 10,
    ...options,
  }, now),
});

type EnsureSandboxResult = Awaited<ReturnType<CodeAgentSandboxLifecycleService['ensureReadySandbox']>>;

const failureReason = (result: EnsureSandboxResult) => {
  if (result.ok) {
    throw new Error('Expected ensureReadySandbox to fail');
  }
  return result.reason;
};

describe('CodeAgentSandboxLifecycleService', () => {
  it('creates a sandbox once and reconnects on later ensure calls', async () => {
    const store = new MemoryRoomStore([room()]);
    const { lifecycle, sandboxService } = createLifecycle(store);

    const first = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(first.ok, true);
    assert.equal(first.ok && first.created, true);
    assert.equal(await sandboxService.countActiveSandboxes(), 1);
    const savedRoom = await store.getRoomById('room-1');
    assert.equal(savedRoom?.sandboxStatus, 'ready');
    assert.equal(savedRoom?.sandboxId, first.ok && first.handle.id);
    assert.deepEqual(sandboxService.initializedWorkspaceVersionControlSandboxIds, [first.ok && first.handle.id]);

    const second = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(second.ok, true);
    assert.equal(second.ok && second.created, false);
    assert.equal(second.ok && first.ok && second.handle.id, first.ok && first.handle.id);
    assert.equal(await sandboxService.countActiveSandboxes(), 1);
    assert.deepEqual(sandboxService.initializedWorkspaceVersionControlSandboxIds, [first.ok && first.handle.id]);
  });

  it('persists the current sandbox artifact metadata when creating a sandbox', async () => {
    const store = new MemoryRoomStore([room()]);
    const { lifecycle } = createLifecycle(
      store,
      new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z')),
      () => new Date('2026-05-03T00:00:00.000Z'),
      {
        artifactVersion: 'artifact-v2',
        codeAgentSourceRef: 'source-v2',
      },
    );

    const result = await lifecycle.ensureReadySandbox('room-1', 'client-1');

    assert.equal(result.ok, true);
    const savedRoom = await store.getRoomById('room-1');
    assert.equal(savedRoom?.sandboxArtifactVersion, 'artifact-v2');
    assert.equal(savedRoom?.sandboxCodeAgentSourceRef, 'source-v2');
  });

  it('migrates a ready sandbox with stale artifact metadata without losing workspace files', async () => {
    const sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));
    const oldHandle = await sandboxService.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60 * 60 * 1000 });
    sandboxService.setWorkspaceFileContent(oldHandle.id, 'src/app.ts', 'console.log("old workspace");');
    const store = new MemoryRoomStore([room({
      sandboxStatus: 'ready',
      sandboxId: oldHandle.id,
      sandboxUpdatedAt: '2026-05-03T00:00:00.000Z',
      sandboxArtifactVersion: 'artifact-v1',
      sandboxCodeAgentSourceRef: 'source-v1',
    })]);
    const { lifecycle } = createLifecycle(
      store,
      sandboxService,
      () => new Date('2026-05-03T00:01:00.000Z'),
      {
        artifactVersion: 'artifact-v2',
        codeAgentSourceRef: 'source-v2',
      },
    );

    const result = await lifecycle.ensureReadySandbox('room-1', 'client-1');

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.created, true);
    assert.notEqual(result.ok && result.handle.id, oldHandle.id);
    assert.deepEqual(sandboxService.exportedWorkspaceArchiveSandboxIds, [oldHandle.id]);
    assert.deepEqual(sandboxService.importedWorkspaceArchiveSandboxIds, [result.ok ? result.handle.id : '']);
    assert.deepEqual(sandboxService.destroyedSandboxIds, [oldHandle.id]);
    const savedRoom = await store.getRoomById('room-1');
    assert.equal(savedRoom?.sandboxId, result.ok && result.handle.id);
    assert.equal(savedRoom?.sandboxArtifactVersion, 'artifact-v2');
    assert.equal(savedRoom?.sandboxCodeAgentSourceRef, 'source-v2');
    assert.equal(result.ok && (await sandboxService.readWorkspaceFile(result.handle, 'src/app.ts')).content, 'console.log("old workspace");');
  });

  it('keeps the old sandbox when artifact migration fails after creating a replacement', async () => {
    const sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));
    const oldHandle = await sandboxService.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60 * 60 * 1000 });
    sandboxService.setWorkspaceFileContent(oldHandle.id, 'README.md', 'old');
    sandboxService.failNext('importWorkspaceArchive');
    const store = new MemoryRoomStore([room({
      sandboxStatus: 'ready',
      sandboxId: oldHandle.id,
      sandboxUpdatedAt: '2026-05-03T00:00:00.000Z',
      sandboxArtifactVersion: 'artifact-v1',
    })]);
    const { lifecycle } = createLifecycle(
      store,
      sandboxService,
      () => new Date('2026-05-03T00:01:00.000Z'),
      { artifactVersion: 'artifact-v2' },
    );

    const result = await lifecycle.ensureReadySandbox('room-1', 'client-1');

    assert.equal(failureReason(result), 'sandbox_error');
    assert.equal((await store.getRoomById('room-1'))?.sandboxId, oldHandle.id);
    assert.equal((await store.getRoomById('room-1'))?.sandboxArtifactVersion, 'artifact-v1');
    assert.equal(sandboxService.destroyedSandboxIds.length, 1);
    assert.notEqual(sandboxService.destroyedSandboxIds[0], oldHandle.id);
    assert.equal(await sandboxService.countActiveSandboxes(), 1);
  });

  it('keeps the old sandbox when artifact migration archive exceeds the configured limit', async () => {
    const sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));
    const oldHandle = await sandboxService.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60 * 60 * 1000 });
    sandboxService.setWorkspaceFileContent(oldHandle.id, 'src/app.ts', 'console.log("old workspace");');
    const store = new MemoryRoomStore([room({
      sandboxStatus: 'ready',
      sandboxId: oldHandle.id,
      sandboxUpdatedAt: '2026-05-03T00:00:00.000Z',
      sandboxArtifactVersion: 'artifact-v1',
    })]);
    const { lifecycle } = createLifecycle(
      store,
      sandboxService,
      () => new Date('2026-05-03T00:01:00.000Z'),
      {
        artifactVersion: 'artifact-v2',
        artifactMigrationMaxArchiveBytes: 8,
      },
    );

    const result = await lifecycle.ensureReadySandbox('room-1', 'client-1');

    assert.equal(failureReason(result), 'sandbox_error');
    assert.deepEqual(sandboxService.exportedWorkspaceArchiveSandboxIds, []);
    assert.deepEqual(sandboxService.importedWorkspaceArchiveSandboxIds, []);
    assert.deepEqual(sandboxService.destroyedSandboxIds, []);
    assert.equal(await sandboxService.countActiveSandboxes(), 1);
    const savedRoom = await store.getRoomById('room-1');
    assert.equal(savedRoom?.sandboxId, oldHandle.id);
    assert.equal(savedRoom?.sandboxArtifactVersion, 'artifact-v1');
  });

  it('destroys the replacement sandbox when artifact migration loses the sandbox CAS race', async () => {
    const sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));
    const oldHandle = await sandboxService.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 60 * 60 * 1000 });
    const store = new MemoryRoomStore([room({
      sandboxStatus: 'ready',
      sandboxId: oldHandle.id,
      sandboxUpdatedAt: '2026-05-03T00:00:00.000Z',
      sandboxArtifactVersion: 'artifact-v1',
    })]);
    store.forceSandboxIdBeforeNextReplace = 'other-sandbox';
    const { lifecycle } = createLifecycle(
      store,
      sandboxService,
      () => new Date('2026-05-03T00:01:00.000Z'),
      { artifactVersion: 'artifact-v2' },
    );

    const result = await lifecycle.ensureReadySandbox('room-1', 'client-1');

    assert.equal(failureReason(result), 'store_conflict');
    assert.equal((await store.getRoomById('room-1'))?.sandboxId, 'other-sandbox');
    assert.equal(sandboxService.destroyedSandboxIds.length, 1);
    assert.notEqual(sandboxService.destroyedSandboxIds[0], oldHandle.id);
  });

  it('rejects missing, non-code-agent, and unauthorized rooms', async () => {
    const store = new MemoryRoomStore([room({ id: 'chat-room', type: undefined })]);
    const { lifecycle } = createLifecycle(store);

    assert.deepEqual(await lifecycle.ensureReadySandbox('missing', 'client-1'), { ok: false, reason: 'missing_room' });
    assert.equal(failureReason(await lifecycle.ensureReadySandbox('chat-room', 'client-1')), 'not_code_agent_room');
    assert.equal(failureReason(await lifecycle.ensureReadySandbox('chat-room', 'client-2')), 'not_code_agent_room');

    await store.saveRoom(room({ id: 'code-agent-room' }));
    assert.equal(failureReason(await lifecycle.ensureReadySandbox('code-agent-room', 'client-2')), 'forbidden');
  });

  it('holds fresh creating locks but recovers stale creating rooms', async () => {
    const store = new MemoryRoomStore([
      room({ sandboxStatus: 'creating', sandboxUpdatedAt: '2026-05-03T00:00:30.000Z' }),
    ]);
    const { lifecycle, sandboxService } = createLifecycle(store, new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:01:00.000Z')), () => new Date('2026-05-03T00:01:00.000Z'));

    assert.equal(failureReason(await lifecycle.ensureReadySandbox('room-1', 'client-1')), 'creating');
    assert.equal(await sandboxService.countActiveSandboxes(), 0);

    await store.saveRoom(room({ sandboxStatus: 'creating', sandboxUpdatedAt: '2026-05-02T23:58:00.000Z' }));
    const recovered = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(recovered.ok, true);
    assert.equal(recovered.ok && recovered.created, true);
    assert.equal((await store.getRoomById('room-1'))?.sandboxStatus, 'ready');
  });

  it('recreates missing sandboxes but reuses live near-expiry sandboxes before extending them', async () => {
    const store = new MemoryRoomStore([
      room({ sandboxStatus: 'ready', sandboxId: 'missing-sandbox', sandboxUpdatedAt: '2026-05-03T00:00:00.000Z' }),
    ]);
    const { lifecycle } = createLifecycle(store, new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:56:00.000Z')), () => new Date('2026-05-03T00:56:00.000Z'));

    const reconnectRecovered = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(reconnectRecovered.ok, true);
    assert.equal(reconnectRecovered.ok && reconnectRecovered.created, true);
    const firstNewSandboxId = (await store.getRoomById('room-1'))?.sandboxId;
    assert.notEqual(firstNewSandboxId, 'missing-sandbox');

    await store.saveRoom(room({ sandboxStatus: 'ready', sandboxId: firstNewSandboxId, sandboxUpdatedAt: '2026-05-03T00:00:00.000Z' }));
    const ttlRecovered = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(ttlRecovered.ok, true);
    assert.equal(ttlRecovered.ok && ttlRecovered.created, false);
    assert.equal((await store.getRoomById('room-1'))?.sandboxId, firstNewSandboxId);
  });

  it('reconnects timed-out sandboxes when the provider can resume them', async () => {
    const store = new MemoryRoomStore([room()]);
    const sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));
    const existing = await sandboxService.create({ roomId: 'room-1', creatorId: 'client-1', ttlMs: 5 * 60 * 1000 });
    await store.saveRoom(room({
      sandboxStatus: 'ready',
      sandboxId: existing.id,
      sandboxUpdatedAt: '2026-05-03T00:00:00.000Z',
    }));
    const lifecycle = new CodeAgentSandboxLifecycleService(store, sandboxService, logger as any, {
      sandboxTtlMs: 5 * 60 * 1000,
      creatingStaleMs: 1_000,
      maxActiveSandboxes: 10,
      maxActiveSandboxesPerUser: 10,
      reconnectTimedOutSandboxes: true,
    }, () => new Date('2026-05-03T00:20:00.000Z'));

    const result = await lifecycle.ensureReadySandbox('room-1', 'client-1');

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.created, false);
    assert.equal(result.ok && result.handle.id, existing.id);
    assert.equal(await sandboxService.countActiveSandboxes(), 1);
  });

  it('destroys a newly-created sandbox when persisting ready state fails', async () => {
    const store = new MemoryRoomStore([room()]);
    const { lifecycle, sandboxService } = createLifecycle(store);
    store.failNextSaveRoom = true;

    const result = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(failureReason(result), 'store_conflict');
    assert.equal(sandboxService.destroyedSandboxIds.length, 1);
    assert.equal((await store.getRoomById('room-1'))?.sandboxStatus, 'error');
  });

  it('continues creating a new sandbox when workspace version control initialization fails', async () => {
    const store = new MemoryRoomStore([room()]);
    const sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));
    sandboxService.failNext('initializeWorkspaceVersionControl');
    const { lifecycle } = createLifecycle(store, sandboxService);

    const result = await lifecycle.ensureReadySandbox('room-1', 'client-1');

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.created, true);
    assert.equal((await store.getRoomById('room-1'))?.sandboxStatus, 'ready');
    assert.equal(await sandboxService.countActiveSandboxes(), 1);
  });

  it('enforces global and per-user active sandbox limits before creating', async () => {
    const store = new MemoryRoomStore([room({ id: 'room-1' }), room({ id: 'room-2' })]);
    const sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));
    await sandboxService.create({ roomId: 'existing', creatorId: 'client-1', ttlMs: 60_000 });
    const lifecycle = new CodeAgentSandboxLifecycleService(store, sandboxService, logger as any, {
      sandboxTtlMs: 60_000,
      creatingStaleMs: 1_000,
      maxActiveSandboxes: 1,
      maxActiveSandboxesPerUser: 10,
    }, () => new Date('2026-05-03T00:00:00.000Z'));

    assert.equal(failureReason(await lifecycle.ensureReadySandbox('room-1', 'client-1')), 'limit_exceeded');

    const perUserLifecycle = new CodeAgentSandboxLifecycleService(store, sandboxService, logger as any, {
      sandboxTtlMs: 60_000,
      creatingStaleMs: 1_000,
      maxActiveSandboxes: 10,
      maxActiveSandboxesPerUser: 1,
    }, () => new Date('2026-05-03T00:00:00.000Z'));
    assert.equal(failureReason(await perUserLifecycle.ensureReadySandbox('room-2', 'client-1')), 'limit_exceeded');
  });

  it('recovers interrupted creating and running room states', async () => {
    const store = new MemoryRoomStore([
      room({ id: 'creating-room', sandboxStatus: 'creating', sandboxUpdatedAt: '2026-05-03T00:00:00.000Z' }),
      room({ id: 'running-room', sandboxStatus: 'ready', codeAgentStatus: 'running' }),
      room({ id: 'both-room', sandboxStatus: 'creating', codeAgentStatus: 'running', sandboxUpdatedAt: '2026-05-03T00:00:00.000Z' }),
      room({ id: 'ready-room', sandboxStatus: 'ready', codeAgentStatus: 'idle' }),
    ]);
    const { lifecycle } = createLifecycle(store);

    assert.equal(await lifecycle.recoverInterruptedSandboxes(), 3);
    assert.equal((await store.getRoomById('creating-room'))?.sandboxStatus, 'error');
    assert.equal((await store.getRoomById('running-room'))?.codeAgentStatus, 'error');
    assert.equal((await store.getRoomById('both-room'))?.sandboxStatus, 'error');
    assert.equal((await store.getRoomById('both-room'))?.codeAgentStatus, 'error');
    assert.equal((await store.getRoomById('ready-room'))?.codeAgentStatus, 'idle');
  });

  it('destroys existing room sandboxes before destructive room cleanup', async () => {
    const store = new MemoryRoomStore([room()]);
    const { lifecycle, sandboxService } = createLifecycle(store);
    const ensured = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(ensured.ok, true);

    const result = await lifecycle.destroyRoomSandbox('room-1', 'client-1');
    assert.equal(result.destroyed, true);
    assert.deepEqual(sandboxService.destroyedSandboxIds, [ensured.ok ? ensured.handle.id : '']);
    assert.equal((await store.getRoomById('room-1'))?.sandboxStatus, 'expired');

    const recreated = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(recreated.ok, true);
    assert.equal(recreated.ok && recreated.created, true);
    assert.notEqual(recreated.ok ? recreated.handle.id : '', ensured.ok ? ensured.handle.id : '');
  });

  it('does not destroy sandboxes while room creation is still in progress', async () => {
    const store = new MemoryRoomStore([
      room({ sandboxStatus: 'creating', sandboxId: 'old-sandbox', sandboxUpdatedAt: '2026-05-03T00:00:00.000Z' }),
    ]);
    const { lifecycle, sandboxService } = createLifecycle(store);

    const result = await lifecycle.destroyRoomSandbox('room-1', 'client-1');
    assert.equal(result.destroyed, false);
    assert.deepEqual(sandboxService.destroyedSandboxIds, []);
    assert.equal((await store.getRoomById('room-1'))?.sandboxStatus, 'creating');
  });

  it('keeps sandbox state unchanged when destroy fails', async () => {
    const store = new MemoryRoomStore([room()]);
    const { lifecycle, sandboxService } = createLifecycle(store);
    const ensured = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(ensured.ok, true);
    sandboxService.failNext('destroy');

    const result = await lifecycle.destroyRoomSandbox('room-1', 'client-1');
    assert.equal(result.destroyed, false);
    assert.match(result.error?.message || '', /destroy failed/);
    assert.equal((await store.getRoomById('room-1'))?.sandboxStatus, 'ready');
  });

  it('does not overwrite a concurrent creating transition while destroying a previous sandbox', async () => {
    const store = new MemoryRoomStore([room()]);
    const { lifecycle } = createLifecycle(store);
    const ensured = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(ensured.ok, true);
    store.forceStatusBeforeNextSandboxCas = 'creating';

    const result = await lifecycle.destroyRoomSandbox('room-1', 'client-1');
    assert.equal(result.destroyed, true);
    assert.equal((await store.getRoomById('room-1'))?.sandboxStatus, 'creating');
  });
});
