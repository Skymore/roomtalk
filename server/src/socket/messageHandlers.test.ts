import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { registerMessageHandlers } from './messageHandlers';
import { Message, RoomAICostTotal } from '../types';

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

const roomCost = (roomId = 'room-1'): RoomAICostTotal => ({
  roomId,
  currency: 'USD',
  totalUsd: 0.5,
});

const createHarness = (clientId: string | null = 'client-1') => {
  const socket = new FakeSocket();
  const io = new FakeIo();
  const store = {
    clientId,
    messages: [message()],
    savedHistory: [] as Message[][],
    appendedMessages: [] as Message[],
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
    },
    async saveMessageHistory(_roomId: string, messages: Message[]) {
      this.savedHistory.push(messages);
      this.messages = messages;
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
    await unregistered.socket.invoke('send_message', { roomId: 'room-1', content: 'hello' });
    assert.deepEqual(unregistered.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);

    const invalid = createHarness();
    await invalid.socket.invoke('send_message', { content: 'hello' });
    assert.deepEqual(invalid.socket.emitted, [{ event: 'error', args: [{ message: 'Room ID is required' }] }]);

    const valid = createHarness('client-2');
    await valid.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'created through socket',
      username: 'Ada',
      avatar: { text: 'A', color: 'primary' },
    });

    assert.equal(valid.store.appendedMessages.length, 1);
    const created = valid.store.appendedMessages[0];
    assert.equal(created.clientId, 'client-2');
    assert.equal(created.roomId, 'room-1');
    assert.equal(created.content, 'created through socket');
    assert.equal(created.messageType, 'text');
    assert.deepEqual(valid.io.roomEmits, [{ roomId: 'room-1', event: 'new_message', args: [created] }]);
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
    assert.equal(valid.store.savedHistory[0][0].content, 'edited');
    assert.deepEqual(valid.io.roomEmits, [{ roomId: 'room-1', event: 'message_edited', args: [response!.updatedMessage] }]);
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
    assert.deepEqual(valid.store.savedHistory[0], []);
    assert.deepEqual(valid.io.roomEmits, [{ roomId: 'room-1', event: 'message_deleted', args: ['message-1', 'room-1'] }]);
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
});
