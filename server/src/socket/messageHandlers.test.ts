import assert from 'assert/strict';
import { describe, it, before } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerMessageHandlers } from './messageHandlers';
import { loadStickerCatalog } from '../stickers/catalog';
import { Message, Room, RoomAICostTotal } from '../types';
import { RoomEventCursorAheadError, RoomEventCursorExpiredError } from '../repositories/store';

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
    rooms: [room()],
    members: new Set(['room-1:client-1', 'room-1:client-2']),
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
    async readRoomSnapshot(roomId: string, options: { limit?: number; beforeMessageId?: string } = {}) {
      const page = await this.readMessagePageByRoom(roomId, options);
      return {
        roomId,
        room: this.rooms.find(item => item.id === roomId) || room({ id: roomId }),
        messages: page.messages,
        snapshotSeq: 4,
        hasMore: page.hasMore,
        oldestMessageId: page.oldestMessageId,
      };
    },
    async readRoomEvents(roomId: string, options: { afterSeq: number }) {
      return {
        roomId,
        events: [{
          id: `${roomId}:${options.afterSeq + 1}`,
          roomId,
          seq: options.afterSeq + 1,
          type: 'messages.upserted' as const,
          payload: { messageIds: [this.messages[0].id], messages: [this.messages[0]] },
          createdAt: '2026-05-03T00:00:00.000Z',
        }],
        headSeq: options.afterSeq + 1,
        minAvailableSeq: 1,
        hasMore: false,
      };
    },
    async readRoomAICost(roomId: string) {
      return roomCost(roomId);
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
        .map(key => ({
          roomId,
          clientId: key.split(':')[1],
          role: 'member' as const,
          joinedAt: '2026-05-03T00:00:00.000Z',
        }));
    },
    async getRoomById(roomId: string) {
      return this.rooms.find(item => item.id === roomId) || null;
    },
    async appendMessage(newMessage: Message) {
      this.appendedMessages.push(newMessage);
      this.messages.push(newMessage);
      return room({ lastActivityAt: newMessage.timestamp });
    },
    async appendMessageIdempotent(newMessage: Message) {
      const existing = newMessage.clientMessageId
        ? this.messages.find(item => (
            item.roomId === newMessage.roomId
            && item.clientId === newMessage.clientId
            && item.clientMessageId === newMessage.clientMessageId
          ))
        : undefined;
      if (existing) {
        return { room: roomActivityForMessages(this.messages), message: existing, inserted: false };
      }
      this.appendedMessages.push(newMessage);
      this.messages.push(newMessage);
      return { room: room({ lastActivityAt: newMessage.timestamp }), message: newMessage, inserted: true };
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
        updatedAt: '2026-05-03T00:00:10.000Z',
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
  it('rejects the retired message-version protocol with an explicit upgrade code', async () => {
    const { socket } = createHarness();
    let response: unknown;

    await socket.invoke('get_room_messages', {
      requestId: 'history-1',
      roomId: 'room-1',
      baseMessageVersion: 7,
    }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, {
      success: false,
      code: 'UPGRADE_REQUIRED',
      error: 'This client uses the retired message-version sync protocol. Reload to upgrade.',
    });
    assert.deepEqual(socket.emitted, []);
  });

  it('returns a room snapshot and AI cost totals for a room', async () => {
    const { socket } = createHarness();
    let response: unknown;

    await socket.invoke('get_room_snapshot', {
      requestId: 'snapshot-1',
      roomId: 'room-1',
    }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, {
      success: true,
      snapshot: {
        requestId: 'snapshot-1',
        roomId: 'room-1',
        room: room(),
        messages: [message()],
        snapshotSeq: 4,
        hasMore: false,
        oldestMessageId: 'message-1',
        mode: 'replace',
      },
    });
    assert.deepEqual(socket.emitted, [{ event: 'ai_cost_total', args: [roomCost()] }]);
  });

  it('returns slim asset-backed media history without exposing object storage keys', async () => {
    const { socket, store } = createHarness();
    store.messages = [
      message({
        id: 'image-message',
        content: '',
        messageType: 'media',
        mimeType: 'image/webp',
        mediaAsset: {
          id: 'asset-1',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 123,
          width: 10,
          height: 20,
        },
      }),
    ];

    let response: { success?: boolean; snapshot?: { messages: Message[] } } | undefined;
    await socket.invoke('get_room_snapshot', {
      requestId: 'snapshot-media',
      roomId: 'room-1',
    }, (result: typeof response) => {
      response = result;
    });

    assert.equal(response?.success, true);
    const history = response?.snapshot?.messages || [];
    assert.deepEqual(history, [store.messages[0]]);
    assert.equal(history[0].content, '');
    assert.equal('objectKey' in history[0].mediaAsset!, false);
    assert.equal(JSON.stringify(history).includes('data:image'), false);
  });

  it('rejects room history requests from non-members', async () => {
    const { socket, store } = createHarness('client-3');
    store.members.clear();
    let response: unknown;

    await socket.invoke('get_room_snapshot', {
      requestId: 'snapshot-denied',
      roomId: 'room-1',
    }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(socket.emitted, [{ event: 'error', args: [{ message: 'You are not authorized to access this room' }] }]);
    assert.deepEqual(response, {
      success: false,
      code: 'ROOM_ACCESS_DENIED',
      error: 'You are not authorized to access this room',
    });
  });

  it('rejects malformed room snapshot requests before reading room state', async () => {
    const { socket } = createHarness();
    let response: unknown;

    await socket.invoke('get_room_snapshot', {
      roomId: 'room-1',
    }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, {
      success: false,
      code: 'INVALID_SNAPSHOT_REQUEST',
      error: 'Invalid room snapshot request',
    });
    assert.deepEqual(socket.emitted, []);
  });

  it('returns a coded error when room snapshot persistence fails', async () => {
    const { socket, store } = createHarness();
    store.readRoomSnapshot = async () => {
      throw new Error('database unavailable');
    };
    let response: unknown;

    await socket.invoke('get_room_snapshot', {
      requestId: 'snapshot-failed',
      roomId: 'room-1',
    }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, {
      success: false,
      code: 'SNAPSHOT_READ_FAILED',
      error: 'Failed to load room snapshot',
    });
    assert.deepEqual(socket.emitted, []);
  });

  it('returns ordered room events after a cursor', async () => {
    const { socket } = createHarness();
    let response: any;

    await socket.invoke('get_room_events', {
      requestId: 'events-1',
      roomId: 'room-1',
      afterSeq: 4,
      limit: 100,
      maxBytes: 256 * 1024,
    }, (result: unknown) => {
      response = result;
    });

    assert.equal(response.success, true);
    assert.equal(response.events.requestId, 'events-1');
    assert.equal(response.events.events[0].seq, 5);
    assert.equal(response.events.events[0].payload.messages[0].id, 'message-1');
  });

  it('returns CURSOR_EXPIRED when the retained event prefix passed the cursor', async () => {
    const { socket, store } = createHarness();
    store.readRoomEvents = async (roomId: string, options: { afterSeq: number }) => {
      throw new RoomEventCursorExpiredError(roomId, options.afterSeq, 10);
    };
    let response: unknown;

    await socket.invoke('get_room_events', {
      requestId: 'events-expired',
      roomId: 'room-1',
      afterSeq: 2,
    }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, {
      success: false,
      code: 'CURSOR_EXPIRED',
      error: 'The retained room event window no longer contains this cursor',
      minAvailableSeq: 10,
    });
  });

  it('returns CURSOR_AHEAD when a restored database has an older stream head', async () => {
    const { socket, store } = createHarness();
    store.readRoomEvents = async (roomId: string, options: { afterSeq: number }) => {
      throw new RoomEventCursorAheadError(roomId, options.afterSeq, 3);
    };
    let response: unknown;

    await socket.invoke('get_room_events', {
      requestId: 'events-ahead',
      roomId: 'room-1',
      afterSeq: 9,
    }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, {
      success: false,
      code: 'CURSOR_AHEAD',
      error: 'The room event cursor is ahead of the current stream and must be reset',
    });
  });

  it('rejects invalid sends and leaves durable fan-out to room_events after a valid write', async () => {
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

    const mediaSend = createHarness('client-2');
    let mediaResponse: unknown;
    await mediaSend.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'data:image/png;base64,AAAA',
      messageType: 'media',
    }, (response: unknown) => {
      mediaResponse = response;
    });
    assert.deepEqual(mediaResponse, { success: false, error: 'Media messages must use the media upload API' });
    assert.equal(mediaSend.store.appendedMessages.length, 0);

    const valid = createHarness('client-2');
    let validResponse: { success: boolean; message?: Message } | undefined;
    await valid.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'created through socket',
      username: 'Ada',
      avatar: { text: 'A', color: 'primary' },
      clientMessageId: 'client-message-1',
      clientBatchId: 'mixed-batch',
      clientBatchIndex: 1,
    }, (response: { success: boolean; message?: Message }) => {
      validResponse = response;
    });

    assert.equal(valid.store.appendedMessages.length, 1);
    const created = valid.store.appendedMessages[0];
    assert.equal(created.clientId, 'client-2');
    assert.equal(created.roomId, 'room-1');
    assert.equal(created.content, 'created through socket');
    assert.equal(created.messageType, 'text');
    assert.equal(created.clientMessageId, 'client-message-1');
    assert.equal(created.clientBatchId, 'mixed-batch');
    assert.equal(created.clientBatchIndex, 1);
    assert.deepEqual(valid.io.roomEmits, [
      { roomId: 'client-1', event: 'room_updated', args: [room({ lastActivityAt: created.timestamp })] },
    ]);
    assert.deepEqual(validResponse, { success: true, message: created });
  });

  it('returns the canonical text message for duplicate client message IDs without duplicate side effects', async () => {
    const text = createHarness('client-2');
    const textResponses: Array<{ success: boolean; message?: Message }> = [];
    const textPayload = {
      roomId: 'room-1',
      content: 'retry-safe text',
      username: 'Ada',
      avatar: { text: 'A', color: 'primary' },
      clientMessageId: 'client-message-retry-1',
    };

    await text.socket.invoke('send_message', textPayload, (response: { success: boolean; message?: Message }) => {
      textResponses.push(response);
    });
    await text.socket.invoke('send_message', { ...textPayload, content: 'must not overwrite' }, (response: { success: boolean; message?: Message }) => {
      textResponses.push(response);
    });

    assert.equal(text.store.appendedMessages.length, 1);
    assert.equal(text.io.roomEmits.length, 1);
    assert.equal(textResponses.length, 2);
    assert.equal(textResponses[1].message?.id, textResponses[0].message?.id);
    assert.equal(textResponses[1].message?.content, 'retry-safe text');
  });

  it('rejects empty or oversized client message IDs', async () => {
    const h = createHarness('client-2');
    const responses: unknown[] = [];
    await h.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'invalid id',
      clientMessageId: '   ',
    }, (response: unknown) => responses.push(response));
    await h.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'invalid id',
      clientMessageId: 'x'.repeat(129),
    }, (response: unknown) => responses.push(response));

    assert.deepEqual(responses, [
      { success: false, error: 'Invalid client message ID' },
      { success: false, error: 'Invalid client message ID' },
    ]);
    assert.equal(h.store.appendedMessages.length, 0);
  });

  it('rejects incomplete or out-of-range client message batches', async () => {
    const h = createHarness('client-2');
    const responses: unknown[] = [];
    await h.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'invalid batch',
      clientBatchId: 'mixed-batch',
    }, (response: unknown) => responses.push(response));
    await h.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'invalid batch',
      clientBatchId: 'mixed-batch',
      clientBatchIndex: 101,
    }, (response: unknown) => responses.push(response));

    assert.deepEqual(responses, [
      { success: false, error: 'Invalid client message batch' },
      { success: false, error: 'Invalid client message batch' },
    ]);
    assert.equal(h.store.appendedMessages.length, 0);
  });

  it('rejects oversized message content and unbounded profile fields', async () => {
    const h = createHarness('client-2');
    const responses: unknown[] = [];

    await h.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'x'.repeat(64 * 1024 + 1),
    }, (response: unknown) => responses.push(response));
    await h.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'valid',
      username: 'x'.repeat(41),
    }, (response: unknown) => responses.push(response));
    await h.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'valid',
      avatar: { text: 'x'.repeat(17), color: 'primary' },
    }, (response: unknown) => responses.push(response));

    assert.deepEqual(responses, [
      { success: false, error: 'Message content is too large' },
      { success: false, error: 'Invalid message profile' },
      { success: false, error: 'Invalid message profile' },
    ]);
    assert.equal(h.store.appendedMessages.length, 0);
  });

  it('rejects new messages when the room posting schedule is closed', async () => {
    const closed = createHarness('client-2');
    closed.store.rooms = [
      room({
        postingSchedule: {
          enabled: true,
          timezone: 'UTC',
          windows: [],
        },
      }),
    ];

    let response: unknown;
    await closed.socket.invoke('send_message', { roomId: 'room-1', content: 'blocked' }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, { success: false, error: 'Posting closed' });
    assert.deepEqual(closed.store.appendedMessages, []);
    assert.deepEqual(closed.io.roomEmits, []);
  });

  it('does not expose ghost message state when persistence fails', async () => {
    const failing = createHarness('client-2');
    failing.store.appendMessageIdempotent = async (newMessage: Message) => {
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

  it('resolves quoted messages on the server and rejects missing quote targets', async () => {
    const valid = createHarness('client-2');
    valid.store.messages = [message({ id: 'quoted', username: 'Ada', content: 'original' })];
    let validResponse: { success: boolean; message?: Message } | undefined;

    await valid.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'answer',
      username: 'Grace',
      replyToMessageId: 'quoted',
    }, (response: { success: boolean; message?: Message }) => {
      validResponse = response;
    });

    assert.deepEqual(validResponse?.message?.replyTo, {
      messageId: 'quoted',
      username: 'Ada',
      messageType: 'text',
      preview: 'original',
    });

    const missing = createHarness('client-2');
    let missingResponse: unknown;
    await missing.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'answer',
      replyToMessageId: 'missing',
    }, (response: unknown) => {
      missingResponse = response;
    });

    assert.equal(missing.store.appendedMessages.length, 0);
    assert.deepEqual(missingResponse, { success: false, error: 'Quoted message not found' });
  });

  it('edits messages with callbacks and leaves durable fan-out to room_events', async () => {
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

    const unauthorized = createHarness('client-2');
    let unauthorizedResponse: unknown;
    await unauthorized.socket.invoke('edit_message', { roomId: 'room-1', messageId: 'message-1', newContent: 'edited' }, (response: unknown) => {
      unauthorizedResponse = response;
    });
    assert.deepEqual(unauthorizedResponse, { success: false, error: 'You are not authorized to modify this message' });
    assert.deepEqual(unauthorized.store.editedMessages, []);
    assert.deepEqual(unauthorized.io.roomEmits, []);

    const valid = createHarness();
    let response: { success: boolean; updatedMessage?: Message } | undefined;
    await valid.socket.invoke('edit_message', { roomId: 'room-1', messageId: 'message-1', newContent: 'edited' }, (result: typeof response) => {
      response = result;
    });

    assert.equal(response?.success, true);
    assert.equal(response?.updatedMessage?.content, 'edited');
    assert.equal(response?.updatedMessage?.timestamp, '2026-05-03T00:00:00.000Z');
    assert.equal(response?.updatedMessage?.updatedAt, '2026-05-03T00:00:10.000Z');
    assert.deepEqual(valid.store.editedMessages, [{ roomId: 'room-1', messageId: 'message-1', newContent: 'edited' }]);
    assert.equal(valid.store.savedHistory.length, 0);
    assert.deepEqual(valid.io.roomEmits, [
      { roomId: 'client-1', event: 'room_updated', args: [roomActivityForMessages(valid.store.messages)] },
    ]);

    const ownerEditingOtherUser = createHarness('client-1');
    ownerEditingOtherUser.store.messages = [message({ clientId: 'client-2' })];
    let ownerResponse: { success: boolean; updatedMessage?: Message } | undefined;
    await ownerEditingOtherUser.socket.invoke('edit_message', { roomId: 'room-1', messageId: 'message-1', newContent: 'owner edit' }, (result: typeof ownerResponse) => {
      ownerResponse = result;
    });

    assert.equal(ownerResponse?.success, true);
    assert.equal(ownerResponse?.updatedMessage?.content, 'owner edit');
    assert.deepEqual(ownerEditingOtherUser.store.editedMessages, [{ roomId: 'room-1', messageId: 'message-1', newContent: 'owner edit' }]);
  });

  it('does not expose ghost edited state when message mutation fails', async () => {
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

  it('deletes messages idempotently and leaves durable fan-out to room_events', async () => {
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

    const unauthorized = createHarness('client-2');
    let unauthorizedResponse: unknown;
    await unauthorized.socket.invoke('delete_message', { roomId: 'room-1', messageId: 'message-1' }, (response: unknown) => {
      unauthorizedResponse = response;
    });
    assert.deepEqual(unauthorizedResponse, { success: false, error: 'You are not authorized to modify this message' });
    assert.deepEqual(unauthorized.store.deletedMessages, []);
    assert.deepEqual(unauthorized.io.roomEmits, []);

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
    ]);

    const ownerDeletingOtherUser = createHarness('client-1');
    ownerDeletingOtherUser.store.messages = [message({ clientId: 'client-2' })];
    let ownerResponse: unknown;
    await ownerDeletingOtherUser.socket.invoke('delete_message', { roomId: 'room-1', messageId: 'message-1' }, (result: unknown) => {
      ownerResponse = result;
    });
    assert.deepEqual(ownerResponse, { success: true });
    assert.deepEqual(ownerDeletingOtherUser.store.deletedMessages, [{ roomId: 'room-1', messageId: 'message-1' }]);
  });

  it('does not expose a ghost deletion when message mutation fails', async () => {
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

  it('clears room messages, leaves durable reset to room_events, and refreshes transient cost state', async () => {
    const unregistered = createHarness(null);
    await unregistered.socket.invoke('clear_room_messages', 'room-1');
    assert.deepEqual(unregistered.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);

    const missingRoom = createHarness();
    await missingRoom.socket.invoke('clear_room_messages', '');
    assert.deepEqual(missingRoom.socket.emitted, [{ event: 'error', args: [{ message: 'Room ID is required' }] }]);

    const nonOwner = createHarness('client-2');
    let nonOwnerResponse: unknown;
    await nonOwner.socket.invoke('clear_room_messages', { roomId: 'room-1', confirmation: 'Room 1' }, (response: unknown) => {
      nonOwnerResponse = response;
    });
    assert.deepEqual(nonOwnerResponse, { success: false, error: 'Only the room owner can clear history' });
    assert.deepEqual(nonOwner.store.clearedRooms, []);

    const wrongConfirmation = createHarness();
    let wrongConfirmationResponse: unknown;
    await wrongConfirmation.socket.invoke('clear_room_messages', { roomId: 'room-1', confirmation: 'wrong room' }, (response: unknown) => {
      wrongConfirmationResponse = response;
    });
    assert.deepEqual(wrongConfirmationResponse, { success: false, error: 'Room name confirmation is required' });
    assert.deepEqual(wrongConfirmation.store.clearedRooms, []);

    const valid = createHarness();
    await valid.socket.invoke('clear_room_messages', { roomId: 'room-1', confirmation: 'Room 1' });

    assert.deepEqual(valid.store.clearedRooms, ['room-1']);
    assert.deepEqual(valid.io.roomEmits, [
      { roomId: 'room-1', event: 'ai_cost_total', args: [roomCost()] },
    ]);
  });

  it('does not expose a ghost clear when persistence throws', async () => {
    const failing = createHarness();
    failing.store.clearRoomMessages = async (roomId: string) => {
      failing.store.clearedRooms.push(roomId);
      throw new Error('clear failed');
    };

    await failing.socket.invoke('clear_room_messages', { roomId: 'room-1', confirmation: 'Room 1' });

    assert.deepEqual(failing.store.clearedRooms, ['room-1']);
    assert.deepEqual(failing.io.roomEmits, []);
    assert.deepEqual(failing.socket.emitted, [{ event: 'error', args: [{ message: 'Failed to clear room messages' }] }]);
  });

  it('accepts A2UI actions for hydrated messages and broadcasts them to the room', async () => {
    const { socket, store, io } = createHarness();
    store.messages = [
      message({
        id: 'ai-1',
        clientId: 'ai_assistant',
        messageType: 'ai',
        uiPayload: {
          format: 'a2ui',
          version: 'v0.9',
          messages: [{
            version: 'v0.9',
            createSurface: {
              surfaceId: 'task-1',
              catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
            },
          }],
        },
      }),
    ];
    let response: unknown;
    const action = {
      name: 'create_task',
      surfaceId: 'task-1',
      sourceComponentId: 'confirm',
      timestamp: '2026-05-03T00:00:10.000Z',
      context: { title: 'Implement A2UI' },
    };

    await socket.invoke('a2ui_action', {
      roomId: 'room-1',
      messageId: 'ai-1',
      action,
    }, (ack: unknown) => {
      response = ack;
    });

    assert.deepEqual(response, { success: true });
    assert.deepEqual(io.roomEmits.at(-1), {
      roomId: 'room-1',
      event: 'a2ui_action',
      args: [{
        roomId: 'room-1',
        messageId: 'ai-1',
        clientId: 'client-1',
        action,
      }],
    });
  });

  it('rejects oversized or deeply nested A2UI action context', async () => {
    const { socket } = createHarness('client-1');
    const responses: unknown[] = [];
    const baseAction = {
      name: 'create_task',
      surfaceId: 'task-1',
      sourceComponentId: 'confirm',
      timestamp: '2026-05-03T00:00:10.000Z',
    };

    await socket.invoke('a2ui_action', {
      roomId: 'room-1',
      messageId: 'ai-1',
      action: { ...baseAction, context: { payload: 'x'.repeat(16 * 1024) } },
    }, (response: unknown) => responses.push(response));
    await socket.invoke('a2ui_action', {
      roomId: 'room-1',
      messageId: 'ai-1',
      action: { ...baseAction, context: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } },
    }, (response: unknown) => responses.push(response));

    assert.deepEqual(responses, [
      { success: false, error: 'Invalid A2UI action payload' },
      { success: false, error: 'Invalid A2UI action payload' },
    ]);
  });
});

describe('sticker messages over send_message', () => {
  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-handler-'));
    const file = path.join(dir, 'catalog.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      packs: [{ id: 'xiaokumao', name: '小哭猫', cover: 'xiaokumao/001/01', stickerIds: ['xiaokumao/001/01'] }],
      stickers: {
        'xiaokumao/001/01': { id: 'xiaokumao/001/01', url: 'https://cdn.test/x/001/01.jpg', pack: 'xiaokumao', keywords: ['哭'] },
      },
    }));
    process.env.STICKER_CATALOG_PATH = file;
    loadStickerCatalog();
  });

  it('rejects a sticker message with an unknown stickerId', async () => {
    const h = createHarness('client-2');
    let response: unknown;
    await h.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'xiaokumao/999/99',
      messageType: 'sticker',
    }, (r: unknown) => { response = r; });

    assert.deepEqual(response, { success: false, error: 'Unknown sticker' });
    assert.equal(h.store.appendedMessages.length, 0);
    assert.deepEqual(h.io.roomEmits, []);
  });

  it('accepts a valid sticker, stores only its id, and leaves durable fan-out to room_events', async () => {
    const h = createHarness('client-2');
    let response: { success: boolean; message?: Message } | undefined;
    await h.socket.invoke('send_message', {
      roomId: 'room-1',
      content: 'xiaokumao/001/01',
      messageType: 'sticker',
      username: 'Ada',
      clientMessageId: 'cm-sticker-1',
    }, (r: { success: boolean; message?: Message }) => { response = r; });

    assert.equal(h.store.appendedMessages.length, 1);
    const created = h.store.appendedMessages[0];
    assert.equal(created.messageType, 'sticker');
    assert.equal(created.content, 'xiaokumao/001/01');
    assert.equal(created.mediaAsset, undefined);
    assert.equal(created.clientMessageId, 'cm-sticker-1');
    assert.deepEqual(h.io.roomEmits, [
      { roomId: 'client-1', event: 'room_updated', args: [room({ lastActivityAt: created.timestamp })] },
    ]);
    assert.deepEqual(response, { success: true, message: created });
  });

  it('returns the canonical sticker for a duplicate client message ID without duplicate side effects', async () => {
    const h = createHarness('client-2');
    const responses: Array<{ success: boolean; message?: Message }> = [];
    const payload = {
      roomId: 'room-1',
      content: 'xiaokumao/001/01',
      messageType: 'sticker' as const,
      clientMessageId: 'cm-sticker-retry-1',
    };

    await h.socket.invoke('send_message', payload, (response: { success: boolean; message?: Message }) => responses.push(response));
    await h.socket.invoke('send_message', payload, (response: { success: boolean; message?: Message }) => responses.push(response));

    assert.equal(h.store.appendedMessages.length, 1);
    assert.equal(h.io.roomEmits.length, 1);
    assert.equal(responses[1].message?.id, responses[0].message?.id);
  });

  it('lets a text message reply to a sticker with a sticker reply reference', async () => {
    const h = createHarness('client-2');
    await h.socket.invoke('send_message', {
      roomId: 'room-1', content: 'xiaokumao/001/01', messageType: 'sticker',
    }, () => {});
    const stickerMsg = h.store.appendedMessages[0];

    let response: { success: boolean; message?: Message } | undefined;
    await h.socket.invoke('send_message', {
      roomId: 'room-1', content: 'haha', replyToMessageId: stickerMsg.id,
    }, (r: { success: boolean; message?: Message }) => { response = r; });

    const reply = response?.message?.replyTo;
    assert.equal(reply?.messageType, 'sticker');
    assert.equal(reply?.stickerId, 'xiaokumao/001/01');
  });
});
