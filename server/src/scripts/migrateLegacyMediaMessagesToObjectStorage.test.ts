import assert from 'assert/strict';
import { describe, it } from 'node:test';
import {
  assertMayRunExecuteMigration,
  buildMediaObjectKey,
  isServingFlyAppVm,
  LegacyImageConversion,
  LegacyMediaMigrationSource,
  LegacyMediaMigrationTarget,
  migrateLegacyMediaMessagesToObjectStorage,
  parseCliOptions,
  parseLegacyImageDataUrl,
} from './migrateLegacyMediaMessagesToObjectStorage';
import { MediaAsset, Message, Room } from '../types';

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  lastActivityAt: '2026-05-03T00:00:00.000Z',
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

const legacyImageContent = (body = 'legacy image bytes') => (
  `data:image/png;base64,${Buffer.from(body, 'utf8').toString('base64')}`
);

const convertedImage = (overrides: Partial<LegacyImageConversion> = {}): LegacyImageConversion => ({
  body: Buffer.from('converted-webp'),
  mimeType: 'image/webp',
  byteSize: Buffer.byteLength('converted-webp'),
  width: 12,
  height: 8,
  ...overrides,
});

class MemoryLegacyMediaSource implements LegacyMediaMigrationSource {
  assetByMessageId = new Map<string, MediaAsset>();

  constructor(
    readonly rooms: Room[],
    readonly messagesByRoom: Map<string, Message[]>
  ) {}

  async readRooms() {
    return this.rooms;
  }

  async readMessagesByRoom(roomId: string) {
    return this.messagesByRoom.get(roomId) || [];
  }

  async getMediaAssetByMessageId(messageId: string) {
    return this.assetByMessageId.get(messageId) || null;
  }
}

class MemoryLegacyMediaTarget implements LegacyMediaMigrationTarget {
  replacements: MediaAsset[] = [];
  failReplace = false;
  missingMessage = false;

  async replaceMessageMediaAsset(_roomId: string, _messageId: string, asset: MediaAsset) {
    this.replacements.push(asset);
    if (this.failReplace) {
      throw new Error('replace failed');
    }
    if (this.missingMessage) {
      return {
        room: room(),
        found: false,
      };
    }
    return {
      room: room(),
      found: true,
      updatedMessage: message({
        id: asset.messageId,
        messageType: 'media',
        content: '',
        mimeType: asset.mimeType,
        mediaAsset: {
          id: asset.id,
          kind: asset.kind,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          width: asset.width,
          height: asset.height,
        },
      }),
    };
  }
}

class MemoryMediaStorage {
  uploaded = new Map<string, { body: Buffer; mimeType: string; byteSize: number }>();
  deleted: string[] = [];
  failUpload = false;

  async putMediaObject(input: { objectKey: string; body: Buffer; mimeType: string; byteSize: number }) {
    if (this.failUpload) {
      throw new Error('upload failed');
    }
    this.uploaded.set(input.objectKey, {
      body: input.body,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
    });
  }

  async deleteMediaObject(objectKey: string) {
    this.deleted.push(objectKey);
    this.uploaded.delete(objectKey);
  }
}

const logger = {
  info() {},
  warn() {},
  error() {},
};

describe('parseLegacyImageDataUrl', () => {
  it('parses base64 image data URLs and ignores non-legacy content', () => {
    const parsed = parseLegacyImageDataUrl(legacyImageContent('abc'));

    assert.equal(parsed?.mimeType, 'image/png');
    assert.equal(parsed?.body.toString('utf8'), 'abc');
    assert.equal(parseLegacyImageDataUrl('https://example.test/image.png'), null);
    assert.equal(parseLegacyImageDataUrl('data:text/plain;base64,SGVsbG8='), null);
  });
});

describe('migrateLegacyMediaMessagesToObjectStorage', () => {
  it('dry-runs by decoding and converting without uploading or replacing', async () => {
    const source = new MemoryLegacyMediaSource(
      [room()],
      new Map([['room-1', [
        message({ id: 'text-1' }),
        message({ id: 'legacy-1', messageType: 'media', content: legacyImageContent('image-1') }),
      ]]])
    );
    const storage = new MemoryMediaStorage();
    const target = new MemoryLegacyMediaTarget();
    const convertedBodies: string[] = [];

    const stats = await migrateLegacyMediaMessagesToObjectStorage({
      source,
      storage,
      target,
      dryRun: true,
      idFactory: () => 'asset-1',
      convertImage: async input => {
        convertedBodies.push(input.toString('utf8'));
        return convertedImage();
      },
      logger,
    });

    assert.equal(stats.dryRun, true);
    assert.equal(stats.roomsRead, 1);
    assert.equal(stats.messagesRead, 2);
    assert.equal(stats.legacyImagesFound, 1);
    assert.equal(stats.converted, 1);
    assert.equal(stats.uploaded, 0);
    assert.equal(stats.replaced, 0);
    assert.deepEqual(convertedBodies, ['image-1']);
    assert.equal(storage.uploaded.size, 0);
    assert.deepEqual(target.replacements, []);
  });

  it('uploads converted images and replaces legacy message payloads in execute mode', async () => {
    const source = new MemoryLegacyMediaSource(
      [room()],
      new Map([['room-1', [
        message({ id: 'legacy-1', messageType: 'media', content: legacyImageContent('image-1') }),
      ]]])
    );
    const storage = new MemoryMediaStorage();
    const target = new MemoryLegacyMediaTarget();

    const stats = await migrateLegacyMediaMessagesToObjectStorage({
      source,
      storage,
      target,
      dryRun: false,
      idFactory: () => 'asset-1',
      convertImage: async () => convertedImage(),
      logger,
    });

    const objectKey = buildMediaObjectKey('room-1', 'asset-1');
    assert.equal(stats.uploaded, 1);
    assert.equal(stats.replaced, 1);
    assert.equal(stats.failed, 0);
    assert.deepEqual([...storage.uploaded.keys()], [objectKey]);
    assert.equal(storage.uploaded.get(objectKey)?.mimeType, 'image/webp');
    assert.deepEqual(target.replacements, [{
      id: 'asset-1',
      roomId: 'room-1',
      messageId: 'legacy-1',
      objectKey,
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 14,
      uploadedByClientId: 'client-1',
      createdAt: '2026-05-03T00:00:00.000Z',
      width: 12,
      height: 8,
    }]);
  });

  it('skips messages already backed by a media asset', async () => {
    const source = new MemoryLegacyMediaSource(
      [room()],
      new Map([['room-1', [
        message({
          id: 'attached-asset',
          messageType: 'media',
          content: legacyImageContent('attached'),
          mediaAsset: { id: 'asset-attached', kind: 'image', mimeType: 'image/webp', byteSize: 1 },
        }),
        message({ id: 'stored-asset', messageType: 'media', content: legacyImageContent('stored') }),
      ]]])
    );
    source.assetByMessageId.set('stored-asset', {
      id: 'asset-stored',
      roomId: 'room-1',
      messageId: 'stored-asset',
      objectKey: 'rooms/room-1/media/image/asset-stored',
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 1,
      createdAt: '2026-05-03T00:00:00.000Z',
    });

    const stats = await migrateLegacyMediaMessagesToObjectStorage({
      source,
      dryRun: true,
      convertImage: async () => convertedImage(),
      logger,
    });

    assert.equal(stats.skippedAlreadyAssetBacked, 2);
    assert.equal(stats.legacyImagesFound, 0);
    assert.equal(stats.converted, 0);
  });

  it('deletes an uploaded object when message replacement fails', async () => {
    const source = new MemoryLegacyMediaSource(
      [room()],
      new Map([['room-1', [
        message({ id: 'legacy-1', messageType: 'media', content: legacyImageContent('image-1') }),
      ]]])
    );
    const storage = new MemoryMediaStorage();
    const target = new MemoryLegacyMediaTarget();
    target.failReplace = true;

    const stats = await migrateLegacyMediaMessagesToObjectStorage({
      source,
      storage,
      target,
      dryRun: false,
      idFactory: () => 'asset-1',
      convertImage: async () => convertedImage(),
      logger,
    });

    const objectKey = buildMediaObjectKey('room-1', 'asset-1');
    assert.equal(stats.uploaded, 1);
    assert.equal(stats.replaced, 0);
    assert.equal(stats.failed, 1);
    assert.deepEqual(stats.failures, [{
      roomId: 'room-1',
      messageId: 'legacy-1',
      stage: 'replace',
      error: 'replace failed',
    }]);
    assert.deepEqual(storage.deleted, [objectKey]);
    assert.equal(storage.uploaded.size, 0);
  });

  it('requires storage and a target for execute mode', async () => {
    await assert.rejects(
      migrateLegacyMediaMessagesToObjectStorage({
        source: new MemoryLegacyMediaSource([], new Map()),
        dryRun: false,
      }),
      /requires storage and target/
    );
  });
});

describe('legacy media migration CLI guards', () => {
  it('parses execute, room id, and backup file options', () => {
    assert.deepEqual(parseCliOptions(['--execute', '--room-id=room-1', '--backup-file', '/tmp/backup.dump']), {
      help: false,
      execute: true,
      roomId: 'room-1',
      backupFile: '/tmp/backup.dump',
    });
  });

  it('detects Fly app VMs unless explicitly allowed', () => {
    assert.equal(isServingFlyAppVm({ FLY_APP_NAME: 'message-system' }), true);
    assert.equal(isServingFlyAppVm({ FLY_MACHINE_ID: 'abc', ALLOW_FLY_APP_VM_IMAGE_MIGRATION: 'true' }), false);
    assert.equal(isServingFlyAppVm({}), false);
  });

  it('requires an absolute verified backup file in execute mode', async () => {
    await assert.rejects(
      assertMayRunExecuteMigration({ help: false, execute: true }, {}),
      /requires --backup-file/
    );
    await assert.rejects(
      assertMayRunExecuteMigration({ help: false, execute: true, backupFile: 'backup.dump' }, {}),
      /must be absolute/
    );
  });

  it('allows dry-run without backup or Fly checks', async () => {
    await assert.doesNotReject(
      assertMayRunExecuteMigration({ help: false, execute: false }, { FLY_APP_NAME: 'message-system' })
    );
  });
});
