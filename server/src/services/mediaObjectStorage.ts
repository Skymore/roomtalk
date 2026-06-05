import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
  }): Promise<{ url: string; expiresAt: string }>;
  headObject(input: {
    objectKey: string;
  }): Promise<{ exists: boolean; mimeType?: string; byteSize?: number }>;
  deleteMediaObject?(objectKey: string): Promise<void>;
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
        ContentLength: input.byteSize,
        CacheControl: 'private, max-age=31536000, immutable',
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
  }): Promise<{ url: string; expiresAt: string }> {
    const expiresInSeconds = input.expiresInSeconds || 15 * 60;
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
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
