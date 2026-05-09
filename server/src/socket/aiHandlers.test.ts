import assert from 'assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { registerAIHandlers } from './aiHandlers';
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

const createHarness = (options: { rejectSaves?: boolean; rejectSaveNumbers?: number[] } = {}) => {
  const socket = new FakeSocket();
  const io = new FakeIo();
  const store = {
    messages: [message()],
    upsertedMessages: [] as Message[],
    savedHistories: [] as Message[][],
    async getClientId() {
      return 'client-1';
    },
    async readMessagesByRoom(roomId: string) {
      return this.messages.filter(item => item.roomId === roomId);
    },
    async saveMessageHistory(_roomId: string, messages: Message[]) {
      this.savedHistories.push(messages);
      this.messages = messages;
      return room({ lastActivityAt: messages[messages.length - 1]?.timestamp || room().createdAt });
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
  };

  registerAIHandlers({
    io: io as any,
    socket: socket as any,
    store: store as any,
    socketLogger: logger as any,
    openaiLogger: logger as any,
    normalizeAIModel: () => selectedModel,
    getAIClientForModel: () => {
      throw new Error('E2E fake AI should not request a real client');
    },
  });

  return { io, socket, store };
};

describe('AI socket handlers', () => {
  const previousEnv = {
    e2eMode: process.env.E2E_TEST_MODE,
    fakeAI: process.env.E2E_FAKE_AI,
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
  });

  it('persists a streaming placeholder before completing an AI response', async () => {
    const { io, socket, store } = createHarness();

    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id });

    assert.equal(store.upsertedMessages.length, 2);
    const streamingMessage = store.upsertedMessages[0];
    assert.equal(streamingMessage.clientId, 'ai_assistant');
    assert.equal(streamingMessage.status, 'streaming');
    assert.equal(streamingMessage.content, '');

    const finalMessage = store.upsertedMessages[1];
    assert.equal(finalMessage.id, streamingMessage.id);
    assert.equal(finalMessage.status, 'complete');
    assert.equal(finalMessage.content, 'E2E AI response to: hello');
    assert.equal(finalMessage.usage?.cacheHitRate, 0.25);
    assert.deepEqual(store.messages.map(item => item.id), ['message-1', streamingMessage.id]);
    assert.equal(store.messages[1].status, 'complete');

    assert.equal(io.roomEmits.some(event => event.event === 'new_message'), true);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_end'), true);
    const aiChunkEvents = io.roomEmits.filter(event => event.event === 'ai_chunk');
    assert.deepEqual(aiChunkEvents.map(event => (event.args[0] as { chunk: string }).chunk), [
      'E2E AI response ',
      'to: hello',
    ]);
  });

  it('emits an error and does not stream when the placeholder cannot be persisted', async () => {
    const { io, socket, store } = createHarness({ rejectSaves: true });

    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id });

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
    assert.equal(store.messages[1].content, 'Error saving response.');
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_end'), false);
    assert.equal(io.roomEmits.some(event => event.event === 'ai_stream_error'), true);
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

    assert.equal(store.savedHistories.length, 1);
    assert.deepEqual(store.savedHistories[0].map(item => item.id), ['message-1']);
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

    assert.equal(store.savedHistories.length, 1);
    assert.deepEqual(store.savedHistories[0].map(item => item.id), ['message-1', 'message-edited']);
    assert.equal(store.messages[2].status, 'complete');
    assert.equal(store.messages[2].content, 'E2E AI response to: edited prompt');
  });
});
