import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { AIModelOption, Message, Room, RoomAICostTotal } from '../types';
import { CocoSandboxLifecycleService } from './cocoSandboxLifecycle';
import { CocoSessionService } from './cocoSessionService';
import { COCO_RUNNER_SCHEMA_VERSION, CocoRunnerEvent, CocoRunnerRunRequest } from './cocoRunnerProtocol';
import { CocoRunnerClient, CocoRunnerRunResult } from './fakeCocoRunner';
import { FakeCocoRunnerClient } from './fakeCocoRunner';
import { FakeCocoSandboxService } from './fakeCocoSandboxService';

type RoomEmit = {
  roomId: string;
  event: string;
  args: unknown[];
};

class FakeEmitter {
  roomEmits: RoomEmit[] = [];

  to(roomId: string) {
    return {
      emit: (event: string, ...args: unknown[]) => {
        this.roomEmits.push({ roomId, event, args });
      },
    };
  }
}

class MemoryCocoStore {
  rooms = new Map<string, Room>();
  messages = new Map<string, Message[]>();
  appendFailures = 0;
  upsertFailures = 0;
  roomCost: RoomAICostTotal = { roomId: 'room-1', currency: 'USD', totalUsd: 0 };

  constructor(initialRoom: Room, initialMessages: Message[] = []) {
    this.rooms.set(initialRoom.id, initialRoom);
    this.messages.set(initialRoom.id, initialMessages);
  }

  async getRoomById(roomId: string) {
    return this.rooms.get(roomId) || null;
  }

  async readMessagesByRoom(roomId: string) {
    return this.messages.get(roomId) || [];
  }

  async saveRoom(room: Room) {
    const current = this.rooms.get(room.id);
    if (!current) return null;
    const saved = { ...current, ...room };
    this.rooms.set(room.id, saved);
    return saved;
  }

  async upsertMessage(message: Message) {
    if (this.upsertFailures > 0) {
      this.upsertFailures--;
      return null;
    }
    const room = this.rooms.get(message.roomId);
    if (!room) return null;
    const messages = this.messages.get(message.roomId) || [];
    const index = messages.findIndex(item => item.id === message.id);
    if (index === -1) {
      messages.push(message);
    } else {
      messages[index] = message;
    }
    this.messages.set(message.roomId, messages);
    return { ...room, lastActivityAt: message.timestamp };
  }

  async appendMessageWithAtomicPosition(message: Message) {
    if (this.appendFailures > 0) {
      this.appendFailures--;
      return null;
    }
    const room = this.rooms.get(message.roomId);
    if (!room) return null;
    this.messages.set(message.roomId, [...(this.messages.get(message.roomId) || []), message]);
    return { ...room, lastActivityAt: message.timestamp };
  }

  async incrementRoomAICost(roomId: string, cost: any) {
    this.roomCost = {
      roomId,
      currency: 'USD',
      totalUsd: this.roomCost.totalUsd + (cost?.totalUsd || 0),
    };
    return this.roomCost;
  }

  async compareAndSetRoomSandboxStatus(roomId: string, expectedStatuses: string[], nextStatus: any, updatedAt = '2026-05-03T00:00:00.000Z') {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const current = room.sandboxStatus || 'none';
    if (!expectedStatuses.includes(current)) return null;
    const updated = { ...room, sandboxStatus: nextStatus, sandboxUpdatedAt: updatedAt };
    this.rooms.set(roomId, updated);
    return updated;
  }
}

class BlockingRunner implements CocoRunnerClient {
  requests: CocoRunnerRunRequest[] = [];
  private releaseRun!: () => void;
  private markStarted!: () => void;
  started = new Promise<void>(resolve => {
    this.markStarted = resolve;
  });
  private blocked = new Promise<void>(resolve => {
    this.releaseRun = resolve;
  });

  release() {
    this.releaseRun();
  }

  async run(request: CocoRunnerRunRequest): Promise<CocoRunnerRunResult> {
    this.requests.push(request);
    this.markStarted();
    await this.blocked;
    const finalEvent = {
      schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
      type: 'final' as const,
      messageId: 'ai',
      answer: 'done',
      sessionId: 'session-blocking',
    };
    return { events: [finalEvent], finalEvent };
  }
}

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
} as unknown as Logger;

const selectedModel: AIModelOption = {
  id: 'deepseek-v4-pro',
  apiModel: 'deepseek-chat',
  provider: 'deepseek',
  label: 'DeepSeek V4 Pro',
  description: 'Test model',
  pricing: { currency: 'USD', inputPerMillion: 0.27, cachedInputPerMillion: 0.07, outputPerMillion: 1.1 },
};

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Coco Room',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  lastActivityAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  type: 'coco',
  ...overrides,
});

const userMessage = (content = 'inspect the project'): Message => ({
  id: 'user-1',
  clientId: 'client-1',
  content,
  roomId: 'room-1',
  timestamp: '2026-05-03T00:00:00.000Z',
  messageType: 'text',
});

const createService = (options: {
  store?: MemoryCocoStore;
  runner?: CocoRunnerClient;
  enabled?: boolean;
  allowedClientIds?: string[];
  ids?: string[];
} = {}) => {
  const store = options.store || new MemoryCocoStore(room(), [userMessage()]);
  const emitter = new FakeEmitter();
  const sandboxService = new FakeCocoSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));
  const lifecycle = new CocoSandboxLifecycleService(store as any, sandboxService, logger, {
    sandboxTtlMs: 60 * 60 * 1000,
    turnTimeoutMs: 5 * 60 * 1000,
    creatingStaleMs: 2 * 60 * 1000,
    maxActiveSandboxes: 10,
    maxActiveSandboxesPerUser: 10,
  }, () => new Date('2026-05-03T00:00:00.000Z'));
  const ids = [...(options.ids || ['ai-1', 'turn-1', 'status-1', 'result-1', 'error-1'])];
  const service = new CocoSessionService(
    store as any,
    emitter,
    lifecycle,
    sandboxService,
    options.runner || new FakeCocoRunnerClient([]),
    logger,
    {
      enabled: options.enabled ?? true,
      allowedClientIds: options.allowedClientIds,
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      createId: () => ids.shift() || 'id-fallback',
    }
  );
  return { emitter, lifecycle, sandboxService, service, store };
};

describe('CocoSessionService', () => {
  it('runs a full fake Coco turn and persists runner events', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'status', turnId: 'turn-1', status: 'starting', message: 'starting' },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Working...' },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Read', args: { file_path: 'README.md' } },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Read', success: true, output: '# RoomTalk' },
      {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, source: 'reported' },
      },
    ]);
    const { emitter, sandboxService, service, store } = createService({ runner });
    let ack: unknown;

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    }, response => {
      ack = response;
    });

    assert.deepEqual(ack, { success: true, messageId: 'ai-1' });
    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    assert.equal(sandboxService.startedRunnerCommands[0], 'python -m roomtalk_coco_runner');
    assert.equal(runner.requests[0].prompt, 'inspect the project');
    assert.equal(runner.requests[0].apiModel, 'deepseek-chat');
    assert.equal(runner.requests[0].workspace, '/workspace/room-1');
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai', 'sandbox_status', 'tool_call', 'tool_result']);
    assert.equal(messages[1].status, 'complete');
    assert.equal(messages[1].content, 'Done');
    assert.equal(messages[3].toolCallId, 'tool-1');
    assert.equal(messages[4].toolOutputPreview, '# RoomTalk');
    assert.equal((await store.getRoomById('room-1'))?.cocoStatus, 'idle');
    assert.equal((await store.getRoomById('room-1'))?.cocoSessionId, 'session-1');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_chunk'), true);
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_end'), true);
  });

  it('rejects concurrent turns in the same Coco room', async () => {
    const runner = new BlockingRunner();
    const { service } = createService({ runner });
    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;

    const second = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    assert.deepEqual(second, { success: false, error: 'A Coco task is already running in this room' });

    runner.release();
    assert.deepEqual(await first, { success: true, messageId: 'ai-1' });
  });

  it('rejects disabled, unauthorized, non-Coco, and allowlist-mismatched turns', async () => {
    assert.deepEqual(await createService({ enabled: false }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'Coco is disabled',
    });
    assert.deepEqual(await createService({ allowedClientIds: ['other-client'] }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'Coco is not enabled for this user',
    });
    assert.deepEqual(await createService({ store: new MemoryCocoStore(room({ creatorId: 'client-2' }), [userMessage()]) }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'You do not have access to this Coco room',
    });
    assert.deepEqual(await createService({ store: new MemoryCocoStore(room({ type: 'chat' }), [userMessage()]) }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'Room is not a Coco room',
    });
  });

  it('stops runner processing when a tool event cannot be persisted', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Read', args: { file_path: 'README.md' } },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Read', success: true, output: '# RoomTalk' },
    ]);
    const store = new MemoryCocoStore(room(), [userMessage()]);
    store.appendFailures = 1;
    const { emitter, service } = createService({ runner, store });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    assert.equal(runner.requests.length, 1);
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai']);
    assert.equal(messages[1].status, 'error');
    assert.equal(messages[1].content, 'Unable to persist Coco tool_call event');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_error'), true);
  });

  it('broadcasts room error state when placeholder persistence is rejected after running state was emitted', async () => {
    const store = new MemoryCocoStore(room(), [userMessage()]);
    store.upsertFailures = 1;
    const { emitter, service } = createService({ store });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(result, { success: false, error: 'Unable to start a durable Coco response' });
    assert.equal((await store.getRoomById('room-1'))?.cocoStatus, 'error');
    const roomUpdates = emitter.roomEmits.filter(event => event.event === 'room_updated');
    assert.equal((roomUpdates[0].args[0] as Room).cocoStatus, 'running');
    assert.equal((roomUpdates[1].args[0] as Room).cocoStatus, 'error');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_error'), false);
  });

  it('marks the AI placeholder as error when the runner returns an error event', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'error', message: 'runner crashed', code: 'runner_exit', retryable: false },
    ]);
    const { service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const messages = store.messages.get('room-1') || [];
    assert.equal(messages[1].messageType, 'ai');
    assert.equal(messages[1].status, 'error');
    assert.equal(messages[1].content, 'runner crashed');
    assert.equal(messages[2].messageType, 'sandbox_status');
    assert.equal(messages[2].isError, true);
    assert.equal((await store.getRoomById('room-1'))?.cocoStatus, 'error');
  });
});
