import assert from 'assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { executeQueuedAssistantRun, registerAIHandlers } from './aiHandlers';
import { AIModelOption, Message, Room, RoomAICostTotal } from '../types';

type SocketEmit = {
  event: string;
  args: unknown[];
};

type RoomEmit = {
  roomId: string;
  event: string;
  args: unknown[];
};

class FakeSocket {
  id = 'socket-1';
  handlers = new Map<string, (...args: any[]) => unknown>();
  emitted: SocketEmit[] = [];
  handshake: { headers: Record<string, string | string[] | undefined> };

  constructor(headers: Record<string, string | string[] | undefined> = {}) {
    this.handshake = { headers };
  }

  on(event: string, handler: (...args: any[]) => unknown) {
    this.handlers.set(event, handler);
  }

  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
  }

  async invoke(event: string, ...args: unknown[]) {
    const handler = this.handlers.get(event);
    assert.ok(handler, `Expected handler for ${event}`);
    return handler(...args);
  }
}

class FakeIo {
  roomEmits: RoomEmit[] = [];

  to(roomId: string) {
    return {
      emit: (event: string, ...args: unknown[]) => {
        this.roomEmits.push({ roomId, event, args });
      },
    };
  }
}

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const roomtalkOriginHeaders = {
  origin: 'https://room.ruit.me',
  'x-forwarded-proto': 'https',
  'x-forwarded-host': 'room.ruit.me',
};

const selectedModel: AIModelOption = {
  id: 'deepseek-v4-pro',
  apiModel: 'deepseek-chat',
  provider: 'deepseek',
  label: 'DeepSeek V4 Pro',
  description: 'Test model',
  pricing: {
    currency: 'USD',
    inputPerMillion: 0.2,
    outputPerMillion: 0.8,
    cachedInputPerMillion: 0.02,
  },
};

const anthropicModel: AIModelOption = {
  id: 'claude-sonnet-4.6',
  apiModel: 'claude-sonnet-4-6',
  provider: 'anthropic',
  label: 'Claude Sonnet 4.6',
  description: 'Anthropic test model',
  pricing: {
    currency: 'USD',
    inputPerMillion: 3,
    outputPerMillion: 15,
  },
};

const a2uiToolArgs = JSON.stringify({
  messages: [
    {
      version: 'v0.9',
      createSurface: {
        surfaceId: 'tool-surface',
        catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
      },
    },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'tool-surface',
        components: [
          { id: 'root', component: 'Card', child: 'body' },
          { id: 'body', component: 'Column', children: ['title'] },
          { id: 'title', component: 'Text', text: 'Tool UI', variant: 'h3' },
        ],
      },
    },
  ],
});

const asyncIterable = (items: any[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const item of items) {
      yield item;
    }
  },
});

const expectedE2EFakeContent = (prompt: string) => (
  `E2E AI response: I received "${prompt}". The text stream is still moving while the UI surface updates. The card below includes live status, checklist items, and an action.`
);

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  lastActivityAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'message-1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T00:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

const roomCost = (roomId = 'room-1'): RoomAICostTotal => ({
  roomId,
  currency: 'USD',
  totalUsd: 0.0001,
});

const roomActivityForMessages = (messages: Message[]) => room({
  lastActivityAt: messages[messages.length - 1]?.timestamp || room().createdAt,
});

const createHarness = (options: {
  rejectSaves?: boolean;
  rejectSaveNumbers?: number[];
  rejectAppend?: boolean;
  clientId?: string | null;
  aiStreamOwnerId?: string;
  model?: AIModelOption;
  aiClientWrapper?: any;
  messages?: Message[];
  currentRoom?: Room | null;
  codeAgentSessionService?: {
    startTurn?: (...args: any[]) => Promise<unknown>;
    queueTurn?: (...args: any[]) => Promise<unknown>;
  };
  headers?: Record<string, string | string[] | undefined>;
} = {}) => {
  const socket = new FakeSocket(options.headers);
  const io = new FakeIo();
  const store = {
    rooms: options.currentRoom === undefined
      ? [room()]
      : (options.currentRoom ? [options.currentRoom] : []),
    members: new Set(['room-1:client-1']),
    messages: options.messages || [message()],
    appendedMessages: [] as Message[],
    upsertedMessages: [] as Message[],
    savedHistories: [] as Message[][],
    assistantRuns: [] as any[],
    outboxEvents: [] as any[],
    normalizeAIModelCalls: [] as unknown[],
    truncateBeforeCalls: [] as Array<{ roomId: string; messageId: string }>,
    truncateAfterCalls: [] as Array<{ roomId: string; messageId: string }>,
    editAndTruncateCalls: [] as Array<{ roomId: string; messageId: string; newContent: string }>,
    async getClientId() {
      return options.clientId === undefined ? 'client-1' : options.clientId;
    },
    async readMessagesByRoom(roomId: string) {
      return this.messages.filter(item => item.roomId === roomId);
    },
    async readMessagePageByRoom(roomId: string, options: { limit?: number; beforeMessageId?: string } = {}) {
      const limit = Math.max(1, Math.min(200, Math.floor(options.limit || 80)));
      const roomMessages = this.messages.filter(item => item.roomId === roomId);
      let endIndex = roomMessages.length;
      if (options.beforeMessageId) {
        const targetIndex = roomMessages.findIndex(item => item.id === options.beforeMessageId);
        if (targetIndex === -1) {
          return { roomId, messages: [], hasMore: false };
        }
        endIndex = targetIndex;
      }

      const startIndex = Math.max(0, endIndex - limit);
      const messages = roomMessages.slice(startIndex, endIndex);
      return { roomId, messages, hasMore: startIndex > 0, oldestMessageId: messages[0]?.id };
    },
    async addRoomMember(roomId: string, memberClientId: string, role: 'owner' | 'member', joinedAt = '2026-05-03T00:00:00.000Z') {
      this.members.add(`${roomId}:${memberClientId}`);
      return { roomId, clientId: memberClientId, role, joinedAt };
    },
    async getRoomMember(roomId: string, memberClientId: string) {
      return this.members.has(`${roomId}:${memberClientId}`)
        ? { roomId, clientId: memberClientId, role: 'member' as const, joinedAt: '2026-05-03T00:00:00.000Z' }
        : null;
    },
    async isRoomMember(roomId: string, memberClientId: string) {
      return this.members.has(`${roomId}:${memberClientId}`);
    },
    async readRoomMembers(roomId: string) {
      return [...this.members]
        .filter(key => key.startsWith(`${roomId}:`))
        .map(key => ({ roomId, clientId: key.split(':')[1], role: 'member' as const, joinedAt: '2026-05-03T00:00:00.000Z' }));
    },
    async getRoomById(roomId: string) {
      return this.rooms.find(item => item.id === roomId) || null;
    },
    async saveMessageHistory(_roomId: string, messages: Message[]) {
      this.savedHistories.push(messages);
      this.messages = messages;
      return room({ lastActivityAt: messages[messages.length - 1]?.timestamp || room().createdAt });
    },
    async appendMessage(newMessage: Message) {
      this.appendedMessages.push(newMessage);
      if (options.rejectAppend) {
        return null;
      }
      this.messages = [...this.messages, newMessage];
      return room({ lastActivityAt: newMessage.timestamp });
    },
    async truncateBeforeMessage(roomId: string, messageId: string) {
      this.truncateBeforeCalls.push({ roomId, messageId });
      const roomMessages = this.messages.filter(item => item.roomId === roomId);
      const targetIndex = roomMessages.findIndex(item => item.id === messageId);
      if (targetIndex === -1) {
        return { room: roomActivityForMessages(roomMessages), messages: roomMessages, targetFound: false };
      }

      const remainingMessages = roomMessages.slice(0, targetIndex);
      this.messages = this.messages.filter(item => item.roomId !== roomId).concat(remainingMessages);
      return { room: roomActivityForMessages(remainingMessages), messages: remainingMessages, targetFound: true };
    },
    async truncateAfterMessage(roomId: string, messageId: string) {
      this.truncateAfterCalls.push({ roomId, messageId });
      const roomMessages = this.messages.filter(item => item.roomId === roomId);
      const targetIndex = roomMessages.findIndex(item => item.id === messageId);
      if (targetIndex === -1) {
        return { room: roomActivityForMessages(roomMessages), messages: roomMessages, targetFound: false };
      }

      const remainingMessages = roomMessages.slice(0, targetIndex + 1);
      this.messages = this.messages.filter(item => item.roomId !== roomId).concat(remainingMessages);
      return { room: roomActivityForMessages(remainingMessages), messages: remainingMessages, targetFound: true };
    },
    async updateMessageAndTruncateAfter(roomId: string, messageId: string, newContent: string, updatedAt = '2026-05-03T00:00:10.000Z') {
      this.editAndTruncateCalls.push({ roomId, messageId, newContent });
      const roomMessages = this.messages.filter(item => item.roomId === roomId);
      const targetIndex = roomMessages.findIndex(item => item.id === messageId);
      if (targetIndex === -1) {
        return { room: roomActivityForMessages(roomMessages), messages: roomMessages, targetFound: false };
      }

      const updatedMessage = {
        ...roomMessages[targetIndex],
        content: newContent,
        updatedAt,
      };
      const remainingMessages = [...roomMessages.slice(0, targetIndex), updatedMessage];
      this.messages = this.messages.filter(item => item.roomId !== roomId).concat(remainingMessages);
      return { room: roomActivityForMessages(remainingMessages), messages: remainingMessages, targetFound: true, updatedMessage };
    },
    async upsertMessage(newMessage: Message) {
      this.upsertedMessages.push(newMessage);
      if (options.rejectSaves || options.rejectSaveNumbers?.includes(this.upsertedMessages.length)) {
        return null;
      }
      const messageIndex = this.messages.findIndex(message => message.id === newMessage.id);
      this.messages = messageIndex === -1
        ? [...this.messages, newMessage]
        : this.messages.map(message => message.id === newMessage.id ? newMessage : message);
      return room({ lastActivityAt: newMessage.timestamp });
    },
    async incrementRoomAICost(roomId: string) {
      return roomCost(roomId);
    },
    async createAssistantRunWithOutbox(run: any, event: any) {
      this.assistantRuns.push(run);
      this.outboxEvents.push(event);
      return { run, event };
    },
    async updateAssistantRun(runId: string, updates: any) {
      const runIndex = this.assistantRuns.findIndex(run => run.id === runId);
      if (runIndex === -1) {
        return null;
      }
      this.assistantRuns[runIndex] = {
        ...this.assistantRuns[runIndex],
        ...updates,
      };
      return this.assistantRuns[runIndex];
    },
  };

  registerAIHandlers({
    io: io as any,
    socket: socket as any,
    store: store as any,
    socketLogger: logger as any,
    openaiLogger: logger as any,
    normalizeAIModel: (modelId?: unknown) => {
      store.normalizeAIModelCalls.push(modelId);
      return options.model || selectedModel;
    },
    getAIClientForModel: () => {
      if (options.aiClientWrapper) {
        return options.aiClientWrapper;
      }
      throw new Error('E2E fake AI should not request a real client');
    },
    aiStreamOwnerId: options.aiStreamOwnerId || 'test-stream-owner',
    codeAgentSessionService: options.codeAgentSessionService as any,
  });

  return { io, socket, store };
};

describe('AI socket handlers', () => {
  const previousEnv = {
    e2eMode: process.env.E2E_TEST_MODE,
    fakeAI: process.env.E2E_FAKE_AI,
    aiRunnerMode: process.env.AI_RUNNER_MODE,
  };

  beforeEach(() => {
    process.env.E2E_TEST_MODE = 'true';
    process.env.E2E_FAKE_AI = 'true';
  });

  afterEach(() => {
    if (previousEnv.e2eMode === undefined) {
      delete process.env.E2E_TEST_MODE;
    } else {
      process.env.E2E_TEST_MODE = previousEnv.e2eMode;
    }

    if (previousEnv.fakeAI === undefined) {
      delete process.env.E2E_FAKE_AI;
    } else {
      process.env.E2E_FAKE_AI = previousEnv.fakeAI;
    }

    if (previousEnv.aiRunnerMode === undefined) {
      delete process.env.AI_RUNNER_MODE;
    } else {
      process.env.AI_RUNNER_MODE = previousEnv.aiRunnerMode;
    }
  });

  it('persists a streaming placeholder before completing an AI response', async () => {
    const { io, socket, store } = createHarness();

    let response: unknown;
    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id }, (ack: unknown) => {
      response = ack;
    });

    assert.equal(store.upsertedMessages.length, 2);
    const streamingMessage = store.upsertedMessages[0];
    assert.equal(streamingMessage.clientId, 'ai_assistant');
    assert.equal(streamingMessage.status, 'streaming');
    assert.equal(streamingMessage.content, '');
    assert.equal((streamingMessage as any).aiStreamOwnerId, 'test-stream-owner');

    const finalMessage = store.upsertedMessages[1];
    assert.equal(finalMessage.id, streamingMessage.id);
    assert.equal(finalMessage.status, 'complete');
    assert.equal(finalMessage.content, expectedE2EFakeContent('hello'));
    assert.equal((finalMessage as any).aiStreamOwnerId, undefined);
    assert.equal(finalMessage.usage?.cacheHitRate, 0.25);
    assert.deepEqual(store.messages.map(item => item.id), ['message-1', streamingMessage.id]);
    assert.equal(store.messages[1].status, 'complete');

    assert.equal(io.roomEmits.some(event => event.event === 'new_message'), false);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_end'), true);
    assert.deepEqual(response, { success: true, messageId: streamingMessage.id });
    const aiChunkEvents = io.roomEmits.filter(event => event.event === 'ai_chunk');
    assert.deepEqual(aiChunkEvents.map(event => (event.args[0] as { chunk: string }).chunk), [
      'E2E AI response: ',
      'I received "hello". ',
      'The text stream is still moving while the UI surface updates. ',
      'The card below includes live status, checklist items, and an action.',
    ]);
    const a2uiUpdateEvents = io.roomEmits.filter(event => event.event === 'a2ui_update');
    const streamEndIndex = io.roomEmits.findIndex(event => event.event === 'ai_stream_end');
    const lastA2UIUpdateIndex = io.roomEmits.map(event => event.event).lastIndexOf('a2ui_update');
    assert.equal(a2uiUpdateEvents.length, 5);
    assert.ok(lastA2UIUpdateIndex !== -1 && streamEndIndex !== -1 && lastA2UIUpdateIndex < streamEndIndex);
    assert.equal(finalMessage.uiPayload?.version, 'v0.9');
    assert.equal(finalMessage.uiPayload?.messages.length, 5);
    assert.equal((a2uiUpdateEvents[0].args[0] as any).uiPayload.messages[0].createSurface.catalogId, 'https://a2ui.org/specification/v0_9/basic_catalog.json');
  });

  it('queues AI runs for the outbox worker without calling the provider in worker mode', async () => {
    process.env.AI_RUNNER_MODE = 'worker';
    process.env.E2E_FAKE_AI = 'false';
    const openAIClient = {
      chat: {
        completions: {
          create: () => {
            throw new Error('provider should not be called while queueing');
          },
        },
      },
    };
    const { io, socket, store } = createHarness({
      aiClientWrapper: { provider: 'deepseek', client: openAIClient },
    });

    let response: unknown;
    await socket.invoke('ask_ai', {
      roomId: 'room-1',
      model: selectedModel.id,
      roleName: 'Assistant',
      codeAgentMode: 'plan',
    }, (ack: unknown) => {
      response = ack;
    });

    assert.equal(store.upsertedMessages.length, 1);
    assert.equal(store.upsertedMessages[0].status, 'streaming');
    assert.equal(store.assistantRuns.length, 1);
    assert.equal(store.assistantRuns[0].status, 'queued');
    assert.equal(store.assistantRuns[0].metadata.runnerMode, 'worker');
    assert.equal(store.outboxEvents.length, 1);
    assert.equal(store.outboxEvents[0].eventType, 'ai.run_requested');
    assert.equal(store.outboxEvents[0].status, 'pending');
    assert.equal(store.outboxEvents[0].attempts, 0);
    assert.equal(store.outboxEvents[0].payload.runId, store.assistantRuns[0].id);
    assert.equal(store.outboxEvents[0].payload.aiMessageId, store.upsertedMessages[0].id);
    assert.equal(io.roomEmits.some(event => event.event === 'new_message'), false);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_chunk'), false);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_end'), false);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_error'), false);
    assert.deepEqual(response, { success: true, messageId: store.upsertedMessages[0].id });
  });

  it('routes code-agent room AI requests to the code-agent session service', async () => {
    const calls: unknown[][] = [];
    const codeAgentSessionService = {
      async startTurn(...args: unknown[]) {
        calls.push(args);
        const callback = args[1] as ((response: { success: boolean; messageId?: string }) => void) | undefined;
        callback?.({ success: true, messageId: 'code-agent-ai-1' });
        return { success: true, messageId: 'code-agent-ai-1' };
      },
    };
    const { socket, store } = createHarness({
      currentRoom: room({ type: 'codeAgent' }),
      codeAgentSessionService,
      headers: roomtalkOriginHeaders,
    });

    let response: unknown;
    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id, codeAgentMode: 'plan' }, (ack: unknown) => {
      response = ack;
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], {
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      maxContextMessages: undefined,
      clientOrigin: 'https://room.ruit.me',
      serverOrigin: 'https://room.ruit.me',
    });
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0][0], 'roleName'), false);
    assert.deepEqual(response, { success: true, messageId: 'code-agent-ai-1' });
    assert.equal(store.upsertedMessages.length, 0);
    assert.equal(store.assistantRuns.length, 0);
    assert.equal(store.outboxEvents.length, 0);
  });

  it('queues a durable follow-up input without starting another concurrent turn', async () => {
    const calls: unknown[][] = [];
    const codeAgentSessionService = {
      async queueTurn(...args: unknown[]) {
        calls.push(args);
        return { success: true, message: args[1] };
      },
    };
    const imageMessage = message({
      id: 'image-message-1',
      clientId: 'client-1',
      messageType: 'media',
      content: '',
      mediaAsset: { id: 'asset-image-1', kind: 'image', mimeType: 'image/png', byteSize: 3 },
    });
    const { socket } = createHarness({
      currentRoom: room({ type: 'codeAgent', codeAgentStatus: 'running' }),
      codeAgentSessionService,
      headers: roomtalkOriginHeaders,
      messages: [imageMessage],
    });

    let response: unknown;
    await socket.invoke('queue_code_agent_input', {
      roomId: 'room-1',
      content: 'use Bing for the next pass',
      model: selectedModel.id,
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'high',
      codexPermissionMode: 'fullAccess',
      codexServiceTier: 'priority',
      codeAgentMode: 'fullAccess',
      clientMessageId: 'client-message-1',
      imageMessageIds: [imageMessage.id],
    }, (ack: unknown) => {
      response = ack;
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], {
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      codexRunSettings: {
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        permissionMode: 'fullAccess',
        serviceTier: 'priority',
      },
      maxContextMessages: undefined,
      clientOrigin: 'https://room.ruit.me',
      serverOrigin: 'https://room.ruit.me',
      requestedMode: 'fullAccess',
      requestedModeSource: 'originalTurn',
    });
    assert.equal((calls[0][1] as Message).content, 'use Bing for the next pass');
    assert.equal((calls[0][1] as Message).clientMessageId, 'client-message-1');
    assert.deepEqual((calls[0][1] as Message).codeAgentImageMessageIds, [imageMessage.id]);
    assert.deepEqual(response, { success: true, message: calls[0][1] });
  });

  it('rejects code-agent image links that are not owned by the requesting client', async () => {
    let queueCalls = 0;
    const codeAgentSessionService = {
      async queueTurn() {
        queueCalls++;
        return { success: true };
      },
    };
    const foreignImage = message({
      id: 'foreign-image-message',
      clientId: 'client-2',
      messageType: 'media',
      content: '',
      mediaAsset: { id: 'foreign-asset', kind: 'image', mimeType: 'image/png', byteSize: 3 },
    });
    const { socket } = createHarness({
      currentRoom: room({ type: 'codeAgent', codeAgentStatus: 'running' }),
      codeAgentSessionService,
      headers: roomtalkOriginHeaders,
      messages: [foreignImage],
    });

    let response: unknown;
    await socket.invoke('queue_code_agent_input', {
      roomId: 'room-1',
      content: 'inspect this',
      model: selectedModel.id,
      imageMessageIds: [foreignImage.id],
    }, (ack: unknown) => {
      response = ack;
    });

    assert.deepEqual(response, { success: false, error: 'Agent image attachment is unavailable' });
    assert.equal(queueCalls, 0);
  });

  it('passes Codex model and reasoning settings to code-agent session service for Codex-backed rooms', async () => {
    const calls: unknown[][] = [];
    const codeAgentSessionService = {
      async startTurn(...args: unknown[]) {
        calls.push(args);
        const callback = args[1] as ((response: { success: boolean; messageId?: string }) => void) | undefined;
        callback?.({ success: true, messageId: 'codex-ai-1' });
        return { success: true, messageId: 'codex-ai-1' };
      },
    };
    const { socket } = createHarness({
      currentRoom: room({ type: 'codeAgent', codeAgentBackend: 'codex' }),
      codeAgentSessionService,
      headers: roomtalkOriginHeaders,
    });

    await socket.invoke('ask_ai', {
      roomId: 'room-1',
      model: selectedModel.id,
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'high',
      codexPermissionMode: 'fullAccess',
      codexServiceTier: 'priority',
    });

    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0][0] as any).codexRunSettings, {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      permissionMode: 'fullAccess',
      serviceTier: 'priority',
    });
  });

  it('reports code-agent unavailability without falling back to ordinary chat AI', async () => {
    const { socket, store } = createHarness({ currentRoom: room({ type: 'codeAgent' }) });

    let response: unknown;
    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id }, (ack: unknown) => {
      response = ack;
    });

    assert.deepEqual(response, { success: false, error: 'Workspace is unavailable' });
    assert.equal(store.upsertedMessages.length, 0);
    assert.equal(store.assistantRuns.length, 0);
  });

  it('executes a queued AI run from the outbox worker path', async () => {
    const { io, store } = createHarness();
    store.assistantRuns.push({
      id: 'run-1',
      status: 'queued',
      metadata: { runnerMode: 'worker' },
    });

    await executeQueuedAssistantRun(
      {
        runId: 'run-1',
        roomId: 'room-1',
        requestedByClientId: 'client-1',
        aiMessageId: 'queued-ai-message',
        roleName: 'Assistant',
        systemPrompt: 'You are helpful.',
        model: selectedModel.id,
        maxContextMessages: 100,
        contextMessages: [message()],
        historyUsedForContext: [message()],
      },
      {
        io: io as any,
        store: store as any,
        socketLogger: logger as any,
        openaiLogger: logger as any,
        normalizeAIModel: () => selectedModel,
        getAIClientForModel: () => {
          throw new Error('E2E fake worker should not request a real client');
        },
      },
    );

    assert.equal(store.upsertedMessages.at(-1)?.id, 'queued-ai-message');
    assert.equal(store.upsertedMessages.at(-1)?.status, 'complete');
    assert.equal(store.assistantRuns[0].status, 'complete');
    assert.equal(store.assistantRuns[0].metadata.runnerMode, 'worker');
    assert.equal(io.roomEmits.some(event => event.event === 'ai_chunk'), true);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_end'), true);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_error'), false);
  });

  it('uses only the current message when the room AI context limit is zero', async () => {
    process.env.E2E_FAKE_AI = 'false';
    const createCalls: any[] = [];
    const openAIClient = {
      chat: {
        completions: {
          create: async (request: any) => {
            createCalls.push(request);
            return asyncIterable([
              { choices: [{ delta: { content: 'limited response' } }] },
              { choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
            ]);
          },
        },
      },
    };
    const previousMessage = message({
      id: 'old-message',
      content: 'old prompt',
      timestamp: '2026-05-03T00:00:00.000Z',
    });
    const currentMessage = message({
      id: 'current-message',
      content: 'current prompt',
      timestamp: '2026-05-03T00:01:00.000Z',
    });
    const { socket } = createHarness({
      messages: [previousMessage, currentMessage],
      aiClientWrapper: { provider: 'deepseek', client: openAIClient },
    });

    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id, maxContextMessages: 0 });

    const providerMessages = createCalls[0].messages as Array<{ role: string; content: string }>;
    const userMessages = providerMessages.filter(item => item.role === 'user');
    assert.equal(userMessages.length, 1);
    assert.match(String(userMessages[0].content), /current prompt/);
    assert.doesNotMatch(String(userMessages[0].content), /old prompt/);
  });

  it('does not include the automatic A2UI hi demo trigger for the default assistant role', async () => {
    process.env.E2E_FAKE_AI = 'false';
    const createCalls: any[] = [];
    const openAIClient = {
      chat: {
        completions: {
          create: (request: any) => {
            createCalls.push(request);
            return asyncIterable([
              { choices: [{ delta: { content: 'hello' } }] },
              { choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
            ]);
          },
        },
      },
    };
    const { socket } = createHarness({
      messages: [message({ content: 'hi' })],
      aiClientWrapper: { provider: 'deepseek', client: openAIClient },
    });

    await socket.invoke('ask_ai', {
      roomId: 'room-1',
      model: selectedModel.id,
      roleName: 'Assistant',
      systemPrompt: 'You are a helpful, creative, friendly assistant. Respond concisely and clearly.',
    });

    const providerMessages = createCalls[0].messages as Array<{ role: string; content: string }>;
    assert.match(String(providerMessages[0].content), /A2UI streaming UI capability/);
    assert.doesNotMatch(String(providerMessages[0].content), /latest user message is exactly "hi"/);
  });

  it('includes the automatic A2UI hi demo trigger for the A2UI demo role', async () => {
    process.env.E2E_FAKE_AI = 'false';
    const createCalls: any[] = [];
    const openAIClient = {
      chat: {
        completions: {
          create: (request: any) => {
            createCalls.push(request);
            return asyncIterable([
              { choices: [{ delta: { content: 'demo' } }] },
              { choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
            ]);
          },
        },
      },
    };
    const { socket } = createHarness({
      messages: [message({ content: 'hi' })],
      aiClientWrapper: { provider: 'deepseek', client: openAIClient },
    });

    await socket.invoke('ask_ai', {
      roomId: 'room-1',
      model: selectedModel.id,
      roleName: 'A2UI Demo',
      systemPrompt: 'You are an A2UI streaming demo assistant.',
    });

    const providerMessages = createCalls[0].messages as Array<{ role: string; content: string }>;
    assert.match(String(providerMessages[0].content), /latest user message is exactly "hi"/);
  });

  it('streams A2UI updates from OpenAI-compatible tool calls before stream end', async () => {
    process.env.E2E_FAKE_AI = 'false';
    const createCalls: any[] = [];
    const openAIClient = {
      chat: {
        completions: {
          create: async (request: any) => {
            createCalls.push(request);
            if (createCalls.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { content: 'Preparing a UI. ' } }] },
                {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        index: 0,
                        id: 'call_a2ui_1',
                        type: 'function',
                        function: {
                          name: 'a2ui_update',
                          arguments: a2uiToolArgs,
                        },
                      }],
                    },
                  }],
                },
                { choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
              ]);
            }

            return asyncIterable([
              { choices: [{ delta: { content: 'The UI is live.' } }] },
              { choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } },
            ]);
          },
        },
      },
    };
    const { io, socket, store } = createHarness({
      aiClientWrapper: { provider: 'deepseek', client: openAIClient },
    });

    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id });

    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0].tools?.[0]?.function?.name, 'a2ui_update');
    assert.equal(createCalls[1].messages.some((message: any) => message.role === 'tool'), true);
    const a2uiUpdateIndex = io.roomEmits.findIndex(event => event.event === 'a2ui_update');
    const streamEndIndex = io.roomEmits.findIndex(event => event.event === 'ai_stream_end');
    assert.ok(a2uiUpdateIndex !== -1 && streamEndIndex !== -1 && a2uiUpdateIndex < streamEndIndex);
    assert.equal(store.upsertedMessages[1].content, 'Preparing a UI. The UI is live.');
    assert.equal(store.upsertedMessages[1].uiPayload?.messages.length, 2);
    assert.equal(store.upsertedMessages[1].usage?.promptTokens, 16);
    assert.equal(store.upsertedMessages[1].usage?.completionTokens, 9);
  });

  it('streams A2UI updates from Anthropic tool_use blocks before stream end', async () => {
    process.env.E2E_FAKE_AI = 'false';
    const streamCalls: any[] = [];
    const anthropicClient = {
      messages: {
        stream: (request: any) => {
          streamCalls.push(request);
          if (streamCalls.length === 1) {
            return {
              ...asyncIterable([
                { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Building the surface. ' } },
              ]),
              finalMessage: async () => ({
                content: [
                  { type: 'text', text: 'Building the surface. ' },
                  { type: 'tool_use', id: 'toolu_a2ui_1', name: 'a2ui_update', input: JSON.parse(a2uiToolArgs) },
                ],
                usage: { input_tokens: 12, output_tokens: 7 },
              }),
            };
          }

          return {
            ...asyncIterable([
              { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } },
            ]),
            finalMessage: async () => ({
              content: [{ type: 'text', text: 'Done.' }],
              usage: { input_tokens: 8, output_tokens: 3 },
            }),
          };
        },
      },
    };
    const { io, socket, store } = createHarness({
      model: anthropicModel,
      aiClientWrapper: { provider: 'anthropic', client: anthropicClient },
    });

    await socket.invoke('ask_ai', { roomId: 'room-1', model: anthropicModel.id });

    assert.equal(streamCalls.length, 2);
    assert.equal(streamCalls[0].tools?.[0]?.name, 'a2ui_update');
    assert.equal(streamCalls[1].messages.some((message: any) =>
      message.role === 'user' && Array.isArray(message.content) && message.content.some((block: any) => block.type === 'tool_result')
    ), true);
    const a2uiUpdateIndex = io.roomEmits.findIndex(event => event.event === 'a2ui_update');
    const streamEndIndex = io.roomEmits.findIndex(event => event.event === 'ai_stream_end');
    assert.ok(a2uiUpdateIndex !== -1 && streamEndIndex !== -1 && a2uiUpdateIndex < streamEndIndex);
    assert.equal(store.upsertedMessages[1].content, 'Building the surface. Done.');
    assert.equal(store.upsertedMessages[1].uiPayload?.messages.length, 2);
    assert.equal(store.upsertedMessages[1].usage?.promptTokens, 20);
    assert.equal(store.upsertedMessages[1].usage?.completionTokens, 10);
  });

  it('treats premature provider close after streamed content as a completed AI response', async () => {
    process.env.E2E_FAKE_AI = 'false';
    const openAIClient = {
      chat: {
        completions: {
          create: () => ({
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: 'complete-looking response' } }] };
              throw new Error('Premature close');
            },
          }),
        },
      },
    };
    const { io, socket, store } = createHarness({
      aiClientWrapper: { provider: 'deepseek', client: openAIClient },
    });

    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id });

    assert.equal(store.upsertedMessages.length, 2);
    assert.equal(store.upsertedMessages[0].status, 'streaming');
    assert.equal(store.upsertedMessages[1].status, 'complete');
    assert.equal(store.upsertedMessages[1].content, 'complete-looking response');
    assert.equal(store.upsertedMessages[1].usage?.source, 'estimated');
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_error'), false);
    const streamEnd = io.roomEmits.find(event => event.event === 'ai_stream_end');
    assert.ok(streamEnd);
    assert.equal((streamEnd.args[0] as any).content, 'complete-looking response');
    assert.equal((streamEnd.args[0] as any).completedAfterPrematureClose, true);
  });

  it('preserves reported usage when a stream closes prematurely after the usage chunk', async () => {
    process.env.E2E_FAKE_AI = 'false';
    const openAIClient = {
      chat: {
        completions: {
          create: () => ({
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: 'complete-looking response' } }] };
              yield {
                choices: [],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 10,
                  total_tokens: 110,
                  prompt_cache_hit_tokens: 86,
                  prompt_cache_miss_tokens: 14,
                },
              };
              throw new Error('Premature close');
            },
          }),
        },
      },
    };
    const { io, socket, store } = createHarness({
      aiClientWrapper: { provider: 'deepseek', client: openAIClient },
    });

    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id });

    const finalMessage = store.upsertedMessages[1];
    assert.equal(finalMessage.status, 'complete');
    assert.equal(finalMessage.usage?.source, 'reported');
    assert.equal(finalMessage.usage?.cacheHitRate, 0.86);
    assert.equal(finalMessage.cost?.estimated, false);
    const streamEnd = io.roomEmits.find(event => event.event === 'ai_stream_end');
    assert.ok(streamEnd);
    assert.equal((streamEnd.args[0] as any).usage.source, 'reported');
    assert.equal((streamEnd.args[0] as any).completedAfterPrematureClose, true);
  });

  it('preserves reported usage in the outbox worker when a stream closes prematurely after the usage chunk', async () => {
    process.env.E2E_FAKE_AI = 'false';
    const openAIClient = {
      chat: {
        completions: {
          create: () => ({
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: 'worker response' } }] };
              yield {
                choices: [],
                usage: {
                  prompt_tokens: 50,
                  completion_tokens: 5,
                  total_tokens: 55,
                  prompt_cache_hit_tokens: 40,
                  prompt_cache_miss_tokens: 10,
                },
              };
              throw new Error('Premature close');
            },
          }),
        },
      },
    };
    const { io, store } = createHarness();
    store.assistantRuns.push({
      id: 'run-reported-usage',
      status: 'queued',
      metadata: { runnerMode: 'worker' },
    });

    await executeQueuedAssistantRun(
      {
        runId: 'run-reported-usage',
        roomId: 'room-1',
        requestedByClientId: 'client-1',
        aiMessageId: 'queued-ai-message',
        roleName: 'Assistant',
        systemPrompt: 'You are helpful.',
        model: selectedModel.id,
        maxContextMessages: 100,
        contextMessages: [message()],
        historyUsedForContext: [message()],
      },
      {
        io: io as any,
        store: store as any,
        socketLogger: logger as any,
        openaiLogger: logger as any,
        normalizeAIModel: () => selectedModel,
        getAIClientForModel: () => ({ provider: 'deepseek', client: openAIClient as any }),
      },
    );

    const finalMessage = store.upsertedMessages.at(-1);
    assert.equal(finalMessage?.status, 'complete');
    assert.equal(finalMessage?.usage?.source, 'reported');
    assert.equal(finalMessage?.usage?.cacheHitRate, 0.8);
    assert.equal(finalMessage?.cost?.estimated, false);
    assert.equal(store.assistantRuns[0].status, 'complete');
    assert.equal(store.assistantRuns[0].metadata.usage.source, 'reported');
    const streamEnd = io.roomEmits.find(event => event.event === 'ai_stream_end');
    assert.ok(streamEnd);
    assert.equal((streamEnd.args[0] as any).usage.source, 'reported');
    assert.equal((streamEnd.args[0] as any).completedAfterPrematureClose, true);
  });

  it('rejects AI requests from clients without room access', async () => {
    const { io, socket, store } = createHarness({ clientId: 'client-2' });
    store.members.clear();

    let response: unknown;
    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id }, (ack: unknown) => {
      response = ack;
    });

    assert.deepEqual(response, { success: false, error: 'You are not authorized to access this room' });
    assert.deepEqual(socket.emitted, [{ event: 'error', args: [{ message: 'You are not authorized to access this room' }] }]);
    assert.deepEqual(io.roomEmits, []);
  });

  it('emits an error and does not stream when the placeholder cannot be persisted', async () => {
    const { io, socket, store } = createHarness({ rejectSaves: true });

    let response: unknown;
    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id }, (ack: unknown) => {
      response = ack;
    });

    assert.equal(store.upsertedMessages.length, 1);
    assert.equal(io.roomEmits.some(event => event.event === 'new_message'), false);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_chunk'), false);
    assert.deepEqual(io.roomEmits, [{
      roomId: 'room-1',
      event: 'ai_stream_error',
      args: [{
        messageId: store.upsertedMessages[0].id,
        error: 'Sorry, unable to start a durable AI response.',
        roomId: 'room-1',
      }],
    }]);
    assert.deepEqual(response, { success: false, error: 'Unable to start a durable AI response' });
  });

  it('emits an error and marks the durable placeholder failed when final persistence fails', async () => {
    const { io, socket, store } = createHarness({ rejectSaveNumbers: [2] });

    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id });

    assert.equal(store.upsertedMessages.length, 3);
    assert.equal(store.upsertedMessages[0].status, 'streaming');
    assert.equal(store.upsertedMessages[1].status, 'complete');
    assert.equal(store.upsertedMessages[2].status, 'error');
    assert.equal(store.messages.length, 2);
    assert.equal(store.messages[1].status, 'error');
    assert.equal(store.messages[1].content, 'Sorry, unable to save the AI response.');
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_end'), false);
    const streamError = io.roomEmits.find(event => event.event === 'ai_stream_error');
    assert.ok(streamError);
    assert.deepEqual((streamError.args[0] as any).message, store.messages[1]);
  });

  it('emits a persistence error when the final-save fallback cannot mark the placeholder failed', async () => {
    const { io, socket, store } = createHarness({ rejectSaveNumbers: [2, 3, 4, 5] });

    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id });

    assert.equal(store.upsertedMessages.length, 5);
    assert.equal(store.upsertedMessages[0].status, 'streaming');
    assert.equal(store.upsertedMessages[1].status, 'complete');
    assert.equal(store.upsertedMessages.slice(2).every(message => message.status === 'error'), true);
    assert.equal(store.messages[1].status, 'streaming');
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_end'), false);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_persistence_error'), true);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_error'), true);
  });

  it('truncates retry history before upserting the replacement AI message', async () => {
    const { socket, store } = createHarness();
    const staleAI = message({
      id: 'ai-old',
      clientId: 'ai_assistant',
      content: 'old answer',
      messageType: 'ai',
      status: 'complete',
    });
    const newerUser = message({ id: 'message-after-ai', content: 'newer message' });
    store.messages = [message(), staleAI, newerUser];

    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id, retryForMessageId: 'ai-old' });

    assert.deepEqual(store.truncateBeforeCalls, [{ roomId: 'room-1', messageId: 'ai-old' }]);
    assert.equal(store.savedHistories.length, 0);
    assert.deepEqual(store.messages.map(item => item.id), ['message-1', store.upsertedMessages[1].id]);
    assert.equal(store.messages[1].status, 'complete');
  });

  it('truncates edit history through the edited message before generating', async () => {
    const { socket, store } = createHarness();
    const editedUser = message({ id: 'message-edited', content: 'edited prompt' });
    const staleAI = message({
      id: 'ai-stale',
      clientId: 'ai_assistant',
      content: 'stale answer',
      messageType: 'ai',
      status: 'complete',
    });
    store.messages = [message(), editedUser, staleAI];

    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id, editedMessageId: 'message-edited' });

    assert.deepEqual(store.truncateAfterCalls, [{ roomId: 'room-1', messageId: 'message-edited' }]);
    assert.equal(store.savedHistories.length, 0);
    assert.equal(store.messages[2].status, 'complete');
    assert.equal(store.messages[2].content, expectedE2EFakeContent('edited prompt'));
  });

  it('edits, truncates, and starts AI generation in one event', async () => {
    const { io, socket, store } = createHarness();
    const editedUser = message({ id: 'message-edited', content: 'original prompt' });
    const staleAI = message({
      id: 'ai-stale',
      clientId: 'ai_assistant',
      content: 'stale answer',
      messageType: 'ai',
      status: 'complete',
    });
    store.messages = [message(), editedUser, staleAI];

    let response: unknown;
    await socket.invoke('edit_message_and_ask_ai', {
      roomId: 'room-1',
      messageId: 'message-edited',
      newContent: 'edited prompt',
      model: selectedModel.id,
    }, (ack: unknown) => {
      response = ack;
    });

    assert.deepEqual(store.editAndTruncateCalls, [{ roomId: 'room-1', messageId: 'message-edited', newContent: 'edited prompt' }]);
    assert.equal(store.savedHistories.length, 0);
    assert.equal(store.messages.find(item => item.id === 'message-edited')?.content, 'edited prompt');
    const historyInvalidatedEvent = io.roomEmits.find(event => event.event === 'message_history_invalidated');
    assert.deepEqual(historyInvalidatedEvent?.args[0], {
      roomId: 'room-1',
      reason: 'edit-and-ask-truncated',
    });
    assert.deepEqual(store.messages.map(item => item.id), ['message-1', 'message-edited', store.upsertedMessages[0].id]);
    assert.equal(store.messages[2].status, 'complete');
    assert.equal(store.messages[2].content, expectedE2EFakeContent('edited prompt'));
    assert.deepEqual(response, { success: true, messageId: store.upsertedMessages[0].id });
  });

  it('edits, truncates, and routes code-agent edit-and-ask to the code-agent session service', async () => {
    const calls: unknown[][] = [];
    const codeAgentSessionService = {
      async startTurn(...args: unknown[]) {
        calls.push(args);
        const callback = args[1] as ((response: { success: boolean; messageId?: string }) => void) | undefined;
        callback?.({ success: true, messageId: 'code-agent-ai-edit-1' });
        return { success: true, messageId: 'code-agent-ai-edit-1' };
      },
    };
    const { io, socket, store } = createHarness({
      currentRoom: room({ type: 'codeAgent' }),
      codeAgentSessionService,
      headers: roomtalkOriginHeaders,
    });
    const editedUser = message({ id: 'message-edited', content: 'original prompt' });
    const staleTool = message({
      id: 'tool-stale',
      clientId: 'code-agent',
      content: 'stale tool result',
      messageType: 'tool_result',
    });
    store.messages = [message(), editedUser, staleTool];

    let response: unknown;
    await socket.invoke('edit_message_and_ask_ai', {
      roomId: 'room-1',
      messageId: 'message-edited',
      newContent: 'edited prompt',
      model: selectedModel.id,
      roleName: 'Assistant',
      codeAgentMode: 'acceptEdits',
    }, (ack: unknown) => {
      response = ack;
    });

    assert.deepEqual(store.editAndTruncateCalls, [{ roomId: 'room-1', messageId: 'message-edited', newContent: 'edited prompt' }]);
    assert.equal(store.upsertedMessages.length, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], {
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      maxContextMessages: undefined,
      clientOrigin: 'https://room.ruit.me',
      serverOrigin: 'https://room.ruit.me',
      promptMessage: store.messages.find(message => message.id === 'message-edited'),
      promptMessageId: 'message-edited',
    });
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0][0], 'roleName'), false);
    assert.equal(store.messages.find(item => item.id === 'message-edited')?.content, 'edited prompt');
    const historyInvalidatedEvent = io.roomEmits.find(event => event.event === 'message_history_invalidated');
    assert.deepEqual(historyInvalidatedEvent?.args[0], {
      roomId: 'room-1',
      reason: 'edit-and-ask-truncated',
    });
    assert.deepEqual(store.messages.map(item => item.id), ['message-1', 'message-edited']);
    assert.deepEqual(response, { success: true, messageId: 'code-agent-ai-edit-1' });
  });

  it('does not edit code-agent messages when the code-agent session service is unavailable', async () => {
    const { socket, store } = createHarness({ currentRoom: room({ type: 'codeAgent' }) });

    let response: unknown;
    await socket.invoke('edit_message_and_ask_ai', {
      roomId: 'room-1',
      messageId: 'message-1',
      newContent: 'edited prompt',
      model: selectedModel.id,
    }, (ack: unknown) => {
      response = ack;
    });

    assert.deepEqual(response, { success: false, error: 'Workspace is unavailable' });
    assert.deepEqual(store.editAndTruncateCalls, []);
  });

  it('saves a user message before starting AI with prepared history', async () => {
    const { io, socket, store } = createHarness();

    let response: { success: boolean; userMessage?: Message; aiMessageId?: string; aiStarted?: boolean; aiError?: string } | undefined;
    await socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'fresh prompt',
      username: 'Ada',
      avatar: { text: 'A', color: 'primary' },
      clientMessageId: 'client-message-1',
      model: selectedModel.id,
    }, (ack: { success: boolean; userMessage?: Message; aiMessageId?: string; aiStarted?: boolean; aiError?: string }) => {
      response = ack;
    });

    assert.equal(store.appendedMessages.length, 1);
    const userMessage = store.appendedMessages[0];
    assert.equal(userMessage.clientId, 'client-1');
    assert.equal(userMessage.content, 'fresh prompt');
    assert.equal(userMessage.clientMessageId, 'client-message-1');
    assert.equal(response?.userMessage, userMessage);
    assert.equal(response?.aiMessageId, store.upsertedMessages[0].id);
    assert.equal(response?.aiStarted, true);

    assert.equal(io.roomEmits.some(event => event.event === 'new_message'), false);
    assert.equal(store.upsertedMessages[1].content, expectedE2EFakeContent('fresh prompt'));
  });

  it('keeps uploaded image references on normal chat Ask AI messages', async () => {
    const imageMessage = message({
      id: 'chat-image-message-1',
      clientId: 'client-1',
      messageType: 'media',
      content: '',
      mediaAsset: { id: 'chat-image-asset-1', kind: 'image', mimeType: 'image/png', byteSize: 3 },
    });
    const { socket, store } = createHarness({ messages: [imageMessage] });

    let response: { success: boolean; userMessage?: Message } | undefined;
    await socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'inspect this image',
      clientMessageId: 'chat-image-prompt-1',
      model: selectedModel.id,
      imageMessageIds: [imageMessage.id],
    }, (ack: { success: boolean; userMessage?: Message }) => {
      response = ack;
    });

    assert.equal(response?.success, true);
    assert.deepEqual(store.appendedMessages[0].codeAgentImageMessageIds, [imageMessage.id]);
    assert.deepEqual(response?.userMessage?.codeAgentImageMessageIds, [imageMessage.id]);
  });

  it('rejects send-message-and-ask-ai before saving when posting is closed', async () => {
    const { io, socket, store } = createHarness({
      currentRoom: room({
        postingSchedule: {
          enabled: true,
          timezone: 'UTC',
          windows: [],
        },
      }),
    });

    let response: unknown;
    await socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'fresh prompt',
      model: selectedModel.id,
    }, (ack: unknown) => {
      response = ack;
    });

    assert.equal(store.appendedMessages.length, 0);
    assert.equal(store.upsertedMessages.length, 0);
    assert.equal(io.roomEmits.length, 0);
    assert.deepEqual(response, { success: false, error: 'Posting closed' });
  });

  it('saves a user message before routing code-agent ask requests to the code-agent session service', async () => {
    const calls: unknown[][] = [];
    const codeAgentSessionService = {
      async startTurn(...args: unknown[]) {
        calls.push(args);
        const callback = args[1] as ((response: { success: boolean; messageId?: string }) => void) | undefined;
        callback?.({ success: true, messageId: 'code-agent-ai-2' });
        return { success: true, messageId: 'code-agent-ai-2' };
      },
    };
    const imageMessage = message({
      id: 'image-message-1',
      clientId: 'client-1',
      messageType: 'media',
      content: '',
      mediaAsset: { id: 'asset-image-1', kind: 'image', mimeType: 'image/png', byteSize: 3 },
    });
    const { io, socket, store } = createHarness({
      currentRoom: room({ type: 'codeAgent' }),
      codeAgentSessionService,
      headers: roomtalkOriginHeaders,
      messages: [imageMessage],
    });

    let response: { success: boolean; userMessage?: Message; aiMessageId?: string; aiStarted?: boolean; aiError?: string } | undefined;
    await socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'fresh prompt',
      clientMessageId: 'client-message-1',
      model: selectedModel.id,
      roleName: 'Assistant',
      codeAgentMode: 'acceptEdits',
      imageMessageIds: [imageMessage.id],
    }, (ack: { success: boolean; userMessage?: Message; aiMessageId?: string; aiStarted?: boolean; aiError?: string }) => {
      response = ack;
    });

    assert.equal(store.appendedMessages.length, 1);
    assert.deepEqual(store.appendedMessages[0].codeAgentImageMessageIds, [imageMessage.id]);
    assert.equal(store.upsertedMessages.length, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], {
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      maxContextMessages: undefined,
      clientOrigin: 'https://room.ruit.me',
      serverOrigin: 'https://room.ruit.me',
      promptMessage: store.appendedMessages[0],
      promptMessageId: store.appendedMessages[0].id,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0][0], 'roleName'), false);
    assert.equal(response?.success, true);
    assert.equal(response?.userMessage, store.appendedMessages[0]);
    assert.equal(response?.aiMessageId, 'code-agent-ai-2');
    assert.equal(response?.aiStarted, true);
    assert.equal(io.roomEmits.some(event => event.event === 'new_message'), false);
  });

  it('rejects code-agent send-message-and-ask-ai before saving when the member cannot use code agent', async () => {
    const calls: unknown[][] = [];
    const codeAgentSessionService = {
      async startTurn(...args: unknown[]) {
        calls.push(args);
        return { success: true, messageId: 'code-agent-ai-2' };
      },
    };
    const { io, socket, store } = createHarness({
      currentRoom: room({ type: 'codeAgent', creatorId: 'owner-1' }),
      codeAgentSessionService,
    });

    let response: unknown;
    await socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'fresh prompt',
      model: selectedModel.id,
    }, (ack: unknown) => {
      response = ack;
    });

    assert.equal(store.appendedMessages.length, 0);
    assert.equal(store.upsertedMessages.length, 0);
    assert.equal(calls.length, 0);
    assert.equal(io.roomEmits.length, 0);
    assert.deepEqual(response, { success: false, error: 'You do not have access to this Workspace room' });
  });

  it('rejects code-agent ask-ai requests before starting when the member cannot use code agent', async () => {
    const calls: unknown[][] = [];
    const codeAgentSessionService = {
      async startTurn(...args: unknown[]) {
        calls.push(args);
        return { success: true, messageId: 'code-agent-ai-2' };
      },
    };
    const { socket } = createHarness({
      currentRoom: room({ type: 'codeAgent', creatorId: 'owner-1' }),
      codeAgentSessionService,
    });

    let response: unknown;
    await socket.invoke('ask_ai', {
      roomId: 'room-1',
      model: selectedModel.id,
    }, (ack: unknown) => {
      response = ack;
    });

    assert.equal(calls.length, 0);
    assert.deepEqual(response, { success: false, error: 'You do not have access to this Workspace room' });
  });

  it('acknowledges the saved user message when AI startup fails afterward', async () => {
    const { io, socket, store } = createHarness({ rejectSaveNumbers: [1] });

    let response: { success: boolean; userMessage?: Message; aiMessageId?: string; aiStarted?: boolean; aiError?: string } | undefined;
    await socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'fresh prompt',
      clientMessageId: 'client-message-1',
      model: selectedModel.id,
    }, (ack: { success: boolean; userMessage?: Message; aiMessageId?: string; aiStarted?: boolean; aiError?: string }) => {
      response = ack;
    });

    assert.equal(store.appendedMessages.length, 1);
    assert.equal(store.upsertedMessages.length, 1);
    assert.equal(response?.success, true);
    assert.equal(response?.userMessage, store.appendedMessages[0]);
    assert.equal(response?.aiStarted, false);
    assert.equal(response?.aiMessageId, undefined);
    assert.equal(response?.aiError, 'Unable to start a durable AI response');
    assert.equal(io.roomEmits.some(event => event.event === 'new_message'), false);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_error'), true);
  });

  it('does not start AI when saving the user message fails', async () => {
    const { io, socket, store } = createHarness({ rejectAppend: true });

    let response: unknown;
    await socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'fresh prompt',
      model: selectedModel.id,
    }, (ack: unknown) => {
      response = ack;
    });

    assert.equal(store.appendedMessages.length, 1);
    assert.equal(store.upsertedMessages.length, 0);
    assert.equal(io.roomEmits.length, 0);
    assert.deepEqual(response, { success: false, error: 'Failed to save message' });
  });

  it('rejects unregistered send-message-and-ask-ai requests', async () => {
    const { socket, store } = createHarness({ clientId: null });

    let response: unknown;
    await socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'fresh prompt',
    }, (ack: unknown) => {
      response = ack;
    });

    assert.equal(store.appendedMessages.length, 0);
    assert.equal(store.upsertedMessages.length, 0);
    assert.deepEqual(response, { success: false, error: 'You are not registered' });
    assert.deepEqual(socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);
  });

  it('saves reply references for send-message-and-ask-ai and rejects missing quote targets', async () => {
    const valid = createHarness();
    valid.store.messages = [message({ id: 'quoted', username: 'Ada', content: 'original prompt' })];
    let validResponse: { success: boolean; userMessage?: Message } | undefined;

    await valid.socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'reply prompt',
      replyToMessageId: 'quoted',
      model: selectedModel.id,
    }, (ack: { success: boolean; userMessage?: Message }) => {
      validResponse = ack;
    });

    assert.deepEqual(validResponse?.userMessage?.replyTo, {
      messageId: 'quoted',
      username: 'Ada',
      messageType: 'text',
      preview: 'original prompt',
    });
    assert.equal(valid.store.upsertedMessages[1].content, expectedE2EFakeContent('reply prompt'));

    const missing = createHarness();
    let missingResponse: unknown;
    await missing.socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'reply prompt',
      replyToMessageId: 'missing',
      model: selectedModel.id,
    }, (ack: unknown) => {
      missingResponse = ack;
    });

    assert.equal(missing.store.appendedMessages.length, 0);
    assert.equal(missing.store.upsertedMessages.length, 0);
    assert.deepEqual(missingResponse, { success: false, error: 'Quoted message not found' });
  });

  const a2uiOwningMessage = (overrides: Partial<Message> = {}) => message({
    id: 'ai-msg-1',
    content: 'previous answer',
    uiPayload: {
      format: 'a2ui',
      version: 'v0.9',
      messages: [
        { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json' } },
      ],
    },
    ...overrides,
  });

  it('starts a new AI turn when a wired A2UI action (context.followUp) is clicked', async () => {
    const { io, socket, store } = createHarness({ messages: [message(), a2uiOwningMessage()] });

    await socket.invoke('a2ui_action', {
      roomId: 'room-1',
      messageId: 'ai-msg-1',
      action: {
        name: 'submit_choice',
        surfaceId: 's',
        sourceComponentId: 'cta',
        timestamp: '2026-05-03T00:01:00.000Z',
        context: { followUp: true, roomId: 'room-1', messageId: 'ai-msg-1', dataModel: { selectedNextStep: ['export'] } },
      },
    });

    const followUp = store.appendedMessages.find(item => /interacted with the streamed A2UI surface/.test(item.content));
    assert.ok(followUp, 'expected a follow-up user message to be appended');
    assert.match(followUp!.content, /selectedNextStep/);
    assert.doesNotMatch(followUp!.content, /followUp/);
    assert.equal(io.roomEmits.some(event => event.event === 'new_message'), false);
    assert.ok(io.roomEmits.some(event => event.event === 'ai_stream_end'), 'expected a new AI turn to complete');
  });

  it('does not route code-agent room A2UI follow-up actions to ordinary chat AI', async () => {
    const { io, socket, store } = createHarness({
      currentRoom: room({ type: 'codeAgent' }),
      messages: [message(), a2uiOwningMessage()],
    });

    await socket.invoke('a2ui_action', {
      roomId: 'room-1',
      messageId: 'ai-msg-1',
      roleName: 'Assistant',
      action: {
        name: 'submit_choice',
        surfaceId: 's',
        sourceComponentId: 'cta',
        timestamp: '2026-05-03T00:01:00.000Z',
        context: { followUp: true, dataModel: { selectedNextStep: ['export'] } },
      },
    });

    assert.equal(store.appendedMessages.length, 0);
    assert.equal(store.upsertedMessages.length, 0);
    assert.equal(store.assistantRuns.length, 0);
    assert.ok(!io.roomEmits.some(event => event.event === 'ai_stream_end'));
  });

  it('uses client-provided role, model, and context settings for A2UI follow-up turns', async () => {
    process.env.E2E_FAKE_AI = 'false';
    const createCalls: any[] = [];
    const openAIClient = {
      chat: {
        completions: {
          create: (request: any) => {
            createCalls.push(request);
            return asyncIterable([
              { choices: [{ delta: { content: 'follow-up response' } }] },
              { choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
            ]);
          },
        },
      },
    };
    const olderMessage = message({ id: 'old-msg', content: 'old context' });
    const owningMessage = a2uiOwningMessage({ id: 'ai-msg-1', content: 'previous A2UI answer' });
    const { socket, store } = createHarness({
      messages: [olderMessage, owningMessage],
      aiClientWrapper: { provider: 'deepseek', client: openAIClient },
    });

    await socket.invoke('a2ui_action', {
      roomId: 'room-1',
      messageId: 'ai-msg-1',
      systemPrompt: 'Use the selected room role.',
      roleName: 'A2UI Demo',
      model: selectedModel.id,
      maxContextMessages: 1,
      action: {
        name: 'submit_choice',
        surfaceId: 's',
        sourceComponentId: 'cta',
        timestamp: '2026-05-03T00:01:00.000Z',
        context: { followUp: true, dataModel: { selectedNextStep: ['export'] } },
      },
    });

    assert.deepEqual(store.normalizeAIModelCalls.at(-1), selectedModel.id);
    const providerMessages = createCalls[0].messages as Array<{ role: string; content: string }>;
    assert.match(String(providerMessages[0].content), /Use the selected room role/);
    const userMessages = providerMessages.filter(item => item.role === 'user');
    assert.equal(userMessages.length, 1);
    assert.match(String(userMessages[0].content), /submit_choice/);
    assert.doesNotMatch(String(userMessages[0].content), /old context/);
    assert.doesNotMatch(String(userMessages[0].content), /previous A2UI answer/);
    assert.equal(store.upsertedMessages.at(-1)?.username, 'A2UI Demo');
  });

  it('ignores A2UI actions that are not wired for follow-up', async () => {
    const { io, socket, store } = createHarness({ messages: [message(), a2uiOwningMessage()] });

    await socket.invoke('a2ui_action', {
      roomId: 'room-1',
      messageId: 'ai-msg-1',
      action: {
        name: 'cosmetic',
        surfaceId: 's',
        sourceComponentId: 'cta',
        timestamp: '2026-05-03T00:01:00.000Z',
        context: { other: 1 },
      },
    });

    assert.equal(store.appendedMessages.length, 0);
    assert.ok(!io.roomEmits.some(event => event.event === 'ai_stream_end'));
  });

  it('ignores follow-up actions when the owning message has no A2UI payload', async () => {
    const { socket, store } = createHarness({ messages: [message({ id: 'plain-msg' })] });

    await socket.invoke('a2ui_action', {
      roomId: 'room-1',
      messageId: 'plain-msg',
      action: {
        name: 'submit_choice',
        surfaceId: 's',
        sourceComponentId: 'cta',
        timestamp: '2026-05-03T00:01:00.000Z',
        context: { followUp: true },
      },
    });

    assert.equal(store.appendedMessages.length, 0);
  });
});
