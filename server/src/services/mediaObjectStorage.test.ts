import assert from 'assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { describe, it } from 'node:test';
import os from 'os';
import path from 'path';
import { Logger } from '../logger';
import { createMediaObjectStorageFromEnv, LocalMediaObjectStorage, MissingMediaObjectStorage, S3MediaObjectStorage } from './mediaObjectStorage';

const withTestAwsCredentials = async (callback: () => Promise<void>) => {
  const previousAccessKey = process.env.AWS_ACCESS_KEY_ID;
  const previousSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';

  try {
    await callback();
  } finally {
    if (previousAccessKey === undefined) {
      delete process.env.AWS_ACCESS_KEY_ID;
    } else {
      process.env.AWS_ACCESS_KEY_ID = previousAccessKey;
    }

    if (previousSecretKey === undefined) {
      delete process.env.AWS_SECRET_ACCESS_KEY;
    } else {
      process.env.AWS_SECRET_ACCESS_KEY = previousSecretKey;
    }
  }
};

describe('S3MediaObjectStorage', () => {
  it('creates browser-compatible upload URLs without signed content length or SDK checksums', async () => {
    await withTestAwsCredentials(async () => {
      const storage = new S3MediaObjectStorage({
        bucket: 'media-bucket',
        region: 'auto',
        endpoint: 'https://example.invalid',
        forcePathStyle: true,
      }, new Logger('S3MediaObjectStorageTest'));

      const { url } = await storage.createWriteUrl({
        objectKey: 'rooms/room-1/media/image/asset-1',
        mimeType: 'image/webp',
        byteSize: 123,
        expiresInSeconds: 900,
      });

      const params = new URL(url).searchParams;
      assert.equal(params.get('X-Amz-SignedHeaders'), 'host');
      assert.equal(params.has('x-amz-sdk-checksum-algorithm'), false);
      assert.equal(params.has('x-amz-checksum-crc32'), false);
    });
  });
});

describe('LocalMediaObjectStorage', () => {
  it('stores and reads media objects from the local filesystem', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'roomtalk-media-'));

    try {
      const storage = new LocalMediaObjectStorage(rootDir, new Logger('LocalMediaObjectStorageTest'));
      await storage.putMediaObject({
        objectKey: 'rooms/room-1/media/image/asset-1',
        body: Buffer.from('image-bytes'),
        mimeType: 'image/webp',
        byteSize: Buffer.byteLength('image-bytes'),
      });

      assert.deepEqual(await storage.headObject({ objectKey: 'rooms/room-1/media/image/asset-1' }), {
        exists: true,
        mimeType: 'image/webp',
        byteSize: Buffer.byteLength('image-bytes'),
      });

      const object = await storage.getMediaObject('rooms/room-1/media/image/asset-1');
      assert.equal(object.body.toString('utf8'), 'image-bytes');
      assert.equal(object.mimeType, 'image/webp');
      assert.equal(object.byteSize, Buffer.byteLength('image-bytes'));

      const writeUrl = await storage.createWriteUrl({
        objectKey: 'rooms/room-1/media/image/asset-1',
        mimeType: 'image/webp',
        byteSize: Buffer.byteLength('image-bytes'),
      });
      assert.match(writeUrl.url, /^\/api\/media\/local-objects\//);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe('createMediaObjectStorageFromEnv', () => {
  it('uses local media storage by default outside production when no bucket is configured', () => {
    const storage = createMediaObjectStorageFromEnv(new Logger('MediaObjectStorageFactoryTest'), {
      NODE_ENV: 'development',
      LOCAL_MEDIA_DIR: path.join(os.tmpdir(), 'roomtalk-local-media'),
    } as NodeJS.ProcessEnv);

    assert.ok(storage instanceof LocalMediaObjectStorage);
  });

  it('keeps production media uploads disabled when no bucket is configured', () => {
    const storage = createMediaObjectStorageFromEnv(new Logger('MediaObjectStorageFactoryTest'), {
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);

    assert.ok(storage instanceof MissingMediaObjectStorage);
  });
});
