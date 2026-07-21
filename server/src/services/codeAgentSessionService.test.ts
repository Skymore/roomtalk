import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Writable } from 'node:stream';
import { Logger } from '../logger';
import { AIModelOption, CodeAgentMode, MediaAsset, Message, Room, RoomAgentTurn, RoomAICostTotal } from '../types';
import { CodeAgentRunnerAdapter, CodeAgentBackend } from './codeAgentRunner';
import { CodeAgentDaemonProcessRegistry } from './codeAgentDaemonRegistry';
import { CodeAgentSandboxLifecycleService } from './codeAgentSandboxLifecycle';
import { CodeAgentSessionService } from './codeAgentSessionService';
import { CODE_AGENT_RUNNER_SCHEMA_VERSION, CodeAgentRunnerEvent, CodeAgentRunnerRunRequest } from './codeAgentRunnerProtocol';
import { CodeAgentRunnerClient, CodeAgentRunnerHandlers, CodeAgentRunnerRunResult } from './fakeCodeAgentRunner';
import { FakeCodeAgentRunnerClient } from './fakeCodeAgentRunner';
import { FakeCodeAgentSandboxService } from './fakeCodeAgentSandboxService';
import { DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND, DEFAULT_CODEX_CLI_RUNNER_COMMAND, DEFAULT_CODE_AGENT_DAEMON_COMMAND, DEFAULT_CODE_AGENT_RUNNER_COMMAND } from './codeAgentRuntimeConfig';
import { CodeAgentModelGateway, InMemoryCodeAgentModelGatewayTokenStateStore } from './codeAgentModelGateway';
import { PublishedStaticSiteService } from './publishedStaticSite';
import { MemoryMediaObjectStorage } from '../testUtils/memoryMediaObjectStorage';
import { ObservabilityEventInput } from './observabilityEvents';
import { CodeAgentRoomContextService } from './codeAgentRoomContext';
import { CodexConnectionError } from './codexConnection';

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

const createMemoryObservability = () => {
  const events: ObservabilityEventInput[] = [];
  return {
    events,
    recorder: {
      async recordEvent(event: ObservabilityEventInput) {
        events.push(event);
        return {
          id: `event-${events.length}`,
          createdAt: '2026-05-03T00:00:00.000Z',
          payload: {},
          ...event,
        } as any;
      },
    },
  };
};

class MemoryCodeAgentStore {
  rooms = new Map<string, Room>();
  messages = new Map<string, Message[]>();
  agentTurns = new Map<string, RoomAgentTurn>();
  roomLeases = new Map<string, { roomId: string; turnId: string; ownerId: string; fence: number; expiresAt: string }>();
  roomLeaseFences = new Map<string, number>();
  mediaAssetsByMessageId = new Map<string, MediaAsset>();
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

  async getMediaAssetByMessageId(messageId: string) {
    return this.mediaAssetsByMessageId.get(messageId) || null;
  }

  async saveRoom(room: Room) {
    const current = this.rooms.get(room.id);
    if (!current) return null;
    const saved = { ...current, ...room };
    this.rooms.set(room.id, saved);
    return saved;
  }

  async acquireCodeAgentRoomLease(roomId: string, turnId: string, ownerId: string, now: string, ttlMs: number) {
    const current = this.roomLeases.get(roomId);
    if (current && Date.parse(current.expiresAt) > Date.parse(now)) {
      return null;
    }
    const fence = (this.roomLeaseFences.get(roomId) || 0) + 1;
    this.roomLeaseFences.set(roomId, fence);
    const lease = {
      roomId,
      turnId,
      ownerId,
      fence,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    };
    this.roomLeases.set(roomId, lease);
    return lease;
  }

  async renewCodeAgentRoomLease(roomId: string, turnId: string, ownerId: string, now: string, ttlMs: number) {
    const current = this.roomLeases.get(roomId);
    if (
      !current ||
      current.turnId !== turnId ||
      current.ownerId !== ownerId ||
      Date.parse(current.expiresAt) <= Date.parse(now)
    ) {
      return null;
    }
    const renewed = { ...current, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString() };
    this.roomLeases.set(roomId, renewed);
    return renewed;
  }

  async releaseCodeAgentRoomLease(roomId: string, turnId: string, ownerId: string) {
    const current = this.roomLeases.get(roomId);
    if (!current || current.turnId !== turnId || current.ownerId !== ownerId) {
      return false;
    }
    this.roomLeases.delete(roomId);
    return true;
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

  async upsertRoomAgentTurn(turn: RoomAgentTurn) {
    this.agentTurns.set(turn.id, turn);
    return turn;
  }

  async appendMessage(message: Message) {
    return this.appendMessageWithAtomicPosition(message);
  }

  async appendMessageIdempotent(message: Message) {
    const room = this.rooms.get(message.roomId);
    if (!room) return null;
    const messages = this.messages.get(message.roomId) || [];
    const existingMessage = message.clientMessageId
      ? messages.find(item => item.clientId === message.clientId && item.clientMessageId === message.clientMessageId)
      : undefined;
    if (existingMessage) {
      return { room, message: existingMessage, inserted: false };
    }
    const updatedRoom = await this.appendMessage(message);
    return updatedRoom ? { room: updatedRoom, message, inserted: true } : null;
  }

  async updateCodeAgentQueuedMessage(roomId: string, messageId: string, update: any) {
    const room = this.rooms.get(roomId);
    const messages = this.messages.get(roomId);
    if (!room || !messages) return null;
    const index = messages.findIndex(item => item.id === messageId && item.codeAgentQueuedInput?.state === update.expectedState);
    if (index === -1) return { room, found: false };
    const updatedMessage: Message = {
      ...messages[index],
      ...(update.content !== undefined ? { content: update.content } : {}),
      updatedAt: update.updatedAt,
      codeAgentQueuedInput: update.queuedInput || undefined,
    };
    messages[index] = updatedMessage;
    return { room, found: true, updatedMessage };
  }

  async materializeCodeAgentQueuedMessage(roomId: string, messageId: string, expectedState: string, turnId?: string, insertedAt = '2026-05-03T00:00:00.000Z') {
    const room = this.rooms.get(roomId);
    const messages = this.messages.get(roomId);
    if (!room || !messages) return null;
    const index = messages.findIndex(item => item.id === messageId && item.codeAgentQueuedInput?.state === expectedState);
    if (index === -1) return { room, found: false };
    const updatedMessage: Message = {
      ...messages[index],
      timestamp: insertedAt,
      updatedAt: insertedAt,
      turnId,
      codeAgentQueuedInput: undefined,
    };
    messages.splice(index, 1);
    messages.push(updatedMessage);
    return { room, found: true, updatedMessage };
  }

  async claimNextCodeAgentQueuedMessage(roomId: string, updatedAt = '2026-05-03T00:00:00.000Z') {
    const room = this.rooms.get(roomId);
    const messages = this.messages.get(roomId);
    if (!room || !messages) return null;
    const message = messages.find(item => item.codeAgentQueuedInput?.state === 'queued');
    if (!message?.codeAgentQueuedInput) return null;
    message.codeAgentQueuedInput = { ...message.codeAgentQueuedInput, state: 'starting', updatedAt, lastError: undefined };
    message.updatedAt = updatedAt;
    return { room, message: { ...message, codeAgentQueuedInput: { ...message.codeAgentQueuedInput } } };
  }

  async deleteCodeAgentQueuedMessage(roomId: string, messageId: string, expectedState = 'queued') {
    const room = this.rooms.get(roomId);
    const messages = this.messages.get(roomId);
    if (!room || !messages) return null;
    const index = messages.findIndex(item => item.id === messageId && item.codeAgentQueuedInput?.state === expectedState);
    if (index === -1) return { room, deleted: false };
    messages.splice(index, 1);
    return { room, deleted: true };
  }

  async findRoomsWithQueuedCodeAgentMessages() {
    return Array.from(this.messages.entries())
      .filter(([, messages]) => messages.some(message => message.codeAgentQueuedInput?.state === 'queued'))
      .map(([roomId]) => roomId);
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

  async replaceRoomSandbox(roomId: string, expectedSandboxId: string, next: any) {
    const room = this.rooms.get(roomId);
    if (!room || room.sandboxId !== expectedSandboxId) return null;
    const updated = { ...room, ...next };
    this.rooms.set(roomId, updated);
    return updated;
  }
}

class BlockingContextStore extends MemoryCodeAgentStore {
  contextReadOptions?: { limit?: number; beforeMessageId?: string };
  private releaseContext!: () => void;
  private readonly contextBlocked = new Promise<void>(resolve => {
    this.releaseContext = resolve;
  });
  private markContextRead!: () => void;
  readonly contextReadStarted = new Promise<void>(resolve => {
    this.markContextRead = resolve;
  });

  releaseContextRead() {
    this.releaseContext();
  }

  async readMessagePageByRoom(roomId: string, options: { limit?: number; beforeMessageId?: string } = {}) {
    this.contextReadOptions = options;
    this.markContextRead();
    await this.contextBlocked;
    const messages = this.messages.get(roomId) || [];
    const end = options.beforeMessageId
      ? Math.max(0, messages.findIndex(message => message.id === options.beforeMessageId))
      : messages.length;
    const limit = options.limit || 80;
    return {
      roomId,
      messages: messages.slice(Math.max(0, end - limit), end),
      hasMore: end > limit,
    };
  }
}

const cocoModelStep = (
  sequence: number,
  hasText: boolean,
  toolCallIds: string[],
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens?: number }
): CodeAgentRunnerEvent => ({
  schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
  type: 'model_step',
  turnId: 'turn-1',
  stepId: `turn-1:step:${sequence}`,
  sequence,
  hasText,
  toolCallIds,
  usage: { ...usage, source: 'reported' },
});

class BlockingRunner implements CodeAgentRunnerClient {
  requests: CodeAgentRunnerRunRequest[] = [];
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

  async run(request: CodeAgentRunnerRunRequest, handlers: CodeAgentRunnerHandlers): Promise<CodeAgentRunnerRunResult> {
    this.requests.push(request);
    this.markStarted();
    await this.blocked;
    const textEvent: CodeAgentRunnerEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'text_delta',
      messageId: 'ai',
      delta: 'done',
    };
    const stepEvent = cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    const finalEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'final' as const,
      messageId: 'ai',
      answer: 'done',
      sessionId: 'session-blocking',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' as const },
    };
    await handlers.onEvent(textEvent);
    await handlers.onEvent(stepEvent);
    await handlers.onEvent(finalEvent);
    return { events: [textEvent, stepEvent, finalEvent], finalEvent };
  }
}

class SequencedBlockingRunner implements CodeAgentRunnerClient {
  requests: CodeAgentRunnerRunRequest[] = [];
  completed = 0;
  private releases: Array<() => void> = [];

  release(index: number) {
    this.releases[index]?.();
  }

  async waitForRuns(count: number) {
    const deadline = Date.now() + 2_000;
    while (this.requests.length < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(this.requests.length >= count, true, `expected ${count} runner requests`);
  }

  async waitForCompletions(count: number) {
    const deadline = Date.now() + 2_000;
    while (this.completed < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(this.completed >= count, true, `expected ${count} completed runner requests`);
  }

  async run(request: CodeAgentRunnerRunRequest, handlers: CodeAgentRunnerHandlers): Promise<CodeAgentRunnerRunResult> {
    this.requests.push(request);
    await new Promise<void>(resolve => this.releases.push(resolve));
    const textEvent: CodeAgentRunnerEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'text_delta',
      messageId: request.turnId,
      delta: `done ${this.requests.length}`,
    };
    const stepEvent: CodeAgentRunnerEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'model_step',
      turnId: request.turnId,
      stepId: `${request.turnId}:step:1`,
      sequence: 1,
      hasText: true,
      toolCallIds: [],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
    };
    const finalEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'final' as const,
      messageId: request.turnId,
      answer: `done ${this.requests.length}`,
      sessionId: `session-${this.requests.length}`,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' as const },
    };
    await handlers.onEvent(textEvent);
    await handlers.onEvent(stepEvent);
    await handlers.onEvent(finalEvent);
    this.completed += 1;
    return { events: [textEvent, stepEvent, finalEvent], finalEvent };
  }
}

class ControlBlockingRunner implements CodeAgentRunnerClient {
  requests: CodeAgentRunnerRunRequest[] = [];
  handlers?: CodeAgentRunnerHandlers;
  private releaseRun!: () => void;
  started = new Promise<void>(resolve => {
    this.markStarted = resolve;
  });
  private markStarted!: () => void;
  private blocked = new Promise<void>(resolve => {
    this.releaseRun = resolve;
  });

  constructor(private readonly acceptControls = true) {}

  async receiveControl(control: any) {
    await this.handlers?.onEvent({
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'control_result',
      turnId: control.turnId,
      controlId: control.controlId,
      controlType: control.type,
      accepted: this.acceptControls,
      message: this.acceptControls ? undefined : 'turn already completed',
    });
    if (control.type === 'steer' && control.messageId && this.acceptControls) {
      await this.handlers?.onEvent({
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'user_input_inserted',
        turnId: control.turnId,
        messageId: control.messageId,
      });
    }
    if (control.type === 'interrupt' && this.acceptControls) {
      this.releaseRun();
    }
  }

  release() {
    this.releaseRun();
  }

  async run(request: CodeAgentRunnerRunRequest, handlers: CodeAgentRunnerHandlers): Promise<CodeAgentRunnerRunResult> {
    this.requests.push(request);
    this.handlers = handlers;
    this.markStarted();
    await this.blocked;
    const textEvent: CodeAgentRunnerEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'text_delta',
      messageId: request.turnId,
      delta: 'stopped',
    };
    const stepEvent: CodeAgentRunnerEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'model_step',
      turnId: request.turnId,
      stepId: `${request.turnId}:step:1`,
      sequence: 1,
      hasText: true,
      toolCallIds: [],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
    };
    const finalEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'final' as const,
      messageId: request.turnId,
      answer: 'stopped',
      sessionId: 'session-controlled',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' as const },
    };
    await handlers.onEvent(textEvent);
    await handlers.onEvent(stepEvent);
    await handlers.onEvent(finalEvent);
    return { events: [textEvent, stepEvent, finalEvent], finalEvent };
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
  apiModel: 'deepseek-v4-pro',
  provider: 'deepseek',
  label: 'DeepSeek V4 Pro',
  description: 'Test model',
  pricing: { currency: 'USD', inputPerMillion: 0.27, cachedInputPerMillion: 0.07, outputPerMillion: 1.1 },
};

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Code Agent Room',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  lastActivityAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  type: 'codeAgent',
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
  store?: MemoryCodeAgentStore;
  runner?: CodeAgentRunnerClient;
  backend?: CodeAgentBackend;
  enabled?: boolean;
  allowedClientIds?: string[];
  ids?: string[];
  runnerEnv?: Record<string, string>;
  runnerClient?: 'fake' | 'jsonl' | 'daemon';
  runnerCommand?: string;
  runnerCommandByBackend?: Partial<Record<CodeAgentBackend, string>>;
  daemonCommand?: string;
  daemonRegistry?: CodeAgentDaemonProcessRegistry;
  runnerEnvByBackend?: Partial<Record<CodeAgentBackend, Record<string, string>>>;
  runnerProviderEnvByProvider?: Partial<Record<AIModelOption['provider'], Record<string, string>>>;
  codexBackendEnabled?: boolean;
  codexConnectionService?: any;
  githubConnectionService?: any;
  mode?: CodeAgentMode;
  availableModes?: CodeAgentMode[];
  defaultMode?: CodeAgentMode;
  modelGateway?: CodeAgentModelGateway;
  staticSitePublisher?: PublishedStaticSiteService;
  roomContext?: CodeAgentRoomContextService;
  observability?: ReturnType<typeof createMemoryObservability>['recorder'];
  mediaObjectStorage?: MemoryMediaObjectStorage;
  aiStreamOwnerId?: string;
  activeSandboxTtlMs?: number;
  idleSandboxTtlMs?: number;
} = {}) => {
  const store = options.store || new MemoryCodeAgentStore(room(), [userMessage()]);
  const emitter = new FakeEmitter();
  const sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));
  const lifecycle = new CodeAgentSandboxLifecycleService(store as any, sandboxService, logger, {
    sandboxTtlMs: 60 * 60 * 1000,
    activeSandboxTtlMs: options.activeSandboxTtlMs ?? 60 * 60 * 1000,
    idleSandboxTtlMs: options.idleSandboxTtlMs ?? 2 * 60 * 1000,
    creatingStaleMs: 2 * 60 * 1000,
    maxActiveSandboxes: 10,
    maxActiveSandboxesPerUser: 10,
  }, () => new Date('2026-05-03T00:00:00.000Z'));
  const ids = [...(options.ids || ['ai-1', 'turn-1', 'status-1', 'result-1', 'error-1'])];
  const service = new CodeAgentSessionService(
    store as any,
    emitter,
    lifecycle,
    sandboxService,
    new CodeAgentRunnerAdapter(options.runner || new FakeCodeAgentRunnerClient([]), options.backend || 'code-agent'),
    logger,
    {
      enabled: options.enabled ?? true,
      allowedClientIds: options.allowedClientIds,
      mode: options.mode,
      availableModes: options.availableModes,
      defaultMode: options.defaultMode,
      modelGateway: options.modelGateway,
      backend: options.backend,
      runnerClient: options.runnerClient,
      runnerCommand: options.runnerCommand,
      runnerCommandByBackend: options.runnerCommandByBackend,
      daemonCommand: options.daemonCommand,
      daemonRegistry: options.daemonRegistry,
      staticSitePublisher: options.staticSitePublisher,
      roomContext: options.roomContext,
      runnerEnv: options.runnerEnv,
      runnerEnvByBackend: options.runnerEnvByBackend,
      runnerProviderEnvByProvider: options.runnerProviderEnvByProvider,
      codexBackendEnabled: options.codexBackendEnabled,
      codexConnectionService: options.codexConnectionService,
      githubConnectionService: options.githubConnectionService,
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      createId: () => ids.shift() || 'id-fallback',
      observability: options.observability,
      mediaObjectStorage: options.mediaObjectStorage,
      aiStreamOwnerId: options.aiStreamOwnerId,
    }
  );
  return { emitter, lifecycle, sandboxService, service, store };
};

describe('CodeAgentSessionService', () => {
  it('signs linked object-storage images for the runner without writing sandbox files', async () => {
    const imageMessage: Message = {
      id: 'image-message-1',
      roomId: 'room-1',
      clientId: 'client-1',
      content: '',
      timestamp: '2026-05-03T00:00:00.000Z',
      messageType: 'media',
      mediaAsset: { id: 'asset-1', kind: 'image', mimeType: 'image/png', byteSize: 3 },
    };
    const promptMessage: Message = {
      ...userMessage('inspect this screenshot'),
      id: 'prompt-with-image',
      codeAgentImageMessageIds: [imageMessage.id],
    };
    const store = new MemoryCodeAgentStore(room(), [imageMessage, promptMessage]);
    store.mediaAssetsByMessageId.set(imageMessage.id, {
      ...imageMessage.mediaAsset!,
      roomId: 'room-1',
      messageId: imageMessage.id,
      objectKey: 'rooms/room-1/media/image/asset-1',
      createdAt: imageMessage.timestamp,
    });
    const mediaObjectStorage = new MemoryMediaObjectStorage();
    await mediaObjectStorage.putMediaObject({
      objectKey: 'rooms/room-1/media/image/asset-1',
      body: Buffer.from('png'),
      mimeType: 'image/png',
      byteSize: 3,
    });
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { sandboxService, service } = createService({ store, runner, mediaObjectStorage });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(runner.requests[0].images, [{
      url: 'https://download.example/rooms%2Froom-1%2Fmedia%2Fimage%2Fasset-1',
    }]);
    assert.deepEqual(mediaObjectStorage.readUrlRequests, [{
      objectKey: 'rooms/room-1/media/image/asset-1',
      expiresInSeconds: 2 * 60 * 60,
    }]);
    assert.deepEqual(sandboxService.deletedSecretFilePaths, []);
  });

  it('rejects image input on the deprecated Codex CLI backend', async () => {
    const imageMessage: Message = {
      id: 'legacy-image-message',
      roomId: 'room-1',
      clientId: 'client-1',
      content: '',
      timestamp: '2026-05-03T00:00:00.000Z',
      messageType: 'media',
      mediaAsset: { id: 'legacy-asset', kind: 'image', mimeType: 'image/png', byteSize: 3 },
    };
    const promptMessage: Message = {
      ...userMessage('inspect this screenshot'),
      id: 'legacy-prompt-with-image',
      codeAgentImageMessageIds: [imageMessage.id],
    };
    const store = new MemoryCodeAgentStore(
      room({ codeAgentBackend: 'codex' }),
      [imageMessage, promptMessage],
    );
    const runner = new FakeCodeAgentRunnerClient([]);
    const { service } = createService({
      store,
      runner,
      backend: 'codex',
      codexBackendEnabled: true,
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(result, {
      success: false,
      error: 'Image input requires Codex app-server or Coco',
    });
    assert.equal(runner.requests.length, 0);
  });

  it('runs a full fake code-agent turn and persists runner events', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'status', turnId: 'turn-1', status: 'starting', message: 'starting' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Working...' },
      cocoModelStep(1, true, ['tool-1'], { promptTokens: 60, completionTokens: 10, totalTokens: 70 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Read', args: { file_path: 'README.md' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Read', success: true, output: '# RoomTalk' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      cocoModelStep(2, true, [], { promptTokens: 40, completionTokens: 10, totalTokens: 50 }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, source: 'reported' },
      },
    ]);
    const observability = createMemoryObservability();
    const { emitter, sandboxService, service, store } = createService({ runner, observability: observability.recorder, aiStreamOwnerId: 'owner-1' });
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
    assert.equal(sandboxService.startedRunnerCommands[0], DEFAULT_CODE_AGENT_RUNNER_COMMAND);
    assert.deepEqual(sandboxService.startedRunnerTimeouts, [0]);
    assert.deepEqual(sandboxService.startedRunnerEnvs[0], {
      PYTHONUNBUFFERED: '1',
      ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true',
    });
    assert.equal(runner.requests[0].prompt, 'inspect the project');
    assert.equal(runner.requests[0].clientId, 'client-1');
    assert.deepEqual(runner.requests[0].priorMessages, []);
    assert.equal(runner.requests[0].apiModel, 'deepseek-v4-pro');
    assert.equal(runner.requests[0].mode, 'plan');
    assert.equal(runner.requests[0].workspace, '/workspace/room-1');
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai', 'tool_call', 'tool_result', 'ai']);
    assert.equal(messages[1].status, 'complete');
    assert.equal(messages[1].content, 'Working...');
    assert.equal((messages[1] as any).aiStreamOwnerId, 'owner-1');
    assert.equal(messages[2].toolCallId, 'tool-1');
    assert.equal(messages[3].toolOutputPreview, '# RoomTalk');
    assert.equal(messages[3].content, '# RoomTalk');
    assert.equal(messages[4].status, 'complete');
    assert.equal(messages[4].content, 'Done');
    assert.ok(Math.abs((messages[1].cost?.totalUsd || 0) - 0.0000272) < 1e-12);
    assert.ok(Math.abs((messages[4].cost?.totalUsd || 0) - 0.0000218) < 1e-12);
    assert.ok(Math.abs(store.roomCost.totalUsd - 0.000049) < 1e-12);
    const streamEnd = emitter.roomEmits.find(event => event.event === 'ai_stream_end' && (event.args[0] as any)?.messageId === messages[4].id);
    assert.ok(Math.abs(((streamEnd?.args[0] as any)?.cost?.totalUsd || 0) - 0.0000218) < 1e-12);
    assert.equal((await store.getRoomById('room-1'))?.codeAgentStatus, 'idle');
    assert.equal((await store.getRoomById('room-1'))?.codeAgentSessionId, 'session-1');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_chunk'), true);
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_end'), true);
    const persistedTurn = [...store.agentTurns.values()][0];
    assert.equal(persistedTurn.status, 'complete');
    assert.equal(persistedTurn.finalMessageId, messages[4].id);
    assert.ok(persistedTurn.completedAt);
    const turnUpdates = emitter.roomEmits
      .filter(event => event.event === 'agent_turn_updated')
      .map(event => event.args[0] as RoomAgentTurn);
    assert.deepEqual(turnUpdates.map(turn => turn.phase), [
      'preparing_context',
      'preparing_sandbox',
      'starting_agent',
      'running',
      'completing',
      undefined,
    ]);
    assert.deepEqual(turnUpdates.map(turn => turn.status), [
      'running',
      'running',
      'running',
      'running',
      'running',
      'complete',
    ]);
    assert.equal(sandboxService.stoppedRunnerCommands.length, 1);
    assert.deepEqual(observability.events.map(event => event.event), [
      'code_agent.turn.started',
      'code_agent.sandbox.ensure',
      'code_agent.runner.started',
      'code_agent.runner.status',
      'code_agent.runner.model_step',
      'code_agent.runner.tool_call',
      'code_agent.runner.tool_result',
      'code_agent.runner.model_step',
      'code_agent.runner.final',
      'code_agent.turn.completed',
    ]);
    assert.equal((observability.events[3].payload as any)?.message, 'starting');
    assert.equal((observability.events[6].payload as any)?.outputLength, '# RoomTalk'.length);
    assert.equal(observability.events.some(event => event.event === 'code_agent.runner.text_delta'), false);
  });

  it('fails loudly when a Coco runner omits provider usage', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    const messages = store.messages.get('room-1') || [];
    const finalMessage = messages[messages.length - 1];
    assert.equal(result.success, false);
    assert.equal(finalMessage.status, 'error');
    assert.match(finalMessage.content, /without provider-reported usage/);
  });

  it('rejects estimated usage from a Coco runner', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, source: 'estimated' },
      },
    ]);
    const { service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    const messages = store.messages.get('room-1') || [];
    const finalMessage = messages[messages.length - 1];
    assert.equal(result.success, false);
    assert.equal(finalMessage.status, 'error');
    assert.match(finalMessage.content, /without provider-reported usage/);
  });

  it('extends sandbox timeout while a turn is active and shortens it after completion', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { sandboxService, service } = createService({
      runner,
      activeSandboxTtlMs: 60 * 60 * 1000,
      idleSandboxTtlMs: 2 * 60 * 1000,
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(sandboxService.sandboxTimeoutUpdates.map(update => update.ttlMs), [
      60 * 60 * 1000,
      2 * 60 * 1000,
    ]);
  });

  it('acknowledges a durable preparing turn before paged context loading completes', async () => {
    const prompt = userMessage('inspect the latest changes');
    const store = new BlockingContextStore(room(), [prompt]);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { service } = createService({ store, runner });
    let resolveAck!: (response: unknown) => void;
    const acked = new Promise<unknown>(resolve => {
      resolveAck = resolve;
    });

    const turn = service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      promptMessageId: prompt.id,
      promptMessage: prompt,
    }, resolveAck);

    await store.contextReadStarted;
    assert.deepEqual(await acked, { success: true, messageId: 'ai-1' });
    const preparing = [...store.agentTurns.values()][0];
    assert.equal(preparing.phase, 'preparing_context');
    assert.ok(preparing.lastHeartbeatAt);
    assert.deepEqual(store.contextReadOptions, { beforeMessageId: prompt.id, limit: 100 });

    store.releaseContextRead();
    assert.deepEqual(await turn, { success: true, messageId: 'ai-1' });
  });

  it('reuses one sandbox daemon process across sequential turns while passing per-turn env', async () => {
    const contexts: Array<{ command?: string; backend?: CodeAgentBackend; runnerEnv?: Record<string, string> }> = [];
    const runner: CodeAgentRunnerClient = {
      async run(_request, handlers, context): Promise<CodeAgentRunnerRunResult> {
        contexts.push({
          command: context?.process.command,
          backend: context?.backend,
          runnerEnv: context?.runnerEnv,
        });
        const finalEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final' as const,
          messageId: 'ai-1',
          answer: 'Done',
          sessionId: `session-${contexts.length}`,
        };
        await handlers.onEvent(finalEvent);
        return { events: [finalEvent], finalEvent };
      },
    };
    const { sandboxService, service } = createService({
      runner,
      runnerClient: 'daemon',
      daemonRegistry: new CodeAgentDaemonProcessRegistry(),
      daemonCommand: DEFAULT_CODE_AGENT_DAEMON_COMMAND,
      runnerEnv: { PYTHONUNBUFFERED: '1' },
      ids: ['ai-1', 'turn-1', 'ai-2', 'turn-2'],
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(sandboxService.startedRunnerCommands, [DEFAULT_CODE_AGENT_DAEMON_COMMAND]);
    assert.deepEqual(sandboxService.startedRunnerTimeouts, [0]);
    assert.deepEqual(sandboxService.stoppedRunnerCommands, []);
    assert.deepEqual(contexts.map(context => context.command), [
      DEFAULT_CODE_AGENT_DAEMON_COMMAND,
      DEFAULT_CODE_AGENT_DAEMON_COMMAND,
    ]);
    assert.deepEqual(contexts.map(context => context.backend), ['code-agent', 'code-agent']);
    assert.deepEqual(contexts.map(context => context.runnerEnv), [
      { PYTHONUNBUFFERED: '1', ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true' },
      { PYTHONUNBUFFERED: '1', ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true' },
    ]);
  });

  it('runs Codex backend turns with sandbox secret auth injection and refreshed auth persistence', async () => {
    const initialAuthJson = JSON.stringify({ OPENAI_AUTH: { access_token: 'initial-access', refresh_token: 'initial-refresh' } });
    const refreshedAuthJson = JSON.stringify({ OPENAI_AUTH: { access_token: 'refreshed-access', refresh_token: 'initial-refresh' } });
    const authCalls: Array<{ clientId: string; runId: string }> = [];
    const refreshedAuths: Array<string | undefined> = [];
    let sandboxService: FakeCodeAgentSandboxService;
    const runner: CodeAgentRunnerClient = {
      async run(request, handlers, context): Promise<CodeAgentRunnerRunResult> {
        assert.equal(request.codexModel, 'gpt-5.6-sol');
        assert.equal(request.codexReasoningEffort, 'high');
        assert.equal(request.codexPermissionMode, 'fullAccess');
        assert.equal(request.codexServiceTier, 'priority');
        const env = sandboxService.startedRunnerEnvs[sandboxService.startedRunnerEnvs.length - 1];
        assert.ok(env.ROOMTALK_CODEX_AUTH_JSON_PATH);
        assert.ok(env.ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH);
        assert.match(env.ROOMTALK_GITHUB_TOKEN_PATH, /^\/tmp\/roomtalk-codex\/turn-1-github-token$/);
        assert.match(env.GIT_CONFIG_GLOBAL, /^\/tmp\/roomtalk-codex\/turn-1-github-gitconfig$/);
        assert.equal(env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(JSON.stringify(env).includes('github_pat_test_secret'), false);
        assert.equal(
          await sandboxService.readSecretFile(context!.sandbox, env.ROOMTALK_GITHUB_TOKEN_PATH),
          'github_pat_test_secret'
        );
        assert.match(
          await sandboxService.readSecretFile(context!.sandbox, env.GIT_CONFIG_GLOBAL),
          /gh auth git-credential/
        );
        await sandboxService.writeSecretFile(context!.sandbox, {
          path: env.ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH,
          content: refreshedAuthJson,
        });
        const textEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta' as const,
          messageId: 'codex-turn-1',
          delta: 'Codex done',
        };
        const finalEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final' as const,
          messageId: 'codex-turn-1',
          answer: 'Codex done',
          sessionId: 'codex-session-1',
          usage: {
            promptTokens: 1200,
            completionTokens: 100,
            totalTokens: 1300,
            cachedPromptTokens: 900,
            cacheHitRate: 0.75,
            source: 'reported' as const,
          },
        };
        await handlers.onEvent(textEvent);
        await handlers.onEvent(finalEvent);
        return { events: [textEvent, finalEvent], finalEvent };
      },
    };
    const codexConnectionService = {
      async withCodexAuth(clientId: string, runId: string, work: (authJson: string, snapshot: { authVersion: number }) => Promise<any>) {
        authCalls.push({ clientId, runId });
        const workResult = await work(initialAuthJson, { authVersion: 1 });
        refreshedAuths.push(workResult.refreshedAuthJson);
        return workResult.result;
      },
    };
    const setup = createService({
      backend: 'codex',
      runner,
      runnerCommand: DEFAULT_CODEX_CLI_RUNNER_COMMAND,
      runnerEnv: { PYTHONUNBUFFERED: '1', CODEX_CLI_BIN: '/usr/local/bin/codex' },
      codexConnectionService,
      githubConnectionService: {
        async getAccessToken(clientId: string) {
          assert.equal(clientId, 'client-1');
          return 'github_pat_test_secret';
        },
      },
      ids: ['ai-1', 'turn-1'],
    });
    sandboxService = setup.sandboxService;

    const result = await setup.service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      codexRunSettings: { model: 'gpt-5.6-sol', reasoningEffort: 'high', permissionMode: 'fullAccess', serviceTier: 'priority' },
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    assert.deepEqual(authCalls, [{ clientId: 'client-1', runId: 'turn-1' }]);
    assert.deepEqual(refreshedAuths, [refreshedAuthJson]);
    assert.equal(sandboxService.startedRunnerCommands[0], DEFAULT_CODEX_CLI_RUNNER_COMMAND);
    const env = sandboxService.startedRunnerEnvs[0];
    assert.match(env.ROOMTALK_CODEX_AUTH_JSON_PATH, /^\/tmp\/roomtalk-codex\/turn-1-auth\.json$/);
    assert.match(env.ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH, /^\/tmp\/roomtalk-codex\/turn-1-refreshed-auth\.json$/);
    assert.equal(JSON.stringify(env).includes('initial-access'), false);
    assert.deepEqual(sandboxService.deletedSecretFilePaths.sort(), [
      '/tmp/roomtalk-codex/turn-1-auth.json',
      '/tmp/roomtalk-codex/turn-1-github-gitconfig',
      '/tmp/roomtalk-codex/turn-1-github-token',
      '/tmp/roomtalk-codex/turn-1-refreshed-auth.json',
    ]);
    const messages = setup.store.messages.get('room-1') || [];
    assert.equal(messages[messages.length - 1].content, 'Codex done');
    assert.deepEqual(messages[messages.length - 1].aiModel, {
      id: 'gpt-5.6-sol',
      apiModel: 'gpt-5.6-sol',
      provider: 'openai',
      label: 'GPT-5.6-Sol High',
    });
    assert.deepEqual(messages[messages.length - 1].usage, {
      promptTokens: 1200,
      completionTokens: 100,
      totalTokens: 1300,
      cachedPromptTokens: 900,
      cacheHitRate: 0.75,
      source: 'reported',
    });
    assert.equal(messages[messages.length - 1].cost, undefined);
    assert.equal(setup.store.roomCost.totalUsd, 0);
  });

  it('lets a room select Codex while the service default backend remains the code-agent backend', async () => {
    const authCalls: Array<{ clientId: string; runId: string }> = [];
    let sandboxService: FakeCodeAgentSandboxService;
    const runner: CodeAgentRunnerClient = {
      async run(_request, handlers): Promise<CodeAgentRunnerRunResult> {
        const env = sandboxService.startedRunnerEnvs[sandboxService.startedRunnerEnvs.length - 1];
        assert.equal(env.CODEX_CLI_BIN, '/usr/local/bin/codex');
        assert.ok(env.ROOMTALK_CODEX_AUTH_JSON_PATH);
        const textEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta' as const,
          messageId: 'codex-turn-1',
          delta: 'Room-level Codex done',
        };
        const finalEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final' as const,
          messageId: 'codex-turn-1',
          answer: 'Room-level Codex done',
          sessionId: 'codex-session-1',
        };
        await handlers.onEvent(textEvent);
        await handlers.onEvent(finalEvent);
        return { events: [textEvent, finalEvent], finalEvent };
      },
    };
    const codexConnectionService = {
      async withCodexAuth(clientId: string, runId: string, work: (authJson: string, snapshot: { authVersion: number }) => Promise<any>) {
        authCalls.push({ clientId, runId });
        const workResult = await work(
          JSON.stringify({ OPENAI_AUTH: { access_token: 'room-token' } }),
          { authVersion: 1 }
        );
        return workResult.result;
      },
    };
    const setup = createService({
      store: new MemoryCodeAgentStore(room({ codeAgentBackend: 'codex' }), [userMessage()]),
      runner,
      backend: 'code-agent',
      runnerCommandByBackend: {
        'code-agent': DEFAULT_CODE_AGENT_RUNNER_COMMAND,
        codex: DEFAULT_CODEX_CLI_RUNNER_COMMAND,
      },
      runnerEnvByBackend: {
        codex: { CODEX_CLI_BIN: '/usr/local/bin/codex' },
      },
      codexBackendEnabled: true,
      codexConnectionService,
      ids: ['ai-1', 'turn-1'],
    });
    sandboxService = setup.sandboxService;

    const result = await setup.service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    assert.deepEqual(authCalls, [{ clientId: 'client-1', runId: 'turn-1' }]);
    assert.equal(sandboxService.startedRunnerCommands[0], DEFAULT_CODEX_CLI_RUNNER_COMMAND);
    const messages = setup.store.messages.get('room-1') || [];
    assert.equal(messages[1].username, 'Codex');
    assert.equal(messages[messages.length - 1].content, 'Room-level Codex done');
  });

  it('lets a room select Codex app-server while reusing Codex subscription auth', async () => {
    const authCalls: Array<{ clientId: string; runId: string }> = [];
    let sandboxService: FakeCodeAgentSandboxService;
    const runner: CodeAgentRunnerClient = {
      async run(request, handlers, context): Promise<CodeAgentRunnerRunResult> {
        assert.equal(request.codexModel, 'gpt-5.5');
        assert.equal(request.codexReasoningEffort, 'xhigh');
        assert.equal(request.codexServiceTier, 'default');
        assert.equal(context?.backend, 'codex-app-server');
        const env = sandboxService.startedRunnerEnvs[sandboxService.startedRunnerEnvs.length - 1];
        assert.equal(env.CODEX_CLI_BIN, '/usr/local/bin/codex');
        assert.ok(env.ROOMTALK_CODEX_AUTH_JSON_PATH);
        const textEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta' as const,
          messageId: 'codex-app-turn-1',
          delta: 'Codex app-server done',
        };
        const finalEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final' as const,
          messageId: 'codex-app-turn-1',
          answer: 'Codex app-server done',
          sessionId: 'codex-app-session-1',
        };
        const usageEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'usage' as const,
          turnId: request.turnId,
          usage: {
            promptTokens: 106_000,
            completionTokens: 0,
            totalTokens: 106_000,
            modelContextWindow: 200_000,
            source: 'reported' as const,
          },
        };
        await handlers.onEvent(usageEvent);
        await handlers.onEvent(textEvent);
        await handlers.onEvent(finalEvent);
        return { events: [usageEvent, textEvent, finalEvent], finalEvent };
      },
    };
    const codexConnectionService = {
      async withCodexAuth(clientId: string, runId: string, work: (authJson: string, snapshot: { authVersion: number }) => Promise<any>) {
        authCalls.push({ clientId, runId });
        const workResult = await work(
          JSON.stringify({ OPENAI_AUTH: { access_token: 'app-server-token' } }),
          { authVersion: 1 }
        );
        return workResult.result;
      },
    };
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'codex-app-server' }), [userMessage()]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.example',
    });
    const roomContext = new CodeAgentRoomContextService(store as any, {
      tokenSecret: 'room-context-secret',
      createId: () => 'room-context-token-id',
    });
    const setup = createService({
      store,
      runner,
      backend: 'code-agent',
      runnerCommandByBackend: {
        'code-agent': DEFAULT_CODE_AGENT_RUNNER_COMMAND,
        codex: DEFAULT_CODEX_CLI_RUNNER_COMMAND,
        'codex-app-server': DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
      },
      runnerEnvByBackend: {
        'codex-app-server': { CODEX_CLI_BIN: '/usr/local/bin/codex' },
      },
      codexBackendEnabled: true,
      codexConnectionService,
      staticSitePublisher,
      roomContext,
      ids: ['ai-1', 'turn-1'],
    });
    sandboxService = setup.sandboxService;

    const result = await setup.service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      codexRunSettings: { model: 'gpt-5.5', reasoningEffort: 'xhigh', permissionMode: 'approveForMe', serviceTier: 'default' },
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    assert.deepEqual(authCalls, [{ clientId: 'client-1', runId: 'turn-1' }]);
    assert.equal(sandboxService.startedRunnerCommands[0], DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND);
    const runnerEnv = sandboxService.startedRunnerEnvs[0];
    assert.equal(runnerEnv.ROOMTALK_CODEX_AUTH_VERSION, '1');
    assert.equal(runnerEnv.ROOMTALK_CODEX_AUTH_REFRESH_URL, 'https://room.example/api/code-agent/codex-auth/refresh');
    const roomContextClaims = roomContext.verifyTurnToken(runnerEnv.ROOMTALK_ROOM_CONTEXT_TOKEN)!;
    const authRefreshClaims = roomContext.verifyTurnToken(runnerEnv.ROOMTALK_CODEX_AUTH_REFRESH_TOKEN)!;
    assert.equal(authRefreshClaims.roomId, 'room-1');
    assert.equal(authRefreshClaims.clientId, 'client-1');
    assert.equal(authRefreshClaims.turnId, 'turn-1');
    assert.ok(authRefreshClaims.exp > roomContextClaims.exp);
    const usageUpdate = setup.emitter.roomEmits.find(event => event.event === 'ai_usage_update');
    assert.deepEqual(usageUpdate?.args[0], {
      messageId: 'ai-1',
      roomId: 'room-1',
      usage: {
        promptTokens: 106_000,
        completionTokens: 0,
        totalTokens: 106_000,
        modelContextWindow: 200_000,
        source: 'reported',
      },
    });
    const messages = setup.store.messages.get('room-1') || [];
    assert.equal(messages[1].username, 'Codex');
    assert.equal(messages[messages.length - 1].content, 'Codex app-server done');
    assert.deepEqual(messages[messages.length - 1].aiModel, {
      id: 'gpt-5.5',
      apiModel: 'gpt-5.5',
      provider: 'openai',
      label: 'GPT-5.5 Extra High',
    });
  });

  it("uses the room owner's Codex and GitHub connections for an authorized member turn", async () => {
    const prompt = { ...userMessage('member prompt'), clientId: 'member-1' };
    const store = new MemoryCodeAgentStore(room({
      codeAgentBackend: 'codex-app-server',
      codeAgentAccess: 'member',
    }), [prompt]);
    store.addMember('room-1', 'member-1', 'member');
    const authCalls: Array<{ clientId: string; runId: string }> = [];
    const githubCalls: string[] = [];
    const runner = new FakeCodeAgentRunnerClient([
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Shared owner Codex done',
        sessionId: 'owner-codex-session',
      },
    ]);
    const { service } = createService({
      store,
      runner,
      backend: 'codex-app-server',
      runnerCommand: DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
      codexBackendEnabled: true,
      codexConnectionService: {
        async withCodexAuth(clientId: string, runId: string, work: (authJson: string, snapshot: { authVersion: number }) => Promise<any>) {
          authCalls.push({ clientId, runId });
          const workResult = await work('{"tokens":{"access_token":"owner-token"}}', { authVersion: 3 });
          return workResult.result;
        },
      },
      githubConnectionService: {
        async getAccessToken(clientId: string) {
          githubCalls.push(clientId);
          return null;
        },
      },
      ids: ['ai-1', 'turn-1'],
    });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'member-1',
      selectedModel,
      promptMessageId: prompt.id,
      promptMessage: prompt,
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    assert.deepEqual(authCalls, [{ clientId: 'client-1', runId: 'turn-1' }]);
    assert.deepEqual(githubCalls, ['client-1']);
    assert.equal(runner.requests[0].clientId, 'member-1');
    assert.equal(runner.requests[0].prompt, 'member prompt');
  });

  it('explains when the room owner has not connected Codex without exposing a client id', async () => {
    const prompt = { ...userMessage('member prompt'), clientId: 'member-1' };
    const store = new MemoryCodeAgentStore(room({
      codeAgentBackend: 'codex-app-server',
      codeAgentAccess: 'member',
    }), [prompt]);
    store.addMember('room-1', 'member-1', 'member');
    const { service, sandboxService } = createService({
      store,
      backend: 'codex-app-server',
      runnerCommand: DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
      codexBackendEnabled: true,
      codexConnectionService: {
        async withCodexAuth(clientId: string) {
          throw new CodexConnectionError(`No Codex connection found for client ${clientId}.`, 'connection_not_found');
        },
      },
      ids: ['ai-1', 'turn-1'],
    });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'member-1',
      selectedModel,
      promptMessageId: prompt.id,
      promptMessage: prompt,
    });

    assert.deepEqual(result, {
      success: false,
      error: 'The room owner must connect Codex before members can use this workspace',
    });
    assert.equal(sandboxService.startedRunnerCommands.length, 0);
    const errorMessage = store.messages.get('room-1')?.at(-1);
    assert.equal(errorMessage?.content, 'The room owner must connect Codex before members can use this workspace');
    assert.equal(errorMessage?.content.includes('client-1'), false);
  });

  it('fails Codex backend turns without a configured Codex connection service before starting the runner', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'unexpected', sessionId: 'session-1' },
    ]);
    const { sandboxService, service, store } = createService({
      backend: 'codex',
      runner,
      runnerCommand: DEFAULT_CODEX_CLI_RUNNER_COMMAND,
      ids: ['ai-1', 'turn-1'],
    });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.equal(result.success, false);
    assert.equal(sandboxService.startedRunnerCommands.length, 0);
    assert.equal(runner.requests.length, 0);
    const messages = store.messages.get('room-1') || [];
    assert.equal(messages[1].status, 'error');
    assert.equal(messages[1].content, 'Codex connection service is not configured');
  });

  it('persists interleaved AI text and tool events in runner order', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'I will inspect.' },
      cocoModelStep(1, true, ['tool-1'], { promptTokens: 6, completionTokens: 1, totalTokens: 7 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Glob', args: { pattern: '**/*' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Glob', success: true, output: 'No files found matching the pattern.' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'The current directory is empty.' },
      cocoModelStep(2, true, [], { promptTokens: 4, completionTokens: 1, totalTokens: 5 }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'I will inspect.The current directory is empty.',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
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

  it('passes prior RoomTalk Workspace history to the runner and excludes the current prompt', async () => {
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
        clientId: 'code_agent_runner',
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
        clientId: 'code_agent_runner',
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
    const store = new MemoryCodeAgentStore(room({ codeAgentSessionId: 'session-prev' }), initialMessages);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'You asked me to list files.', sessionId: 'session-prev' },
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
        clientId: 'code_agent_runner',
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
        clientId: 'code_agent_runner',
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
    const store = new MemoryCodeAgentStore(room(), initialMessages);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'You asked about files.', sessionId: 'session-1' },
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

  it('uses only the saved prompt when maxContextMessages is zero', async () => {
    const prompt = { ...userMessage('current prompt'), id: 'user-current' };
    const store = new MemoryCodeAgentStore(room(), [userMessage('older prompt'), prompt]);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { service } = createService({ store, runner });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      maxContextMessages: 0,
      promptMessageId: prompt.id,
      promptMessage: prompt,
    });

    assert.equal(runner.requests[0].prompt, 'current prompt');
    assert.deepEqual(runner.requests[0].priorMessages, []);
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
    const store = new MemoryCodeAgentStore(room(), initialMessages);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'ok', sessionId: 'session-1' },
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
    const runner = new FakeCodeAgentRunnerClient([
      cocoModelStep(1, false, ['tool-1', 'tool-2'], { promptTokens: 6, completionTokens: 1, totalTokens: 7 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Write', args: { file_path: 'hello.py' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Write', success: true, output: 'wrote hello.py' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-2', name: 'Shell', args: { command: 'python3 hello.py' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-2', name: 'Shell', success: true, output: 'Hello, World!' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done. The program prints Hello, World!' },
      cocoModelStep(2, true, [], { promptTokens: 4, completionTokens: 1, totalTokens: 5 }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done. The program prints Hello, World!',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
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
    assert.equal(emitter.roomEmits.some(event => event.event === 'message_deleted'), false);
  });

  it('does not render final answers when a tool-only turn sends no text delta', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      cocoModelStep(1, false, ['tool-1'], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Shell', args: { command: 'python3 hello.py' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Shell', success: true, output: 'Hello, World!' },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'The script printed Hello, World!',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
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
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'tool_call', 'tool_result']);
    assert.equal(messages.some(message => message.id === 'ai-1'), false);
    assert.ok((messages[1].cost?.totalUsd || 0) > 0);
    assert.equal(messages[1].modelStepId, 'turn-1:step:1');
    assert.equal(store.roomCost.totalUsd, messages[1].cost?.totalUsd);
    assert.equal(emitter.roomEmits.some(event => event.event === 'message_deleted'), false);
  });

  it('stops the runner before broadcasting the final stream end', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
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
      const runner = new FakeCodeAgentRunnerClient([
        { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
      ]);
      const { sandboxService, service } = createService({
        runner,
        runnerEnv: { CODE_AGENT_SOURCE_DIR: '/sandbox/code-agent-engine/src' },
      });

      await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

      assert.deepEqual(sandboxService.startedRunnerEnvs[0], {
        PYTHONUNBUFFERED: '1',
        CODE_AGENT_SOURCE_DIR: '/sandbox/code-agent-engine/src',
        ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true',
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
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
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
      ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true',
    });
  });

  it('allows each code-agent turn to choose plan mode within an edit-capable server configuration', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'plan' }), [userMessage()]);
    const { service } = createService({ store, runner, mode: 'acceptEdits' });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.equal(runner.requests[0].mode, 'plan');
  });

  it('rejects edit mode requests when the server is configured for plan mode only', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'acceptEdits' }), [userMessage()]);
    const { service } = createService({ store, runner, mode: 'plan' });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: false, error: 'Agent edit mode is not enabled' });
    assert.equal(runner.requests.length, 0);
  });

  it('keeps host provider keys out of proxied runner environments', async () => {
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'host-openai-key';
    process.env.ANTHROPIC_API_KEY = 'host-anthropic-key';
    try {
      const runner = new FakeCodeAgentRunnerClient([
        { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
      ]);
      const { sandboxService, service } = createService({
        runner,
        runnerEnv: {
          CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
          CODE_AGENT_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
        },
      });

      await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

      assert.deepEqual(sandboxService.startedRunnerEnvs[0], {
        PYTHONUNBUFFERED: '1',
        CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
        CODE_AGENT_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
        ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true',
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
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const gateway = new CodeAgentModelGateway({
      publicBaseUrl: 'https://room.example/api/code-agent/model-gateway',
      tokenSecret: 'gateway-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      nowMs: () => 1_800_000_000_000,
      stateStore: new InMemoryCodeAgentModelGatewayTokenStateStore(() => 1_800_000_000_000),
    });
    const { sandboxService, service } = createService({
      store: new MemoryCodeAgentStore(room({ codeAgentMode: 'acceptEdits' }), [userMessage()]),
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
    assert.equal(env.CODE_AGENT_MODEL_PROXY_URL, 'https://room.example/api/code-agent/model-gateway/v1');
    assert.equal(typeof env.CODE_AGENT_MODEL_PROXY_TOKEN, 'string');
    assert.notEqual(env.CODE_AGENT_MODEL_PROXY_TOKEN, 'deepseek-provider-key');
    assert.equal(env.ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS, 'true');
    assert.equal('DEEPSEEK_API_KEY' in env, false);
    assert.equal(runner.requests[0].mode, 'edit');
  });

  it('injects a scoped static publish token for configured approve-for-me turns', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.example',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'static-publish-token-id',
    });
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'approveForMe' }), [userMessage()]);
    const roomContext = new CodeAgentRoomContextService(store as any, {
      tokenSecret: 'room-context-secret',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'static-publish-refresh-token-id',
    });
    const { sandboxService, service } = createService({
      store,
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      staticSitePublisher,
      roomContext,
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH, 'true');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_URL, 'https://room.example/api/code-agent/publish-static-site');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL, 'https://room.example');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_REFRESH_URL, 'https://room.example/api/code-agent/publish-static-site/token');
    const refreshClaims = roomContext.verifyTurnToken(env.ROOMTALK_STATIC_PUBLISH_REFRESH_TOKEN);
    assert.equal(refreshClaims?.turnId, 'turn-1');
    assert.equal(refreshClaims?.exp, Date.parse('2026-05-03T02:00:00.000Z') / 1000);
    const claims = staticSitePublisher.verifyTurnToken(env.ROOMTALK_STATIC_PUBLISH_TOKEN);
    assert.equal(claims?.roomId, 'room-1');
    assert.equal(claims?.clientId, 'client-1');
    assert.equal(claims?.turnId, 'turn-1');
    assert.equal(claims?.mode, 'approveForMe');
  });

  it('injects a read-only room context CLI token in every agent mode', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'plan', codeAgentBackend: 'code-agent' }), [userMessage()]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.example',
    });
    const roomContext = new CodeAgentRoomContextService(store as any, {
      tokenSecret: 'room-context-secret',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'room-context-token-id',
    });
    const { sandboxService, service } = createService({
      store,
      runner,
      availableModes: ['plan'],
      defaultMode: 'plan',
      staticSitePublisher,
      roomContext,
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.ROOMTALK_ROOM_CONTEXT_URL, 'https://room.example/api/code-agent/room-context');
    const claims = roomContext.verifyTurnToken(env.ROOMTALK_ROOM_CONTEXT_TOKEN);
    assert.equal(claims?.roomId, 'room-1');
    assert.equal(claims?.clientId, 'client-1');
    assert.equal(claims?.turnId, 'turn-1');
    assert.equal(claims?.mode, 'plan');
    assert.equal(env.ROOMTALK_CODE_AGENT_ALLOW_SHELL, 'true');
    assert.equal(env.ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH, undefined);
  });

  it('injects static publish URLs using the allowed production client origin', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.ruit.me',
      allowedPublicBaseUrls: ['https://room.ruit.me', 'https://admin.room.ruit.me'],
      nodeEnv: 'production',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'static-publish-token-id',
    });
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'fullAccess' }), [userMessage()]);
    const { sandboxService, service } = createService({
      store,
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      staticSitePublisher,
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      clientOrigin: 'https://room.ruit.me',
      serverOrigin: 'http://127.0.0.1:3012',
    });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_URL, 'https://room.ruit.me/api/code-agent/publish-static-site');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL, 'https://room.ruit.me');
  });

  it('injects local static publish URLs from the local server origin outside production', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.ruit.me',
      nodeEnv: 'development',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'static-publish-token-id',
    });
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'fullAccess' }), [userMessage()]);
    const { sandboxService, service } = createService({
      store,
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      staticSitePublisher,
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      clientOrigin: 'http://127.0.0.1:3011',
      serverOrigin: 'http://127.0.0.1:3012',
    });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_URL, 'http://127.0.0.1:3012/api/code-agent/publish-static-site');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL, 'http://127.0.0.1:3012');
  });

  it('does not inject static publish credentials into plan turns', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.example',
    });
    const { sandboxService, service } = createService({
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      staticSitePublisher,
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal('ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH' in env, false);
    assert.equal('ROOMTALK_STATIC_PUBLISH_TOKEN' in env, false);
  });

  it('defaults code-agent turns to plan even when edit mode is available', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { sandboxService, service } = createService({
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      runnerEnv: { ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS: 'true' },
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(runner.requests[0].mode, 'plan');
    assert.equal('ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS' in sandboxService.startedRunnerEnvs[0], false);
  });

  it('rejects concurrent turns in the same code-agent room', async () => {
    const runner = new BlockingRunner();
    const { service } = createService({ runner });
    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;

    const second = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    assert.deepEqual(second, { success: false, error: 'An agent task is already running in this workspace' });

    runner.release();
    assert.deepEqual(await first, { success: true, messageId: 'ai-1' });
  });

  it('rejects overlapping turns across service instances with a durable room lease', async () => {
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    const firstRunner = new BlockingRunner();
    const firstService = createService({
      store,
      runner: firstRunner,
      ids: ['ai-1', 'turn-1'],
    }).service;
    const secondService = createService({
      store,
      runner: new FakeCodeAgentRunnerClient([
        { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-2', delta: 'Done' },
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'model_step',
          turnId: 'turn-2',
          stepId: 'turn-2:step:1',
          sequence: 1,
          hasText: true,
          toolCallIds: [],
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
        },
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final',
          messageId: 'ai-2',
          answer: 'Done',
          sessionId: 'session-2',
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
        },
      ]),
      ids: ['rejected-ai', 'rejected-turn', 'ai-2', 'turn-2'],
    }).service;

    const first = firstService.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await firstRunner.started;
    assert.deepEqual(
      await secondService.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }),
      { success: false, error: 'An agent task is already running in this workspace' }
    );

    firstRunner.release();
    assert.deepEqual(await first, { success: true, messageId: 'ai-1' });
    assert.equal(store.roomLeases.has('room-1'), false);
    assert.deepEqual(
      await secondService.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }),
      { success: true, messageId: 'ai-2' }
    );
  });

  it('rejects approval responses from members who did not start the turn', async () => {
    const runner = new BlockingRunner();
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'codex-app-server' }), [userMessage()]);
    store.addMember('room-1', 'member-1', 'member');
    const { service } = createService({
      store,
      runner,
      backend: 'codex-app-server',
      codexBackendEnabled: true,
      codexConnectionService: {
        async withCodexAuth(
          _clientId: string,
          _runId: string,
          work: (authJson: string, snapshot: { authVersion: number }) => Promise<any>,
        ) {
          const workResult = await work('{"tokens":{"access_token":"test"}}', { authVersion: 1 });
          return workResult.result;
        },
      },
    });
    const active = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;

    assert.deepEqual(await service.respondToApproval('room-1', 'member-1', 'approval-1', 'accept'), {
      success: false,
      error: 'Only the task starter, room owner, or room admin can respond to this approval',
    });

    runner.release();
    await active;
  });

  it('persists follow-up input and starts it as the next complete turn', async () => {
    const runner = new SequencedBlockingRunner();
    const { service, store } = createService({
      runner,
      ids: ['ai-1', 'turn-1', 'ai-2', 'turn-2'],
    });
    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.waitForRuns(1);

    const queuedMessage: Message = {
      id: 'queued-1',
      clientId: 'client-1',
      content: 'run the tests next',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    };
    const queued = await service.queueTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      requestedMode: 'plan',
    }, queuedMessage);
    assert.equal(queued.success, true);
    assert.equal(queued.message?.codeAgentQueuedInput?.state, 'queued');

    runner.release(0);
    assert.deepEqual(await first, { success: true, messageId: 'ai-1' });
    await runner.waitForRuns(2);
    assert.equal(runner.requests[1].prompt, 'run the tests next');
    assert.equal(runner.requests[1].mode, 'plan');
    assert.equal(runner.requests[1].priorMessages?.some(item => item.role === 'user' && item.content === 'run the tests next') ?? false, false);

    const deadline = Date.now() + 1_000;
    while (store.messages.get('room-1')?.find(item => item.id === 'queued-1')?.codeAgentQueuedInput?.state === 'starting' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const startedPrompt = store.messages.get('room-1')?.find(item => item.id === 'queued-1');
    assert.equal(startedPrompt?.codeAgentQueuedInput, undefined);
    assert.equal(startedPrompt?.turnId, 'turn-2');

    runner.release(1);
    await runner.waitForCompletions(2);
  });

  it('returns only the canonical queued message for an idempotent retry and leaves durable fan-out to room_events', async () => {
    const runner = new BlockingRunner();
    const { emitter, service, store } = createService({
      runner,
      ids: ['ai-1', 'turn-1'],
    });
    const activeTurn = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;
    const canonicalMessage: Message = {
      id: 'queued-canonical',
      clientId: 'client-1',
      clientMessageId: 'queue-request-1',
      content: 'run the tests next',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    };

    const first = await service.queueTurn(
      { roomId: 'room-1', clientId: 'client-1', selectedModel },
      canonicalMessage,
    );
    const duplicate = await service.queueTurn(
      { roomId: 'room-1', clientId: 'client-1', selectedModel },
      { ...canonicalMessage, id: 'queued-ghost' },
    );

    assert.equal(first.message?.id, 'queued-canonical');
    assert.equal(duplicate.message?.id, 'queued-canonical');
    assert.equal(
      store.messages.get('room-1')?.filter(item => item.clientMessageId === 'queue-request-1').length,
      1,
    );
    assert.equal(emitter.roomEmits.some(event => event.event === 'new_message'), false);

    await service.cancelQueuedTurn('room-1', 'client-1', 'queued-canonical');
    runner.release();
    await activeTurn;
  });

  it('accepts Queue during the completion race and starts it immediately when no turn is active', async () => {
    const runner = new SequencedBlockingRunner();
    const { service, store } = createService({
      runner,
      ids: ['ai-1', 'turn-1'],
    });
    const queued = await service.queueTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }, {
      id: 'queued-race-1',
      clientId: 'client-1',
      content: 'start this queued task',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    });

    assert.equal(queued.success, true);
    await runner.waitForRuns(1);
    assert.equal(runner.requests[0].prompt, 'start this queued task');

    const deadline = Date.now() + 1_000;
    while (store.messages.get('room-1')?.find(item => item.id === 'queued-race-1')?.codeAgentQueuedInput?.state === 'starting' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(store.messages.get('room-1')?.find(item => item.id === 'queued-race-1')?.codeAgentQueuedInput, undefined);
    assert.equal(store.messages.get('room-1')?.find(item => item.id === 'queued-race-1')?.turnId, 'turn-1');

    runner.release(0);
    await runner.waitForCompletions(1);
  });

  it('keeps queued follow-up input after an explicit user interrupt', async () => {
    const runner = new ControlBlockingRunner();
    const { service, store, sandboxService } = createService({ runner });
    sandboxService.startRunner = async input => ({
      command: input.command,
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          void runner.receiveControl(JSON.parse(String(chunk))).then(() => callback(), callback);
        },
      }),
      stop: async () => {},
    });

    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;
    await service.queueTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }, {
      id: 'queued-stop-1',
      clientId: 'client-1',
      content: 'do this after the current task',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    });

    assert.deepEqual(await service.interruptTurn('room-1', 'client-1'), { success: true });
    await first;
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(runner.requests.length, 1);
    assert.equal(store.messages.get('room-1')?.find(item => item.id === 'queued-stop-1')?.codeAgentQueuedInput?.state, 'queued');
  });

  it('returns a rejected steer to queued state instead of losing it', async () => {
    const runner = new ControlBlockingRunner(false);
    const { service, store, sandboxService } = createService({ runner });
    sandboxService.startRunner = async input => ({
      command: input.command,
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          void runner.receiveControl(JSON.parse(String(chunk))).then(() => callback(), callback);
        },
      }),
      stop: async () => {},
    });

    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;
    await service.queueTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }, {
      id: 'queued-steer-1',
      clientId: 'client-1',
      content: 'use Bing instead',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    });

    const response = await service.steerQueuedTurn('room-1', 'client-1', 'queued-steer-1');
    assert.deepEqual(response, { success: false, error: 'turn already completed' });
    const queued = store.messages.get('room-1')?.find(item => item.id === 'queued-steer-1')?.codeAgentQueuedInput;
    assert.equal(queued?.state, 'queued');
    assert.equal(queued?.lastError, 'turn already completed');

    runner.release();
    await first;
  });

  it('keeps an accepted steer pending until the runner reports its user input insertion', async () => {
    const runner = new ControlBlockingRunner(true);
    const { service, store, sandboxService } = createService({ runner });
    sandboxService.startRunner = async input => ({
      command: input.command,
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          void runner.receiveControl(JSON.parse(String(chunk))).then(() => callback(), callback);
        },
      }),
      stop: async () => {},
    });

    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;
    await service.queueTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }, {
      id: 'queued-steer-inserted',
      clientId: 'client-1',
      content: 'use Bing instead',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    });

    const response = await service.steerQueuedTurn('room-1', 'client-1', 'queued-steer-inserted');
    assert.deepEqual(response, { success: true });
    const inserted = store.messages.get('room-1')?.find(item => item.id === 'queued-steer-inserted');
    assert.equal(inserted?.codeAgentQueuedInput, undefined);
    assert.equal(inserted?.turnId, 'turn-1');

    runner.release();
    await first;
  });

  it('rejects disabled, unauthorized, non-code-agent, and allowlist-mismatched turns', async () => {
    assert.deepEqual(await createService({ enabled: false }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'Workspace is disabled',
    });
    assert.deepEqual(await createService({ allowedClientIds: ['other-client'] }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'Workspace is not enabled for this user',
    });
    assert.deepEqual(await createService({ store: new MemoryCodeAgentStore(room({ creatorId: 'client-2' }), [userMessage()]) }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'You do not have access to this Workspace room',
    });
    assert.deepEqual(await createService({ store: new MemoryCodeAgentStore(room({ type: 'chat' }), [userMessage()]) }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'Room is not a Workspace room',
    });
  });

  it('allows admins when codeAgentAccess is admin', async () => {
    const store = new MemoryCodeAgentStore(room({ codeAgentAccess: 'admin' }), [
      { ...userMessage(), clientId: 'admin-1' },
    ]);
    store.addMember('room-1', 'admin-1', 'admin');
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'ok' },
      cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'ok',
        sessionId: 's1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { service } = createService({ store, runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'admin-1', selectedModel });
    assert.equal(result.success, true);
  });

  it('rejects regular members when codeAgentAccess is admin', async () => {
    const store = new MemoryCodeAgentStore(room({ codeAgentAccess: 'admin' }), [
      { ...userMessage(), clientId: 'member-1' },
    ]);
    store.addMember('room-1', 'member-1', 'member');
    const { service } = createService({ store });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'member-1', selectedModel });
    assert.deepEqual(result, { success: false, error: 'You do not have access to this Workspace room' });
  });

  it('allows all members when codeAgentAccess is member', async () => {
    const store = new MemoryCodeAgentStore(room({ codeAgentAccess: 'member' }), [
      { ...userMessage(), clientId: 'member-1' },
    ]);
    store.addMember('room-1', 'member-1', 'member');
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'ok' },
      cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'ok',
        sessionId: 's1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { service } = createService({ store, runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'member-1', selectedModel });
    assert.equal(result.success, true);
  });

  it('defaults to owner-only access when codeAgentAccess is not set', async () => {
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    store.addMember('room-1', 'member-1', 'member');

    const result = await createService({ store }).service.startTurn({ roomId: 'room-1', clientId: 'member-1', selectedModel });
    assert.deepEqual(result, { success: false, error: 'You do not have access to this Workspace room' });
  });

  it('stops runner processing when a tool event cannot be persisted', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      cocoModelStep(1, false, ['tool-1'], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Read', args: { file_path: 'README.md' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Read', success: true, output: '# RoomTalk' },
    ]);
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    store.appendFailures = 1;
    const { emitter, service } = createService({ runner, store });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    assert.equal(runner.requests.length, 1);
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai']);
    assert.equal(messages[1].status, 'error');
    assert.equal(messages[1].content, 'Unable to persist agent tool_call event');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_error'), true);
  });

  it('broadcasts room error state when placeholder persistence is rejected after running state was emitted', async () => {
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    store.upsertFailures = 1;
    const { emitter, service } = createService({ store });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(result, { success: false, error: 'Unable to start a durable agent response' });
    assert.equal((await store.getRoomById('room-1'))?.codeAgentStatus, 'error');
    const roomUpdates = emitter.roomEmits.filter(event => event.event === 'room_updated');
    assert.equal((roomUpdates[0].args[0] as Room).codeAgentStatus, 'running');
    assert.equal((roomUpdates[1].args[0] as Room).codeAgentStatus, 'error');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_error'), false);
  });

  it('marks the AI placeholder as error when the runner returns an error event', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'error', message: 'runner crashed', code: 'runner_exit', retryable: false },
    ]);
    const { emitter, service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const messages = store.messages.get('room-1') || [];
    assert.equal(messages[1].messageType, 'ai');
    assert.equal(messages[1].status, 'error');
    assert.equal(messages[1].content, 'runner crashed');
    assert.equal(messages[2].messageType, 'sandbox_status');
    assert.equal(messages[2].isError, true);
    assert.equal((await store.getRoomById('room-1'))?.codeAgentStatus, 'error');
    assert.equal(emitter.roomEmits.some(event => event.event === 'new_message'), false);
    const streamError = emitter.roomEmits.find(event => event.event === 'ai_stream_error');
    assert.ok(streamError);
    assert.equal((streamError.args[0] as any).persisted, true);
    assert.deepEqual((streamError.args[0] as any).message, messages[1]);
    assert.equal(Object.prototype.hasOwnProperty.call((streamError.args[0] as any).message, 'aiStreamOwnerId'), false);
  });

  it('closes pending tool calls with failed results when the runner errors', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      cocoModelStep(1, false, ['tool-1'], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Shell', args: { command: 'python3 -m http.server 4173 --directory dist' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'error', message: 'code agent runner process failed: E2B command wait failed', code: 'runner_process_error', retryable: false },
    ]);
    const { emitter, service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai', 'tool_call', 'tool_result', 'sandbox_status']);
    assert.equal(messages[3].toolCallId, 'tool-1');
    assert.equal(messages[3].toolName, 'Shell');
    assert.equal(messages[3].status, 'error');
    assert.equal(messages[3].isError, true);
    assert.ok((messages[2].cost?.totalUsd || 0) > 0);
    assert.equal(store.roomCost.totalUsd, messages[2].cost?.totalUsd);
    assert.match(messages[3].content, /Tool interrupted before completion/);
    assert.match(messages[3].content, /E2B command wait failed/);
    assert.equal(emitter.roomEmits.some(event => event.event === 'new_message'), false);
  });

  it('closes pending tool calls with failed results when the runner finalizes after interruption', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      cocoModelStep(1, false, ['tool-1'], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Shell', args: { command: 'sleep 30' } },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: '',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { emitter, service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    const messages = store.messages.get('room-1') || [];
    assert.equal(result.success, true);
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'tool_call', 'tool_result']);
    assert.equal(messages[2].toolCallId, 'tool-1');
    assert.equal(messages[2].status, 'error');
    assert.equal(messages[2].isError, true);
    assert.match(messages[2].content, /agent turn ended before tool completion/);
    assert.equal(emitter.roomEmits.some(event => event.event === 'new_message'), false);
  });
});
