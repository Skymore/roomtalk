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

const roomActivityForMessages = (messages: Message[]) => room({
  lastActivityAt: messages[messages.length - 1]?.timestamp || room().createdAt,
});

const createHarness = (options: { rejectSaves?: boolean; rejectSaveNumbers?: number[]; rejectAppend?: boolean; clientId?: string | null } = {}) => {
  const socket = new FakeSocket();
  const io = new FakeIo();
  const store = {
    rooms: [room()],
    members: new Set(['room-1:client-1']),
    messages: [message()],
    appendedMessages: [] as Message[],
    upsertedMessages: [] as Message[],
    savedHistories: [] as Message[][],
    truncateBeforeCalls: [] as Array<{ roomId: string; messageId: string }>,
    truncateAfterCalls: [] as Array<{ roomId: string; messageId: string }>,
    editAndTruncateCalls: [] as Array<{ roomId: string; messageId: string; newContent: string }>,
    async getClientId() {
      return options.clientId === undefined ? 'client-1' : options.clientId;
    },
    async readMessagesByRoom(roomId: string) {
      return this.messages.filter(item => item.roomId === roomId);
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
    async updateMessageAndTruncateAfter(roomId: string, messageId: string, newContent: string) {
      this.editAndTruncateCalls.push({ roomId, messageId, newContent });
      const roomMessages = this.messages.filter(item => item.roomId === roomId);
      const targetIndex = roomMessages.findIndex(item => item.id === messageId);
      if (targetIndex === -1) {
        return { room: roomActivityForMessages(roomMessages), messages: roomMessages, targetFound: false };
      }

      const updatedMessage = {
        ...roomMessages[targetIndex],
        content: newContent,
        timestamp: '2026-05-03T00:00:10.000Z',
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
    imageObjectStorage: {
      isConfigured: () => true,
      putImageObject: async () => {},
      createReadUrl: async () => ({ url: 'https://signed.example/image.webp', expiresAt: '2026-05-03T00:15:00.000Z' }),
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

    let response: unknown;
    await socket.invoke('ask_ai', { roomId: 'room-1', model: selectedModel.id }, (ack: unknown) => {
      response = ack;
    });

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
    assert.deepEqual(response, { success: true, messageId: streamingMessage.id });
    const aiChunkEvents = io.roomEmits.filter(event => event.event === 'ai_chunk');
    assert.deepEqual(aiChunkEvents.map(event => (event.args[0] as { chunk: string }).chunk), [
      'E2E AI response ',
      'to: hello',
    ]);
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
    assert.equal(store.messages[2].content, 'E2E AI response to: edited prompt');
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
    const editedEvent = io.roomEmits.find(event => event.event === 'message_edited');
    assert.equal((editedEvent?.args[0] as Message).content, 'edited prompt');
    const historyEvent = io.roomEmits.find(event => event.event === 'message_history');
    assert.deepEqual((historyEvent?.args[0] as Message[]).map(item => item.id), ['message-1', 'message-edited']);
    assert.equal(store.messages[2].status, 'complete');
    assert.equal(store.messages[2].content, 'E2E AI response to: edited prompt');
    assert.deepEqual(response, { success: true, messageId: store.upsertedMessages[0].id });
  });

  it('saves a user message before starting AI with prepared history', async () => {
    const { io, socket, store } = createHarness();

    let response: { success: boolean; userMessage?: Message; aiMessageId?: string } | undefined;
    await socket.invoke('send_message_and_ask_ai', {
      roomId: 'room-1',
      content: 'fresh prompt',
      username: 'Ada',
      avatar: { text: 'A', color: 'primary' },
      clientMessageId: 'client-message-1',
      model: selectedModel.id,
    }, (ack: { success: boolean; userMessage?: Message; aiMessageId?: string }) => {
      response = ack;
    });

    assert.equal(store.appendedMessages.length, 1);
    const userMessage = store.appendedMessages[0];
    assert.equal(userMessage.clientId, 'client-1');
    assert.equal(userMessage.content, 'fresh prompt');
    assert.equal(userMessage.clientMessageId, 'client-message-1');
    assert.equal(response?.userMessage, userMessage);
    assert.equal(response?.aiMessageId, store.upsertedMessages[0].id);

    const userMessageEventIndex = io.roomEmits.findIndex(event =>
      event.event === 'new_message' && (event.args[0] as Message).id === userMessage.id
    );
    const aiPlaceholderEventIndex = io.roomEmits.findIndex(event =>
      event.event === 'new_message' && (event.args[0] as Message).clientId === 'ai_assistant'
    );
    assert.ok(userMessageEventIndex !== -1);
    assert.ok(aiPlaceholderEventIndex !== -1);
    assert.ok(userMessageEventIndex < aiPlaceholderEventIndex);
    assert.equal(store.upsertedMessages[1].content, 'E2E AI response to: fresh prompt');
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
    assert.equal(valid.store.upsertedMessages[1].content, 'E2E AI response to: reply prompt');

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
});
