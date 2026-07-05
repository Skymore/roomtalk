import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import path from 'path';

export const CODE_WORKSPACE_ASSET_ROUTE_PREFIX = '/api/code-agent/workspace-assets';
export const DEFAULT_CODE_WORKSPACE_ASSET_TOKEN_TTL_SECONDS = 60 * 60;

// Mirrored from T3's shared workspace file preview classification.
export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = ['.htm', '.html', '.pdf'] as const;
export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
] as const;

const WORKSPACE_BROWSER_ASSET_EXTENSIONS = [
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  ...WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
  '.css',
  '.js',
  '.mjs',
  '.otf',
  '.ttf',
  '.woff',
  '.woff2',
] as const;

const WORKSPACE_ASSET_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

type WorkspaceBrowserAssetExtension = typeof WORKSPACE_BROWSER_ASSET_EXTENSIONS[number];

interface CodeWorkspaceAssetBaseClaims {
  v: 1;
  jti: string;
  roomId: string;
  sandboxId: string;
  exp: number;
}

interface CodeWorkspaceBrowserAssetClaims extends CodeWorkspaceAssetBaseClaims {
  _tag: 'workspace-file';
  entryPath: string;
  basePath: string;
}

interface CodeWorkspaceExactAssetClaims extends CodeWorkspaceAssetBaseClaims {
  _tag: 'workspace-file-exact';
  path: string;
}

export type CodeWorkspaceAssetClaims = CodeWorkspaceBrowserAssetClaims | CodeWorkspaceExactAssetClaims;

export interface CodeWorkspaceAssetUrl {
  relativeUrl: string;
  expiresAt: string;
}

export interface IssueCodeWorkspaceAssetUrlInput {
  roomId: string;
  sandboxId: string;
  path: string;
}

export interface ResolvedCodeWorkspaceAsset {
  roomId: string;
  sandboxId: string;
  path: string;
  mimeType: string;
}

export interface CodeWorkspaceAssetAccessOptions {
  tokenSecret: string;
  tokenTtlSeconds?: number;
  nowMs?: () => number;
  createId?: () => string;
}

export class CodeWorkspaceAssetError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'CodeWorkspaceAssetError';
  }
}

const base64UrlEncode = (value: string | Buffer) => (
  typeof value === 'string' ? Buffer.from(value).toString('base64url') : value.toString('base64url')
);

const base64UrlDecode = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const stableJson = (value: unknown) => JSON.stringify(value);

const signPayload = (payload: string, secret: string) => (
  createHmac('sha256', secret).update(payload).digest('base64url')
);

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasExtension = (workspacePath: string, extensions: readonly string[]) => {
  const normalized = workspacePath.split(/[?#]/, 1)[0].toLowerCase();
  return extensions.some(extension => normalized.endsWith(extension));
};

const workspaceExtension = (workspacePath: string) => (
  path.posix.extname(workspacePath.split(/[?#]/, 1)[0]).toLowerCase()
);

export const isWorkspaceBrowserPreviewPath = (workspacePath: string) => (
  hasExtension(workspacePath, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS)
);

export const isWorkspaceImagePreviewPath = (workspacePath: string) => (
  hasExtension(workspacePath, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS)
);

export const isWorkspacePreviewEntryPath = (workspacePath: string) => (
  isWorkspaceBrowserPreviewPath(workspacePath) || isWorkspaceImagePreviewPath(workspacePath)
);

export const isWorkspaceBrowserAssetPath = (workspacePath: string) => (
  hasExtension(workspacePath, WORKSPACE_BROWSER_ASSET_EXTENSIONS)
);

export const guessCodeWorkspaceAssetMimeType = (workspacePath: string) => (
  WORKSPACE_ASSET_MIME_TYPES[workspaceExtension(workspacePath)] || null
);

export const normalizeWorkspaceAssetPath = (
  value: unknown,
  options: { allowDotSegments?: boolean } = {}
): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const raw = value.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!raw || raw.includes('\0')) {
    return null;
  }

  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.length > 1024
  ) {
    return null;
  }

  const segments = normalized.split('/');
  if (segments.some(segment => (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    (!options.allowDotSegments && segment.startsWith('.'))
  ))) {
    return null;
  }

  return normalized;
};

const parentWorkspacePath = (workspacePath: string) => {
  const index = workspacePath.lastIndexOf('/');
  return index > 0 ? workspacePath.slice(0, index) : '';
};

const isCodeWorkspaceAssetClaims = (value: unknown): value is CodeWorkspaceAssetClaims => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.v !== 1 ||
    typeof value.jti !== 'string' ||
    typeof value.roomId !== 'string' ||
    typeof value.sandboxId !== 'string' ||
    typeof value.exp !== 'number'
  ) {
    return false;
  }

  if (value._tag === 'workspace-file') {
    return typeof value.entryPath === 'string' && typeof value.basePath === 'string';
  }

  if (value._tag === 'workspace-file-exact') {
    return typeof value.path === 'string';
  }

  return false;
};

const normalizeBrowserRequestPath = (
  requestPath: string,
  fallbackPath: string,
  options: { allowDotSegments?: boolean } = {}
) => {
  const pathToNormalize = requestPath.trim() || fallbackPath;
  return normalizeWorkspaceAssetPath(pathToNormalize, options);
};

export class CodeWorkspaceAssetAccess {
  private readonly tokenTtlSeconds: number;
  private readonly nowMs: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: CodeWorkspaceAssetAccessOptions) {
    const ttl = Number(options.tokenTtlSeconds);
    this.tokenTtlSeconds = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_CODE_WORKSPACE_ASSET_TOKEN_TTL_SECONDS;
    this.nowMs = options.nowMs || (() => Date.now());
    this.createId = options.createId || (() => randomUUID());
  }

  issueAssetUrl(input: IssueCodeWorkspaceAssetUrlInput): CodeWorkspaceAssetUrl {
    const workspacePath = normalizeWorkspaceAssetPath(input.path, { allowDotSegments: true });
    if (!workspacePath || !isWorkspacePreviewEntryPath(workspacePath)) {
      throw new CodeWorkspaceAssetError('Workspace preview is unavailable for this file type');
    }

    const expiresAtMs = this.nowMs() + this.tokenTtlSeconds * 1000;
    const baseClaims: CodeWorkspaceAssetBaseClaims = {
      v: 1,
      jti: this.createId(),
      roomId: input.roomId,
      sandboxId: input.sandboxId,
      exp: Math.floor(expiresAtMs / 1000),
    };
    const claims: CodeWorkspaceAssetClaims = isWorkspaceImagePreviewPath(workspacePath)
      ? { ...baseClaims, _tag: 'workspace-file-exact', path: workspacePath }
      : {
        ...baseClaims,
        _tag: 'workspace-file',
        entryPath: workspacePath,
        basePath: parentWorkspacePath(workspacePath),
      };
    const token = this.issueToken(claims);
    const filename = encodeURIComponent(path.posix.basename(workspacePath));
    return {
      relativeUrl: `${CODE_WORKSPACE_ASSET_ROUTE_PREFIX}/${token}/${filename}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  resolveAsset(token: string, requestPath: string): ResolvedCodeWorkspaceAsset | null {
    const claims = this.verifyToken(token);
    if (!claims) {
      return null;
    }

    if (claims._tag === 'workspace-file-exact') {
      const normalizedRequestPath = normalizeBrowserRequestPath(requestPath, path.posix.basename(claims.path), {
        allowDotSegments: true,
      });
      if (normalizedRequestPath !== path.posix.basename(claims.path)) {
        return null;
      }
      const mimeType = guessCodeWorkspaceAssetMimeType(claims.path);
      return mimeType ? {
        roomId: claims.roomId,
        sandboxId: claims.sandboxId,
        path: claims.path,
        mimeType,
      } : null;
    }

    const requestRelativePath = normalizeBrowserRequestPath(requestPath, path.posix.basename(claims.entryPath));
    if (!requestRelativePath || !isWorkspaceBrowserAssetPath(requestRelativePath)) {
      return null;
    }

    const joinedPath = normalizeWorkspaceAssetPath(path.posix.join(claims.basePath, requestRelativePath), {
      allowDotSegments: true,
    });
    if (!joinedPath || !isWorkspaceBrowserAssetPath(joinedPath)) {
      return null;
    }
    if (claims.basePath) {
      const relativeToBase = path.posix.relative(claims.basePath, joinedPath);
      if (!relativeToBase || relativeToBase === '..' || relativeToBase.startsWith('../')) {
        return null;
      }
    }

    const mimeType = guessCodeWorkspaceAssetMimeType(joinedPath);
    return mimeType ? {
      roomId: claims.roomId,
      sandboxId: claims.sandboxId,
      path: joinedPath,
      mimeType,
    } : null;
  }

  verifyToken(token: string): CodeWorkspaceAssetClaims | null {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) {
      return null;
    }

    const expectedSignature = signPayload(payload, this.options.tokenSecret);
    if (!safeEqual(signature, expectedSignature)) {
      return null;
    }

    try {
      const claims = JSON.parse(base64UrlDecode(payload)) as unknown;
      if (!isCodeWorkspaceAssetClaims(claims)) {
        return null;
      }
      if (claims.exp <= Math.floor(this.nowMs() / 1000)) {
        return null;
      }
      if (claims._tag === 'workspace-file') {
        const normalizedEntryPath = normalizeWorkspaceAssetPath(claims.entryPath, { allowDotSegments: true });
        if (
          normalizedEntryPath !== claims.entryPath ||
          !isWorkspaceBrowserPreviewPath(claims.entryPath) ||
          parentWorkspacePath(claims.entryPath) !== claims.basePath
        ) {
          return null;
        }
      } else {
        const normalizedPath = normalizeWorkspaceAssetPath(claims.path, { allowDotSegments: true });
        if (normalizedPath !== claims.path || !isWorkspaceImagePreviewPath(claims.path)) {
          return null;
        }
      }
      return claims;
    } catch {
      return null;
    }
  }

  private issueToken(claims: CodeWorkspaceAssetClaims) {
    const payload = base64UrlEncode(stableJson(claims));
    return `${payload}.${signPayload(payload, this.options.tokenSecret)}`;
  }
}

export const createCodeWorkspaceAssetAccessFromEnv = (env: NodeJS.ProcessEnv = process.env) => {
  const tokenSecret = (
    env.CODE_AGENT_WORKSPACE_ASSET_TOKEN_SECRET ||
    env.ROOMTALK_WORKSPACE_ASSET_TOKEN_SECRET ||
    env.CODE_AGENT_MODEL_GATEWAY_SECRET ||
    env.CODE_AGENT_STATIC_PUBLISH_TOKEN_SECRET ||
    randomUUID()
  ).trim();
  return new CodeWorkspaceAssetAccess({
    tokenSecret,
    tokenTtlSeconds: Number(env.CODE_AGENT_WORKSPACE_ASSET_TOKEN_TTL_SECONDS) || DEFAULT_CODE_WORKSPACE_ASSET_TOKEN_TTL_SECONDS,
  });
};

export const WORKSPACE_BROWSER_ASSET_EXTENSIONS_FOR_TESTS: readonly WorkspaceBrowserAssetExtension[] = WORKSPACE_BROWSER_ASSET_EXTENSIONS;
