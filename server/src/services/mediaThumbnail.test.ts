import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { MemoryMediaObjectStorage } from '../testUtils/memoryMediaObjectStorage';
import { MediaAsset } from '../types';
import { getMediaThumbnailObjectKey, MediaThumbnailService } from './mediaThumbnail';

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const imageAsset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'asset-1',
  roomId: 'room-1',
  messageId: 'message-1',
  objectKey: 'rooms/room-1/media/image/asset-1',
  kind: 'image',
  mimeType: 'image/jpeg',
  byteSize: 1,
  createdAt: '2026-07-22T00:00:00.000Z',
  ...overrides,
});

describe('MediaThumbnailService', () => {
  it('creates one bounded WebP thumbnail and reuses it for concurrent requests', async () => {
    const storage = new MemoryMediaObjectStorage();
    const source = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 180, g: 80, b: 40 },
      },
    }).jpeg({ quality: 90 }).toBuffer();
    const asset = imageAsset({ byteSize: source.length });
    storage.objects.set(asset.objectKey, {
      body: source,
      mimeType: asset.mimeType,
      byteSize: source.length,
    });
    let sourceReads = 0;
    const getMediaObject = storage.getMediaObject.bind(storage);
    storage.getMediaObject = async objectKey => {
      sourceReads += 1;
      return getMediaObject(objectKey);
    };
    const service = new MediaThumbnailService(storage, logger as any);

    const [firstKey, secondKey] = await Promise.all([
      service.ensureThumbnail(asset),
      service.ensureThumbnail(asset),
    ]);

    const expectedKey = getMediaThumbnailObjectKey(asset.objectKey);
    assert.equal(firstKey, expectedKey);
    assert.equal(secondKey, expectedKey);
    assert.equal(sourceReads, 1);
    const thumbnail = storage.objects.get(expectedKey);
    assert.ok(thumbnail);
    assert.equal(thumbnail.mimeType, 'image/webp');
    const metadata = await sharp(thumbnail.body).metadata();
    assert.equal(metadata.format, 'webp');
    assert.ok((metadata.width || 0) <= 512);
    assert.ok((metadata.height || 0) <= 512);

    assert.equal(await service.ensureThumbnail(asset), expectedKey);
    assert.equal(sourceReads, 1);
  });

  it('does not create thumbnails for non-image media', async () => {
    const storage = new MemoryMediaObjectStorage();
    const service = new MediaThumbnailService(storage, logger as any);
    const result = await service.ensureThumbnail(imageAsset({
      id: 'video-1',
      objectKey: 'rooms/room-1/media/video/video-1',
      kind: 'video',
      mimeType: 'video/mp4',
    }));

    assert.equal(result, null);
    assert.equal(storage.objects.size, 0);
  });
});
