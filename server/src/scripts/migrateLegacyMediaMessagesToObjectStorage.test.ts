import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Message, MediaAsset, Room } from '../types';
import {
  LegacyMediaMigrationStore,
  migrateLegacyMediaMessagesToObjectStorage,
} from './migrateLegacyMediaMessagesToObjectStorage';

const ONE_PIXEL_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
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

class FakeMigrationStore implements LegacyMediaMigrationStore {
  messages: Message[];
  legacyImageAssets: Array<{
    id: string;
    roomId: string;
    messageId?: string;
    objectKey: string;
    mimeType: string;
    byteSize: number;
    width?: number;
    height?: number;
    createdAt: string;
  }>;
  mediaAssetsByMessageId = new Map<string, MediaAsset>();
  replacements: Array<{ roomId: string; messageId: string; asset: MediaAsset }> = [];

  constructor(input: {
    messages: Message[];
    legacyImageAssets?: FakeMigrationStore['legacyImageAssets'];
  }) {
    this.messages = input.messages;
    this.legacyImageAssets = input.legacyImageAssets || [];
  }

  async readRoomIdsWithLegacyMediaMessages(roomId?: string) {
    const roomIds = [...new Set(this.messages
      .filter(item => item.messageType === 'image' || item.messageType === 'voice')
      .map(item => item.roomId))];
    return roomId ? roomIds.filter(id => id === roomId) : roomIds;
  }

  async readMessagesByRoom(roomId: string) {
    return this.messages.filter(item => item.roomId === roomId);
  }

  async readLegacyImageAssetsByRoom(roomId: string) {
    return this.legacyImageAssets.filter(asset => asset.roomId === roomId);
  }

  async getMediaAssetByMessageId(messageId: string) {
    return this.mediaAssetsByMessageId.get(messageId) || null;
  }

  async replaceMessageMediaAsset(roomId: string, messageId: string, asset: MediaAsset) {
    const index = this.messages.findIndex(item => item.roomId === roomId && item.id === messageId);
    if (index === -1) {
      return { room: room({ id: roomId }), found: false };
    }

    this.replacements.push({ roomId, messageId, asset });
    this.mediaAssetsByMessageId.set(messageId, asset);
    this.messages[index] = {
      ...this.messages[index],
      content: '',
      messageType: 'media',
      mimeType: asset.mimeType,
      mediaAsset: {
        id: asset.id,
        kind: asset.kind,
        mimeType: asset.mimeType,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
        durationMs: asset.durationMs,
      },
    };
    return { room: room({ id: roomId }), found: true, updatedMessage: this.messages[index] };
  }
}

class FakeMediaObjectStorage {
  uploads: Array<{ objectKey: string; mimeType: string; byteSize: number; body: Buffer }> = [];

  isConfigured() {
    return true;
  }

  async putMediaObject(input: { objectKey: string; body: Buffer; mimeType: string; byteSize: number }) {
    this.uploads.push(input);
  }

  async createWriteUrl() {
    return { url: 'https://upload.example/object', expiresAt: '2026-05-03T00:15:00.000Z' };
  }

  async createReadUrl() {
    return { url: 'https://download.example/object', expiresAt: '2026-05-03T00:15:00.000Z' };
  }

  async headObject() {
    return { exists: true };
  }
}

describe('migrateLegacyMediaMessagesToObjectStorage', () => {
  it('dry-runs legacy image, voice, and existing image assets without writing', async () => {
    const store = new FakeMigrationStore({
      messages: [
        message({ id: 'legacy-image', content: ONE_PIXEL_PNG_DATA_URL, messageType: 'image', mimeType: 'image/png' }),
        message({ id: 'legacy-voice', content: Buffer.from('voice').toString('base64'), messageType: 'voice', mimeType: 'audio/webm' }),
        message({ id: 'existing-image', content: 'existing-asset', messageType: 'image', mimeType: 'image/webp' }),
      ],
      legacyImageAssets: [{
        id: 'existing-asset',
        roomId: 'room-1',
        messageId: 'existing-image',
        objectKey: 'rooms/room-1/old/existing.webp',
        mimeType: 'image/webp',
        byteSize: 10,
        width: 1,
        height: 1,
        createdAt: '2026-05-03T00:00:00.000Z',
      }],
    });
    const storage = new FakeMediaObjectStorage();

    const stats = await migrateLegacyMediaMessagesToObjectStorage({
      store,
      mediaObjectStorage: storage,
      dryRun: true,
    });

    assert.equal(stats.legacyImageMessagesFound, 1);
    assert.equal(stats.legacyAudioMessagesFound, 1);
    assert.equal(stats.existingImageAssetsFound, 1);
    assert.equal(stats.mediaMigrated, 0);
    assert.equal(storage.uploads.length, 0);
    assert.equal(store.replacements.length, 0);
  });

  it('executes media migration and records invalid base64 without aborting', async () => {
    const store = new FakeMigrationStore({
      messages: [
        message({ id: 'legacy-image', content: ONE_PIXEL_PNG_DATA_URL, messageType: 'image', mimeType: 'image/png' }),
        message({ id: 'legacy-voice', content: Buffer.from('voice').toString('base64'), messageType: 'voice', mimeType: 'audio/webm' }),
        message({ id: 'existing-image', content: 'existing-asset', messageType: 'image', mimeType: 'image/webp' }),
        message({ id: 'bad-voice', content: 'not valid base64!', messageType: 'voice', mimeType: 'audio/webm' }),
      ],
      legacyImageAssets: [{
        id: 'existing-asset',
        roomId: 'room-1',
        messageId: 'existing-image',
        objectKey: 'rooms/room-1/old/existing.webp',
        mimeType: 'image/webp',
        byteSize: 10,
        width: 1,
        height: 1,
        createdAt: '2026-05-03T00:00:00.000Z',
      }],
    });
    const storage = new FakeMediaObjectStorage();

    const stats = await migrateLegacyMediaMessagesToObjectStorage({
      store,
      mediaObjectStorage: storage,
      dryRun: false,
    });

    assert.equal(stats.mediaMigrated, 3);
    assert.equal(stats.unableToParseMessageIds.includes('bad-voice'), true);
    assert.equal(storage.uploads.length, 2);
    assert.deepEqual(store.replacements.map(item => item.asset.kind).sort(), ['audio', 'image', 'image']);
    assert.deepEqual(store.messages.filter(item => item.messageType === 'media').map(item => item.id).sort(), [
      'existing-image',
      'legacy-image',
      'legacy-voice',
    ]);
    assert.equal(store.mediaAssetsByMessageId.get('existing-image')?.objectKey, 'rooms/room-1/old/existing.webp');
  });

  it('migrates voice data URLs that carry codec parameters', async () => {
    const audioBase64 = Buffer.from('opus-voice-bytes').toString('base64');
    const store = new FakeMigrationStore({
      messages: [
        message({
          id: 'codec-voice',
          content: `data:audio/webm;codecs=opus;base64,${audioBase64}`,
          messageType: 'voice',
          mimeType: 'audio/webm',
        }),
      ],
    });
    const storage = new FakeMediaObjectStorage();

    const stats = await migrateLegacyMediaMessagesToObjectStorage({ store, mediaObjectStorage: storage, dryRun: false });

    assert.equal(stats.legacyAudioMessagesFound, 1);
    assert.equal(stats.unableToParseMessageIds.length, 0);
    assert.equal(stats.failures.length, 0);
    assert.equal(stats.mediaMigrated, 1);
    assert.equal(storage.uploads.length, 1);
    const asset = store.mediaAssetsByMessageId.get('codec-voice');
    assert.equal(asset?.kind, 'audio');
    assert.equal(asset?.mimeType, 'audio/webm');
  });
});
