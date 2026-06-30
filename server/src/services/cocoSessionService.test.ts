import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { AIModelOption, Message, Room, RoomAICostTotal } from '../types';
import { CocoCodeAgentRunner } from './codeAgentRunner';
import { CocoSandboxLifecycleService } from './cocoSandboxLifecycle';
import { CocoSessionService } from './cocoSessionService';
import { COCO_RUNNER_SCHEMA_VERSION, CocoRunnerEvent, CocoRunnerRunRequest } from './cocoRunnerProtocol';
import { CocoRunnerClient, CocoRunnerRunResult } from './fakeCocoRunner';
import { FakeCocoRunnerClient } from './fakeCocoRunner';
import { FakeCocoSandboxService } from './fakeCocoSandboxService';
import { DEFAULT_COCO_RUNNER_COMMAND } from './cocoRuntimeConfig';
import { CocoModelGateway, InMemoryCocoModelGatewayTokenStateStore } from './cocoModelGateway';
import { PublishedStaticSiteService } from './publishedStaticSite';
import { MemoryMediaObjectStorage } from '../testUtils/memoryMediaObjectStorage';

type RoomEmit = {
  roomId: string;
  event: string;
  args: unknown[];
};

class FakeEmitter {
  roomEmits: RoomEmit[] = [];
  onEmit?: (event: RoomEmit) => void;

  to(roomId: string) {
    return {
      emit: (event: string, ...args: unknown[]) => {
        const roomEmit = { roomId, event, args };
        this.roomEmits.push(roomEmit);
        this.onEmit?.(roomEmit);
      },
    };
  }
}

class MemoryCocoStore {
  rooms = new Map<string, Room>();
  messages = new Map<string, Message[]>();
  members = new Map<string, { roomId: string; clientId: string; role: string; joinedAt: string }[]>();
  appendFailures = 0;
  upsertFailures = 0;
  roomCost: RoomAICostTotal = { roomId: 'room-1', currency: 'USD', totalUsd: 0 };

  constructor(initialRoom: Room, initialMessages: Message[] = []) {
    this.rooms.set(initialRoom.id, initialRoom);
    this.messages.set(initialRoom.id, initialMessages);
    this.members.set(initialRoom.id, [
      { roomId: initialRoom.id, clientId: initialRoom.creatorId, role: 'owner', joinedAt: initialRoom.createdAt },
    ]);
  }

  async getRoomById(roomId: string) {
    return this.rooms.get(roomId) || null;
  }

  async getRoomMember(roomId: string, clientId: string) {
    const members = this.members.get(roomId) || [];
    return members.find(m => m.clientId === clientId) || null;
  }

  addMember(roomId: string, clientId: string, role: string) {
    const list = this.members.get(roomId) || [];
    list.push({ roomId, clientId, role, joinedAt: '2026-05-03T00:00:00.000Z' });
    this.members.set(roomId, list);
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

  async deleteMessageById(roomId: string, messageId: string) {
    const messages = this.messages.get(roomId);
    if (!messages) return null;
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return null;
    messages.splice(index, 1);
    return { roomId, messageId };
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
  runnerEnv?: Record<string, string>;
  runnerProviderEnvByProvider?: Partial<Record<AIModelOption['provider'], Record<string, string>>>;
  mode?: 'plan' | 'acceptEdits';
  availableModes?: Array<'plan' | 'acceptEdits'>;
  defaultMode?: 'plan' | 'acceptEdits';
  modelGateway?: CocoModelGateway;
  staticSitePublisher?: PublishedStaticSiteService;
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
    new CocoCodeAgentRunner(options.runner || new FakeCocoRunnerClient([])),
    logger,
    {
      enabled: options.enabled ?? true,
      allowedClientIds: options.allowedClientIds,
      mode: options.mode,
      availableModes: options.availableModes,
      defaultMode: options.defaultMode,
      modelGateway: options.modelGateway,
      staticSitePublisher: options.staticSitePublisher,
      runnerEnv: options.runnerEnv,
      runnerProviderEnvByProvider: options.runnerProviderEnvByProvider,
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
    assert.equal(sandboxService.startedRunnerCommands[0], DEFAULT_COCO_RUNNER_COMMAND);
    assert.deepEqual(sandboxService.startedRunnerEnvs[0], { PYTHONUNBUFFERED: '1' });
    assert.equal(runner.requests[0].prompt, 'inspect the project');
    assert.deepEqual(runner.requests[0].priorMessages, []);
    assert.equal(runner.requests[0].apiModel, 'deepseek-chat');
    assert.equal(runner.requests[0].mode, 'plan');
    assert.equal(runner.requests[0].workspace, '/workspace/room-1');
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai', 'tool_call', 'tool_result', 'ai']);
    assert.equal(messages[1].status, 'complete');
    assert.equal(messages[1].content, 'Working...');
    assert.equal(messages[2].toolCallId, 'tool-1');
    assert.equal(messages[3].toolOutputPreview, '# RoomTalk');
    assert.equal(messages[3].content, '# RoomTalk');
    assert.equal(messages[4].status, 'complete');
    assert.equal(messages[4].content, 'Done');
    assert.equal((await store.getRoomById('room-1'))?.cocoStatus, 'idle');
    assert.equal((await store.getRoomById('room-1'))?.cocoSessionId, 'session-1');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_chunk'), true);
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_end'), true);
    assert.equal(sandboxService.stoppedRunnerCommands.length, 1);
  });

  it('persists interleaved AI text and tool events in runner order', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'I will inspect.' },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Glob', args: { pattern: '**/*' } },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Glob', success: true, output: 'No files found matching the pattern.' },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'The current directory is empty.' },
      {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'The current directory is empty.',
        sessionId: 'session-1',
      },
    ]);
    const { service, store } = createService({ runner });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai', 'tool_call', 'tool_result', 'ai']);
    assert.equal(messages[1].content, 'I will inspect.');
    assert.equal(messages[1].status, 'complete');
    assert.equal(messages[2].toolName, 'Glob');
    assert.deepEqual(messages[2].toolArgs, { pattern: '**/*' });
    assert.equal(messages[3].toolOutputPreview, 'No files found matching the pattern.');
    assert.equal(messages[3].content, 'No files found matching the pattern.');
    assert.equal(messages[4].content, 'The current directory is empty.');
    assert.equal(messages[4].status, 'complete');
    assert.equal(messages[4].turnId, messages[1].turnId);
  });

  it('passes prior RoomTalk Coco history to the runner and excludes the current prompt', async () => {
    const initialMessages: Message[] = [
      userMessage('list files'),
      {
        id: 'ai-prev-1',
        clientId: 'ai_assistant',
        content: 'I will inspect.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:01.000Z',
        messageType: 'ai',
        status: 'complete',
        turnId: 'turn-prev',
      },
      {
        id: 'tool-prev-1',
        clientId: 'coco_runner',
        content: 'Glob {"pattern":"**/*"}',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:02.000Z',
        messageType: 'tool_call',
        username: 'Coco',
        status: 'complete',
        turnId: 'turn-prev',
        toolCallId: 'tool-prev',
        toolName: 'Glob',
        toolArgs: { pattern: '**/*' },
      },
      {
        id: 'tool-result-prev-1',
        clientId: 'coco_runner',
        content: 'No files found matching the pattern.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:03.000Z',
        messageType: 'tool_result',
        username: 'Coco',
        status: 'complete',
        turnId: 'turn-prev',
        toolCallId: 'tool-prev',
        toolName: 'Glob',
        toolOutputPreview: 'No files found matching the pattern.',
      },
      {
        id: 'ai-prev-2',
        clientId: 'ai_assistant',
        content: 'The directory is empty.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:04.000Z',
        messageType: 'ai',
        status: 'complete',
        turnId: 'turn-prev',
      },
      {
        ...userMessage('what did I ask before?'),
        id: 'user-2',
        timestamp: '2026-05-03T00:00:05.000Z',
      },
    ];
    const store = new MemoryCocoStore(room({ cocoSessionId: 'session-prev' }), initialMessages);
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'You asked me to list files.', sessionId: 'session-prev' },
    ]);
    const { service } = createService({ store, runner });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(runner.requests[0].prompt, 'what did I ask before?');
    assert.equal(runner.requests[0].sessionId, 'session-prev');
    assert.deepEqual(runner.requests[0].priorMessages, [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect.' },
          { type: 'tool_use', id: 'tool-prev', name: 'Glob', input: { pattern: '**/*' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-prev', content: 'No files found matching the pattern.' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'The directory is empty.' },
        ],
      },
    ]);
  });

  it('limits prior messages when maxContextMessages is set', async () => {
    const initialMessages: Message[] = [
      userMessage('list files'),
      {
        id: 'ai-prev-1',
        clientId: 'ai_assistant',
        content: 'I will inspect.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:01.000Z',
        messageType: 'ai',
        status: 'complete',
        turnId: 'turn-prev',
      },
      {
        id: 'tool-prev-1',
        clientId: 'coco_runner',
        content: 'Glob {"pattern":"**/*"}',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:02.000Z',
        messageType: 'tool_call',
        username: 'Coco',
        status: 'complete',
        turnId: 'turn-prev',
        toolCallId: 'tool-prev',
        toolName: 'Glob',
        toolArgs: { pattern: '**/*' },
      },
      {
        id: 'tool-result-prev-1',
        clientId: 'coco_runner',
        content: 'No files found matching the pattern.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:03.000Z',
        messageType: 'tool_result',
        username: 'Coco',
        status: 'complete',
        turnId: 'turn-prev',
        toolCallId: 'tool-prev',
        toolName: 'Glob',
        toolOutputPreview: 'No files found matching the pattern.',
      },
      {
        id: 'ai-prev-2',
        clientId: 'ai_assistant',
        content: 'The directory is empty.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:04.000Z',
        messageType: 'ai',
        status: 'complete',
        turnId: 'turn-prev',
      },
      {
        ...userMessage('what did I ask before?'),
        id: 'user-2',
        timestamp: '2026-05-03T00:00:05.000Z',
      },
    ];
    const store = new MemoryCocoStore(room(), initialMessages);
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'You asked about files.', sessionId: 'session-1' },
    ]);
    const { service } = createService({ store, runner });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel, maxContextMessages: 2 });

    assert.equal(runner.requests[0].prompt, 'what did I ask before?');
    assert.deepEqual(runner.requests[0].priorMessages, [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'The directory is empty.' },
        ],
      },
    ]);
  });

  it('sends all prior messages when maxContextMessages is not set', async () => {
    const initialMessages: Message[] = [
      userMessage('list files'),
      {
        id: 'ai-prev-1',
        clientId: 'ai_assistant',
        content: 'Done.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:01.000Z',
        messageType: 'ai',
        status: 'complete',
      },
      {
        ...userMessage('now what?'),
        id: 'user-2',
        timestamp: '2026-05-03T00:00:02.000Z',
      },
    ];
    const store = new MemoryCocoStore(room(), initialMessages);
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'ok', sessionId: 'session-1' },
    ]);
    const { service } = createService({ store, runner });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(runner.requests[0].prompt, 'now what?');
    assert.deepEqual(runner.requests[0].priorMessages, [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]);
  });

  it('removes the unused AI placeholder when tool events arrive before text', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Write', args: { file_path: 'hello.py' } },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Write', success: true, output: 'wrote hello.py' },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-2', name: 'Shell', args: { command: 'python3 hello.py' } },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-2', name: 'Shell', success: true, output: 'Hello, World!' },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done. The program prints Hello, World!' },
      {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done. The program prints Hello, World!',
        sessionId: 'session-1',
      },
    ]);
    const { emitter, service, store } = createService({
      runner,
      ids: ['ai-1', 'turn-1', 'tool-result-msg-1', 'tool-result-msg-2', 'ai-2'],
    });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'ai']);
    assert.equal(messages.some(message => message.id === 'ai-1'), false);
    assert.equal(messages[5].id, 'ai-2');
    assert.equal(messages[5].status, 'complete');
    assert.equal(messages[5].content, 'Done. The program prints Hello, World!');
    assert.deepEqual(
      emitter.roomEmits
        .filter(event => event.event === 'message_deleted')
        .map(event => (event.args[0] as { messageId: string }).messageId),
      ['ai-1']
    );
  });

  it('removes the unused AI placeholder when a tool-only turn completes with a final answer', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Shell', args: { command: 'python3 hello.py' } },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Shell', success: true, output: 'Hello, World!' },
      {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'The script printed Hello, World!',
        sessionId: 'session-1',
      },
    ]);
    const { emitter, service, store } = createService({
      runner,
      ids: ['ai-1', 'turn-1', 'tool-result-msg-1', 'ai-2'],
    });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'tool_call', 'tool_result', 'ai']);
    assert.equal(messages.some(message => message.id === 'ai-1'), false);
    assert.equal(messages[3].id, 'ai-2');
    assert.equal(messages[3].status, 'complete');
    assert.equal(messages[3].content, 'The script printed Hello, World!');
    assert.deepEqual(
      emitter.roomEmits
        .filter(event => event.event === 'message_deleted')
        .map(event => (event.args[0] as { messageId: string }).messageId),
      ['ai-1']
    );
  });

  it('stops the runner before broadcasting the final stream end', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { emitter, sandboxService, service } = createService({ runner });
    const stopCountsAtStreamEnd: number[] = [];
    emitter.onEmit = event => {
      if (event.event === 'ai_stream_end') {
        stopCountsAtStreamEnd.push(sandboxService.stoppedRunnerCommands.length);
      }
    };

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(stopCountsAtStreamEnd, [1]);
  });

  it('passes only explicit minimal environment to runner processes', async () => {
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'must-not-leak';
    try {
      const runner = new FakeCocoRunnerClient([
        { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
      ]);
      const { sandboxService, service } = createService({
        runner,
        runnerEnv: { COCO_SOURCE_DIR: '/sandbox/coco/src' },
      });

      await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

      assert.deepEqual(sandboxService.startedRunnerEnvs[0], {
        PYTHONUNBUFFERED: '1',
        COCO_SOURCE_DIR: '/sandbox/coco/src',
      });
      assert.equal('ANTHROPIC_API_KEY' in sandboxService.startedRunnerEnvs[0], false);
    } finally {
      if (previousAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      }
    }
  });

  it('passes only the selected model provider env to runner processes', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { sandboxService, service } = createService({
      runner,
      runnerProviderEnvByProvider: {
        deepseek: { DEEPSEEK_API_KEY: 'deepseek-key' },
        anthropic: { ANTHROPIC_API_KEY: 'anthropic-key' },
      },
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(sandboxService.startedRunnerEnvs[0], {
      PYTHONUNBUFFERED: '1',
      DEEPSEEK_API_KEY: 'deepseek-key',
    });
  });

  it('allows each Coco turn to choose plan mode within an edit-capable server configuration', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const store = new MemoryCocoStore(room({ codeAgentMode: 'plan' }), [userMessage()]);
    const { service } = createService({ store, runner, mode: 'acceptEdits' });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.equal(runner.requests[0].mode, 'plan');
  });

  it('rejects edit mode requests when the server is configured for plan mode only', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const store = new MemoryCocoStore(room({ codeAgentMode: 'acceptEdits' }), [userMessage()]);
    const { service } = createService({ store, runner, mode: 'plan' });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: false, error: 'Coco edit mode is not enabled' });
    assert.equal(runner.requests.length, 0);
  });

  it('keeps host provider keys out of proxied runner environments', async () => {
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'host-openai-key';
    process.env.ANTHROPIC_API_KEY = 'host-anthropic-key';
    try {
      const runner = new FakeCocoRunnerClient([
        { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
      ]);
      const { sandboxService, service } = createService({
        runner,
        runnerEnv: {
          COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
          COCO_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
        },
      });

      await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

      assert.deepEqual(sandboxService.startedRunnerEnvs[0], {
        PYTHONUNBUFFERED: '1',
        COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
        COCO_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
      });
      assert.equal('OPENAI_API_KEY' in sandboxService.startedRunnerEnvs[0], false);
      assert.equal('ANTHROPIC_API_KEY' in sandboxService.startedRunnerEnvs[0], false);
    } finally {
      if (previousOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAIKey;
      }
      if (previousAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      }
    }
  });

  it('injects a per-turn model gateway token and write tools only for edit turns', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const gateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'gateway-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      nowMs: () => 1_800_000_000_000,
      stateStore: new InMemoryCocoModelGatewayTokenStateStore(() => 1_800_000_000_000),
    });
    const { sandboxService, service } = createService({
      store: new MemoryCocoStore(room({ codeAgentMode: 'acceptEdits' }), [userMessage()]),
      runner,
      availableModes: ['plan', 'acceptEdits'],
      defaultMode: 'plan',
      modelGateway: gateway,
      runnerProviderEnvByProvider: {
        deepseek: { DEEPSEEK_API_KEY: 'must-not-leak' },
      },
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.COCO_MODEL_PROXY_URL, 'https://room.example/api/coco/model-gateway/v1');
    assert.equal(typeof env.COCO_MODEL_PROXY_TOKEN, 'string');
    assert.notEqual(env.COCO_MODEL_PROXY_TOKEN, 'deepseek-provider-key');
    assert.equal(env.ROOMTALK_COCO_ALLOW_WRITE_TOOLS, 'true');
    assert.equal('DEEPSEEK_API_KEY' in env, false);
    assert.equal(runner.requests[0].mode, 'acceptEdits');
  });

  it('injects a scoped static publish token for configured edit turns', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.example',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'static-publish-token-id',
    });
    const { sandboxService, service } = createService({
      runner,
      availableModes: ['plan', 'acceptEdits'],
      defaultMode: 'plan',
      staticSitePublisher,
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      mode: 'acceptEdits',
    });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.ROOMTALK_COCO_ENABLE_STATIC_PUBLISH, 'true');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_URL, 'https://room.example/api/coco/publish-static-site');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL, 'https://room.example');
    const claims = staticSitePublisher.verifyTurnToken(env.ROOMTALK_STATIC_PUBLISH_TOKEN);
    assert.equal(claims?.roomId, 'room-1');
    assert.equal(claims?.clientId, 'client-1');
    assert.equal(claims?.turnId, 'turn-1');
    assert.equal(claims?.mode, 'acceptEdits');
  });

  it('does not inject static publish credentials into plan turns', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.example',
    });
    const { sandboxService, service } = createService({
      runner,
      availableModes: ['plan', 'acceptEdits'],
      defaultMode: 'plan',
      staticSitePublisher,
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel, mode: 'plan' });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal('ROOMTALK_COCO_ENABLE_STATIC_PUBLISH' in env, false);
    assert.equal('ROOMTALK_STATIC_PUBLISH_TOKEN' in env, false);
  });

  it('defaults Coco turns to plan even when edit mode is available', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { sandboxService, service } = createService({
      runner,
      availableModes: ['plan', 'acceptEdits'],
      defaultMode: 'plan',
      runnerEnv: { ROOMTALK_COCO_ALLOW_WRITE_TOOLS: 'true' },
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(runner.requests[0].mode, 'plan');
    assert.equal('ROOMTALK_COCO_ALLOW_WRITE_TOOLS' in sandboxService.startedRunnerEnvs[0], false);
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

  it('allows admins when cocoAccess is admin', async () => {
    const store = new MemoryCocoStore(room({ cocoAccess: 'admin' }), [
      { ...userMessage(), clientId: 'admin-1' },
    ]);
    store.addMember('room-1', 'admin-1', 'admin');
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'ok', sessionId: 's1' },
    ]);
    const { service } = createService({ store, runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'admin-1', selectedModel });
    assert.equal(result.success, true);
  });

  it('rejects regular members when cocoAccess is admin', async () => {
    const store = new MemoryCocoStore(room({ cocoAccess: 'admin' }), [
      { ...userMessage(), clientId: 'member-1' },
    ]);
    store.addMember('room-1', 'member-1', 'member');
    const { service } = createService({ store });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'member-1', selectedModel });
    assert.deepEqual(result, { success: false, error: 'You do not have access to this Coco room' });
  });

  it('allows all members when cocoAccess is member', async () => {
    const store = new MemoryCocoStore(room({ cocoAccess: 'member' }), [
      { ...userMessage(), clientId: 'member-1' },
    ]);
    store.addMember('room-1', 'member-1', 'member');
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'ok', sessionId: 's1' },
    ]);
    const { service } = createService({ store, runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'member-1', selectedModel });
    assert.equal(result.success, true);
  });

  it('defaults to owner-only access when cocoAccess is not set', async () => {
    const store = new MemoryCocoStore(room(), [userMessage()]);
    store.addMember('room-1', 'member-1', 'member');

    const result = await createService({ store }).service.startTurn({ roomId: 'room-1', clientId: 'member-1', selectedModel });
    assert.deepEqual(result, { success: false, error: 'You do not have access to this Coco room' });
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
