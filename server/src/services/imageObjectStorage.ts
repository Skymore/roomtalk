import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Logger } from '../logger';

export interface ImageObjectStorage {
  isConfigured(): boolean;
  putImageObject(input: {
    objectKey: string;
    body: Buffer;
    mimeType: string;
    byteSize: number;
  }): Promise<void>;
  createReadUrl(input: {
    objectKey: string;
    expiresInSeconds?: number;
  }): Promise<{ url: string; expiresAt: string }>;
  deleteImageObject?(objectKey: string): Promise<void>;
}

export class MissingImageObjectStorage implements ImageObjectStorage {
  isConfigured() {
    return false;
  }

  async putImageObject(): Promise<void> {
    throw new Error('Image object storage is not configured');
  }

  async createReadUrl(): Promise<{ url: string; expiresAt: string }> {
    throw new Error('Image object storage is not configured');
  }
}

type ImageObjectStorageConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
};

export class S3ImageObjectStorage implements ImageObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly config: ImageObjectStorageConfig,
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

  async putImageObject(input: {
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
    this.logger.debug('Uploaded image object', { objectKey: input.objectKey, byteSize: input.byteSize });
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

  async deleteImageObject(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
    }));
  }
}

export const resolveImageObjectStorageConfig = (env: NodeJS.ProcessEnv = process.env): ImageObjectStorageConfig | null => {
  const bucket = env.IMAGE_BUCKET_NAME || env.S3_BUCKET || env.AWS_BUCKET_NAME || env.BUCKET_NAME;
  if (!bucket) {
    return null;
  }

  return {
    bucket,
    region: env.IMAGE_STORAGE_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || 'auto',
    endpoint: env.IMAGE_STORAGE_ENDPOINT || env.AWS_ENDPOINT_URL_S3 || env.S3_ENDPOINT,
    forcePathStyle: env.IMAGE_STORAGE_FORCE_PATH_STYLE === 'true' || env.S3_FORCE_PATH_STYLE === 'true',
  };
};

export const createImageObjectStorageFromEnv = (logger: Logger, env: NodeJS.ProcessEnv = process.env): ImageObjectStorage => {
  const config = resolveImageObjectStorageConfig(env);
  if (!config) {
    logger.warn('Image object storage is not configured; image uploads will fail until bucket env vars are set');
    return new MissingImageObjectStorage();
  }

  logger.info('Image object storage configured', {
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
  });
  return new S3ImageObjectStorage(config, logger);
};
