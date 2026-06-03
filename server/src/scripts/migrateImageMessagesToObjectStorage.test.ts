import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import {
  assertBackupBeforeExecute,
  LegacyImageMigrationStore,
  migrateLegacyImageMessagesToObjectStorage,
} from './migrateImageMessagesToObjectStorage';
import { ImageAsset, Message, Room } from '../types';

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  lastActivityAt: '2026-05-03T00:00:10.000Z',
  creatorId: 'client-1',
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'message-1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T00:00:01.000Z',
  messageType: 'text',
  ...overrides,
});

const createTinyPngBase64 = async () => {
  const buffer = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  }).png().toBuffer();
  return buffer.toString('base64');
};

class MemoryLegacyImageMigrationStore implements LegacyImageMigrationStore {
  assetsByMessageId = new Map<string, ImageAsset>();
  replacements: Array<{ roomId: string; messageId: string; asset: ImageAsset }> = [];
  failReplace = false;

  constructor(
    readonly rooms: Room[],
    readonly messagesByRoom: Map<string, Message[]>,
  ) {}

  async readRoomIdsWithImageMessages(roomId?: string) {
    return this.rooms
      .map(item => item.id)
      .filter(item => !roomId || item === roomId)
      .filter(item => (this.messagesByRoom.get(item) || []).some(candidate => candidate.messageType === 'image'));
  }

  async readMessagesByRoom(roomId: string) {
    return this.messagesByRoom.get(roomId) || [];
  }

  async getImageAssetByMessageId(messageId: string) {
    return this.assetsByMessageId.get(messageId) || null;
  }

  async replaceMessageImageAsset(roomId: string, messageId: string, asset: ImageAsset) {
    this.replacements.push({ roomId, messageId, asset });
    if (this.failReplace) {
      return null;
    }

    const messages = this.messagesByRoom.get(roomId) || [];
    const index = messages.findIndex(item => item.id === messageId && item.messageType === 'image');
    if (index === -1) {
      return { room: room({ id: roomId }), found: false };
    }

    this.assetsByMessageId.set(messageId, asset);
    const updatedMessage: Message = {
      ...messages[index],
      content: asset.id,
      mimeType: asset.mimeType,
      imageAsset: {
        id: asset.id,
        mimeType: asset.mimeType,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
      },
    };
    messages[index] = updatedMessage;
    this.messagesByRoom.set(roomId, messages);
    return { room: room({ id: roomId }), found: true, updatedMessage };
  }
}

const createImageObjectStorage = () => ({
  uploadedObjects: [] as Array<{ objectKey: string; body: Buffer; mimeType: string; byteSize: number }>,
  deletedObjects: [] as string[],
  configured: true,
  isConfigured() {
    return this.configured;
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
});

describe('migrateLegacyImageMessagesToObjectStorage', () => {
  it('scans legacy base64 image messages during dry-run without writing objects or messages', async () => {
    const legacyBase64 = await createTinyPngBase64();
    const store = new MemoryLegacyImageMigrationStore(
      [room()],
      new Map([['room-1', [
        message({
          id: 'legacy-image',
          content: `data:image/png;base64,${legacyBase64}`,
          messageType: 'image',
          mimeType: 'image/png',
        }),
      ]]])
    );
    const imageObjectStorage = createImageObjectStorage();

    const stats = await migrateLegacyImageMessagesToObjectStorage({
      store,
      imageObjectStorage,
      dryRun: true,
    });

    assert.equal(stats.roomsScanned, 1);
    assert.equal(stats.messagesScanned, 1);
    assert.equal(stats.legacyImagesFound, 1);
    assert.equal(stats.imagesMigrated, 0);
    assert.equal(stats.failures.length, 0);
    assert.ok(stats.originalBytes > 0);
    assert.ok(stats.objectBytes > 0);
    assert.equal(imageObjectStorage.uploadedObjects.length, 0);
    assert.equal(store.replacements.length, 0);
  });

  it('uploads converted WebP objects and replaces message payloads during execute runs', async () => {
    const legacyBase64 = await createTinyPngBase64();
    const store = new MemoryLegacyImageMigrationStore(
      [room()],
      new Map([['room-1', [
        message({
          id: 'legacy-image',
          content: legacyBase64,
          messageType: 'image',
          mimeType: 'image/png',
        }),
      ]]])
    );
    const imageObjectStorage = createImageObjectStorage();

    const stats = await migrateLegacyImageMessagesToObjectStorage({
      store,
      imageObjectStorage,
      dryRun: false,
    });

    assert.equal(stats.imagesMigrated, 1);
    assert.equal(stats.failures.length, 0);
    assert.equal(imageObjectStorage.uploadedObjects.length, 1);
    assert.equal(imageObjectStorage.uploadedObjects[0].mimeType, 'image/webp');
    assert.match(imageObjectStorage.uploadedObjects[0].objectKey, /^rooms\/room-1\/.+\.webp$/);
    assert.equal(store.replacements.length, 1);

    const [updatedMessage] = await store.readMessagesByRoom('room-1');
    assert.equal(updatedMessage.content, store.replacements[0].asset.id);
    assert.equal(updatedMessage.mimeType, 'image/webp');
    assert.deepEqual(updatedMessage.imageAsset, {
      id: store.replacements[0].asset.id,
      mimeType: 'image/webp',
      byteSize: imageObjectStorage.uploadedObjects[0].byteSize,
      width: 1,
      height: 1,
    });
  });

  it('skips existing image assets and unsupported image payloads', async () => {
    const store = new MemoryLegacyImageMigrationStore(
      [room()],
      new Map([['room-1', [
        message({
          id: 'asset-backed',
          content: 'asset-1',
          messageType: 'image',
          mimeType: 'image/webp',
          imageAsset: {
            id: 'asset-1',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        }),
        message({
          id: 'unsupported',
          content: 'AAAA',
          messageType: 'image',
          mimeType: 'application/octet-stream',
        }),
      ]]])
    );

    const stats = await migrateLegacyImageMessagesToObjectStorage({
      store,
      imageObjectStorage: createImageObjectStorage(),
      dryRun: true,
    });

    assert.equal(stats.legacyImagesFound, 0);
    assert.equal(stats.skippedExistingAssets, 1);
    assert.equal(stats.skippedUnsupportedImages, 1);
    assert.equal(stats.failures.length, 0);
  });

  it('records parse failures for malformed base64 images', async () => {
    const store = new MemoryLegacyImageMigrationStore(
      [room()],
      new Map([['room-1', [
        message({
          id: 'broken-image',
          content: 'not-base64!',
          messageType: 'image',
          mimeType: 'image/png',
        }),
      ]]])
    );

    const stats = await migrateLegacyImageMessagesToObjectStorage({
      store,
      imageObjectStorage: createImageObjectStorage(),
      dryRun: true,
    });

    assert.equal(stats.legacyImagesFound, 0);
    assert.deepEqual(stats.failures, [{
      roomId: 'room-1',
      messageId: 'broken-image',
      stage: 'parse',
      error: 'Image content is not valid base64',
    }]);
  });

  it('deletes uploaded objects when database replacement fails', async () => {
    const legacyBase64 = await createTinyPngBase64();
    const store = new MemoryLegacyImageMigrationStore(
      [room()],
      new Map([['room-1', [
        message({
          id: 'legacy-image',
          content: legacyBase64,
          messageType: 'image',
          mimeType: 'image/png',
        }),
      ]]])
    );
    store.failReplace = true;
    const imageObjectStorage = createImageObjectStorage();

    const stats = await migrateLegacyImageMessagesToObjectStorage({
      store,
      imageObjectStorage,
      dryRun: false,
    });

    assert.equal(stats.imagesMigrated, 0);
    assert.equal(stats.failures.length, 1);
    assert.equal(stats.failures[0].stage, 'replace');
    assert.equal(imageObjectStorage.uploadedObjects.length, 1);
    assert.deepEqual(imageObjectStorage.deletedObjects, [imageObjectStorage.uploadedObjects[0].objectKey]);
  });

  it('requires a non-empty backup file before execute runs', () => {
    assert.doesNotThrow(() => assertBackupBeforeExecute(true));
    assert.throws(() => assertBackupBeforeExecute(false), /verified database backup/);

    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomtalk-backup-'));
    const emptyBackupFile = path.join(backupDir, 'empty.dump');
    const backupFile = path.join(backupDir, 'message-system.dump');
    fs.writeFileSync(emptyBackupFile, '');
    fs.writeFileSync(backupFile, 'verified backup');

    assert.throws(() => assertBackupBeforeExecute(false, emptyBackupFile), /empty or invalid/);
    assert.doesNotThrow(() => assertBackupBeforeExecute(false, backupFile));
  });
});
