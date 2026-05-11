import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { registerMessageHandlers } from './messageHandlers';
import { Message, Room, RoomAICostTotal } from '../types';

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
  formatMessageForLog(message: unknown) {
    return message;
  },
};

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'message-1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T00:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  ...overrides,
});

const roomCost = (roomId = 'room-1'): RoomAICostTotal => ({
  roomId,
  currency: 'USD',
  totalUsd: 0.5,
});

const roomActivityForMessages = (messages: Message[]) => room({
  lastActivityAt: messages[messages.length - 1]?.timestamp || '2026-05-03T00:00:00.000Z',
});

const createHarness = (clientId: string | null = 'client-1') => {
  const socket = new FakeSocket();
  const io = new FakeIo();
  const store = {
    clientId,
    messages: [message()],
    savedHistory: [] as Message[][],
    appendedMessages: [] as Message[],
    editedMessages: [] as Array<{ roomId: string; messageId: string; newContent: string }>,
    deletedMessages: [] as Array<{ roomId: string; messageId: string }>,
    clearedRooms: [] as string[],
    async getClientId() {
      return this.clientId;
    },
    async readMessagesByRoom(roomId: string) {
      return this.messages.filter(item => item.roomId === roomId);
    },
    async readRoomAICost(roomId: string) {
      return roomCost(roomId);
    },
    async appendMessage(newMessage: Message) {
      this.appendedMessages.push(newMessage);
      this.messages.push(newMessage);
      return room({ lastActivityAt: newMessage.timestamp });
    },
    async saveMessageHistory(_roomId: string, messages: Message[]) {
      this.savedHistory.push(messages);
      this.messages = messages;
      return roomActivityForMessages(messages);
    },
    async updateMessageContent(roomId: string, messageId: string, newContent: string) {
      this.editedMessages.push({ roomId, messageId, newContent });
      const messageIndex = this.messages.findIndex(item => item.roomId === roomId && item.id === messageId);
      if (messageIndex === -1) {
        return { room: roomActivityForMessages(this.messages), found: false };
      }

      const updatedMessage = {
        ...this.messages[messageIndex],
        content: newContent,
        timestamp: '2026-05-03T00:00:10.000Z',
      };
      this.messages = this.messages.map(item => item.id === messageId ? updatedMessage : item);
      return { room: roomActivityForMessages(this.messages), found: true, updatedMessage };
    },
    async deleteMessageById(roomId: string, messageId: string) {
      this.deletedMessages.push({ roomId, messageId });
      const found = this.messages.some(item => item.roomId === roomId && item.id === messageId);
      if (!found) {
        return { room: roomActivityForMessages(this.messages), deleted: false };
      }

      this.messages = this.messages.filter(item => !(item.roomId === roomId && item.id === messageId));
      return { room: roomActivityForMessages(this.messages), deleted: true };
    },
    async clearRoomMessages(roomId: string) {
      this.clearedRooms.push(roomId);
      this.messages = this.messages.filter(item => item.roomId !== roomId);
      return 1;
    },
  };

  registerMessageHandlers({
    io: io as any,
    socket: socket as any,
    store: store as any,
    socketLogger: logger as any,
  } as any);

  return { io, socket, store };
};

describe('message socket handlers', () => {
  it('returns message history and AI cost totals for a room', async () => {
    const { socket } = createHarness();

    await socket.invoke('get_room_messages', 'room-1');

    assert.deepEqual(socket.emitted, [
      { event: 'message_history', args: [[message()]] },
      { event: 'ai_cost_total', args: [roomCost()] },
    ]);
  });

  it('rejects unregistered or invalid sends and broadcasts valid messages', async () => {
    const unregistered = createHarness(null);
    let unregisteredResponse: unknown;
    await unregistered.socket.invoke('send_message', { roomId: 'room-1', content: 'hello' }, (response: unknown) => {
      unregisteredResponse = response;
    });
    assert.deepEqual(unregistered.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);
    assert.deepEqual(unregisteredResponse, { success: false, error: 'You are not registered' });

    const invalid = createHarness();
    let invalidResponse: unknown;
    await invalid.socket.invoke('send_message', { content: 'hello' }, (response: unknown) => {
      invalidResponse = response;
    });
    assert.deepEqual(invalid.socket.emitted, [{ event: 'error', args: [{ message: 'Room ID is required' }] }]);
    assert.deepEqual(invalidResponse, { success: false, error: 'Room ID is required' });

    const valid = createHarness('client-2');
    let validResponse: { success: boolean; message?: Message } | undefined;
    await valid.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'created through socket',
      username: 'Ada',
      avatar: { text: 'A', color: 'primary' },
    }, (response: { success: boolean; message?: Message }) => {
      validResponse = response;
    });

    assert.equal(valid.store.appendedMessages.length, 1);
    const created = valid.store.appendedMessages[0];
    assert.equal(created.clientId, 'client-2');
    assert.equal(created.roomId, 'room-1');
    assert.equal(created.content, 'created through socket');
    assert.equal(created.messageType, 'text');
    assert.deepEqual(valid.io.roomEmits, [
      { roomId: 'client-1', event: 'room_updated', args: [room({ lastActivityAt: created.timestamp })] },
      { roomId: 'room-1', event: 'new_message', args: [created] },
    ]);
    assert.deepEqual(validResponse, { success: true, message: created });
  });

  it('does not broadcast WebSocket messages when persistence fails', async () => {
    const failing = createHarness('client-2');
    failing.store.appendMessage = async (newMessage: Message) => {
      failing.store.appendedMessages.push(newMessage);
      return null as any;
    };

    let failureResponse: unknown;
    await failing.socket.invoke('send_message', { roomId: 'room-1', content: 'unsaved' }, (response: unknown) => {
      failureResponse = response;
    });

    assert.equal(failing.store.appendedMessages.length, 1);
    assert.deepEqual(failing.io.roomEmits, []);
    assert.deepEqual(failing.socket.emitted, [{ event: 'error', args: [{ message: 'Failed to save message' }] }]);
    assert.deepEqual(failureResponse, { success: false, error: 'Failed to save message' });
  });

  it('edits messages with callbacks and broadcasts successful updates', async () => {
    const unregistered = createHarness(null);
    let unregisteredResponse: unknown;
    await unregistered.socket.invoke('edit_message', { roomId: 'room-1', messageId: 'message-1', newContent: 'new' }, (response: unknown) => {
      unregisteredResponse = response;
    });
    assert.deepEqual(unregisteredResponse, { success: false, error: 'Not registered' });

    const missing = createHarness();
    let missingResponse: unknown;
    await missing.socket.invoke('edit_message', { roomId: 'room-1', messageId: 'missing', newContent: 'new' }, (response: unknown) => {
      missingResponse = response;
    });
    assert.deepEqual(missingResponse, { success: false, error: 'Message not found' });

    const valid = createHarness();
    let response: { success: boolean; updatedMessage?: Message } | undefined;
    await valid.socket.invoke('edit_message', { roomId: 'room-1', messageId: 'message-1', newContent: 'edited' }, (result: typeof response) => {
      response = result;
    });

    assert.equal(response?.success, true);
    assert.equal(response?.updatedMessage?.content, 'edited');
    assert.deepEqual(valid.store.editedMessages, [{ roomId: 'room-1', messageId: 'message-1', newContent: 'edited' }]);
    assert.equal(valid.store.savedHistory.length, 0);
    assert.deepEqual(valid.io.roomEmits, [
      { roomId: 'client-1', event: 'room_updated', args: [roomActivityForMessages(valid.store.messages)] },
      { roomId: 'room-1', event: 'message_edited', args: [response!.updatedMessage] },
    ]);
  });

  it('does not broadcast edited messages when message mutation fails', async () => {
    const failing = createHarness();
    failing.store.updateMessageContent = async (roomId: string, messageId: string, newContent: string) => {
      failing.store.editedMessages.push({ roomId, messageId, newContent });
      return null as any;
    };

    let response: unknown;
    await failing.socket.invoke('edit_message', { roomId: 'room-1', messageId: 'message-1', newContent: 'edited' }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, { success: false, error: 'Failed to save edited message' });
    assert.equal(failing.store.editedMessages.length, 1);
    assert.equal(failing.store.savedHistory.length, 0);
    assert.deepEqual(failing.io.roomEmits, []);
  });

  it('deletes messages idempotently and broadcasts only real deletions', async () => {
    const unregistered = createHarness(null);
    let unregisteredResponse: unknown;
    await unregistered.socket.invoke('delete_message', { roomId: 'room-1', messageId: 'message-1' }, (response: unknown) => {
      unregisteredResponse = response;
    });
    assert.deepEqual(unregisteredResponse, { success: false, error: 'Not registered' });

    const missing = createHarness();
    let missingResponse: unknown;
    await missing.socket.invoke('delete_message', { roomId: 'room-1', messageId: 'missing' }, (response: unknown) => {
      missingResponse = response;
    });
    assert.deepEqual(missingResponse, { success: true });
    assert.deepEqual(missing.io.roomEmits, []);

    const valid = createHarness();
    let response: unknown;
    await valid.socket.invoke('delete_message', { roomId: 'room-1', messageId: 'message-1' }, (result: unknown) => {
      response = result;
    });
    assert.deepEqual(response, { success: true });
    assert.deepEqual(valid.store.deletedMessages, [{ roomId: 'room-1', messageId: 'message-1' }]);
    assert.equal(valid.store.savedHistory.length, 0);
    assert.deepEqual(valid.io.roomEmits, [
      { roomId: 'client-1', event: 'room_updated', args: [roomActivityForMessages(valid.store.messages)] },
      { roomId: 'room-1', event: 'message_deleted', args: ['message-1', 'room-1'] },
    ]);
  });

  it('does not broadcast deleted messages when message mutation fails', async () => {
    const failing = createHarness();
    failing.store.deleteMessageById = async (roomId: string, messageId: string) => {
      failing.store.deletedMessages.push({ roomId, messageId });
      return null as any;
    };

    let response: unknown;
    await failing.socket.invoke('delete_message', { roomId: 'room-1', messageId: 'message-1' }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, { success: false, error: 'Failed to delete message' });
    assert.equal(failing.store.deletedMessages.length, 1);
    assert.equal(failing.store.savedHistory.length, 0);
    assert.deepEqual(failing.io.roomEmits, []);
  });

  it('clears room messages and emits reset events for registered clients', async () => {
    const unregistered = createHarness(null);
    await unregistered.socket.invoke('clear_room_messages', 'room-1');
    assert.deepEqual(unregistered.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);

    const missingRoom = createHarness();
    await missingRoom.socket.invoke('clear_room_messages', '');
    assert.deepEqual(missingRoom.socket.emitted, [{ event: 'error', args: [{ message: 'Room ID is required' }] }]);

    const valid = createHarness();
    await valid.socket.invoke('clear_room_messages', 'room-1');

    assert.deepEqual(valid.store.clearedRooms, ['room-1']);
    assert.deepEqual(valid.io.roomEmits, [
      { roomId: 'room-1', event: 'messages_cleared', args: ['room-1'] },
      { roomId: 'room-1', event: 'ai_cost_total', args: [roomCost()] },
    ]);
  });

  it('does not broadcast clear events when clearing persistence throws', async () => {
    const failing = createHarness();
    failing.store.clearRoomMessages = async (roomId: string) => {
      failing.store.clearedRooms.push(roomId);
      throw new Error('clear failed');
    };

    await failing.socket.invoke('clear_room_messages', 'room-1');

    assert.deepEqual(failing.store.clearedRooms, ['room-1']);
    assert.deepEqual(failing.io.roomEmits, []);
    assert.deepEqual(failing.socket.emitted, [{ event: 'error', args: [{ message: 'Failed to clear room messages' }] }]);
  });
});
