import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { S3MediaObjectStorage } from './mediaObjectStorage';

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
