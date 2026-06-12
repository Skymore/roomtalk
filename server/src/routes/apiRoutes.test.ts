import assert from 'assert/strict';
import express from 'express';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Server as HttpServer } from 'http';
import os from 'os';
import path from 'path';
import { registerApiRoutes } from './apiRoutes';
import { MediaAsset, Message, Room } from '../types';
import { LocalMediaObjectStorage } from '../services/mediaObjectStorage';
import { Logger } from '../logger';
import { AudioTranscriptionRecord, AudioTranscriptionUpdate, PendingMediaUpload } from '../repositories/store';
import { AudioTranscriptionJob } from '../services/audioTranscription';

type EmittedEvent = {
  target: string;
  event: string;
  payload: unknown;
};

type TestMediaHistoryOptions = {
  limit?: number;
  before?: { createdAt: string; assetId: string } | null;
  since?: string;
  kinds?: Array<MediaAsset['kind']>;
};

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
  emitted: EmittedEvent[];
  generatedRoleIdeas: string[];
  store: {
    messages: Message[];
    rooms: Room[];
    members: Set<string>;
    savedRooms: Room[];
    appendedMessages: Message[];
    appendedMediaAssets: MediaAsset[];
    mediaAssets: Map<string, MediaAsset>;
    pendingMediaUploads: Map<string, PendingMediaUpload>;
    audioTranscriptions: Map<string, AudioTranscriptionRecord>;
    pushSubscriptions: Map<string, { clientId: string; browserInstanceId?: string; endpoint: string; p256dh: string; auth: string; userAgent?: string }>;
    clientPasswords: Map<string, string>;
    clientAuthTokens: Map<string, { clientId: string; tokenHash: string; createdAt: string }>;
    nicknames: Map<string, string>;
    readMessagesByRoom: (roomId: string) => Promise<Message[]>;
    addRoomMember: (roomId: string, clientId: string, role: 'owner' | 'member', joinedAt?: string) => Promise<{ roomId: string; clientId: string; role: 'owner' | 'member'; joinedAt: string } | null>;
    getRoomMember: (roomId: string, clientId: string) => Promise<{ roomId: string; clientId: string; role: 'owner' | 'member'; joinedAt: string } | null>;
    isRoomMember: (roomId: string, clientId: string) => Promise<boolean>;
    readRoomMembers: (roomId: string) => Promise<Array<{ roomId: string; clientId: string; role: 'owner' | 'member'; joinedAt: string }>>;
    savePushSubscription: (subscription: { clientId: string; browserInstanceId?: string; endpoint: string; p256dh: string; auth: string; userAgent?: string }) => Promise<void>;
    deletePushSubscription: (clientId: string, endpoint: string) => Promise<boolean>;
    readPushSubscriptionsByRoom: (roomId: string) => Promise<Array<{ clientId: string; browserInstanceId?: string; endpoint: string; p256dh: string; auth: string; createdAt: string; updatedAt: string; userAgent?: string }>>;
    setClientPasswordHash: (clientId: string, passwordHash: string) => Promise<void>;
    getClientPasswordHash: (clientId: string) => Promise<string | null>;
    saveClientAuthToken: (token: { clientId: string; tokenHash: string; createdAt: string }) => Promise<void>;
    isClientAuthTokenValid: (clientId: string, tokenHash: string) => Promise<boolean>;
    deleteClientAuthToken: (clientId: string, tokenHash: string) => Promise<boolean>;
    deleteClientAuthTokens: (clientId: string) => Promise<void>;
    setClientNickname: (clientId: string, nickname: string) => Promise<void>;
    getClientNicknames: (clientIds: string[]) => Promise<Record<string, string>>;
    readRoomsByUser: (clientId: string) => Promise<Room[]>;
    generateUniqueRoomId: () => Promise<string>;
    saveRoom: (room: Room) => Promise<Room | null>;
    appendMessage: (message: Message) => Promise<Room | null>;
    appendMediaMessageWithAsset: (message: Message, asset: MediaAsset) => Promise<{ room: Room; message: Message; asset: MediaAsset } | null>;
    saveMediaAsset: (asset: MediaAsset) => Promise<MediaAsset | null>;
    getMediaAsset: (assetId: string) => Promise<MediaAsset | null>;
    readMediaAssetsByRoom: (roomId: string) => Promise<MediaAsset[]>;
    readMediaHistoryPageByRoom: (roomId: string, options?: TestMediaHistoryOptions) => Promise<{ assets: MediaAsset[]; hasMore: boolean }>;
    deleteMediaAsset: (assetId: string) => Promise<void>;
    savePendingMediaUpload: (upload: PendingMediaUpload) => Promise<void>;
    getPendingMediaUpload: (assetId: string) => Promise<PendingMediaUpload | null>;
    deletePendingMediaUpload: (assetId: string) => Promise<void>;
    claimExpiredPendingMediaUploads: (now: string, limit?: number) => Promise<PendingMediaUpload[]>;
    getAudioTranscription: (assetId: string) => Promise<AudioTranscriptionRecord | null>;
    createAudioTranscription: (record: AudioTranscriptionRecord) => Promise<AudioTranscriptionRecord>;
    updateAudioTranscription: (assetId: string, updates: AudioTranscriptionUpdate) => Promise<AudioTranscriptionRecord | null>;
    readRoomAICost: (roomId: string) => Promise<{ roomId: string; currency: 'USD'; totalUsd: number }>;
    getRoomById: (roomId: string) => Promise<Room | null>;
    countRooms: () => Promise<number>;
  };
  redisClient: {
    isOpen: boolean;
  };
  deletedMediaObjects: string[];
  audioTranscriptionJobs: AudioTranscriptionJob[];
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

const pendingUpload = (overrides: Partial<PendingMediaUpload> = {}): PendingMediaUpload => {
  const assetId = overrides.assetId || 'asset-1';
  const roomId = overrides.roomId || 'room-1';
  const kind = overrides.kind || 'audio';

  return {
    assetId,
    roomId,
    objectKey: overrides.objectKey || `rooms/${roomId}/media/${kind}/${assetId}`,
    kind,
    mimeType: overrides.mimeType || `${kind}/webm`,
    byteSize: overrides.byteSize || 456,
    uploadedByClientId: overrides.uploadedByClientId || 'client-2',
    createdAt: overrides.createdAt || '2026-05-03T00:00:00.000Z',
    expiresAt: overrides.expiresAt || '2999-01-01T00:00:00.000Z',
  };
};

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

async function createTestServer(overrides: {
  mediaObjectStorage?: unknown;
  mediaUploadCleanup?: Parameters<typeof registerApiRoutes>[1]['mediaUploadCleanup'];
  audioTranscriptionRunner?: Parameters<typeof registerApiRoutes>[1]['audioTranscriptionRunner'];
} = {}): Promise<TestServer> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const emitted: EmittedEvent[] = [];
  const generatedRoleIdeas: string[] = [];
  const store = {
    messages: [sampleMessage()],
    rooms: [sampleRoom()],
    members: new Set(['room-1:client-1']),
    savedRooms: [] as Room[],
    appendedMessages: [] as Message[],
    appendedMediaAssets: [] as MediaAsset[],
    mediaAssets: new Map<string, MediaAsset>(),
    pendingMediaUploads: new Map<string, PendingMediaUpload>(),
    audioTranscriptions: new Map<string, AudioTranscriptionRecord>(),
    pushSubscriptions: new Map<string, { clientId: string; browserInstanceId?: string; endpoint: string; p256dh: string; auth: string; userAgent?: string }>(),
    clientPasswords: new Map<string, string>(),
    clientAuthTokens: new Map<string, { clientId: string; tokenHash: string; createdAt: string }>(),
    nicknames: new Map<string, string>(),
    async readMessagesByRoom(roomId: string) {
      return this.messages.filter(message => message.roomId === roomId);
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
    async savePushSubscription(subscription: { clientId: string; browserInstanceId?: string; endpoint: string; p256dh: string; auth: string; userAgent?: string }) {
      this.pushSubscriptions.set(subscription.endpoint, subscription);
    },
    async deletePushSubscription(clientId: string, endpoint: string) {
      const existing = this.pushSubscriptions.get(endpoint);
      if (!existing || existing.clientId !== clientId) {
        return false;
      }
      this.pushSubscriptions.delete(endpoint);
      return true;
    },
    async readPushSubscriptionsByRoom(roomId: string) {
      const members = await this.readRoomMembers(roomId);
      const memberIds = new Set(members.map(member => member.clientId));
      return [...this.pushSubscriptions.values()]
        .filter(subscription => memberIds.has(subscription.clientId))
        .map(subscription => ({
          ...subscription,
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        }));
    },
    async setClientPasswordHash(clientId: string, passwordHash: string) {
      this.clientPasswords.set(clientId, passwordHash);
    },
    async getClientPasswordHash(clientId: string) {
      return this.clientPasswords.get(clientId) || null;
    },
    async saveClientAuthToken(token: { clientId: string; tokenHash: string; createdAt: string }) {
      this.clientAuthTokens.set(token.tokenHash, token);
    },
    async isClientAuthTokenValid(clientId: string, tokenHash: string) {
      return this.clientAuthTokens.get(tokenHash)?.clientId === clientId;
    },
    async deleteClientAuthToken(clientId: string, tokenHash: string) {
      const token = this.clientAuthTokens.get(tokenHash);
      if (!token || token.clientId !== clientId) {
        return false;
      }
      this.clientAuthTokens.delete(tokenHash);
      return true;
    },
    async deleteClientAuthTokens(clientId: string) {
      for (const [tokenHash, token] of this.clientAuthTokens.entries()) {
        if (token.clientId === clientId) {
          this.clientAuthTokens.delete(tokenHash);
        }
      }
    },
    async setClientNickname(clientId: string, nickname: string) {
      this.nicknames.set(clientId, nickname);
    },
    async getClientNicknames(clientIds: string[]) {
      return Object.fromEntries(
        clientIds
          .map(clientId => [clientId, this.nicknames.get(clientId)])
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    },
    async readRoomsByUser(clientId: string) {
      return this.rooms.filter(room => room.creatorId === clientId || this.members.has(`${room.id}:${clientId}`));
    },
    async generateUniqueRoomId() {
      return 'generated-room';
    },
    async saveRoom(room: Room) {
      this.savedRooms.push(room);
      this.rooms.push(room);
      this.members.add(`${room.id}:${room.creatorId}`);
      return room;
    },
    async appendMessage(message: Message) {
      this.appendedMessages.push(message);
      this.messages.push(message);
      return sampleRoom({ lastActivityAt: message.timestamp });
    },
    async appendMediaMessageWithAsset(message: Message, asset: MediaAsset) {
      const savedAsset = {
        ...asset,
        roomId: message.roomId,
        messageId: message.id,
      };
      const mediaAsset: Message['mediaAsset'] = {
        id: savedAsset.id,
        kind: savedAsset.kind,
        mimeType: savedAsset.mimeType,
        byteSize: savedAsset.byteSize,
      };
      if (savedAsset.filename !== undefined) mediaAsset.filename = savedAsset.filename;
      if (savedAsset.width !== undefined) mediaAsset.width = savedAsset.width;
      if (savedAsset.height !== undefined) mediaAsset.height = savedAsset.height;
      if (savedAsset.durationMs !== undefined) mediaAsset.durationMs = savedAsset.durationMs;
      const savedMessage = {
        ...message,
        content: message.content || '',
        mimeType: savedAsset.mimeType as Message['mimeType'],
        mediaAsset,
      };
      this.appendedMessages.push(savedMessage);
      this.appendedMediaAssets.push(savedAsset);
      this.messages.push(savedMessage);
      this.mediaAssets.set(savedAsset.id, savedAsset);
      return { room: sampleRoom({ lastActivityAt: message.timestamp }), message: savedMessage, asset: savedAsset };
    },
    async saveMediaAsset(asset: MediaAsset) {
      this.mediaAssets.set(asset.id, asset);
      return asset;
    },
    async getMediaAsset(assetId: string) {
      return this.mediaAssets.get(assetId) || null;
    },
    async readMediaAssetsByRoom(roomId: string) {
      return [...this.mediaAssets.values()].filter(asset => asset.roomId === roomId);
    },
    async readMediaHistoryPageByRoom(roomId: string, options: TestMediaHistoryOptions = {}) {
      const limit = Math.min(200, Math.max(1, Math.floor(options.limit || 40)));
      const kinds = new Set(options.kinds?.length ? options.kinds : ['image', 'video', 'audio']);
      const sinceTime = Date.parse(options.since || '');
      const cursorTime = Date.parse(options.before?.createdAt || '');
      const assets = [...this.mediaAssets.values()]
        .filter(asset => asset.roomId === roomId)
        .filter(asset => kinds.has(asset.kind))
        .filter(asset => {
          const createdAt = Date.parse(asset.createdAt);
          return Number.isFinite(createdAt) && (!Number.isFinite(sinceTime) || createdAt >= sinceTime);
        })
        .filter(asset => {
          if (!options.before || !Number.isFinite(cursorTime)) {
            return true;
          }
          const createdAt = Date.parse(asset.createdAt);
          return createdAt < cursorTime || (createdAt === cursorTime && asset.id < options.before.assetId);
        })
        .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt) || second.id.localeCompare(first.id));
      return {
        assets: assets.slice(0, limit),
        hasMore: assets.length > limit,
      };
    },
    async deleteMediaAsset(assetId: string) {
      this.mediaAssets.delete(assetId);
    },
    async savePendingMediaUpload(upload: PendingMediaUpload) {
      this.pendingMediaUploads.set(upload.assetId, upload);
    },
    async getPendingMediaUpload(assetId: string) {
      return this.pendingMediaUploads.get(assetId) || null;
    },
    async deletePendingMediaUpload(assetId: string) {
      this.pendingMediaUploads.delete(assetId);
    },
    async claimExpiredPendingMediaUploads(now: string, limit = 50) {
      const nowMs = Date.parse(now);
      const expired = [...this.pendingMediaUploads.values()]
        .filter(upload => Date.parse(upload.expiresAt) <= nowMs)
        .sort((first, second) => Date.parse(first.expiresAt) - Date.parse(second.expiresAt))
        .slice(0, limit);
      expired.forEach(upload => this.pendingMediaUploads.delete(upload.assetId));
      return expired;
    },
    async getAudioTranscription(assetId: string) {
      return this.audioTranscriptions.get(assetId) || null;
    },
    async createAudioTranscription(record: AudioTranscriptionRecord) {
      const existing = this.audioTranscriptions.get(record.assetId);
      if (existing) {
        return existing;
      }
      this.audioTranscriptions.set(record.assetId, record);
      return record;
    },
    async updateAudioTranscription(assetId: string, updates: AudioTranscriptionUpdate) {
      const existing = this.audioTranscriptions.get(assetId);
      if (!existing) {
        return null;
      }
      const nextRecord: AudioTranscriptionRecord = {
        ...existing,
        updatedAt: updates.updatedAt || existing.updatedAt,
      };
      if (updates.status !== undefined) nextRecord.status = updates.status;
      if (updates.transcript !== undefined) {
        if (updates.transcript === null) delete nextRecord.transcript;
        else nextRecord.transcript = updates.transcript;
      }
      if (updates.languageCode !== undefined) {
        if (updates.languageCode === null) delete nextRecord.languageCode;
        else nextRecord.languageCode = updates.languageCode;
      }
      if (updates.providerTranscriptId !== undefined) {
        if (updates.providerTranscriptId === null) delete nextRecord.providerTranscriptId;
        else nextRecord.providerTranscriptId = updates.providerTranscriptId;
      }
      if (updates.error !== undefined) {
        if (updates.error === null) delete nextRecord.error;
        else nextRecord.error = updates.error;
      }
      if (updates.completedAt !== undefined) {
        if (updates.completedAt === null) delete nextRecord.completedAt;
        else nextRecord.completedAt = updates.completedAt;
      }
      this.audioTranscriptions.set(assetId, nextRecord);
      return nextRecord;
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

  const deletedMediaObjects: string[] = [];
  const mediaObjectStorage = overrides.mediaObjectStorage || {
    isConfigured: () => true,
    async putMediaObject() {},
    async createWriteUrl({ objectKey }: { objectKey: string }) {
      return { url: `https://upload.example/${encodeURIComponent(objectKey)}`, expiresAt: '2026-05-03T00:15:00.000Z' };
    },
    async createReadUrl({ objectKey }: { objectKey: string }) {
      return { url: `https://download.example/${encodeURIComponent(objectKey)}`, expiresAt: '2026-05-03T00:15:00.000Z' };
    },
    async headObject() {
      return { exists: true };
    },
    async deleteMediaObject(objectKey: string) {
      deletedMediaObjects.push(objectKey);
    },
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
  const audioTranscriptionJobs: AudioTranscriptionJob[] = [];
  const audioTranscriptionRunner = overrides.audioTranscriptionRunner || (async (job: AudioTranscriptionJob) => {
    audioTranscriptionJobs.push(job);
  });

  registerApiRoutes(app, {
    store: store as any,
    io: io as any,
    redisClient: redisClient as any,
    routeLogger: routeLogger as any,
    getAIModelResponse: () => ({
      defaultModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
    }),
    generateAIRoleDraft: async (idea: string) => {
      generatedRoleIdeas.push(idea);
      if (idea === 'fail generation') {
        throw new Error('provider failed');
      }
      return { name: 'Review Expert', systemPrompt: 'Review implementation decisions carefully.' };
    },
    mediaObjectStorage: mediaObjectStorage as any,
    audioTranscriptionRunner,
    mediaUploadCleanup: overrides.mediaUploadCleanup,
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
    generatedRoleIdeas,
    store,
    redisClient,
    deletedMediaObjects,
    audioTranscriptionJobs,
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
    const messagesResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages?clientId=client-1`);
    assert.equal(messagesResponse.status, 200);
    assert.deepEqual(await messagesResponse.json(), [sampleMessage()]);

    const modelsResponse = await fetch(`${server.baseUrl}/api/ai-models`);
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(await modelsResponse.json(), {
      defaultModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
    });

    const costResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/ai-cost?clientId=client-1`);
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

  it('returns push notification public configuration', async () => {
    const previousPublicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    const previousPrivateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;

    try {
      const disabledResponse = await fetch(`${server.baseUrl}/api/push/vapid-public-key`);
      assert.equal(disabledResponse.status, 200);
      assert.deepEqual(await disabledResponse.json(), { enabled: false, publicKey: '' });

      process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'public-key';
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'private-key';
      const enabledResponse = await fetch(`${server.baseUrl}/api/push/vapid-public-key`);
      assert.equal(enabledResponse.status, 200);
      assert.deepEqual(await enabledResponse.json(), { enabled: true, publicKey: 'public-key' });
    } finally {
      if (previousPublicKey === undefined) delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
      else process.env.WEB_PUSH_VAPID_PUBLIC_KEY = previousPublicKey;
      if (previousPrivateKey === undefined) delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
      else process.env.WEB_PUSH_VAPID_PRIVATE_KEY = previousPrivateKey;
    }
  });

  it('saves and deletes push notification subscriptions', async () => {
    const body = {
      clientId: 'client-1',
      browserInstanceId: 'browser-1',
      subscription: {
        endpoint: 'https://push.example/subscription-1',
        keys: {
          p256dh: 'p256dh-key',
          auth: 'auth-key',
        },
      },
      userAgent: 'test-agent',
    };

    const saveResponse = await fetch(`${server.baseUrl}/api/push/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(saveResponse.status, 204);
    assert.deepEqual(server.store.pushSubscriptions.get(body.subscription.endpoint), {
      clientId: 'client-1',
      browserInstanceId: 'browser-1',
      endpoint: body.subscription.endpoint,
      p256dh: 'p256dh-key',
      auth: 'auth-key',
      userAgent: 'test-agent',
    });

    const deleteResponse = await fetch(`${server.baseUrl}/api/push/subscriptions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', endpoint: body.subscription.endpoint }),
    });
    assert.equal(deleteResponse.status, 204);
    assert.equal(server.store.pushSubscriptions.has(body.subscription.endpoint), false);
  });

  it('sets client ID passwords and issues login tokens', async () => {
    const initialStatusResponse = await fetch(`${server.baseUrl}/api/client-auth/client-1/status`);
    assert.equal(initialStatusResponse.status, 200);
    assert.deepEqual(await initialStatusResponse.json(), { clientId: 'client-1', hasPassword: false });

    const setPasswordResponse = await fetch(`${server.baseUrl}/api/client-auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', password: 'password-1' }),
    });
    assert.equal(setPasswordResponse.status, 200);
    const setPasswordPayload = await setPasswordResponse.json() as { clientId: string; clientAuthToken: string; hasPassword: boolean };
    assert.equal(setPasswordPayload.clientId, 'client-1');
    assert.equal(setPasswordPayload.hasPassword, true);
    assert.equal(typeof setPasswordPayload.clientAuthToken, 'string');
    assert.ok(setPasswordPayload.clientAuthToken.length > 20);
    assert.equal(server.store.clientPasswords.has('client-1'), true);

    const updatedStatusResponse = await fetch(`${server.baseUrl}/api/client-auth/client-1/status`);
    assert.equal(updatedStatusResponse.status, 200);
    assert.deepEqual(await updatedStatusResponse.json(), { clientId: 'client-1', hasPassword: true });

    const badLoginResponse = await fetch(`${server.baseUrl}/api/client-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', password: 'wrong-password' }),
    });
    assert.equal(badLoginResponse.status, 401);

    const loginResponse = await fetch(`${server.baseUrl}/api/client-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', password: 'password-1' }),
    });
    assert.equal(loginResponse.status, 200);
    const loginPayload = await loginResponse.json() as { clientId: string; clientAuthToken: string; hasPassword: boolean; nickname: string | null };
    assert.equal(loginPayload.clientId, 'client-1');
    assert.equal(loginPayload.hasPassword, true);
    assert.equal(loginPayload.nickname, null);
    assert.ok(loginPayload.clientAuthToken.length > 20);

    await server.store.setClientNickname('client-1', 'Ada');
    const loginWithNicknameResponse = await fetch(`${server.baseUrl}/api/client-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', password: 'password-1' }),
    });
    assert.equal(loginWithNicknameResponse.status, 200);
    const loginWithNicknamePayload = await loginWithNicknameResponse.json() as { nickname: string | null };
    assert.equal(loginWithNicknamePayload.nickname, 'Ada');
  });

  it('requires valid client auth tokens after a User ID password is set', async () => {
    const setPasswordResponse = await fetch(`${server.baseUrl}/api/client-auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', password: 'password-1' }),
    });
    assert.equal(setPasswordResponse.status, 200);
    const { clientAuthToken } = await setPasswordResponse.json() as { clientAuthToken: string };

    const missingTokenResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages?clientId=client-1`);
    assert.equal(missingTokenResponse.status, 401);
    assert.deepEqual(await missingTokenResponse.json(), { error: 'User ID password login is required' });

    const invalidTokenResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages?clientId=client-1&clientAuthToken=bad-token`);
    assert.equal(invalidTokenResponse.status, 401);

    const authorizedResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages?clientId=client-1&clientAuthToken=${encodeURIComponent(clientAuthToken)}`);
    assert.equal(authorizedResponse.status, 200);
    assert.deepEqual(await authorizedResponse.json(), [sampleMessage()]);

    const logoutResponse = await fetch(`${server.baseUrl}/api/client-auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', clientAuthToken }),
    });
    assert.equal(logoutResponse.status, 204);

    const afterLogoutResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages?clientId=client-1&clientAuthToken=${encodeURIComponent(clientAuthToken)}`);
    assert.equal(afterLogoutResponse.status, 401);
  });

  it('rejects room message API reads without membership', async () => {
    const response = await fetch(`${server.baseUrl}/api/rooms/room-1/messages?clientId=client-2`);

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Not authorized to access this room' });
  });

  it('creates one persisted audio transcription record per audio asset and reuses an in-flight job', async () => {
    await server.close();
    const audioTranscriptionJobs: AudioTranscriptionJob[] = [];
    let resolveAudioTranscriptionJob: () => void = () => {};
    server = await createTestServer({
      audioTranscriptionRunner: async (job) => {
        audioTranscriptionJobs.push(job);
        await new Promise<void>(resolve => {
          resolveAudioTranscriptionJob = resolve;
        });
      },
    });

    const audioMessage = sampleMessage({
      id: 'audio-message-1',
      content: '',
      messageType: 'media',
      mediaAsset: {
        id: 'audio-asset-1',
        kind: 'audio',
        mimeType: 'audio/webm',
        byteSize: 456,
        durationMs: 1200,
      },
    });
    const audioAsset: MediaAsset = {
      id: 'audio-asset-1',
      roomId: 'room-1',
      messageId: 'audio-message-1',
      objectKey: 'rooms/room-1/media/audio/audio-asset-1',
      kind: 'audio',
      mimeType: 'audio/webm',
      byteSize: 456,
      durationMs: 1200,
      createdAt: audioMessage.timestamp,
    };
    server.store.messages = [audioMessage];
    server.store.mediaAssets.set(audioAsset.id, audioAsset);

    const initialResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages/audio-message-1/audio-transcription?clientId=client-1`);
    assert.equal(initialResponse.status, 200);
    assert.deepEqual(await initialResponse.json(), {
      assetId: 'audio-asset-1',
      roomId: 'room-1',
      messageId: 'audio-message-1',
      status: 'not_requested',
    });

    const firstStartResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages/audio-message-1/audio-transcription`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(firstStartResponse.status, 202);
    const firstStartPayload = await firstStartResponse.json() as { assetId: string; status: string };
    assert.equal(firstStartPayload.assetId, 'audio-asset-1');
    assert.equal(firstStartPayload.status, 'pending');
    assert.equal(server.store.audioTranscriptions.get('audio-asset-1')?.messageId, 'audio-message-1');

    const secondStartResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages/audio-message-1/audio-transcription`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(secondStartResponse.status, 202);
    assert.equal(audioTranscriptionJobs.length, 1);
    assert.equal(audioTranscriptionJobs[0].record.assetId, 'audio-asset-1');
    assert.equal(audioTranscriptionJobs[0].asset.objectKey, audioAsset.objectKey);

    resolveAudioTranscriptionJob();
  });

  it('checks room membership and audio message type before exposing audio transcription state', async () => {
    const textResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages/message-1/audio-transcription?clientId=client-1`);
    assert.equal(textResponse.status, 400);
    assert.deepEqual(await textResponse.json(), { error: 'Message is not an audio message' });

    const audioMessage = sampleMessage({
      id: 'audio-message-2',
      content: '',
      messageType: 'media',
      mediaAsset: {
        id: 'audio-asset-2',
        kind: 'audio',
        mimeType: 'audio/webm',
        byteSize: 456,
      },
    });
    server.store.messages = [audioMessage];
    server.store.mediaAssets.set('audio-asset-2', {
      id: 'audio-asset-2',
      roomId: 'room-1',
      messageId: 'audio-message-2',
      objectKey: 'rooms/room-1/media/audio/audio-asset-2',
      kind: 'audio',
      mimeType: 'audio/webm',
      byteSize: 456,
      createdAt: audioMessage.timestamp,
    });

    const unauthorizedResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/messages/audio-message-2/audio-transcription?clientId=client-2`);
    assert.equal(unauthorizedResponse.status, 403);
    assert.deepEqual(await unauthorizedResponse.json(), { error: 'Not authorized to access this room' });
  });

  it('returns large room message histories as complete ordered JSON and writes a response-size baseline', async () => {
    const largeMessages = Array.from({ length: 120 }, (_, index) => largeMessage(index));
    server.store.messages = largeMessages;

    const response = await fetch(`${server.baseUrl}/api/rooms/room-1/messages?clientId=client-1`);

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

  it('generates AI role drafts and rejects invalid or failed generation requests', async () => {
    const response = await fetch(`${server.baseUrl}/api/ai-role-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', idea: '  Create a strict reviewer  ' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      name: 'Review Expert',
      systemPrompt: 'Review implementation decisions carefully.',
    });
    assert.deepEqual(server.generatedRoleIdeas, ['Create a strict reviewer']);

    const invalidResponse = await fetch(`${server.baseUrl}/api/ai-role-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', idea: ' ' }),
    });
    assert.equal(invalidResponse.status, 400);

    const failedResponse = await fetch(`${server.baseUrl}/api/ai-role-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', idea: 'fail generation' }),
    });
    assert.equal(failedResponse.status, 502);
    assert.deepEqual(await failedResponse.json(), { error: 'Failed to generate AI role draft' });
  });

  it('requires an authorized client and rate limits AI role draft generation', async () => {
    const missingClientResponse = await fetch(`${server.baseUrl}/api/ai-role-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: 'Create a strict reviewer' }),
    });
    assert.equal(missingClientResponse.status, 400);

    const unauthorizedResponse = await fetch(`${server.baseUrl}/api/ai-role-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-without-rooms', idea: 'Create a strict reviewer' }),
    });
    assert.equal(unauthorizedResponse.status, 403);

    server.store.members.add('room-1:client-rate-limited');
    for (let index = 0; index < 5; index += 1) {
      const rateAllowedResponse = await fetch(`${server.baseUrl}/api/ai-role-draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: 'client-rate-limited', idea: `Create role ${index}` }),
      });
      assert.equal(rateAllowedResponse.status, 200);
    }

    const rateLimitedResponse = await fetch(`${server.baseUrl}/api/ai-role-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-rate-limited', idea: 'Create one more role' }),
    });
    assert.equal(rateLimitedResponse.status, 429);
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
    server.store.members.add('room-1:client-2');
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
    server.store.members.add('room-1:client-2');

    const response = await fetch(`${server.baseUrl}/api/rooms/room-1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-2', content: 'unsaved message' }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Failed to create message' });
    assert.deepEqual(server.emitted, []);
  });

  it('creates media messages through the atomic media append path and broadcasts the saved message', async () => {
    server.store.members.add('room-1:client-2');

    const uploadResponse = await fetch(`${server.baseUrl}/api/media/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-2',
        roomId: 'room-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
      }),
    });
    assert.equal(uploadResponse.status, 201);
    const upload = await uploadResponse.json() as { assetId: string; objectKey: string; uploadUrl: string };
    assert.ok(upload.assetId);
    assert.equal(upload.objectKey, `rooms/room-1/media/image/${upload.assetId}`);
    assert.equal(upload.uploadUrl, `https://upload.example/${encodeURIComponent(upload.objectKey)}`);
    assert.deepEqual(server.store.pendingMediaUploads.get(upload.assetId), {
      assetId: upload.assetId,
      roomId: 'room-1',
      objectKey: upload.objectKey,
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 123,
      uploadedByClientId: 'client-2',
      createdAt: server.store.pendingMediaUploads.get(upload.assetId)?.createdAt,
      expiresAt: server.store.pendingMediaUploads.get(upload.assetId)?.expiresAt,
    });

    const completeResponse = await fetch(`${server.baseUrl}/api/media/uploads/${upload.assetId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-2',
        roomId: 'room-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
        objectKey: upload.objectKey,
        username: 'Alice',
        width: 40,
        height: 30,
      }),
    });

    assert.equal(completeResponse.status, 201);
    const message = await completeResponse.json() as Message;
    assert.equal(message.clientId, 'client-2');
    assert.equal(message.roomId, 'room-1');
    assert.equal(message.messageType, 'media');
    assert.equal(message.mimeType, 'image/webp');
    assert.deepEqual(message.mediaAsset, {
      id: upload.assetId,
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 123,
      width: 40,
      height: 30,
    });
    assert.equal(server.store.appendedMessages[0].id, message.id);
    assert.equal(server.store.appendedMediaAssets[0].messageId, message.id);
    assert.equal(server.store.pendingMediaUploads.has(upload.assetId), false);
    const broadcastMessage = server.store.appendedMessages[0];
    assert.deepEqual(server.emitted, [
      { target: 'client-1', event: 'room_updated', payload: sampleRoom({ lastActivityAt: message.timestamp }) },
      { target: 'room-1', event: 'new_message', payload: broadcastMessage },
    ]);
  });

  it('creates file media messages with arbitrary MIME types and sanitized filenames', async () => {
    server.store.members.add('room-1:client-file');

    const uploadResponse = await fetch(`${server.baseUrl}/api/media/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-file',
        roomId: 'room-1',
        kind: 'file',
        mimeType: 'text/html',
        byteSize: 321,
        filename: '../docs/report.html',
      }),
    });
    assert.equal(uploadResponse.status, 201);
    const upload = await uploadResponse.json() as { assetId: string; objectKey: string; uploadUrl: string };
    assert.equal(upload.objectKey, `rooms/room-1/media/file/${upload.assetId}`);
    assert.equal(server.store.pendingMediaUploads.get(upload.assetId)?.filename, 'report.html');

    const completeResponse = await fetch(`${server.baseUrl}/api/media/uploads/${upload.assetId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-file',
        roomId: 'room-1',
        kind: 'file',
        mimeType: 'text/html',
        byteSize: 321,
        objectKey: upload.objectKey,
        filename: 'ignored.html',
      }),
    });

    assert.equal(completeResponse.status, 201);
    const message = await completeResponse.json() as Message;
    assert.deepEqual(message.mediaAsset, {
      id: upload.assetId,
      kind: 'file',
      mimeType: 'text/html',
      byteSize: 321,
      filename: 'report.html',
    });
    assert.equal(server.store.appendedMediaAssets[0].filename, 'report.html');
  });

  it('rejects media filenames containing line breaks', async () => {
    server.store.members.add('room-1:client-crlf');

    const uploadResponse = await fetch(`${server.baseUrl}/api/media/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-crlf',
        roomId: 'room-1',
        kind: 'file',
        mimeType: 'text/plain',
        byteSize: 12,
        filename: 'safe.txt\r\nContent-Disposition: inline',
      }),
    });
    assert.equal(uploadResponse.status, 400);
    assert.deepEqual(await uploadResponse.json(), { error: 'Filename must not contain line breaks' });

    const assetId = 'asset-crlf-complete';
    const objectKey = `rooms/room-1/media/file/${assetId}`;
    server.store.pendingMediaUploads.set(assetId, pendingUpload({
      assetId,
      objectKey,
      kind: 'file',
      mimeType: 'text/plain',
      byteSize: 12,
      uploadedByClientId: 'client-crlf',
    }));

    const completeResponse = await fetch(`${server.baseUrl}/api/media/uploads/${assetId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-crlf',
        roomId: 'room-1',
        kind: 'file',
        mimeType: 'text/plain',
        byteSize: 12,
        objectKey,
        filename: 'safe.txt\nx',
      }),
    });
    assert.equal(completeResponse.status, 400);
    assert.deepEqual(await completeResponse.json(), { error: 'Filename must not contain line breaks' });
  });

  it('limits generic file uploads to 50 MB', async () => {
    server.store.members.add('room-1:client-file-large');

    const response = await fetch(`${server.baseUrl}/api/media/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-file-large',
        roomId: 'room-1',
        kind: 'file',
        mimeType: 'application/zip',
        byteSize: 50 * 1024 * 1024 + 1,
        filename: 'archive.zip',
      }),
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'Media file is too large' });
  });

  it('requires initialized pending media uploads before completion', async () => {
    server.store.members.add('room-1:client-2');
    const assetId = 'asset-without-pending';
    const objectKey = `rooms/room-1/media/image/${assetId}`;

    const response = await fetch(`${server.baseUrl}/api/media/uploads/${assetId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-2',
        roomId: 'room-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
        objectKey,
      }),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Media upload was not initialized or has expired' });
    assert.equal(server.store.appendedMediaAssets.length, 0);
  });

  it('deletes pending uploads and objects when completed media object metadata mismatches', async () => {
    await server.close();
    const deletedObjects: string[] = [];
    let objectHead: { exists: boolean; byteSize?: number; mimeType?: string } = {
      exists: true,
      byteSize: 999,
      mimeType: 'image/webp',
    };
    server = await createTestServer({
      mediaObjectStorage: {
        isConfigured: () => true,
        async createWriteUrl({ objectKey }: { objectKey: string }) {
          return { url: `https://upload.example/${encodeURIComponent(objectKey)}`, expiresAt: '2026-05-03T00:15:00.000Z' };
        },
        async createReadUrl({ objectKey }: { objectKey: string }) {
          return { url: `https://download.example/${encodeURIComponent(objectKey)}`, expiresAt: '2026-05-03T00:15:00.000Z' };
        },
        async headObject() {
          return objectHead;
        },
        async deleteMediaObject(objectKey: string) {
          deletedObjects.push(objectKey);
        },
      },
    });
    server.store.members.add('room-1:client-2');

    const sizeAssetId = 'asset-size-mismatch';
    const sizeObjectKey = `rooms/room-1/media/image/${sizeAssetId}`;
    server.store.pendingMediaUploads.set(sizeAssetId, pendingUpload({
      assetId: sizeAssetId,
      objectKey: sizeObjectKey,
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 123,
    }));

    const sizeResponse = await fetch(`${server.baseUrl}/api/media/uploads/${sizeAssetId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-2',
        roomId: 'room-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
        objectKey: sizeObjectKey,
      }),
    });

    assert.equal(sizeResponse.status, 409);
    assert.deepEqual(await sizeResponse.json(), { error: 'Uploaded media object size does not match' });
    assert.equal(server.store.pendingMediaUploads.has(sizeAssetId), false);

    objectHead = { exists: true, byteSize: 123, mimeType: 'image/png' };
    const mimeAssetId = 'asset-mime-mismatch';
    const mimeObjectKey = `rooms/room-1/media/image/${mimeAssetId}`;
    server.store.pendingMediaUploads.set(mimeAssetId, pendingUpload({
      assetId: mimeAssetId,
      objectKey: mimeObjectKey,
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 123,
    }));

    const mimeResponse = await fetch(`${server.baseUrl}/api/media/uploads/${mimeAssetId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-2',
        roomId: 'room-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
        objectKey: mimeObjectKey,
      }),
    });

    assert.equal(mimeResponse.status, 409);
    assert.deepEqual(await mimeResponse.json(), { error: 'Uploaded media object MIME type does not match' });
    assert.equal(server.store.pendingMediaUploads.has(mimeAssetId), false);
    assert.deepEqual(deletedObjects, [sizeObjectKey, mimeObjectKey]);
    assert.equal(server.store.appendedMediaAssets.length, 0);
  });

  it('rate limits media upload URL creation', async () => {
    server.store.members.add('room-1:client-upload-rate');

    for (let index = 0; index < 20; index += 1) {
      const response = await fetch(`${server.baseUrl}/api/media/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: 'client-upload-rate',
          roomId: 'room-1',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 123,
        }),
      });
      assert.equal(response.status, 201);
    }

    const rateLimitedResponse = await fetch(`${server.baseUrl}/api/media/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-upload-rate',
        roomId: 'room-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
      }),
    });

    assert.equal(rateLimitedResponse.status, 429);
  });

  it('sweeps expired pending media uploads and deletes their objects', async () => {
    await server.close();
    let nowMs = Date.parse('2026-05-03T00:00:00.000Z');
    server = await createTestServer({
      mediaUploadCleanup: {
        pendingUploadTtlMs: 5,
        sweepIntervalMs: 10,
        nowMs: () => nowMs,
      },
    });
    server.store.members.add('room-1:client-2');

    const uploadResponse = await fetch(`${server.baseUrl}/api/media/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-2',
        roomId: 'room-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
      }),
    });
    assert.equal(uploadResponse.status, 201);
    const upload = await uploadResponse.json() as { assetId: string; objectKey: string };
    assert.equal(server.store.pendingMediaUploads.has(upload.assetId), true);

    nowMs += 6;
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(server.store.pendingMediaUploads.has(upload.assetId), false);
    assert.deepEqual(server.deletedMediaObjects, [upload.objectKey]);
  });

  it('supports local development media upload and download routes', async () => {
    await server.close();
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'roomtalk-route-media-'));
    server = await createTestServer({
      mediaObjectStorage: new LocalMediaObjectStorage(rootDir, new Logger('LocalMediaRouteTest')),
    });

    try {
      server.store.members.add('room-1:client-local-file');
      const bytes = Buffer.from('image-bytes');

      const uploadResponse = await fetch(`${server.baseUrl}/api/media/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: 'client-local-file',
          roomId: 'room-1',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: bytes.length,
        }),
      });

      assert.equal(uploadResponse.status, 201);
      const upload = await uploadResponse.json() as { assetId: string; objectKey: string; uploadUrl: string };
      assert.match(upload.uploadUrl, /^\/api\/media\/local-objects\//);

      const missingDownloadResponse = await fetch(`${server.baseUrl}${upload.uploadUrl}`);
      assert.equal(missingDownloadResponse.status, 404);
      assert.deepEqual(await missingDownloadResponse.json(), { error: 'Media object not found' });

      const putResponse = await fetch(`${server.baseUrl}${upload.uploadUrl}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/webp' },
        body: bytes,
      });
      assert.equal(putResponse.status, 204);

      const completeResponse = await fetch(`${server.baseUrl}/api/media/uploads/${upload.assetId}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: 'client-local-file',
          roomId: 'room-1',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: bytes.length,
          objectKey: upload.objectKey,
        }),
      });
      assert.equal(completeResponse.status, 201);

      const downloadUrlResponse = await fetch(`${server.baseUrl}/api/media/${upload.assetId}/download-url?roomId=room-1&clientId=client-local-file`);
      assert.equal(downloadUrlResponse.status, 200);
      const download = await downloadUrlResponse.json() as { url: string };
      assert.match(download.url, /^\/api\/media\/local-objects\//);

      const downloadResponse = await fetch(`${server.baseUrl}${download.url}`);
      assert.equal(downloadResponse.status, 200);
      assert.equal(downloadResponse.headers.get('content-type'), 'image/webp');
      assert.equal(Buffer.from(await downloadResponse.arrayBuffer()).toString('utf8'), 'image-bytes');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('passes attachment content disposition when creating file download URLs', async () => {
    await server.close();
    const readInputs: Array<{ objectKey: string; expiresInSeconds?: number; responseContentDisposition?: string }> = [];
    server = await createTestServer({
      mediaObjectStorage: {
        isConfigured: () => true,
        async putMediaObject() {},
        async createWriteUrl({ objectKey }: { objectKey: string }) {
          return { url: `https://upload.example/${encodeURIComponent(objectKey)}`, expiresAt: '2026-05-03T00:15:00.000Z' };
        },
        async createReadUrl(input: { objectKey: string; expiresInSeconds?: number; responseContentDisposition?: string }) {
          readInputs.push(input);
          return { url: `https://download.example/${encodeURIComponent(input.objectKey)}`, expiresAt: '2026-05-03T00:15:00.000Z' };
        },
        async headObject() {
          return { exists: true };
        },
      },
    });
    server.store.members.add('room-1:client-2');
    server.store.mediaAssets.set('file-asset-1', {
      id: 'file-asset-1',
      roomId: 'room-1',
      messageId: 'file-message-1',
      objectKey: 'rooms/room-1/media/file/file-asset-1',
      kind: 'file',
      mimeType: 'text/html',
      byteSize: 12,
      filename: 'report final.html',
      uploadedByClientId: 'client-2',
      createdAt: '2026-05-03T00:00:00.000Z',
    });

    const response = await fetch(`${server.baseUrl}/api/media/file-asset-1/download-url?roomId=room-1&clientId=client-2`);

    assert.equal(response.status, 200);
    assert.equal(readInputs[0]?.responseContentDisposition, "attachment; filename*=UTF-8''report%20final.html");
  });

  it('forces attachment disposition for local file object downloads', async () => {
    await server.close();
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'roomtalk-route-file-media-'));
    server = await createTestServer({
      mediaObjectStorage: new LocalMediaObjectStorage(rootDir, new Logger('LocalFileMediaRouteTest')),
    });

    try {
      server.store.members.add('room-1:client-local-html');
      const bytes = Buffer.from('<script>alert(1)</script>');

      const uploadResponse = await fetch(`${server.baseUrl}/api/media/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: 'client-local-html',
          roomId: 'room-1',
          kind: 'file',
          mimeType: 'text/html',
          byteSize: bytes.length,
          filename: 'index.html',
        }),
      });
      assert.equal(uploadResponse.status, 201);
      const upload = await uploadResponse.json() as { assetId: string; objectKey: string; uploadUrl: string };

      const putResponse = await fetch(`${server.baseUrl}${upload.uploadUrl}`, {
        method: 'PUT',
        headers: { 'content-type': 'text/html' },
        body: bytes,
      });
      assert.equal(putResponse.status, 204);

      const completeResponse = await fetch(`${server.baseUrl}/api/media/uploads/${upload.assetId}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: 'client-local-html',
          roomId: 'room-1',
          kind: 'file',
          mimeType: 'text/html',
          byteSize: bytes.length,
          objectKey: upload.objectKey,
        }),
      });
      assert.equal(completeResponse.status, 201);

      const downloadUrlResponse = await fetch(`${server.baseUrl}/api/media/${upload.assetId}/download-url?roomId=room-1&clientId=client-local-html`);
      assert.equal(downloadUrlResponse.status, 200);
      const download = await downloadUrlResponse.json() as { url: string };

      const downloadResponse = await fetch(`${server.baseUrl}${download.url}`);
      assert.equal(downloadResponse.status, 200);
      assert.match(downloadResponse.headers.get('content-disposition') || '', /^attachment;/);
      assert.equal(downloadResponse.headers.get('content-disposition'), "attachment; filename*=UTF-8''index.html");
      assert.equal(Buffer.from(await downloadResponse.arrayBuffer()).toString('utf8'), '<script>alert(1)</script>');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('does not expose local media object routes for non-local storage implementations', async () => {
    await server.close();
    let putCalled = false;
    server = await createTestServer({
      mediaObjectStorage: {
        isConfigured: () => true,
        async putMediaObject() {
          putCalled = true;
        },
        async createWriteUrl({ objectKey }: { objectKey: string }) {
          return { url: `https://upload.example/${encodeURIComponent(objectKey)}`, expiresAt: '2026-05-03T00:15:00.000Z' };
        },
        async createReadUrl({ objectKey }: { objectKey: string }) {
          return { url: `https://download.example/${encodeURIComponent(objectKey)}`, expiresAt: '2026-05-03T00:15:00.000Z' };
        },
        async headObject() {
          return { exists: true };
        },
        async getMediaObject() {
          return { body: Buffer.from('stored'), mimeType: 'text/html', byteSize: 6 };
        },
      },
    });

    const encodedObjectKey = Buffer.from('rooms/room-1/media/image/asset-1', 'utf8').toString('base64url');
    const putResponse = await fetch(`${server.baseUrl}/api/media/local-objects/${encodedObjectKey}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: '<script>alert(1)</script>',
    });
    assert.equal(putResponse.status, 404);
    assert.equal(putCalled, false);

    const getResponse = await fetch(`${server.baseUrl}/api/media/local-objects/${encodedObjectKey}`);
    assert.equal(getResponse.status, 404);
  });

  it('returns paginated recent image and video history for a room', async () => {
    server.store.members.add('room-1:client-2');
    server.store.readMediaAssetsByRoom = async () => {
      throw new Error('media history route must use readMediaHistoryPageByRoom');
    };
    server.store.mediaAssets.set('image-new', {
      id: 'image-new',
      roomId: 'room-1',
      messageId: 'message-image-new',
      objectKey: 'rooms/room-1/media/image/image-new',
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 123,
      width: 40,
      height: 30,
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    server.store.mediaAssets.set('video-new', {
      id: 'video-new',
      roomId: 'room-1',
      messageId: 'message-video-new',
      objectKey: 'rooms/room-1/media/video/video-new',
      kind: 'video',
      mimeType: 'video/mp4',
      byteSize: 456,
      durationMs: 1200,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    server.store.mediaAssets.set('audio-hidden', {
      id: 'audio-hidden',
      roomId: 'room-1',
      messageId: 'message-audio',
      objectKey: 'rooms/room-1/media/audio/audio-hidden',
      kind: 'audio',
      mimeType: 'audio/webm',
      byteSize: 456,
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    server.store.mediaAssets.set('old-hidden', {
      id: 'old-hidden',
      roomId: 'room-1',
      messageId: 'message-old',
      objectKey: 'rooms/room-1/media/image/old-hidden',
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 123,
      createdAt: '2025-01-01T00:00:00.000Z',
    });

    const firstResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/media-history?clientId=client-2&limit=1`);
    assert.equal(firstResponse.status, 200);
    const firstPage = await firstResponse.json() as { items: Array<{ assetId: string; kind: string; url: string }>; hasMore: boolean; nextCursor: string | null; windowMonths: number };

    assert.equal(firstPage.windowMonths, 6);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0].assetId, 'image-new');
    assert.equal(firstPage.items[0].kind, 'image');
    assert.equal(firstPage.items[0].url, 'https://download.example/rooms%2Froom-1%2Fmedia%2Fimage%2Fimage-new');
    assert.ok(firstPage.nextCursor);

    const secondResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/media-history?clientId=client-2&limit=10&before=${encodeURIComponent(firstPage.nextCursor!)}`);
    assert.equal(secondResponse.status, 200);
    const secondPage = await secondResponse.json() as { items: Array<{ assetId: string }>; hasMore: boolean };

    assert.equal(secondPage.hasMore, false);
    assert.deepEqual(secondPage.items.map(item => item.assetId), ['video-new']);

    const videoOnlyResponse = await fetch(`${server.baseUrl}/api/rooms/room-1/media-history?clientId=client-2&limit=10&kind=video`);
    assert.equal(videoOnlyResponse.status, 200);
    const videoOnlyPage = await videoOnlyResponse.json() as { items: Array<{ assetId: string; kind: string }>; hasMore: boolean };

    assert.equal(videoOnlyPage.hasMore, false);
    assert.deepEqual(videoOnlyPage.items.map(item => item.assetId), ['video-new']);
    assert.deepEqual(videoOnlyPage.items.map(item => item.kind), ['video']);
  });

  it('rejects media history requests without room access', async () => {
    const response = await fetch(`${server.baseUrl}/api/rooms/room-1/media-history?clientId=client-2`);

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Not authorized to access this room' });
  });

  it('does not use separate media asset and message writes when completing media uploads', async () => {
    server.store.members.add('room-1:client-2');
    server.store.saveMediaAsset = async () => {
      throw new Error('saveMediaAsset must not be used by media complete');
    };
    server.store.appendMessage = async () => {
      throw new Error('appendMessage must not be used by media complete');
    };

    const assetId = 'asset-atomic-only';
    const objectKey = `rooms/room-1/media/audio/${assetId}`;
    server.store.pendingMediaUploads.set(assetId, pendingUpload({ assetId, objectKey }));
    const response = await fetch(`${server.baseUrl}/api/media/uploads/${assetId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-2',
        roomId: 'room-1',
        kind: 'audio',
        mimeType: 'audio/webm',
        byteSize: 456,
        objectKey,
      }),
    });

    assert.equal(response.status, 201);
    const message = await response.json() as Message;
    assert.equal(message.messageType, 'media');
    assert.equal(message.mediaAsset?.id, assetId);
    assert.equal(server.store.appendedMessages.length, 1);
    assert.equal(server.store.appendedMediaAssets.length, 1);
    assert.equal(server.store.pendingMediaUploads.has(assetId), false);
  });

  it('does not emit ghost media messages and deletes uploaded objects when atomic persistence fails', async () => {
    server.store.members.add('room-1:client-2');
    server.store.appendMediaMessageWithAsset = async () => null;
    const assetId = 'asset-fail';
    const objectKey = `rooms/room-1/media/audio/${assetId}`;
    server.store.pendingMediaUploads.set(assetId, pendingUpload({ assetId, objectKey }));

    const response = await fetch(`${server.baseUrl}/api/media/uploads/${assetId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-2',
        roomId: 'room-1',
        kind: 'audio',
        mimeType: 'audio/webm',
        byteSize: 456,
        objectKey,
      }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Failed to create media message' });
    assert.deepEqual(server.emitted, []);
    assert.deepEqual(server.deletedMediaObjects, [objectKey]);
    assert.equal(server.store.pendingMediaUploads.has(assetId), false);
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
