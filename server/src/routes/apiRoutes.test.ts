import assert from 'assert/strict';
import express from 'express';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Server as HttpServer } from 'http';
import { registerApiRoutes } from './apiRoutes';
import { Message, Room } from '../types';

type EmittedEvent = {
  target: string;
  event: string;
  payload: unknown;
};

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
  emitted: EmittedEvent[];
  store: {
    messages: Message[];
    rooms: Room[];
    savedRooms: Room[];
    appendedMessages: Message[];
    readMessagesByRoom: (roomId: string) => Promise<Message[]>;
    readRoomsByUser: (clientId: string) => Promise<Room[]>;
    generateUniqueRoomId: () => Promise<string>;
    saveRoom: (room: Room) => Promise<Room | null>;
    appendMessage: (message: Message) => Promise<Room | null>;
    readRoomAICost: (roomId: string) => Promise<{ roomId: string; currency: 'USD'; totalUsd: number }>;
    getRoomById: (roomId: string) => Promise<Room | null>;
    countRooms: () => Promise<number>;
  };
  redisClient: {
    isOpen: boolean;
  };
};

const sampleRoom = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  ...overrides,
});

const sampleMessage = (overrides: Partial<Message> = {}): Message => ({
  id: 'message-1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T00:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

async function createTestServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const emitted: EmittedEvent[] = [];
  const store = {
    messages: [sampleMessage()],
    rooms: [sampleRoom()],
    savedRooms: [] as Room[],
    appendedMessages: [] as Message[],
    async readMessagesByRoom(roomId: string) {
      return this.messages.filter(message => message.roomId === roomId);
    },
    async readRoomsByUser(clientId: string) {
      return this.rooms.filter(room => room.creatorId === clientId);
    },
    async generateUniqueRoomId() {
      return 'generated-room';
    },
    async saveRoom(room: Room) {
      this.savedRooms.push(room);
      this.rooms.push(room);
      return room;
    },
    async appendMessage(message: Message) {
      this.appendedMessages.push(message);
      this.messages.push(message);
      return sampleRoom({ lastActivityAt: message.timestamp });
    },
    async readRoomAICost(roomId: string) {
      return { roomId, currency: 'USD' as const, totalUsd: 1.25 };
    },
    async getRoomById(roomId: string) {
      return this.rooms.find(room => room.id === roomId) || null;
    },
    async countRooms() {
      return this.rooms.length;
    },
  };

  const io = {
    to(target: string) {
      return {
        emit(event: string, payload: unknown) {
          emitted.push({ target, event, payload });
        },
      };
    },
    of() {
      return { adapter: {} };
    },
  };

  const redisClient = {
    isOpen: true,
  };

  const routeLogger = {
    debug() {},
    error() {},
    info() {},
    warn() {},
    formatMessageForLog(message: unknown) {
      return message;
    },
  };

  registerApiRoutes(app, {
    store: store as any,
    io: io as any,
    redisClient: redisClient as any,
    routeLogger: routeLogger as any,
    getAIModelResponse: () => ({
      defaultModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
    }),
  });

  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
    emitted,
    store,
    redisClient,
  };
}

describe('API routes', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns room messages, AI models, room cost, and status payloads', async () => {
    const messagesResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages`);
    assert.equal(messagesResponse.status, 200);
    assert.deepEqual(await messagesResponse.json(), [sampleMessage()]);

    const modelsResponse = await fetch(`${server.baseUrl}/api/ai-models`);
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(await modelsResponse.json(), {
      defaultModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
    });

    const costResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/ai-cost`);
    assert.equal(costResponse.status, 200);
    assert.deepEqual(await costResponse.json(), { roomId: 'room-1', currency: 'USD', totalUsd: 1.25 });

    const statusResponse = await fetch(`${server.baseUrl}/api/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as { status: string; persistenceStore: string; redis: string; rooms: number };
    assert.equal(status.status, 'online');
    assert.equal(status.persistenceStore, 'redis');
    assert.equal(status.redis, 'connected');
    assert.equal(status.rooms, 1);
  });

  it('creates rooms and broadcasts the new room to the creator', async () => {
    const response = await fetch(`${server.baseUrl}/api/clients/client-2/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Created Room', description: 'API room' }),
    });

    assert.equal(response.status, 201);
    const room = await response.json() as Room;
    assert.equal(room.id, 'generated-room');
    assert.equal(room.name, 'Created Room');
    assert.equal(room.description, 'API room');
    assert.equal(room.creatorId, 'client-2');
    assert.deepEqual(server.emitted, [{ target: 'client-2', event: 'new_room', payload: room }]);
  });

  it('rejects invalid room and message creation requests', async () => {
    const roomResponse = await fetch(`${server.baseUrl}/api/clients/client-1/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'missing name' }),
    });
    assert.equal(roomResponse.status, 400);
    assert.deepEqual(await roomResponse.json(), { error: 'Room name and client ID are required' });

    const messageResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(messageResponse.status, 400);
    assert.deepEqual(await messageResponse.json(), { error: 'Client ID, room ID, and message content are required' });
  });

  it('creates text messages by default and broadcasts them to the room', async () => {
    const response = await fetch(`${server.baseUrl}/api/rooms/room-1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-2', content: 'hello from API' }),
    });

    assert.equal(response.status, 201);
    const message = await response.json() as Message;
    assert.equal(message.clientId, 'client-2');
    assert.equal(message.roomId, 'room-1');
    assert.equal(message.content, 'hello from API');
    assert.equal(message.messageType, 'text');
    assert.equal(server.store.appendedMessages[0].id, message.id);
    assert.deepEqual(server.emitted, [
      { target: 'client-1', event: 'room_updated', payload: sampleRoom({ lastActivityAt: message.timestamp }) },
      { target: 'room-1', event: 'new_message', payload: message },
    ]);
  });

  it('does not emit ghost API messages when persistence fails', async () => {
    server.store.appendMessage = async () => null;

    const response = await fetch(`${server.baseUrl}/api/rooms/room-1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-2', content: 'unsaved message' }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Failed to create message' });
    assert.deepEqual(server.emitted, []);
  });

  it('returns client rooms and protects owner-only room detail lookup', async () => {
    const listResponse = await fetch(`${server.baseUrl}/api/clients/client-1/rooms`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), [sampleRoom()]);

    const ownedResponse = await fetch(`${server.baseUrl}/api/clients/client-1/rooms/room-1`);
    assert.equal(ownedResponse.status, 200);
    assert.deepEqual(await ownedResponse.json(), sampleRoom());

    const unauthorizedResponse = await fetch(`${server.baseUrl}/api/clients/client-2/rooms/room-1`);
    assert.equal(unauthorizedResponse.status, 404);
    assert.deepEqual(await unauthorizedResponse.json(), { error: 'Room not found' });
  });

  it('returns a status error when store status lookup fails', async () => {
    server.store.countRooms = async () => {
      throw new Error('store failed');
    };

    const response = await fetch(`${server.baseUrl}/api/status`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Error getting system status' });
  });
});
