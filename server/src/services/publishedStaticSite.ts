import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import path from 'path';
import { Logger } from '../logger';
import { MediaObjectStorage } from './mediaObjectStorage';
import { CodeAgentRunnerMode } from './codeAgentRunnerProtocol';
import { codeAgentModeAllowsStaticPublish, normalizeCodeAgentMode } from './codeAgentModes';

export const CODE_AGENT_STATIC_PUBLISH_API_PATH = '/api/code-agent/publish-static-site';
export const CODE_AGENT_STATIC_PUBLISH_ROUTE_PREFIX = '/p';

export const DEFAULT_STATIC_PUBLISH_MAX_FILES = 100;
export const DEFAULT_STATIC_PUBLISH_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const DEFAULT_STATIC_PUBLISH_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_STATIC_PUBLISH_TOKEN_TTL_SECONDS = 15 * 60;
export const DEFAULT_STATIC_PUBLISH_UPLOAD_TTL_SECONDS = 15 * 60;

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

export interface PublishedStaticSiteDirectFileInput {
  path: string;
  byteSize: number;
}

export interface PublishedStaticSitePrepareInput {
  roomId: string;
  turnId: string;
  title?: string;
  slug?: string;
  entry?: string;
  files: PublishedStaticSiteDirectFileInput[];
}

export interface PublishedStaticSiteFinalizeInput {
  uploadToken: string;
}

interface PublishedStaticSiteUploadClaims {
  v: 1;
  kind: 'static-site-upload';
  roomId: string;
  clientId: string;
  turnId: string;
  title?: string;
  slug: string;
  entry: string;
  versionId: string;
  files: Array<{ path: string; mimeType: string; byteSize: number; objectKey: string }>;
  exp: number;
}

export interface PublishedStaticSitePrepareResult {
  uploadToken: string;
  versionId: string;
  files: Array<{ path: string; mimeType: string; byteSize: number; uploadUrl: string; expiresAt: string }>;
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
  activatedAt?: string;
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

export interface PublishedStaticSiteUnpublishInput {
  slug: string;
}

export interface PublishedStaticSiteUnpublishResult {
  url: string;
  slug: string;
  objectCount: number;
}

export interface PublishedStaticSiteActivateInput {
  slug: string;
  versionId: string;
}

export interface PublishedStaticSiteActivateResult {
  url: string;
  versionUrl: string;
  slug: string;
  versionId: string;
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
  versions: PublishedStaticSiteVersion[];
}

export interface PublishedStaticSiteVersion {
  versionId: string;
  url: string;
  entry: string;
  fileCount: number;
  totalBytes: number;
  publishedAt: string;
  isCurrent: boolean;
}

interface PublishedStaticSiteVersionSummary extends Omit<PublishedStaticSiteVersion, 'url' | 'isCurrent'> {}

interface PublishedStaticSiteVersionIndex {
  schemaVersion: 1;
  slug: string;
  roomId: string;
  currentVersionId: string;
  versions: PublishedStaticSiteVersionSummary[];
  updatedAt: string;
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
const versionIndexObjectKey = (slug: string) => `published-sites/${slug}/versions.json`;
const versionManifestObjectKey = (slug: string, versionId: string) => (
  `published-sites/${slug}/version-manifests/${versionId}.json`
);
const fileObjectKey = (slug: string, versionId: string, sitePath: string) => (
  `published-sites/${slug}/versions/${versionId}/${sitePath}`
);
const roomIndexObjectKey = (roomId: string) => (
  `published-sites/by-room/${base64UrlEncode(roomId)}/index.json`
);

const routePathForSlug = (slug: string) => `${CODE_AGENT_STATIC_PUBLISH_ROUTE_PREFIX}/${slug}/`;
const routePathForVersion = (slug: string, versionId: string) => (
  `${CODE_AGENT_STATIC_PUBLISH_ROUTE_PREFIX}/${slug}/__versions/${versionId}/`
);

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

const isPublishedSiteVersionId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

const versionSummaryFromManifest = (manifest: PublishedStaticSiteManifest): PublishedStaticSiteVersionSummary => ({
  versionId: manifest.versionId,
  entry: manifest.entry,
  fileCount: manifest.fileCount,
  totalBytes: manifest.totalBytes,
  publishedAt: manifest.updatedAt,
});

const publishedAtFromVersionId = (versionId: string, fallback: string) => {
  const match = versionId.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_/);
  if (!match) return fallback;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
};

const parseVersionIndex = (
  value: Buffer,
  slug: string,
  roomId: string
): PublishedStaticSiteVersionIndex | null => {
  try {
    const parsed = JSON.parse(value.toString('utf8'));
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.slug !== slug ||
      parsed.roomId !== roomId ||
      typeof parsed.currentVersionId !== 'string' ||
      !Array.isArray(parsed.versions)
    ) {
      return null;
    }
    const versions = parsed.versions.filter((version): version is PublishedStaticSiteVersionSummary => (
      isRecord(version) &&
      typeof version.versionId === 'string' && isPublishedSiteVersionId(version.versionId) &&
      typeof version.entry === 'string' &&
      typeof version.fileCount === 'number' &&
      typeof version.totalBytes === 'number' &&
      typeof version.publishedAt === 'string'
    ));
    return {
      schemaVersion: 1,
      slug,
      roomId,
      currentVersionId: parsed.currentVersionId,
      versions,
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
    return this.publicBaseUrl ? joinPublicUrl(this.publicBaseUrl, CODE_AGENT_STATIC_PUBLISH_API_PATH) : CODE_AGENT_STATIC_PUBLISH_API_PATH;
  }

  get turnTokenTtlSeconds() {
    return this.tokenTtlSeconds;
  }

  publishApiUrlForRequest(clientOrigin?: string, serverOrigin?: string) {
    const publicBaseUrl = this.publicBaseUrlForRequest(clientOrigin, serverOrigin);
    return publicBaseUrl ? joinPublicUrl(publicBaseUrl, CODE_AGENT_STATIC_PUBLISH_API_PATH) : CODE_AGENT_STATIC_PUBLISH_API_PATH;
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
        !normalizeCodeAgentMode(claims.mode) ||
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
    if (!codeAgentModeAllowsStaticPublish(claims.mode)) {
      throw new PublishedStaticSiteError('Static site publishing requires a writable agent mode', 403);
    }
    if (input.roomId !== claims.roomId || input.turnId !== claims.turnId) {
      throw new PublishedStaticSiteError('Publish token does not match this agent turn', 403);
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

    const metadata = await this.persistVersionMetadata(manifest, existingManifest);
    try {
      await this.recordRoomPublish(input.roomId, slug, [
        ...metadata.objectKeys,
        ...files.map(file => file.objectKey),
      ], now);
    } catch (error) {
      await Promise.all([
        metadata.rollback(),
        this.deleteObjectKeys(files.map(file => file.objectKey)),
      ]).catch(cleanupError => {
        this.options.logger.error('Failed to clean up static site after room index write failed', {
          error: cleanupError,
          roomId: input.roomId,
          slug,
        });
      });
      throw error;
    }

    this.options.logger.info('Published code-agent static site', {
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

  async prepareDirectUpload(
    input: PublishedStaticSitePrepareInput,
    claims: PublishedStaticSiteTokenClaims
  ): Promise<PublishedStaticSitePrepareResult> {
    if (!this.isConfigured()) {
      throw new PublishedStaticSiteError('Static site publishing is not configured', 503);
    }
    if (!codeAgentModeAllowsStaticPublish(claims.mode)) {
      throw new PublishedStaticSiteError('Static site publishing requires a writable agent mode', 403);
    }
    if (input.roomId !== claims.roomId || input.turnId !== claims.turnId) {
      throw new PublishedStaticSiteError('Publish token does not match this agent turn', 403);
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
    let totalBytes = 0;
    const now = new Date(this.nowMs());
    const versionId = versionIdFromDate(now, this.createId());
    const files = input.files.map(file => {
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
      if (!Number.isSafeInteger(file.byteSize) || file.byteSize <= 0) {
        throw new PublishedStaticSiteError(`Invalid static file byteSize: ${normalizedPath}`);
      }
      if (file.byteSize > this.maxFileBytes) {
        throw new PublishedStaticSiteError(`Static file is too large: ${normalizedPath}`, 413);
      }
      totalBytes += file.byteSize;
      return {
        path: normalizedPath,
        mimeType,
        byteSize: file.byteSize,
        objectKey: fileObjectKey(slug, versionId, normalizedPath),
      };
    });
    if (!seenPaths.has(entry)) {
      throw new PublishedStaticSiteError(`Entry file was not included: ${entry}`);
    }
    if (totalBytes > this.maxTotalBytes) {
      throw new PublishedStaticSiteError(`Static site is too large; max ${this.maxTotalBytes} bytes`, 413);
    }

    const uploadClaims: PublishedStaticSiteUploadClaims = {
      v: 1,
      kind: 'static-site-upload',
      roomId: claims.roomId,
      clientId: claims.clientId,
      turnId: claims.turnId,
      ...(title ? { title } : {}),
      slug,
      entry,
      versionId,
      files,
      exp: Math.floor(this.nowMs() / 1000) + DEFAULT_STATIC_PUBLISH_UPLOAD_TTL_SECONDS,
    };
    const encodedClaims = base64UrlEncode(stableJson(uploadClaims));
    const uploadToken = `${encodedClaims}.${signPayload(encodedClaims, this.options.tokenSecret)}`;
    const uploads = await Promise.all(files.map(async file => {
      const signed = await this.options.mediaObjectStorage.createWriteUrl({
        objectKey: file.objectKey,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        expiresInSeconds: DEFAULT_STATIC_PUBLISH_UPLOAD_TTL_SECONDS,
      });
      return {
        path: file.path,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        uploadUrl: signed.url,
        expiresAt: signed.expiresAt,
      };
    }));
    return { uploadToken, versionId, files: uploads };
  }

  async finalizeDirectUpload(
    input: PublishedStaticSiteFinalizeInput,
    claims: PublishedStaticSiteTokenClaims,
    requestBaseUrl?: string
  ): Promise<PublishedStaticSitePublishResult> {
    const upload = this.verifyUploadToken(input.uploadToken);
    if (!upload) {
      throw new PublishedStaticSiteError('Invalid or expired static site upload token', 401);
    }
    if (upload.roomId !== claims.roomId || upload.clientId !== claims.clientId || upload.turnId !== claims.turnId) {
      throw new PublishedStaticSiteError('Static site upload token does not match this agent turn', 403);
    }
    const existingManifest = await this.readManifest(upload.slug);
    if (existingManifest && existingManifest.roomId !== claims.roomId) {
      throw new PublishedStaticSiteError('This publish slug is already owned by another room', 409);
    }
    for (const file of upload.files) {
      const object = await this.options.mediaObjectStorage.headObject({ objectKey: file.objectKey });
      if (!object.exists) {
        throw new PublishedStaticSiteError(`Static file upload is missing: ${file.path}`, 409);
      }
      if (object.byteSize !== file.byteSize) {
        throw new PublishedStaticSiteError(`Static file upload size does not match: ${file.path}`, 409);
      }
    }

    const now = new Date(this.nowMs());
    const manifest: PublishedStaticSiteManifest = {
      schemaVersion: 1,
      slug: upload.slug,
      roomId: upload.roomId,
      clientId: upload.clientId,
      turnId: upload.turnId,
      ...(upload.title ? { title: upload.title } : {}),
      entry: upload.entry,
      versionId: upload.versionId,
      fileCount: upload.files.length,
      totalBytes: upload.files.reduce((sum, file) => sum + file.byteSize, 0),
      createdAt: existingManifest?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
      files: upload.files,
    };
    const metadata = await this.persistVersionMetadata(manifest, existingManifest);
    try {
      await this.recordRoomPublish(upload.roomId, upload.slug, [
        ...metadata.objectKeys,
        ...upload.files.map(file => file.objectKey),
      ], now);
    } catch (error) {
      await Promise.all([
        metadata.rollback(),
        this.deleteObjectKeys(upload.files.map(file => file.objectKey)),
      ]).catch(cleanupError => {
        this.options.logger.error('Failed to clean up direct static site publish after room index write failed', {
          error: cleanupError,
          roomId: upload.roomId,
          slug: upload.slug,
        });
      });
      throw error;
    }
    return {
      url: this.publicUrlForSlug(upload.slug, requestBaseUrl),
      slug: upload.slug,
      entry: upload.entry,
      versionId: upload.versionId,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
    };
  }

  private verifyUploadToken(token: string): PublishedStaticSiteUploadClaims | null {
    const [payload, signature, extra] = (token || '').split('.');
    if (!payload || !signature || extra !== undefined || !safeEqual(signature, signPayload(payload, this.options.tokenSecret))) {
      return null;
    }
    try {
      const value = JSON.parse(base64UrlDecode(payload)) as PublishedStaticSiteUploadClaims;
      if (value.v !== 1 || value.kind !== 'static-site-upload' || !Array.isArray(value.files) || value.exp <= Math.floor(this.nowMs() / 1000)) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  async unpublish(
    input: PublishedStaticSiteUnpublishInput,
    claims: PublishedStaticSiteTokenClaims,
    requestBaseUrl?: string
  ): Promise<PublishedStaticSiteUnpublishResult> {
    if (!this.isConfigured()) {
      throw new PublishedStaticSiteError('Static site management is not configured', 503);
    }
    if (!codeAgentModeAllowsStaticPublish(claims.mode)) {
      throw new PublishedStaticSiteError('Static site unpublishing requires a writable agent mode', 403);
    }
    if (typeof input.slug !== 'string' || !input.slug.trim()) {
      throw new PublishedStaticSiteError('slug is required');
    }
    const slug = normalizePublishedSiteSlug(input.slug, '');
    const manifest = await this.readManifest(slug);
    if (!manifest) {
      throw new PublishedStaticSiteError('Published site not found', 404);
    }
    if (manifest.roomId !== claims.roomId) {
      throw new PublishedStaticSiteError('Published site belongs to another room', 403);
    }

    const { objectCount } = await this.deletePublishedSiteBySlug(slug);
    return {
      url: this.publicUrlForSlug(slug, requestBaseUrl),
      slug,
      objectCount,
    };
  }

  async activateVersion(
    input: PublishedStaticSiteActivateInput,
    claims: PublishedStaticSiteTokenClaims,
    requestBaseUrl?: string
  ): Promise<PublishedStaticSiteActivateResult> {
    if (!this.isConfigured()) {
      throw new PublishedStaticSiteError('Static site management is not configured', 503);
    }
    if (!codeAgentModeAllowsStaticPublish(claims.mode)) {
      throw new PublishedStaticSiteError('Static site version activation requires a writable agent mode', 403);
    }
    const slug = normalizePublishedSiteSlug(input.slug, '');
    if (!slug || slug !== input.slug) {
      throw new PublishedStaticSiteError('A valid slug is required');
    }
    if (typeof input.versionId !== 'string' || !isPublishedSiteVersionId(input.versionId)) {
      throw new PublishedStaticSiteError('A valid versionId is required');
    }
    const currentManifest = await this.readManifest(slug);
    if (!currentManifest) {
      throw new PublishedStaticSiteError('Published site not found', 404);
    }
    if (currentManifest.roomId !== claims.roomId) {
      throw new PublishedStaticSiteError('Published site belongs to another room', 403);
    }
    const targetManifest = await this.readVersionManifest(slug, input.versionId);
    if (!targetManifest || targetManifest.roomId !== claims.roomId) {
      throw new PublishedStaticSiteError('Published site version not found', 404);
    }
    const previousIndex = await this.ensureVersionHistory(currentManifest);
    if (!previousIndex) {
      throw new PublishedStaticSiteError('Published site version history is unavailable', 503);
    }
    const now = new Date(this.nowMs()).toISOString();
    const nextIndex: PublishedStaticSiteVersionIndex = {
      ...previousIndex,
      currentVersionId: targetManifest.versionId,
      updatedAt: now,
    };
    const indexKey = versionIndexObjectKey(slug);
    await this.writeJsonObject(indexKey, nextIndex);
    try {
      await this.writeJsonObject(manifestObjectKey(slug), {
        ...targetManifest,
        activatedAt: now,
      });
    } catch (error) {
      await this.writeJsonObject(indexKey, previousIndex).catch(rollbackError => {
        this.options.logger.error('Failed to roll back static site version index after activation failed', {
          error: rollbackError,
          roomId: claims.roomId,
          slug,
          versionId: input.versionId,
        });
      });
      throw error;
    }
    this.options.logger.info('Activated published static site version', {
      roomId: claims.roomId,
      turnId: claims.turnId,
      slug,
      versionId: targetManifest.versionId,
    });
    return {
      url: this.publicUrlForSlug(slug, requestBaseUrl),
      versionUrl: this.publicUrlForVersion(slug, targetManifest.versionId, requestBaseUrl),
      slug,
      versionId: targetManifest.versionId,
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

  async readVersionManifest(slug: string, versionId: string): Promise<PublishedStaticSiteManifest | null> {
    if (!this.options.mediaObjectStorage.getMediaObject || !isPublishedSiteVersionId(versionId)) {
      return null;
    }
    const normalizedSlug = normalizePublishedSiteSlug(slug, '');
    if (normalizedSlug !== slug) {
      return null;
    }
    try {
      const objectKey = versionManifestObjectKey(slug, versionId);
      const head = await this.options.mediaObjectStorage.headObject({ objectKey });
      if (head.exists) {
        const object = await this.options.mediaObjectStorage.getMediaObject(objectKey);
        const manifest = parseManifest(object.body);
        return manifest?.slug === slug && manifest.versionId === versionId ? manifest : null;
      }
      const current = await this.readManifest(slug);
      if (!current) return null;
      if (current.versionId === versionId) return current;
      await this.ensureVersionHistory(current);
      const migratedHead = await this.options.mediaObjectStorage.headObject({ objectKey });
      if (!migratedHead.exists) return null;
      const migrated = parseManifest((await this.options.mediaObjectStorage.getMediaObject(objectKey)).body);
      return migrated?.slug === slug && migrated.versionId === versionId ? migrated : null;
    } catch (error) {
      this.options.logger.warn('Failed to read published static site version manifest', { error, slug, versionId });
      return null;
    }
  }

  async listSitesForRoom(roomId: string, requestBaseUrl?: string): Promise<PublishedStaticSiteArtifact[]> {
    const index = await this.readRoomIndex(roomId);
    if (!index) {
      return [];
    }

    const manifests = (await Promise.all(index.slugs.map(slug => this.readManifest(slug))))
      .filter((manifest): manifest is PublishedStaticSiteManifest => Boolean(manifest && manifest.roomId === roomId))
      .sort((left, right) => (right.activatedAt || right.updatedAt).localeCompare(left.activatedAt || left.updatedAt));
    return await Promise.all(manifests.map(async manifest => ({
      slug: manifest.slug,
      url: this.publicUrlForSlug(manifest.slug, requestBaseUrl),
      entry: manifest.entry,
      versionId: manifest.versionId,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      createdAt: manifest.createdAt,
      updatedAt: manifest.activatedAt || manifest.updatedAt,
      ...(manifest.title ? { title: manifest.title } : {}),
      versions: await this.listVersionsForManifest(manifest, requestBaseUrl),
    })));
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

    const index = await this.readRoomIndex(manifest.roomId);
    const siteObjectPrefix = `published-sites/${manifest.slug}/`;
    const siteObjectKeys = Array.from(new Set([
      manifestObjectKey(manifest.slug),
      ...manifest.files.map(file => file.objectKey),
      ...(index?.objectKeys.filter(objectKey => objectKey.startsWith(siteObjectPrefix)) || []),
    ]));
    let objectCount = await this.deleteObjectKeys(siteObjectKeys);

    if (index) {
      const nextIndex: PublishedStaticSiteRoomIndex = {
        ...index,
        slugs: index.slugs.filter(indexedSlug => indexedSlug !== manifest.slug),
        objectKeys: index.objectKeys.filter(objectKey => !objectKey.startsWith(siteObjectPrefix)),
        updatedAt: new Date(this.nowMs()).toISOString(),
      };
      if (nextIndex.slugs.length === 0) {
        objectCount += await this.deleteObjectKeys([roomIndexObjectKey(manifest.roomId)]);
      } else {
        const body = Buffer.from(JSON.stringify(nextIndex, null, 2), 'utf8');
        await this.options.mediaObjectStorage.putMediaObject({
          objectKey: roomIndexObjectKey(manifest.roomId),
          body,
          mimeType: MANIFEST_MIME_TYPE,
          byteSize: body.length,
        });
      }
    }

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
  } | null>;
  async readFile(slug: string, requestPath: string, versionId: string): Promise<{
    manifest: PublishedStaticSiteManifest;
    file: PublishedStaticSiteFileManifest;
    body: Buffer;
  } | null>;
  async readFile(slug: string, requestPath: string, versionId?: string): Promise<{
    manifest: PublishedStaticSiteManifest;
    file: PublishedStaticSiteFileManifest;
    body: Buffer;
  } | null> {
    if (!this.options.mediaObjectStorage.getMediaObject) {
      return null;
    }
    const manifest = versionId
      ? await this.readVersionManifest(slug, versionId)
      : await this.readManifest(slug);
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

  publicUrlForVersion(slug: string, versionId: string, requestBaseUrl?: string) {
    const baseUrl = parseUrlOrigin(requestBaseUrl) || this.publicBaseUrl;
    const routePath = routePathForVersion(slug, versionId);
    return baseUrl ? joinPublicUrl(baseUrl, routePath) : routePath;
  }

  private async persistVersionMetadata(
    manifest: PublishedStaticSiteManifest,
    existingManifest: PublishedStaticSiteManifest | null
  ) {
    const metadataKeys = new Set<string>();
    const rollbackDeleteKeys = new Set<string>();
    const existingIndex = existingManifest
      ? await this.ensureVersionHistory(existingManifest)
      : await this.readVersionIndex(manifest.slug, manifest.roomId);
    const versionsById = new Map<string, PublishedStaticSiteVersionSummary>();
    for (const version of existingIndex?.versions || []) {
      versionsById.set(version.versionId, version);
    }

    if (existingManifest) {
      versionsById.set(existingManifest.versionId, versionSummaryFromManifest(existingManifest));
      const legacyVersionManifestKey = versionManifestObjectKey(existingManifest.slug, existingManifest.versionId);
      const legacyHead = await this.options.mediaObjectStorage.headObject({ objectKey: legacyVersionManifestKey });
      if (!legacyHead.exists) {
        await this.writeJsonObject(legacyVersionManifestKey, existingManifest);
        rollbackDeleteKeys.add(legacyVersionManifestKey);
      }
      metadataKeys.add(legacyVersionManifestKey);
    }

    versionsById.set(manifest.versionId, versionSummaryFromManifest(manifest));
    const versionManifestKey = versionManifestObjectKey(manifest.slug, manifest.versionId);
    await this.writeJsonObject(versionManifestKey, manifest);
    metadataKeys.add(versionManifestKey);
    rollbackDeleteKeys.add(versionManifestKey);

    const versionIndex: PublishedStaticSiteVersionIndex = {
      schemaVersion: 1,
      slug: manifest.slug,
      roomId: manifest.roomId,
      currentVersionId: manifest.versionId,
      versions: Array.from(versionsById.values())
        .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt)),
      updatedAt: manifest.updatedAt,
    };
    const versionIndexKey = versionIndexObjectKey(manifest.slug);
    await this.writeJsonObject(versionIndexKey, versionIndex);
    metadataKeys.add(versionIndexKey);

    const currentManifestKey = manifestObjectKey(manifest.slug);
    await this.writeJsonObject(currentManifestKey, manifest);
    metadataKeys.add(currentManifestKey);
    return {
      objectKeys: Array.from(metadataKeys),
      rollback: async () => {
        if (existingManifest) {
          await this.writeJsonObject(currentManifestKey, existingManifest);
        } else {
          rollbackDeleteKeys.add(currentManifestKey);
        }
        if (existingIndex) {
          await this.writeJsonObject(versionIndexKey, existingIndex);
        } else {
          rollbackDeleteKeys.add(versionIndexKey);
        }
        if (rollbackDeleteKeys.size > 0) {
          await this.deleteObjectKeys(Array.from(rollbackDeleteKeys));
        }
      },
    };
  }

  private async listVersionsForManifest(
    manifest: PublishedStaticSiteManifest,
    requestBaseUrl?: string
  ): Promise<PublishedStaticSiteVersion[]> {
    const index = await this.ensureVersionHistory(manifest);
    const versionsById = new Map<string, PublishedStaticSiteVersionSummary>();
    for (const version of index?.versions || []) {
      versionsById.set(version.versionId, version);
    }
    versionsById.set(manifest.versionId, versionSummaryFromManifest(manifest));
    return Array.from(versionsById.values())
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
      .map(version => ({
        ...version,
        url: this.publicUrlForVersion(manifest.slug, version.versionId, requestBaseUrl),
        isCurrent: version.versionId === manifest.versionId,
      }));
  }

  private async ensureVersionHistory(
    currentManifest: PublishedStaticSiteManifest
  ): Promise<PublishedStaticSiteVersionIndex | null> {
    const [existingIndex, roomIndex] = await Promise.all([
      this.readVersionIndex(currentManifest.slug, currentManifest.roomId),
      this.readRoomIndex(currentManifest.roomId),
    ]);
    const versionsById = new Map<string, PublishedStaticSiteVersionSummary>();
    for (const version of existingIndex?.versions || []) {
      versionsById.set(version.versionId, version);
    }

    const versionFiles = new Map<string, Array<{ path: string; objectKey: string }>>();
    const prefix = `published-sites/${currentManifest.slug}/versions/`;
    for (const objectKey of roomIndex?.objectKeys || []) {
      if (!objectKey.startsWith(prefix)) continue;
      const relative = objectKey.slice(prefix.length);
      const separator = relative.indexOf('/');
      if (separator <= 0) continue;
      const versionId = relative.slice(0, separator);
      const filePath = relative.slice(separator + 1);
      if (!isPublishedSiteVersionId(versionId) || !normalizePublishedSitePath(filePath)) continue;
      const files = versionFiles.get(versionId) || [];
      files.push({ path: filePath, objectKey });
      versionFiles.set(versionId, files);
    }
    if (!versionFiles.has(currentManifest.versionId)) {
      versionFiles.set(currentManifest.versionId, currentManifest.files.map(file => ({
        path: file.path,
        objectKey: file.objectKey,
      })));
    }

    let changed = !existingIndex;
    const metadataKeys = new Set<string>();
    for (const [versionId, indexedFiles] of versionFiles) {
      const versionManifestKey = versionManifestObjectKey(currentManifest.slug, versionId);
      const manifestHead = await this.options.mediaObjectStorage.headObject({ objectKey: versionManifestKey });
      if (versionsById.has(versionId) && manifestHead.exists) {
        metadataKeys.add(versionManifestKey);
        continue;
      }

      let manifest: PublishedStaticSiteManifest;
      if (versionId === currentManifest.versionId) {
        manifest = currentManifest;
      } else {
        const files = (await Promise.all(indexedFiles.map(async indexedFile => {
          const head = await this.options.mediaObjectStorage.headObject({ objectKey: indexedFile.objectKey });
          if (!head.exists) return null;
          const mimeType = head.mimeType || guessPublishedSiteMimeType(indexedFile.path);
          if (!mimeType) return null;
          return {
            path: indexedFile.path,
            mimeType,
            byteSize: typeof head.byteSize === 'number' ? head.byteSize : 0,
            objectKey: indexedFile.objectKey,
          };
        }))).filter((file): file is PublishedStaticSiteFileManifest => Boolean(file));
        if (files.length === 0) continue;
        const filePaths = new Set(files.map(file => file.path));
        const entry = filePaths.has(currentManifest.entry)
          ? currentManifest.entry
          : (filePaths.has('index.html') ? 'index.html' : files.find(file => file.mimeType.startsWith('text/html'))?.path || files[0].path);
        const publishedAt = publishedAtFromVersionId(versionId, currentManifest.createdAt);
        manifest = {
          schemaVersion: 1,
          slug: currentManifest.slug,
          roomId: currentManifest.roomId,
          clientId: currentManifest.clientId,
          turnId: currentManifest.turnId,
          ...(currentManifest.title ? { title: currentManifest.title } : {}),
          entry,
          versionId,
          fileCount: files.length,
          totalBytes: files.reduce((sum, file) => sum + file.byteSize, 0),
          createdAt: currentManifest.createdAt,
          updatedAt: publishedAt,
          files,
        };
      }
      await this.writeJsonObject(versionManifestKey, manifest);
      metadataKeys.add(versionManifestKey);
      versionsById.set(versionId, versionSummaryFromManifest(manifest));
      changed = true;
    }

    versionsById.set(currentManifest.versionId, versionSummaryFromManifest(currentManifest));
    if (!changed && existingIndex) return existingIndex;

    const versionIndex: PublishedStaticSiteVersionIndex = {
      schemaVersion: 1,
      slug: currentManifest.slug,
      roomId: currentManifest.roomId,
      currentVersionId: currentManifest.versionId,
      versions: Array.from(versionsById.values()).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt)),
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
    const indexKey = versionIndexObjectKey(currentManifest.slug);
    await this.writeJsonObject(indexKey, versionIndex);
    metadataKeys.add(indexKey);
    try {
      await this.recordRoomPublish(currentManifest.roomId, currentManifest.slug, Array.from(metadataKeys), new Date(this.nowMs()));
    } catch (error) {
      this.options.logger.warn('Version history was rebuilt but the room index metadata update failed', {
        error,
        roomId: currentManifest.roomId,
        slug: currentManifest.slug,
      });
    }
    this.options.logger.info('Rebuilt published static site version history', {
      roomId: currentManifest.roomId,
      slug: currentManifest.slug,
      versionCount: versionIndex.versions.length,
    });
    return versionIndex;
  }

  private async readVersionIndex(slug: string, roomId: string): Promise<PublishedStaticSiteVersionIndex | null> {
    if (!this.options.mediaObjectStorage.getMediaObject) {
      return null;
    }
    try {
      const objectKey = versionIndexObjectKey(slug);
      const head = await this.options.mediaObjectStorage.headObject({ objectKey });
      if (!head.exists) {
        return null;
      }
      const object = await this.options.mediaObjectStorage.getMediaObject(objectKey);
      return parseVersionIndex(object.body, slug, roomId);
    } catch (error) {
      this.options.logger.warn('Failed to read published static site version index', { error, slug, roomId });
      return null;
    }
  }

  private async writeJsonObject(objectKey: string, value: unknown) {
    const body = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    await this.options.mediaObjectStorage.putMediaObject({
      objectKey,
      body,
      mimeType: MANIFEST_MIME_TYPE,
      byteSize: body.length,
    });
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
    env.CODE_AGENT_STATIC_PUBLISH_TOKEN_SECRET ||
    env.ROOMTALK_STATIC_PUBLISH_TOKEN_SECRET ||
    env.CODE_AGENT_MODEL_GATEWAY_SECRET ||
    randomUUID()
  ).trim();
  const publicBaseUrl = (
    env.CODE_AGENT_STATIC_PUBLISH_PUBLIC_URL ||
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
    tokenTtlSeconds: Number(env.CODE_AGENT_STATIC_PUBLISH_TOKEN_TTL_SECONDS) || DEFAULT_STATIC_PUBLISH_TOKEN_TTL_SECONDS,
  });
};
