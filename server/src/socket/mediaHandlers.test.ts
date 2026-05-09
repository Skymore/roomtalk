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
  const store = {
    clientId,
    appendedMessages: [] as Message[],
    async getClientId() {
      return this.clientId;
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
  } as any);

  return { io, socket, store };
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

  it('reassembles image chunks, converts to webp, stores, and broadcasts an image message', async () => {
    const imageBuffer = await createTinyPng();
    const firstChunk = imageBuffer.subarray(0, Math.ceil(imageBuffer.length / 2));
    const secondChunk = imageBuffer.subarray(Math.ceil(imageBuffer.length / 2));
    const { io, socket, store } = createHarness('client-2');

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
    assert.ok(Buffer.from(created.content, 'base64').length > 0);
    assert.deepEqual(io.roomEmits, [
      { roomId: 'client-1', event: 'room_updated', args: [room({ lastActivityAt: created.timestamp })] },
      { roomId: 'room-1', event: 'new_message', args: [created] },
    ]);
    assert.deepEqual(socket.emitted, []);
  });

  it('does not broadcast image messages when persistence fails', async () => {
    const imageBuffer = await createTinyPng();
    const { io, socket, store } = createHarness('client-2');
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
    assert.deepEqual(io.roomEmits, []);
    assert.deepEqual(socket.emitted, [{ event: 'error', args: [{ message: 'Failed to save image message' }] }]);
  });
});
