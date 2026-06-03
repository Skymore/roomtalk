import assert from 'assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { registerMediaHandlers } from './mediaHandlers';
import { Message, Room } from '../types';

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
  warn() {},
  info() {},
};

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  ...overrides,
});

const createHarness = (clientId: string | null = 'client-1') => {
  const socket = new FakeSocket();
  const io = new FakeIo();
  const imageObjectStorage = {
    uploadedObjects: [] as Array<{ objectKey: string; body: Buffer; mimeType: string; byteSize: number }>,
    deletedObjects: [] as string[],
    isConfigured() {
      return true;
    },
    async putImageObject(input: { objectKey: string; body: Buffer; mimeType: string; byteSize: number }) {
      this.uploadedObjects.push(input);
    },
    async createReadUrl(input: { objectKey: string }) {
      return {
        url: `https://signed.example/${input.objectKey}`,
        expiresAt: '2026-05-03T00:15:00.000Z',
      };
    },
    async deleteImageObject(objectKey: string) {
      this.deletedObjects.push(objectKey);
    },
  };
  const store = {
    clientId,
    rooms: [room()],
    members: new Set(['room-1:client-1', 'room-1:client-2']),
    appendedMessages: [] as Message[],
    imageAssets: new Map<string, any>(),
    async getClientId() {
      return this.clientId;
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
    async saveImageAsset(asset: any) {
      this.imageAssets.set(asset.id, asset);
      return asset;
    },
    async getImageAsset(assetId: string) {
      return this.imageAssets.get(assetId) || null;
    },
    async getImageAssetByMessageId(messageId: string) {
      return [...this.imageAssets.values()].find(asset => asset.messageId === messageId) || null;
    },
    async readImageAssetsByRoom(roomId: string) {
      return [...this.imageAssets.values()].filter(asset => asset.roomId === roomId);
    },
    async deleteImageAsset(assetId: string) {
      this.imageAssets.delete(assetId);
    },
    async appendMessage(message: Message) {
      this.appendedMessages.push(message);
      return room({ lastActivityAt: message.timestamp });
    },
  };

  registerMediaHandlers({
    io: io as any,
    socket: socket as any,
    store: store as any,
    socketLogger: logger as any,
    imageObjectStorage: imageObjectStorage as any,
  } as any);

  return { io, socket, store, imageObjectStorage };
};

const createTinyPng = async () => {
  return sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  }).png().toBuffer();
};

describe('media socket handlers', () => {
  it('requires registration before starting an image upload', async () => {
    const { socket } = createHarness(null);

    await socket.invoke('start_image_upload', {
      fileId: 'file-1',
      totalChunks: 1,
      roomId: 'room-1',
    });

    assert.deepEqual(socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);
  });

  it('reports chunk and completion errors for missing or incomplete uploads', async () => {
    const { socket } = createHarness();

    await socket.invoke('upload_image_chunk', {
      fileId: 'missing',
      chunkIndex: 0,
      chunkData: Buffer.from('chunk').toString('base64'),
    });
    assert.deepEqual(socket.emitted[0], { event: 'error', args: [{ message: 'No upload session for this fileId' }] });

    await socket.invoke('start_image_upload', {
      fileId: 'file-1',
      totalChunks: 2,
      roomId: 'room-1',
    });
    await socket.invoke('upload_image_chunk', {
      fileId: 'file-1',
      chunkIndex: 5,
      chunkData: Buffer.from('chunk').toString('base64'),
    });
    await socket.invoke('finish_image_upload', { fileId: 'file-1' });

    assert.deepEqual(socket.emitted.slice(1), [
      { event: 'error', args: [{ message: 'Invalid chunk index' }] },
      { event: 'error', args: [{ message: 'Not all chunks received' }] },
    ]);
  });

  it('rejects invalid image upload declarations and chunks from unregistered sockets', async () => {
    const unregistered = createHarness(null);
    await unregistered.socket.invoke('upload_image_chunk', {
      fileId: 'missing',
      chunkIndex: 0,
      chunkData: Buffer.from('chunk').toString('base64'),
    });
    assert.deepEqual(unregistered.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);

    const { socket } = createHarness();
    await socket.invoke('start_image_upload', {
      fileId: 'too-many',
      totalChunks: 300,
      roomId: 'room-1',
    });
    assert.deepEqual(socket.emitted, [{ event: 'error', args: [{ message: 'Invalid image upload' }] }]);
  });

  it('reassembles image chunks, converts to webp, uploads an image asset, and broadcasts metadata', async () => {
    const imageBuffer = await createTinyPng();
    const firstChunk = imageBuffer.subarray(0, Math.ceil(imageBuffer.length / 2));
    const secondChunk = imageBuffer.subarray(Math.ceil(imageBuffer.length / 2));
    const { io, socket, store, imageObjectStorage } = createHarness('client-2');

    await socket.invoke('start_image_upload', {
      fileId: 'file-1',
      totalChunks: 2,
      roomId: 'room-1',
    });
    await socket.invoke('upload_image_chunk', {
      fileId: 'file-1',
      chunkIndex: 1,
      chunkData: secondChunk.toString('base64'),
    });
    await socket.invoke('upload_image_chunk', {
      fileId: 'file-1',
      chunkIndex: 0,
      chunkData: firstChunk.toString('base64'),
    });
    await socket.invoke('finish_image_upload', {
      fileId: 'file-1',
      username: 'Ada',
      avatar: { text: 'A', color: 'primary' },
    });

    assert.equal(store.appendedMessages.length, 1);
    const created = store.appendedMessages[0];
    assert.equal(created.clientId, 'client-2');
    assert.equal(created.roomId, 'room-1');
    assert.equal(created.messageType, 'image');
    assert.equal(created.mimeType, 'image/webp');
    assert.equal(created.username, 'Ada');
    assert.ok(created.imageAsset);
    assert.equal(created.content, created.imageAsset!.id);
    assert.equal(created.imageAsset!.mimeType, 'image/webp');
    assert.equal(created.imageAsset!.byteSize, imageObjectStorage.uploadedObjects[0].byteSize);
    assert.equal(imageObjectStorage.uploadedObjects.length, 1);
    assert.match(imageObjectStorage.uploadedObjects[0].objectKey, /^rooms\/room-1\/.+\.webp$/);
    assert.ok(imageObjectStorage.uploadedObjects[0].body.length > 0);
    assert.deepEqual(io.roomEmits, [
      { roomId: 'client-1', event: 'room_updated', args: [room({ lastActivityAt: created.timestamp })] },
      { roomId: 'room-1', event: 'new_message', args: [created] },
    ]);
    assert.deepEqual(socket.emitted, []);
  });

  it('does not broadcast image messages when persistence fails', async () => {
    const imageBuffer = await createTinyPng();
    const { io, socket, store, imageObjectStorage } = createHarness('client-2');
    store.appendMessage = async (message: Message) => {
      store.appendedMessages.push(message);
      return null as any;
    };

    await socket.invoke('start_image_upload', {
      fileId: 'file-fail',
      totalChunks: 1,
      roomId: 'room-1',
    });
    await socket.invoke('upload_image_chunk', {
      fileId: 'file-fail',
      chunkIndex: 0,
      chunkData: imageBuffer.toString('base64'),
    });
    await socket.invoke('finish_image_upload', { fileId: 'file-fail' });

    assert.equal(store.appendedMessages.length, 1);
    assert.equal(store.imageAssets.size, 0);
    assert.equal(imageObjectStorage.deletedObjects.length, 1);
    assert.deepEqual(io.roomEmits, []);
    assert.deepEqual(socket.emitted, [{ event: 'error', args: [{ message: 'Failed to save image message' }] }]);
  });

  it('returns signed image URLs only to room members', async () => {
    const { socket, store } = createHarness('client-2');
    const asset = {
      id: 'asset-1',
      roomId: 'room-1',
      messageId: 'message-1',
      objectKey: 'rooms/room-1/asset-1.webp',
      mimeType: 'image/webp',
      byteSize: 123,
      createdAt: '2026-05-03T00:00:00.000Z',
    };
    await store.saveImageAsset(asset);

    let response: unknown;
    await socket.invoke('get_image_download_url', { roomId: 'room-1', assetId: 'asset-1' }, (ack: unknown) => {
      response = ack;
    });

    assert.deepEqual(response, {
      success: true,
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T00:15:00.000Z',
    });

    store.members.clear();
    let deniedResponse: unknown;
    await socket.invoke('get_image_download_url', { roomId: 'room-1', assetId: 'asset-1' }, (ack: unknown) => {
      deniedResponse = ack;
    });
    assert.deepEqual(deniedResponse, { success: false, error: 'You are not authorized to access this room' });
  });
});
