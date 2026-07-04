import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import path from 'path';
import { Logger } from '../logger';
import { MediaObjectStorage } from './mediaObjectStorage';
import { CodeAgentRunnerMode } from './codeAgentRunnerProtocol';

export const COCO_STATIC_PUBLISH_API_PATH = '/api/coco/publish-static-site';
export const COCO_STATIC_PUBLISH_ROUTE_PREFIX = '/p';

export const DEFAULT_STATIC_PUBLISH_MAX_FILES = 100;
export const DEFAULT_STATIC_PUBLISH_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const DEFAULT_STATIC_PUBLISH_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_STATIC_PUBLISH_TOKEN_TTL_SECONDS = 15 * 60;

export interface PublishedStaticSiteFileInput {
  path: string;
  contentBase64: string;
  byteSize?: number;
  mimeType?: string;
}

export interface PublishedStaticSitePublishInput {
  roomId: string;
  turnId: string;
  title?: string;
  slug?: string;
  entry?: string;
  files: PublishedStaticSiteFileInput[];
}

export interface PublishedStaticSiteFileManifest {
  path: string;
  mimeType: string;
  byteSize: number;
  objectKey: string;
}

export interface PublishedStaticSiteManifest {
  schemaVersion: 1;
  slug: string;
  roomId: string;
  clientId: string;
  turnId: string;
  title?: string;
  entry: string;
  versionId: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
  files: PublishedStaticSiteFileManifest[];
}

interface PublishedStaticSiteRoomIndex {
  schemaVersion: 1;
  roomId: string;
  slugs: string[];
  objectKeys: string[];
  updatedAt: string;
}

export interface PublishedStaticSitePublishResult {
  url: string;
  slug: string;
  entry: string;
  versionId: string;
  fileCount: number;
  totalBytes: number;
}

export interface PublishedStaticSiteArtifact {
  slug: string;
  url: string;
  entry: string;
  versionId: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
  title?: string;
}

export interface PublishedStaticSiteTokenClaims {
  v: 1;
  jti: string;
  roomId: string;
  clientId: string;
  turnId: string;
  mode: CodeAgentRunnerMode;
  exp: number;
}

export interface PublishedStaticSiteServiceOptions {
  mediaObjectStorage: MediaObjectStorage;
  logger: Logger;
  tokenSecret: string;
  publicBaseUrl?: string;
  allowedPublicBaseUrls?: string[];
  nodeEnv?: string;
  tokenTtlSeconds?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  nowMs?: () => number;
  createId?: () => string;
}

export class PublishedStaticSiteError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'PublishedStaticSiteError';
  }
}

const MANIFEST_MIME_TYPE = 'application/json; charset=utf-8';

const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const DISALLOWED_SEGMENTS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.venv',
  'venv',
  'node_modules',
  '__pycache__',
]);

const SECRET_BASENAME_RE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|.*(?:secret|credential|private[_-]?key).*)$/i;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const base64UrlEncode = (value: string | Buffer) => (
  typeof value === 'string' ? Buffer.from(value).toString('base64url') : value.toString('base64url')
);

const base64UrlDecode = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const signPayload = (payload: string, secret: string) => (
  createHmac('sha256', secret).update(payload).digest('base64url')
);

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const stableJson = (value: unknown) => JSON.stringify(value);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const sanitizeTitle = (value: unknown) => (
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : ''
);

export const normalizePublishedSiteSlug = (value: unknown, fallbackSeed: string) => {
  const raw = typeof value === 'string' && value.trim()
    ? value
    : fallbackSeed;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63)
    .replace(/-+$/g, '');
  const slug = normalized || 'static-site';
  return SLUG_RE.test(slug) ? slug : 'static-site';
};

export const normalizePublishedSitePath = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const raw = value.replace(/\\/g, '/').trim();
  if (!raw || raw.includes('\0') || raw.startsWith('/')) {
    return null;
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    return null;
  }
  if (normalized.length > 512) {
    return null;
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  if (segments.some(segment => DISALLOWED_SEGMENTS.has(segment))) {
    return null;
  }
  const basename = segments[segments.length - 1];
  if (basename.startsWith('.') || SECRET_BASENAME_RE.test(basename)) {
    return null;
  }
  return normalized;
};

export const guessPublishedSiteMimeType = (sitePath: string) => {
  const extension = path.posix.extname(sitePath).toLowerCase();
  return EXTENSION_MIME_TYPES[extension] || null;
};

export const isSupportedPublishedSitePath = (sitePath: string) => Boolean(guessPublishedSiteMimeType(sitePath));

const manifestObjectKey = (slug: string) => `published-sites/${slug}/manifest.json`;
const fileObjectKey = (slug: string, versionId: string, sitePath: string) => (
  `published-sites/${slug}/versions/${versionId}/${sitePath}`
);
const roomIndexObjectKey = (roomId: string) => (
  `published-sites/by-room/${base64UrlEncode(roomId)}/index.json`
);

const routePathForSlug = (slug: string) => `${COCO_STATIC_PUBLISH_ROUTE_PREFIX}/${slug}/`;

const joinPublicUrl = (baseUrl: string, routePath: string) => (
  `${baseUrl.replace(/\/+$/, '')}/${routePath.replace(/^\/+/, '')}`
);

const parseUrlOrigin = (value?: string) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

const parseOriginList = (value?: string) => (
  (value || '')
    .split(',')
    .map(parseUrlOrigin)
    .filter((origin): origin is string => Boolean(origin))
);

const versionIdFromDate = (date: Date, suffix: string) => (
  `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}_${suffix.slice(0, 8)}`
);

const parseManifest = (value: Buffer): PublishedStaticSiteManifest | null => {
  try {
    const parsed = JSON.parse(value.toString('utf8'));
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.slug !== 'string' || !Array.isArray(parsed.files)) {
      return null;
    }
    return parsed as unknown as PublishedStaticSiteManifest;
  } catch {
    return null;
  }
};

const parseRoomIndex = (value: Buffer, roomId: string): PublishedStaticSiteRoomIndex | null => {
  try {
    const parsed = JSON.parse(value.toString('utf8'));
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.roomId !== roomId ||
      !Array.isArray(parsed.slugs) ||
      !Array.isArray(parsed.objectKeys)
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      roomId,
      slugs: parsed.slugs.filter((slug): slug is string => typeof slug === 'string'),
      objectKeys: parsed.objectKeys.filter((key): key is string => typeof key === 'string'),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
};

export class PublishedStaticSiteService {
  private readonly nowMs: () => number;
  private readonly createId: () => string;
  private readonly tokenTtlSeconds: number;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly maxFileBytes: number;

  constructor(private readonly options: PublishedStaticSiteServiceOptions) {
    this.nowMs = options.nowMs || (() => Date.now());
    this.createId = options.createId || (() => randomUUID());
    this.tokenTtlSeconds = options.tokenTtlSeconds || DEFAULT_STATIC_PUBLISH_TOKEN_TTL_SECONDS;
    this.maxFiles = options.maxFiles || DEFAULT_STATIC_PUBLISH_MAX_FILES;
    this.maxTotalBytes = options.maxTotalBytes || DEFAULT_STATIC_PUBLISH_MAX_TOTAL_BYTES;
    this.maxFileBytes = options.maxFileBytes || DEFAULT_STATIC_PUBLISH_MAX_FILE_BYTES;
  }

  get publicBaseUrl() {
    return parseUrlOrigin(this.options.publicBaseUrl);
  }

  get publishApiUrl() {
    return this.publicBaseUrl ? joinPublicUrl(this.publicBaseUrl, COCO_STATIC_PUBLISH_API_PATH) : COCO_STATIC_PUBLISH_API_PATH;
  }

  publishApiUrlForRequest(clientOrigin?: string, serverOrigin?: string) {
    const publicBaseUrl = this.publicBaseUrlForRequest(clientOrigin, serverOrigin);
    return publicBaseUrl ? joinPublicUrl(publicBaseUrl, COCO_STATIC_PUBLISH_API_PATH) : COCO_STATIC_PUBLISH_API_PATH;
  }

  publicBaseUrlForRequest(clientOrigin?: string, serverOrigin?: string) {
    const normalizedServerOrigin = parseUrlOrigin(serverOrigin);
    if (!this.isProduction()) {
      return normalizedServerOrigin || this.publicBaseUrl;
    }

    const normalizedClientOrigin = parseUrlOrigin(clientOrigin);
    if (normalizedClientOrigin && this.allowedPublicBaseUrlSet().has(normalizedClientOrigin)) {
      return normalizedClientOrigin;
    }

    return this.publicBaseUrl || normalizedServerOrigin;
  }

  isConfigured() {
    return (
      this.options.mediaObjectStorage.isConfigured() &&
      Boolean(this.options.mediaObjectStorage.getMediaObject) &&
      Boolean(this.options.mediaObjectStorage.deleteMediaObject)
    );
  }

  issueTurnToken(input: {
    roomId: string;
    clientId: string;
    turnId: string;
    mode: CodeAgentRunnerMode;
  }) {
    const claims: PublishedStaticSiteTokenClaims = {
      v: 1,
      jti: this.createId(),
      roomId: input.roomId,
      clientId: input.clientId,
      turnId: input.turnId,
      mode: input.mode,
      exp: Math.floor(this.nowMs() / 1000) + this.tokenTtlSeconds,
    };
    const payload = base64UrlEncode(stableJson(claims));
    const signature = signPayload(payload, this.options.tokenSecret);
    return `${payload}.${signature}`;
  }

  verifyTurnToken(token: string): PublishedStaticSiteTokenClaims | null {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) {
      return null;
    }
    const expectedSignature = signPayload(payload, this.options.tokenSecret);
    if (!safeEqual(signature, expectedSignature)) {
      return null;
    }
    try {
      const claims = JSON.parse(base64UrlDecode(payload));
      if (
        !isRecord(claims) ||
        claims.v !== 1 ||
        typeof claims.roomId !== 'string' ||
        typeof claims.clientId !== 'string' ||
        typeof claims.turnId !== 'string' ||
        (claims.mode !== 'plan' && claims.mode !== 'acceptEdits') ||
        typeof claims.exp !== 'number'
      ) {
        return null;
      }
      if (claims.exp <= Math.floor(this.nowMs() / 1000)) {
        return null;
      }
      return claims as unknown as PublishedStaticSiteTokenClaims;
    } catch {
      return null;
    }
  }

  async publish(input: PublishedStaticSitePublishInput, claims: PublishedStaticSiteTokenClaims, requestBaseUrl?: string): Promise<PublishedStaticSitePublishResult> {
    if (!this.isConfigured()) {
      throw new PublishedStaticSiteError('Static site publishing is not configured', 503);
    }
    if (claims.mode !== 'acceptEdits') {
      throw new PublishedStaticSiteError('Static site publishing requires edit mode', 403);
    }
    if (input.roomId !== claims.roomId || input.turnId !== claims.turnId) {
      throw new PublishedStaticSiteError('Publish token does not match this Coco turn', 403);
    }
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new PublishedStaticSiteError('At least one static file is required');
    }
    if (input.files.length > this.maxFiles) {
      throw new PublishedStaticSiteError(`Static site contains too many files; max ${this.maxFiles}`, 413);
    }

    const title = sanitizeTitle(input.title);
    const fallbackSlug = `${title || 'static-site'}-${input.roomId.slice(0, 8)}`;
    const slug = normalizePublishedSiteSlug(input.slug, fallbackSlug);
    const entry = normalizePublishedSitePath(input.entry || 'index.html');
    if (!entry || !isSupportedPublishedSitePath(entry)) {
      throw new PublishedStaticSiteError('entry must be a supported relative static file path');
    }

    const existingManifest = await this.readManifest(slug);
    if (existingManifest && existingManifest.roomId !== input.roomId) {
      throw new PublishedStaticSiteError('This publish slug is already owned by another room', 409);
    }

    const seenPaths = new Set<string>();
    const decodedFiles = input.files.map(file => {
      const normalizedPath = normalizePublishedSitePath(file.path);
      if (!normalizedPath) {
        throw new PublishedStaticSiteError(`Invalid static file path: ${file.path}`);
      }
      if (seenPaths.has(normalizedPath)) {
        throw new PublishedStaticSiteError(`Duplicate static file path: ${normalizedPath}`);
      }
      seenPaths.add(normalizedPath);
      const mimeType = guessPublishedSiteMimeType(normalizedPath);
      if (!mimeType) {
        throw new PublishedStaticSiteError(`Unsupported static file type: ${normalizedPath}`);
      }
      let body: Buffer;
      try {
        body = Buffer.from(file.contentBase64, 'base64');
      } catch {
        throw new PublishedStaticSiteError(`Invalid base64 content for ${normalizedPath}`);
      }
      if (body.length === 0) {
        throw new PublishedStaticSiteError(`Static file is empty: ${normalizedPath}`);
      }
      if (typeof file.byteSize === 'number' && file.byteSize !== body.length) {
        throw new PublishedStaticSiteError(`Static file byteSize does not match content: ${normalizedPath}`);
      }
      if (body.length > this.maxFileBytes) {
        throw new PublishedStaticSiteError(`Static file is too large: ${normalizedPath}`, 413);
      }
      return { path: normalizedPath, body, mimeType, byteSize: body.length };
    });

    if (!seenPaths.has(entry)) {
      throw new PublishedStaticSiteError(`Entry file was not included: ${entry}`);
    }

    const totalBytes = decodedFiles.reduce((sum, file) => sum + file.byteSize, 0);
    if (totalBytes > this.maxTotalBytes) {
      throw new PublishedStaticSiteError(`Static site is too large; max ${this.maxTotalBytes} bytes`, 413);
    }

    const now = new Date(this.nowMs());
    const versionId = versionIdFromDate(now, this.createId());
    const files: PublishedStaticSiteFileManifest[] = [];
    for (const file of decodedFiles) {
      const objectKey = fileObjectKey(slug, versionId, file.path);
      await this.options.mediaObjectStorage.putMediaObject({
        objectKey,
        body: file.body,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
      });
      files.push({
        path: file.path,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        objectKey,
      });
    }

    const manifest: PublishedStaticSiteManifest = {
      schemaVersion: 1,
      slug,
      roomId: input.roomId,
      clientId: claims.clientId,
      turnId: input.turnId,
      title: title || undefined,
      entry,
      versionId,
      fileCount: files.length,
      totalBytes,
      createdAt: existingManifest?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
      files,
    };

    const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const manifestKey = manifestObjectKey(slug);
    await this.options.mediaObjectStorage.putMediaObject({
      objectKey: manifestKey,
      body: manifestBody,
      mimeType: MANIFEST_MIME_TYPE,
      byteSize: manifestBody.length,
    });
    try {
      await this.recordRoomPublish(input.roomId, slug, [
        manifestKey,
        ...files.map(file => file.objectKey),
      ], now);
    } catch (error) {
      await this.deleteObjectKeys([
        manifestKey,
        ...files.map(file => file.objectKey),
      ]).catch(cleanupError => {
        this.options.logger.error('Failed to clean up static site after room index write failed', {
          error: cleanupError,
          roomId: input.roomId,
          slug,
        });
      });
      throw error;
    }

    this.options.logger.info('Published Coco static site', {
      roomId: input.roomId,
      turnId: input.turnId,
      slug,
      versionId,
      fileCount: files.length,
      totalBytes,
    });

    return {
      url: this.publicUrlForSlug(slug, requestBaseUrl),
      slug,
      entry,
      versionId,
      fileCount: files.length,
      totalBytes,
    };
  }

  async readManifest(slug: string): Promise<PublishedStaticSiteManifest | null> {
    if (!this.options.mediaObjectStorage.getMediaObject) {
      return null;
    }
    const normalizedSlug = normalizePublishedSiteSlug(slug, '');
    if (normalizedSlug !== slug) {
      return null;
    }
    try {
      const head = await this.options.mediaObjectStorage.headObject({ objectKey: manifestObjectKey(slug) });
      if (!head.exists) {
        return null;
      }
      const object = await this.options.mediaObjectStorage.getMediaObject(manifestObjectKey(slug));
      return parseManifest(object.body);
    } catch (error) {
      this.options.logger.warn('Failed to read published static site manifest', { error, slug });
      return null;
    }
  }

  async listSitesForRoom(roomId: string, requestBaseUrl?: string): Promise<PublishedStaticSiteArtifact[]> {
    const index = await this.readRoomIndex(roomId);
    if (!index) {
      return [];
    }

    const manifests = await Promise.all(index.slugs.map(slug => this.readManifest(slug)));
    return manifests
      .filter((manifest): manifest is PublishedStaticSiteManifest => Boolean(manifest && manifest.roomId === roomId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(manifest => ({
        slug: manifest.slug,
        url: this.publicUrlForSlug(manifest.slug, requestBaseUrl),
        entry: manifest.entry,
        versionId: manifest.versionId,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        ...(manifest.title ? { title: manifest.title } : {}),
      }));
  }

  async deleteSitesForRoom(roomId: string): Promise<{ slugCount: number; objectCount: number }> {
    const index = await this.readRoomIndex(roomId);
    if (!index) {
      return { slugCount: 0, objectCount: 0 };
    }

    const objectCount = await this.deleteObjectKeys([
      ...index.objectKeys,
      roomIndexObjectKey(roomId),
    ]);
    this.options.logger.info('Deleted published static sites for room', {
      roomId,
      slugCount: index.slugs.length,
      objectCount,
    });
    return { slugCount: index.slugs.length, objectCount };
  }

  async deletePublishedSiteBySlug(slug: string): Promise<{ roomId?: string; objectCount: number }> {
    const manifest = await this.readManifest(slug);
    if (!manifest) {
      return { objectCount: 0 };
    }

    const objectCount = await this.deleteObjectKeys([
      manifestObjectKey(manifest.slug),
      ...manifest.files.map(file => file.objectKey),
    ]);
    this.options.logger.info('Deleted published static site by slug', {
      roomId: manifest.roomId,
      slug: manifest.slug,
      objectCount,
    });
    return { roomId: manifest.roomId, objectCount };
  }

  async readFile(slug: string, requestPath: string): Promise<{
    manifest: PublishedStaticSiteManifest;
    file: PublishedStaticSiteFileManifest;
    body: Buffer;
  } | null> {
    if (!this.options.mediaObjectStorage.getMediaObject) {
      return null;
    }
    const manifest = await this.readManifest(slug);
    if (!manifest) {
      return null;
    }
    const file = this.resolveManifestFile(manifest, requestPath);
    if (!file) {
      return null;
    }
    const object = await this.options.mediaObjectStorage.getMediaObject(file.objectKey);
    return { manifest, file, body: object.body };
  }

  resolveManifestFile(manifest: PublishedStaticSiteManifest, requestPath: string): PublishedStaticSiteFileManifest | null {
    const filesByPath = new Map(manifest.files.map(file => [file.path, file]));
    const normalized = normalizePublishedSitePath(requestPath || manifest.entry);
    if (!normalized) {
      return null;
    }
    const candidates = [
      normalized,
      normalized.endsWith('/') ? `${normalized}index.html` : `${normalized}/index.html`,
      manifest.entry,
    ];
    for (const candidate of candidates) {
      const file = filesByPath.get(candidate);
      if (file) {
        return file;
      }
    }
    return null;
  }

  publicUrlForSlug(slug: string, requestBaseUrl?: string) {
    const baseUrl = parseUrlOrigin(requestBaseUrl) || this.publicBaseUrl;
    const routePath = routePathForSlug(slug);
    return baseUrl ? joinPublicUrl(baseUrl, routePath) : routePath;
  }

  private isProduction() {
    return (this.options.nodeEnv || process.env.NODE_ENV || 'development') === 'production';
  }

  private allowedPublicBaseUrlSet() {
    return new Set((this.options.allowedPublicBaseUrls || []).map(parseUrlOrigin).filter((origin): origin is string => Boolean(origin)));
  }

  private async readRoomIndex(roomId: string): Promise<PublishedStaticSiteRoomIndex | null> {
    if (!this.options.mediaObjectStorage.getMediaObject) {
      return null;
    }

    try {
      const objectKey = roomIndexObjectKey(roomId);
      const head = await this.options.mediaObjectStorage.headObject({ objectKey });
      if (!head.exists) {
        return null;
      }
      const object = await this.options.mediaObjectStorage.getMediaObject(objectKey);
      return parseRoomIndex(object.body, roomId);
    } catch (error) {
      this.options.logger.warn('Failed to read published static site room index', { error, roomId });
      return null;
    }
  }

  private async recordRoomPublish(roomId: string, slug: string, objectKeys: string[], now: Date) {
    const existing = await this.readRoomIndex(roomId);
    const index: PublishedStaticSiteRoomIndex = {
      schemaVersion: 1,
      roomId,
      slugs: Array.from(new Set([...(existing?.slugs || []), slug])).sort(),
      objectKeys: Array.from(new Set([...(existing?.objectKeys || []), ...objectKeys])).sort(),
      updatedAt: now.toISOString(),
    };
    const body = Buffer.from(JSON.stringify(index, null, 2), 'utf8');
    await this.options.mediaObjectStorage.putMediaObject({
      objectKey: roomIndexObjectKey(roomId),
      body,
      mimeType: MANIFEST_MIME_TYPE,
      byteSize: body.length,
    });
  }

  private async deleteObjectKeys(objectKeys: string[]) {
    if (!this.options.mediaObjectStorage.deleteMediaObject) {
      throw new PublishedStaticSiteError('Static site deletion is not configured', 503);
    }

    let deleted = 0;
    const errors: unknown[] = [];
    for (const objectKey of Array.from(new Set(objectKeys)).sort()) {
      try {
        await this.options.mediaObjectStorage.deleteMediaObject(objectKey);
        deleted++;
      } catch (error) {
        errors.push(error);
        this.options.logger.error('Failed to delete published static site object', { error, objectKey });
      }
    }

    if (errors.length > 0) {
      throw new PublishedStaticSiteError('Failed to delete all published static site objects', 500);
    }
    return deleted;
  }
}

export const createPublishedStaticSiteServiceFromEnv = (input: {
  mediaObjectStorage: MediaObjectStorage;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}) => {
  const env = input.env || process.env;
  const tokenSecret = (
    env.COCO_STATIC_PUBLISH_TOKEN_SECRET ||
    env.ROOMTALK_STATIC_PUBLISH_TOKEN_SECRET ||
    env.COCO_MODEL_GATEWAY_SECRET ||
    randomUUID()
  ).trim();
  const publicBaseUrl = (
    env.COCO_STATIC_PUBLISH_PUBLIC_URL ||
    env.ROOMTALK_STATIC_PUBLISH_PUBLIC_URL ||
    ((env.NODE_ENV || 'development') === 'production' ? env.CLIENT_URL : '') ||
    ''
  ).trim() || undefined;
  return new PublishedStaticSiteService({
    mediaObjectStorage: input.mediaObjectStorage,
    logger: input.logger,
    tokenSecret,
    publicBaseUrl,
    allowedPublicBaseUrls: [
      ...parseOriginList(env.CLIENT_URLS),
      ...parseOriginList(env.CLIENT_URL),
    ],
    nodeEnv: env.NODE_ENV || 'development',
    tokenTtlSeconds: Number(env.COCO_STATIC_PUBLISH_TOKEN_TTL_SECONDS) || DEFAULT_STATIC_PUBLISH_TOKEN_TTL_SECONDS,
  });
};
