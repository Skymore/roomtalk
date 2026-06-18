import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs/promises';
import path from 'path';
import { Logger } from '../logger';

export interface MediaObjectStorage {
  isConfigured(): boolean;
  putMediaObject(input: {
    objectKey: string;
    body: Buffer;
    mimeType: string;
    byteSize: number;
  }): Promise<void>;
  createWriteUrl(input: {
    objectKey: string;
    mimeType: string;
    byteSize: number;
    expiresInSeconds?: number;
  }): Promise<{ url: string; expiresAt: string }>;
  createReadUrl(input: {
    objectKey: string;
    expiresInSeconds?: number;
    responseContentDisposition?: string;
    responseCacheControl?: string;
  }): Promise<{ url: string; expiresAt: string }>;
  headObject(input: {
    objectKey: string;
  }): Promise<{ exists: boolean; mimeType?: string; byteSize?: number }>;
  deleteMediaObject?(objectKey: string): Promise<void>;
  getMediaObject?(objectKey: string): Promise<{ body: Buffer; mimeType?: string; byteSize: number }>;
}

export class MissingMediaObjectStorage implements MediaObjectStorage {
  isConfigured() {
    return false;
  }

  async putMediaObject(): Promise<void> {
    throw new Error('Media object storage is not configured');
  }

  async createWriteUrl(): Promise<{ url: string; expiresAt: string }> {
    throw new Error('Media object storage is not configured');
  }

  async createReadUrl(): Promise<{ url: string; expiresAt: string }> {
    throw new Error('Media object storage is not configured');
  }

  async headObject(): Promise<{ exists: boolean }> {
    throw new Error('Media object storage is not configured');
  }
}

type MediaObjectStorageConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
};

type LocalMediaMetadata = {
  mimeType: string;
  byteSize: number;
};

const encodeLocalMediaObjectKey = (objectKey: string) => (
  Buffer.from(objectKey, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
);

export const decodeLocalMediaObjectKey = (encodedObjectKey: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(encodedObjectKey)) {
    return null;
  }

  const padded = `${encodedObjectKey}${'='.repeat((4 - (encodedObjectKey.length % 4)) % 4)}`;
  try {
    return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
};

export class LocalMediaObjectStorage implements MediaObjectStorage {
  private readonly rootDir: string;

  constructor(rootDir: string, private readonly logger: Logger) {
    this.rootDir = path.resolve(rootDir);
  }

  isConfigured() {
    return true;
  }

  private resolveObjectPath(objectKey: string) {
    const resolvedPath = path.resolve(this.rootDir, objectKey);
    const rootWithSeparator = `${this.rootDir}${path.sep}`;
    if (!resolvedPath.startsWith(rootWithSeparator)) {
      throw new Error('Invalid local media object key');
    }
    return resolvedPath;
  }

  private resolveMetadataPath(objectKey: string) {
    return `${this.resolveObjectPath(objectKey)}.meta.json`;
  }

  async putMediaObject(input: {
    objectKey: string;
    body: Buffer;
    mimeType: string;
    byteSize: number;
  }): Promise<void> {
    const objectPath = this.resolveObjectPath(input.objectKey);
    const metadataPath = this.resolveMetadataPath(input.objectKey);
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await fs.writeFile(objectPath, input.body);
    await fs.writeFile(
      metadataPath,
      JSON.stringify({ mimeType: input.mimeType, byteSize: input.byteSize }, null, 2),
      'utf8'
    );
    this.logger.debug('Stored local media object', { objectKey: input.objectKey, byteSize: input.byteSize });
  }

  async createWriteUrl(input: {
    objectKey: string;
    mimeType: string;
    byteSize: number;
    expiresInSeconds?: number;
  }): Promise<{ url: string; expiresAt: string }> {
    const expiresInSeconds = input.expiresInSeconds || 15 * 60;
    return {
      url: `/api/media/local-objects/${encodeLocalMediaObjectKey(input.objectKey)}`,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  async createReadUrl(input: {
    objectKey: string;
    expiresInSeconds?: number;
    responseContentDisposition?: string;
    responseCacheControl?: string;
  }): Promise<{ url: string; expiresAt: string }> {
    const expiresInSeconds = input.expiresInSeconds || 15 * 60;
    return {
      url: `/api/media/local-objects/${encodeLocalMediaObjectKey(input.objectKey)}`,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  private async readMetadata(objectKey: string): Promise<LocalMediaMetadata | null> {
    try {
      return JSON.parse(await fs.readFile(this.resolveMetadataPath(objectKey), 'utf8')) as LocalMediaMetadata;
    } catch {
      return null;
    }
  }

  async headObject(input: {
    objectKey: string;
  }): Promise<{ exists: boolean; mimeType?: string; byteSize?: number }> {
    try {
      const [stats, metadata] = await Promise.all([
        fs.stat(this.resolveObjectPath(input.objectKey)),
        this.readMetadata(input.objectKey),
      ]);

      return {
        exists: true,
        mimeType: metadata?.mimeType,
        byteSize: metadata?.byteSize ?? stats.size,
      };
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return { exists: false };
      }
      throw error;
    }
  }

  async getMediaObject(objectKey: string): Promise<{ body: Buffer; mimeType?: string; byteSize: number }> {
    const [body, metadata] = await Promise.all([
      fs.readFile(this.resolveObjectPath(objectKey)),
      this.readMetadata(objectKey),
    ]);

    return {
      body,
      mimeType: metadata?.mimeType,
      byteSize: metadata?.byteSize ?? body.length,
    };
  }

  async deleteMediaObject(objectKey: string): Promise<void> {
    await Promise.all([
      fs.rm(this.resolveObjectPath(objectKey), { force: true }),
      fs.rm(this.resolveMetadataPath(objectKey), { force: true }),
    ]);
  }
}

export class S3MediaObjectStorage implements MediaObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly config: MediaObjectStorageConfig,
    private readonly logger: Logger
  ) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  isConfigured() {
    return true;
  }

  async putMediaObject(input: {
    objectKey: string;
    body: Buffer;
    mimeType: string;
    byteSize: number;
  }): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.objectKey,
      Body: input.body,
      ContentType: input.mimeType,
      ContentLength: input.byteSize,
      CacheControl: 'private, max-age=31536000, immutable',
    }));
    this.logger.debug('Uploaded media object', { objectKey: input.objectKey, byteSize: input.byteSize });
  }

  async createWriteUrl(input: {
    objectKey: string;
    mimeType: string;
    byteSize: number;
    expiresInSeconds?: number;
  }): Promise<{ url: string; expiresAt: string }> {
    const expiresInSeconds = input.expiresInSeconds || 15 * 60;
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
        ContentType: input.mimeType,
      }),
      { expiresIn: expiresInSeconds }
    );

    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  async createReadUrl(input: {
    objectKey: string;
    expiresInSeconds?: number;
    responseContentDisposition?: string;
    responseCacheControl?: string;
  }): Promise<{ url: string; expiresAt: string }> {
    const expiresInSeconds = input.expiresInSeconds || 15 * 60;
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
        ResponseContentDisposition: input.responseContentDisposition,
        ResponseCacheControl: input.responseCacheControl,
      }),
      { expiresIn: expiresInSeconds }
    );

    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  async headObject(input: {
    objectKey: string;
  }): Promise<{ exists: boolean; mimeType?: string; byteSize?: number }> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
      }));
      return {
        exists: true,
        mimeType: result.ContentType,
        byteSize: typeof result.ContentLength === 'number' ? result.ContentLength : undefined,
      };
    } catch (error: any) {
      const statusCode = error?.$metadata?.httpStatusCode;
      if (statusCode === 404 || error?.name === 'NotFound' || error?.Code === 'NoSuchKey') {
        return { exists: false };
      }
      throw error;
    }
  }

  async deleteMediaObject(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
    }));
  }
}

export const resolveMediaObjectStorageConfig = (env: NodeJS.ProcessEnv = process.env): MediaObjectStorageConfig | null => {
  const bucket = env.MEDIA_BUCKET_NAME || env.S3_BUCKET || env.AWS_BUCKET_NAME || env.BUCKET_NAME;
  if (!bucket) {
    return null;
  }

  return {
    bucket,
    region: env.MEDIA_STORAGE_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || 'auto',
    endpoint: env.MEDIA_STORAGE_ENDPOINT || env.AWS_ENDPOINT_URL_S3 || env.S3_ENDPOINT,
    forcePathStyle: env.MEDIA_STORAGE_FORCE_PATH_STYLE === 'true' || env.S3_FORCE_PATH_STYLE === 'true',
  };
};

export const createMediaObjectStorageFromEnv = (logger: Logger, env: NodeJS.ProcessEnv = process.env): MediaObjectStorage => {
  const config = resolveMediaObjectStorageConfig(env);
  if (!config) {
    if ((env.NODE_ENV || 'development') !== 'production' && env.DISABLE_LOCAL_MEDIA_STORAGE !== 'true') {
      const rootDir = env.LOCAL_MEDIA_DIR || path.resolve(process.cwd(), '.local-media');
      logger.warn('Media object storage is not configured; using local development media storage', { rootDir });
      return new LocalMediaObjectStorage(rootDir, logger);
    }

    logger.warn('Media object storage is not configured; media uploads will fail until bucket env vars are set');
    return new MissingMediaObjectStorage();
  }

  logger.info('Media object storage configured', {
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
  });
  return new S3MediaObjectStorage(config, logger);
};
