import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
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

export type MediaObjectStorageConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  socketTimeoutMs?: number;
  maxAttempts?: number;
  slowRequestMs?: number;
};

const DEFAULT_MEDIA_CONNECTION_TIMEOUT_MS = 3_000;
const DEFAULT_MEDIA_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MEDIA_SOCKET_TIMEOUT_MS = 10_000;
const DEFAULT_MEDIA_MAX_ATTEMPTS = 2;
const DEFAULT_MEDIA_SLOW_REQUEST_MS = 2_000;

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const isMediaObjectNotFoundError = (error: unknown) => {
  const candidate = error as { $metadata?: { httpStatusCode?: number }; name?: string; Code?: string; code?: string };
  return candidate?.$metadata?.httpStatusCode === 404 ||
    candidate?.name === 'NotFound' ||
    candidate?.name === 'NoSuchKey' ||
    candidate?.Code === 'NoSuchKey' ||
    candidate?.code === 'ENOENT';
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

  constructor(
    rootDir: string,
    private readonly logger: Logger,
    private readonly signingSecret?: string,
  ) {
    this.rootDir = path.resolve(rootDir);
  }

  isConfigured() {
    return true;
  }

  hasSignedUrls() {
    return Boolean(this.signingSecret);
  }

  private createLocalUrl(method: 'GET' | 'PUT', objectKey: string, expiresInSeconds: number) {
    const basePath = `/api/media/local-objects/${encodeLocalMediaObjectKey(objectKey)}`;
    const expiresEpochSeconds = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const expiresAt = new Date(expiresEpochSeconds * 1000).toISOString();
    if (!this.signingSecret) {
      return { url: basePath, expiresAt };
    }

    const signature = createHmac('sha256', this.signingSecret)
      .update(`${method}\n${objectKey}\n${expiresEpochSeconds}`)
      .digest('hex');
    const query = new URLSearchParams({
      expires: String(expiresEpochSeconds),
      signature,
    });
    return { url: `${basePath}?${query.toString()}`, expiresAt };
  }

  verifySignedUrl(input: {
    method: 'GET' | 'PUT';
    objectKey: string;
    expires: unknown;
    signature: unknown;
    nowMs?: number;
  }) {
    if (!this.signingSecret) {
      return true;
    }
    if (typeof input.expires !== 'string' || !/^\d+$/.test(input.expires)) {
      return false;
    }
    if (typeof input.signature !== 'string' || !/^[a-f0-9]{64}$/i.test(input.signature)) {
      return false;
    }

    const expiresEpochSeconds = Number(input.expires);
    const nowEpochSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
    if (!Number.isSafeInteger(expiresEpochSeconds) || expiresEpochSeconds < nowEpochSeconds) {
      return false;
    }

    const expected = createHmac('sha256', this.signingSecret)
      .update(`${input.method}\n${input.objectKey}\n${expiresEpochSeconds}`)
      .digest();
    const provided = Buffer.from(input.signature, 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
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
    return this.createLocalUrl('PUT', input.objectKey, expiresInSeconds);
  }

  async createReadUrl(input: {
    objectKey: string;
    expiresInSeconds?: number;
    responseContentDisposition?: string;
    responseCacheControl?: string;
  }): Promise<{ url: string; expiresAt: string }> {
    const expiresInSeconds = input.expiresInSeconds || 15 * 60;
    return this.createLocalUrl('GET', input.objectKey, expiresInSeconds);
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
  private readonly slowRequestMs: number;

  constructor(
    private readonly config: MediaObjectStorageConfig,
    private readonly logger: Logger
  ) {
    const connectionTimeout = config.connectionTimeoutMs ?? DEFAULT_MEDIA_CONNECTION_TIMEOUT_MS;
    const requestTimeout = config.requestTimeoutMs ?? DEFAULT_MEDIA_REQUEST_TIMEOUT_MS;
    const socketTimeout = config.socketTimeoutMs ?? DEFAULT_MEDIA_SOCKET_TIMEOUT_MS;
    this.slowRequestMs = config.slowRequestMs ?? DEFAULT_MEDIA_SLOW_REQUEST_MS;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      maxAttempts: config.maxAttempts ?? DEFAULT_MEDIA_MAX_ATTEMPTS,
      requestHandler: new NodeHttpHandler({
        connectionTimeout,
        requestTimeout,
        socketTimeout,
        throwOnRequestTimeout: true,
      }),
    });
  }

  private async runOperation<T>(operation: string, objectKey: string, task: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    let outcome = 'success';
    try {
      return await task();
    } catch (error) {
      outcome = error instanceof Error ? error.name : 'error';
      throw error;
    } finally {
      const durationMs = Date.now() - startedAt;
      if (durationMs >= this.slowRequestMs) {
        this.logger.warn('Slow media object storage operation', {
          operation,
          objectKey,
          durationMs,
          outcome,
        });
      }
    }
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
    await this.runOperation('put', input.objectKey, () => this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.objectKey,
      Body: input.body,
      ContentType: input.mimeType,
      ContentLength: input.byteSize,
      CacheControl: 'private, max-age=31536000, immutable',
    })).then(() => undefined));
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
      const result = await this.runOperation('head', input.objectKey, () => this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
      })));
      return {
        exists: true,
        mimeType: result.ContentType,
        byteSize: typeof result.ContentLength === 'number' ? result.ContentLength : undefined,
      };
    } catch (error: any) {
      if (isMediaObjectNotFoundError(error)) {
        return { exists: false };
      }
      throw error;
    }
  }

  async deleteMediaObject(objectKey: string): Promise<void> {
    await this.runOperation('delete', objectKey, () => this.client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
    })).then(() => undefined));
  }

  async getMediaObject(objectKey: string): Promise<{ body: Buffer; mimeType?: string; byteSize: number }> {
    return this.runOperation('get', objectKey, async () => {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
      }));
      const body = await s3BodyToBuffer(result.Body);
      return {
        body,
        mimeType: result.ContentType,
        byteSize: typeof result.ContentLength === 'number' ? result.ContentLength : body.length,
      };
    });
  }
}

const s3BodyToBuffer = async (body: unknown): Promise<Buffer> => {
  if (!body) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof (body as any).transformToByteArray === 'function') {
    return Buffer.from(await (body as any).transformToByteArray());
  }
  if (body instanceof Readable || typeof (body as any).on === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, 'utf8'));
      } else {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(body));
};

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
    connectionTimeoutMs: positiveInteger(env.MEDIA_STORAGE_CONNECTION_TIMEOUT_MS, DEFAULT_MEDIA_CONNECTION_TIMEOUT_MS),
    requestTimeoutMs: positiveInteger(env.MEDIA_STORAGE_REQUEST_TIMEOUT_MS, DEFAULT_MEDIA_REQUEST_TIMEOUT_MS),
    socketTimeoutMs: positiveInteger(env.MEDIA_STORAGE_SOCKET_TIMEOUT_MS, DEFAULT_MEDIA_SOCKET_TIMEOUT_MS),
    maxAttempts: positiveInteger(env.MEDIA_STORAGE_MAX_ATTEMPTS, DEFAULT_MEDIA_MAX_ATTEMPTS),
    slowRequestMs: positiveInteger(env.MEDIA_STORAGE_SLOW_REQUEST_MS, DEFAULT_MEDIA_SLOW_REQUEST_MS),
  };
};

export const createMediaObjectStorageFromEnv = (logger: Logger, env: NodeJS.ProcessEnv = process.env): MediaObjectStorage => {
  const requestedMode = env.MEDIA_STORAGE_MODE?.trim().toLowerCase();
  if (requestedMode && requestedMode !== 'local' && requestedMode !== 's3') {
    throw new Error('MEDIA_STORAGE_MODE must be "local" or "s3"');
  }

  if (requestedMode === 'local') {
    if (env.DISABLE_LOCAL_MEDIA_STORAGE === 'true') {
      throw new Error('MEDIA_STORAGE_MODE=local conflicts with DISABLE_LOCAL_MEDIA_STORAGE=true');
    }
    const rootDir = env.LOCAL_MEDIA_DIR || path.resolve(process.cwd(), '.local-media');
    const signingSource = env.LOCAL_MEDIA_SIGNING_SECRET || env.POSTGRES_PASSWORD;
    const isProduction = (env.NODE_ENV || 'development') === 'production';
    if (isProduction && (!signingSource || signingSource.length < 16)) {
      throw new Error('Production MEDIA_STORAGE_MODE=local requires LOCAL_MEDIA_SIGNING_SECRET or POSTGRES_PASSWORD with at least 16 characters');
    }
    const signingSecret = signingSource
      ? createHash('sha256').update('roomtalk-local-media-signing-v1\0').update(signingSource).digest('hex')
      : undefined;
    logger.info('Local media object storage configured', { rootDir, signedUrls: Boolean(signingSecret) });
    return new LocalMediaObjectStorage(rootDir, logger, signingSecret);
  }

  const config = resolveMediaObjectStorageConfig(env);
  if (!config) {
    if (requestedMode === 's3') {
      throw new Error('MEDIA_STORAGE_MODE=s3 requires MEDIA_BUCKET_NAME or another supported bucket variable');
    }
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
