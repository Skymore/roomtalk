import assert from 'assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { describe, it } from 'node:test';
import os from 'os';
import path from 'path';
import { Logger } from '../logger';
import { createMediaObjectStorageFromEnv, LocalMediaObjectStorage, MissingMediaObjectStorage, resolveMediaObjectStorageConfig, S3MediaObjectStorage } from './mediaObjectStorage';

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

  it('adds response content disposition to signed read URLs when requested', async () => {
    await withTestAwsCredentials(async () => {
      const storage = new S3MediaObjectStorage({
        bucket: 'media-bucket',
        region: 'auto',
        endpoint: 'https://example.invalid',
        forcePathStyle: true,
      }, new Logger('S3MediaObjectStorageTest'));

      const { url } = await storage.createReadUrl({
        objectKey: 'rooms/room-1/media/file/asset-1',
        expiresInSeconds: 900,
        responseContentDisposition: "attachment; filename*=UTF-8''notes.md",
      });

      const params = new URL(url).searchParams;
      assert.equal(params.get('response-content-disposition'), "attachment; filename*=UTF-8''notes.md");
    });
  });

  it('bounds stalled object-storage requests instead of waiting indefinitely', async () => {
    await withTestAwsCredentials(async () => {
      const server = createServer(() => undefined);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const storage = new S3MediaObjectStorage({
        bucket: 'media-bucket',
        region: 'auto',
        endpoint: `http://127.0.0.1:${port}`,
        forcePathStyle: true,
        connectionTimeoutMs: 100,
        requestTimeoutMs: 100,
        socketTimeoutMs: 100,
        maxAttempts: 1,
        slowRequestMs: 5_000,
      }, new Logger('S3MediaObjectStorageTest'));

      const startedAt = Date.now();
      try {
        await assert.rejects(
          () => storage.getMediaObject('rooms/room-1/media/image/stalled'),
          error => error instanceof Error && error.name === 'TimeoutError'
        );
        assert.ok(Date.now() - startedAt < 2_000);
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
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

  it('signs production-style local URLs by method, object key, and expiry', async () => {
    const storage = new LocalMediaObjectStorage('/tmp/roomtalk-signed-media', new Logger('LocalMediaObjectStorageTest'), 'test-signing-secret');
    const objectKey = 'rooms/room-1/media/image/asset-1';
    const writeUrl = await storage.createWriteUrl({
      objectKey,
      mimeType: 'image/png',
      byteSize: 10,
      expiresInSeconds: 60,
    });
    const parsed = new URL(writeUrl.url, 'http://localhost');
    const expires = parsed.searchParams.get('expires');
    const signature = parsed.searchParams.get('signature');

    assert.ok(storage.hasSignedUrls());
    assert.ok(storage.verifySignedUrl({ method: 'PUT', objectKey, expires, signature }));
    assert.equal(storage.verifySignedUrl({ method: 'GET', objectKey, expires, signature }), false);
    assert.equal(storage.verifySignedUrl({ method: 'PUT', objectKey: `${objectKey}-other`, expires, signature }), false);
    assert.equal(storage.verifySignedUrl({
      method: 'PUT',
      objectKey,
      expires,
      signature,
      nowMs: (Number(expires) + 1) * 1000,
    }), false);
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

  it('allows an explicit persistent local media store in production', () => {
    const storage = createMediaObjectStorageFromEnv(new Logger('MediaObjectStorageFactoryTest'), {
      NODE_ENV: 'production',
      MEDIA_STORAGE_MODE: 'local',
      LOCAL_MEDIA_DIR: '/var/lib/roomtalk/media',
      POSTGRES_PASSWORD: 'roomtalk-test-password-32-bytes',
    } as NodeJS.ProcessEnv);

    assert.ok(storage instanceof LocalMediaObjectStorage);
  });

  it('fails closed when production local media has no signing secret', () => {
    assert.throws(
      () => createMediaObjectStorageFromEnv(new Logger('MediaObjectStorageFactoryTest'), {
        NODE_ENV: 'production',
        MEDIA_STORAGE_MODE: 'local',
        LOCAL_MEDIA_DIR: '/var/lib/roomtalk/media',
      } as NodeJS.ProcessEnv),
      /requires LOCAL_MEDIA_SIGNING_SECRET or POSTGRES_PASSWORD/
    );
  });

  it('keeps production media uploads disabled when no bucket is configured', () => {
    const storage = createMediaObjectStorageFromEnv(new Logger('MediaObjectStorageFactoryTest'), {
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);

    assert.ok(storage instanceof MissingMediaObjectStorage);
  });

  it('fails fast when an explicit S3 mode has no bucket', () => {
    assert.throws(
      () => createMediaObjectStorageFromEnv(new Logger('MediaObjectStorageFactoryTest'), {
        NODE_ENV: 'production',
        MEDIA_STORAGE_MODE: 's3',
      } as NodeJS.ProcessEnv),
      /MEDIA_STORAGE_MODE=s3 requires MEDIA_BUCKET_NAME/
    );
  });

  it('selects the S3 implementation for an explicit cloud mode', () => {
    const storage = createMediaObjectStorageFromEnv(new Logger('MediaObjectStorageFactoryTest'), {
      NODE_ENV: 'production',
      MEDIA_STORAGE_MODE: 's3',
      MEDIA_BUCKET_NAME: 'roomtalk-media',
      MEDIA_STORAGE_REGION: 'us-west-2',
    } as NodeJS.ProcessEnv);

    assert.ok(storage instanceof S3MediaObjectStorage);
  });

  it('rejects unknown media storage modes', () => {
    assert.throws(
      () => createMediaObjectStorageFromEnv(new Logger('MediaObjectStorageFactoryTest'), {
        MEDIA_STORAGE_MODE: 'other',
      } as NodeJS.ProcessEnv),
      /MEDIA_STORAGE_MODE must be "local" or "s3"/
    );
  });

  it('loads bounded S3 transport settings from the environment', () => {
    const config = resolveMediaObjectStorageConfig({
      MEDIA_BUCKET_NAME: 'media-bucket',
      MEDIA_STORAGE_CONNECTION_TIMEOUT_MS: '4000',
      MEDIA_STORAGE_REQUEST_TIMEOUT_MS: '20000',
      MEDIA_STORAGE_SOCKET_TIMEOUT_MS: '12000',
      MEDIA_STORAGE_MAX_ATTEMPTS: '3',
      MEDIA_STORAGE_SLOW_REQUEST_MS: '2500',
    } as NodeJS.ProcessEnv);

    assert.equal(config?.connectionTimeoutMs, 4000);
    assert.equal(config?.requestTimeoutMs, 20000);
    assert.equal(config?.socketTimeoutMs, 12000);
    assert.equal(config?.maxAttempts, 3);
    assert.equal(config?.slowRequestMs, 2500);
  });
});
