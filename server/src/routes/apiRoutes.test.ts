import assert from 'assert/strict';
import express from 'express';
import { mkdir, writeFile } from 'fs/promises';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Server as HttpServer } from 'http';
import path from 'path';
import { registerApiRoutes } from './apiRoutes';
import { Message, Room } from '../types';
import { CocoAccessControl, createCocoAccessControl } from '../services/cocoAccessControl';

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

const largeMessage = (index: number): Message => sampleMessage({
  id: `large-message-${index.toString().padStart(3, '0')}`,
  content: `large message ${index} ${'x'.repeat(2048)}`,
  timestamp: new Date(Date.UTC(2026, 4, 3, 0, 0, index)).toISOString(),
  usage: { promptTokens: index + 1, completionTokens: 1, totalTokens: index + 2, source: 'reported' },
  cost: {
    currency: 'USD',
    inputUsd: 0.000001,
    outputUsd: 0.000001,
    totalUsd: 0.000002,
    inputPerMillion: 1,
    outputPerMillion: 1,
    estimated: false,
  },
});

const writeLargeHistoryBaseline = async (payload: {
  messageCount: number;
  responseBytes: number;
  firstMessageId: string;
  lastMessageId: string;
}) => {
  const outputDir = path.join(process.cwd(), 'test-results');
  const outputPath = path.join(outputDir, 'large-message-history-baseline.json');
  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    assert.fail(`Failed to write large message history baseline to ${outputPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

async function createTestServer(options: { cocoAccess?: CocoAccessControl } = {}): Promise<TestServer> {
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
    cocoAccess: options.cocoAccess,
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
    const status = await statusResponse.json() as {
      status: string;
      persistenceStore: string;
      redis: string;
      rooms: number;
      features: { coco: { enabled: boolean; rollout: string } };
    };
    assert.equal(status.status, 'online');
    assert.equal(status.persistenceStore, 'redis');
    assert.equal(status.redis, 'connected');
    assert.equal(status.rooms, 1);
    assert.deepEqual(status.features.coco, { enabled: false, rollout: 'disabled' });
  });

  it('returns Coco feature flags per client', async () => {
    await server.close();
    server = await createTestServer({
      cocoAccess: createCocoAccessControl({ enabled: true, allowedClientIds: ['client-1'] }),
    });

    const allowedResponse = await fetch(`${server.baseUrl}/api/features?clientId=client-1`);
    assert.equal(allowedResponse.status, 200);
    assert.deepEqual(await allowedResponse.json(), {
      coco: { enabled: true, rollout: 'allowlist' },
    });

    const deniedResponse = await fetch(`${server.baseUrl}/api/features?clientId=client-2`);
    assert.equal(deniedResponse.status, 200);
    assert.deepEqual(await deniedResponse.json(), {
      coco: { enabled: false, rollout: 'allowlist', reason: 'not_allowed' },
    });
  });

  it('returns large room message histories as complete ordered JSON and writes a response-size baseline', async () => {
    const largeMessages = Array.from({ length: 120 }, (_, index) => largeMessage(index));
    server.store.messages = largeMessages;

    const response = await fetch(`${server.baseUrl}/api/rooms/room-1/messages`);

    assert.equal(response.status, 200);
    const rawBody = await response.text();
    const parsed = JSON.parse(rawBody) as Message[];
    assert.equal(parsed.length, largeMessages.length);
    assert.deepEqual(parsed.map(item => item.id), largeMessages.map(item => item.id));
    assert.deepEqual(parsed.map(item => item.content), largeMessages.map(item => item.content));

    const responseBytes = Buffer.byteLength(rawBody, 'utf8');
    assert.ok(responseBytes > 200_000, `Expected large response baseline, got ${responseBytes} bytes`);
    await writeLargeHistoryBaseline({
      messageCount: parsed.length,
      responseBytes,
      firstMessageId: parsed[0].id,
      lastMessageId: parsed[parsed.length - 1].id,
    });
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

  it('creates Coco rooms through the HTTP API', async () => {
    await server.close();
    server = await createTestServer({
      cocoAccess: createCocoAccessControl({ enabled: true }),
    });

    const response = await fetch(`${server.baseUrl}/api/clients/client-2/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Coco Room', type: 'coco' }),
    });

    assert.equal(response.status, 201);
    const room = await response.json() as Room;
    assert.equal(room.type, 'coco');
    assert.equal(room.sandboxStatus, 'none');
    assert.equal(room.cocoStatus, 'idle');
    assert.ok(room.sandboxUpdatedAt);
    assert.deepEqual(server.emitted, [{ target: 'client-2', event: 'new_room', payload: room }]);
  });

  it('does not emit API rooms when room persistence fails', async () => {
    server.store.saveRoom = async (room: Room) => {
      server.store.savedRooms.push(room);
      return null;
    };

    const response = await fetch(`${server.baseUrl}/api/clients/client-2/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Unsaved Room' }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Failed to create room' });
    assert.equal(server.store.savedRooms.length, 1);
    assert.deepEqual(server.emitted, []);
  });

  it('gates Coco room creation via API with rollout controls', async () => {
    const disabledResponse = await fetch(`${server.baseUrl}/api/clients/client-1/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Coco', type: 'coco' }),
    });
    assert.equal(disabledResponse.status, 403);
    assert.deepEqual(await disabledResponse.json(), { error: 'Coco is disabled' });
    assert.equal(server.store.savedRooms.length, 0);

    await server.close();
    server = await createTestServer({
      cocoAccess: createCocoAccessControl({ enabled: true, allowedClientIds: ['client-1'] }),
    });

    const deniedResponse = await fetch(`${server.baseUrl}/api/clients/client-2/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Coco', type: 'coco' }),
    });
    assert.equal(deniedResponse.status, 403);
    assert.deepEqual(await deniedResponse.json(), { error: 'Coco is not enabled for this user' });
    assert.equal(server.store.savedRooms.length, 0);

    const allowedResponse = await fetch(`${server.baseUrl}/api/clients/client-1/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Coco', type: 'coco' }),
    });
    assert.equal(allowedResponse.status, 201);
    const room = await allowedResponse.json() as Room;
    assert.equal(room.type, 'coco');
    assert.equal(server.store.savedRooms.length, 1);
  });

  it('rejects invalid room and message creation requests', async () => {
    const roomResponse = await fetch(`${server.baseUrl}/api/clients/client-1/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'missing name' }),
    });
    assert.equal(roomResponse.status, 400);
    assert.deepEqual(await roomResponse.json(), { error: 'Room name is required' });

    const tooLongRoomResponse = await fetch(`${server.baseUrl}/api/clients/client-1/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(21) }),
    });
    assert.equal(tooLongRoomResponse.status, 400);
    assert.deepEqual(await tooLongRoomResponse.json(), { error: 'Room name cannot exceed 20 characters' });

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
