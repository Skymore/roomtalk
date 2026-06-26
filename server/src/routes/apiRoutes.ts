import express, { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { Server } from 'socket.io';
import { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { AudioTranscriptionRecord, ClientAccount, MediaHistoryPageCursor, PendingMediaUpload, RoomStore } from '../repositories/store';
import { MediaAsset, MediaKind, Message, Room } from '../types';
import { AIRoleDraft, MAX_AI_ROLE_IDEA_LENGTH } from '../services/aiRoleGenerator';
import { hasRoomAccess } from '../socket/roomAccess';
import { authorizeRoomAction } from '../socket/roomAuthorization';
import { createMediaMessage, createReplyReference } from '../services/messageDomain';
import { decodeLocalMediaObjectKey, LocalMediaObjectStorage, MediaObjectStorage } from '../services/mediaObjectStorage';
import { getPushPublicConfig, notifyRoomMessageBestEffort } from '../services/pushNotifications';
import { AudioTranscriptionRunner } from '../services/audioTranscription';
import {
  hashClientAuthToken,
  hashClientPassword,
  isClientRequestAuthorized,
  issueClientAuthToken,
  validateClientPassword,
  verifyClientPassword,
} from '../services/clientAuth';
import { VerifyGoogleCredentialResult, resolveGoogleClientIds, verifyGoogleCredential } from '../services/googleAuth';
import { getStickerCatalog } from '../stickers/catalog';
import { CocoAccessControl, createCocoAccessControl } from '../services/cocoAccessControl';
import { CocoRunnerMode } from '../services/cocoRunnerProtocol';
import { buildCodeAgentWorkspaceSnapshot } from '../services/codeAgentWorkspace';

interface ApiRouteOptions {
  store: RoomStore;
  io: Server;
  redisClient: RedisClientType;
  routeLogger: Logger;
  getAIModelResponse: () => unknown;
  generateAIRoleDraft: (idea: string) => Promise<AIRoleDraft>;
  persistenceStore?: string;
  mediaObjectStorage: MediaObjectStorage;
  audioTranscriptionRunner?: AudioTranscriptionRunner;
  googleClientIds?: string[];
  verifyGoogleCredential?: (credential: string, clientIds: string[]) => Promise<VerifyGoogleCredentialResult>;
  cocoAccess?: CocoAccessControl;
  cocoMode?: CocoRunnerMode;
  mediaUploadCleanup?: {
    disabled?: boolean;
    pendingUploadTtlMs?: number;
    sweepIntervalMs?: number;
    sweepBatchSize?: number;
    nowMs?: () => number;
  };
}

const MEDIA_UPLOAD_LIMIT_BYTES: Record<MediaKind, number> = {
  image: 10 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  file: 50 * 1024 * 1024,
};

const MEDIA_HISTORY_DEFAULT_LIMIT = 40;
const MEDIA_HISTORY_MAX_LIMIT = 80;
const MEDIA_HISTORY_MONTH_WINDOW = 6;
const MEDIA_HISTORY_KINDS: MediaKind[] = ['image', 'video'];
const AI_ROLE_DRAFT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const AI_ROLE_DRAFT_RATE_LIMIT_MAX_REQUESTS = 5;
const MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MEDIA_UPLOAD_RATE_LIMIT_MAX_REQUESTS = 20;
const MEDIA_PENDING_UPLOAD_TTL_MS = 30 * 60 * 1000;
const MEDIA_PENDING_UPLOAD_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MEDIA_PENDING_UPLOAD_SWEEP_BATCH_SIZE = 50;
const STICKER_OBJECT_PREFIX = 'stickers/';
const STICKER_ASSET_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const STICKER_ASSET_REDIRECT_CACHE_SECONDS = 6 * 24 * 60 * 60;
const STICKER_ASSET_RESPONSE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

type RateLimitEntry = {
  windowStartMs: number;
  count: number;
};

const mediaUploadRateLimits = new Map<string, RateLimitEntry>();

const isMediaKind = (kind: unknown): kind is MediaKind => (
  kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'file'
);

const isAllowedMediaMimeType = (kind: MediaKind, mimeType: string) => {
  if (!mimeType || mimeType.includes('\n') || mimeType.includes('\r')) {
    return false;
  }
  if (kind === 'file') {
    return true;
  }
  if (kind === 'image') {
    return mimeType.startsWith('image/') && mimeType !== 'image/svg+xml';
  }
  return mimeType.startsWith(`${kind}/`);
};

const parseStickerAssetPath = (assetPath: unknown): string | null => {
  if (typeof assetPath !== 'string') {
    return null;
  }
  const normalized = assetPath.replace(/^\/+/, '');
  return /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:jpe?g|png|webp)$/i.test(normalized)
    ? normalized
    : null;
};

type UploadFilenameParseResult =
  | { ok: true; filename?: string }
  | { ok: false; error: string };

const sanitizeUploadFilename = (value: unknown): UploadFilenameParseResult => {
  if (value === null || value === undefined || value === '') {
    return { ok: true };
  }
  if (typeof value !== 'string') {
    return { ok: true };
  }
  if (value.includes('\r') || value.includes('\n')) {
    return { ok: false, error: 'Filename must not contain line breaks' };
  }

  const cleaned = value.split(/[\\/]/).pop()?.trim().slice(0, 200);
  return { ok: true, filename: cleaned || undefined };
};

const sanitizeContentDispositionFilename = (value: string) => (
  value
    .replace(/[\r\n]/g, '')
    .split(/[\\/]/)
    .pop()
    ?.trim()
    .slice(0, 200) || 'download'
);

const buildAttachmentContentDisposition = (filename: string) => (
  `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeContentDispositionFilename(filename))}`
);

const isPreviewMediaMimeType = (mimeType: string) => (
  mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')
);

const getAssetIdFromMediaObjectKey = (objectKey: string) => objectKey.split('/').pop() || '';

const shouldForceLocalMediaAttachment = (objectKey: string, mimeType: string) => (
  objectKey.includes('/media/file/') || !isPreviewMediaMimeType(mimeType)
);

const parseByteSize = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
};

const parseOptionalInteger = (value: unknown) => {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
};

const buildMediaObjectKey = (roomId: string, kind: MediaKind, assetId: string) => (
  `rooms/${roomId}/media/${kind}/${assetId}`
);

const encodeMediaHistoryCursor = (createdAt: string, assetId: string) => (
  Buffer.from(JSON.stringify({ createdAt, assetId }), 'utf8').toString('base64url')
);

const decodeMediaHistoryCursor = (cursor: unknown): MediaHistoryPageCursor | null => {
  if (typeof cursor !== 'string' || !cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.createdAt === 'string' && typeof parsed?.assetId === 'string') {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
};

const resolveMediaHistoryCutoff = () => {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MEDIA_HISTORY_MONTH_WINDOW);
  return cutoff.toISOString();
};

const parseMediaHistoryLimit = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return MEDIA_HISTORY_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(parsed), MEDIA_HISTORY_MAX_LIMIT);
};

const parseMediaHistoryKinds = (value: unknown): MediaKind[] => {
  if (value === 'image' || value === 'video') {
    return [value];
  }
  return MEDIA_HISTORY_KINDS;
};

const serializeAudioTranscription = (record: AudioTranscriptionRecord) => ({
  assetId: record.assetId,
  roomId: record.roomId,
  messageId: record.messageId,
  status: record.status,
  transcript: record.transcript,
  languageCode: record.languageCode,
  error: record.error,
  updatedAt: record.updatedAt,
  completedAt: record.completedAt,
});

const BROWSER_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const normalizeBrowserInstanceId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return BROWSER_INSTANCE_ID_PATTERN.test(trimmed) ? trimmed : undefined;
};

const parsePushSubscriptionBody = (body: unknown) => {
  const payload = body && typeof body === 'object' ? body as Record<string, any> : {};
  const subscription = payload.subscription && typeof payload.subscription === 'object'
    ? payload.subscription as Record<string, any>
    : {};
  const keys = subscription.keys && typeof subscription.keys === 'object'
    ? subscription.keys as Record<string, any>
    : {};
  const clientId = typeof payload.clientId === 'string' ? payload.clientId.trim() : '';
  const browserInstanceId = normalizeBrowserInstanceId(payload.browserInstanceId);
  const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  const userAgent = typeof payload.userAgent === 'string' ? payload.userAgent.slice(0, 500) : undefined;

  if (!clientId || !endpoint || !p256dh || !auth) {
    return null;
  }

  return { clientId, browserInstanceId, endpoint, p256dh, auth, userAgent };
};

const serializeClientAccount = (account: ClientAccount | null) => account
  ? {
      accountId: account.accountId,
      primaryClientId: account.primaryClientId,
      provider: account.provider,
      email: account.email,
      emailVerified: account.emailVerified,
      displayName: account.displayName,
      avatarUrl: account.avatarUrl,
      lastLoginAt: account.lastLoginAt,
    }
  : null;

const consumeMediaUploadRateLimit = (clientId: string, ip: string | undefined, nowMs = Date.now()) => {
  const key = `${clientId}:${ip || 'unknown'}`;
  const current = mediaUploadRateLimits.get(key);
  if (!current || nowMs - current.windowStartMs >= MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS) {
    mediaUploadRateLimits.set(key, { windowStartMs: nowMs, count: 1 });
    return true;
  }

  if (current.count >= MEDIA_UPLOAD_RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  current.count += 1;
  return true;
};

export function registerApiRoutes(app: Express, options: ApiRouteOptions) {
  const { store, io, redisClient, routeLogger, getAIModelResponse, generateAIRoleDraft, persistenceStore = 'redis', mediaObjectStorage, audioTranscriptionRunner } = options;
  const cocoAccess = options.cocoAccess ?? createCocoAccessControl({ enabled: false });
  const cocoMode = options.cocoMode ?? 'plan';
  const mediaUploadCleanup = options.mediaUploadCleanup || {};
  const getNowMs = mediaUploadCleanup.nowMs || (() => Date.now());
  const pendingUploadTtlMs = mediaUploadCleanup.pendingUploadTtlMs ?? MEDIA_PENDING_UPLOAD_TTL_MS;
  const sweepIntervalMs = mediaUploadCleanup.sweepIntervalMs ?? MEDIA_PENDING_UPLOAD_SWEEP_INTERVAL_MS;
  const sweepBatchSize = mediaUploadCleanup.sweepBatchSize ?? MEDIA_PENDING_UPLOAD_SWEEP_BATCH_SIZE;
  const googleClientIds = options.googleClientIds ?? resolveGoogleClientIds();
  const verifyGoogleCredentialFn = options.verifyGoogleCredential ?? verifyGoogleCredential;

  // AI role drafts are a global per-client feature, not room-gated. Abuse (burning
  // OpenRouter credits) is bounded purely by source IP — keyed by IP so rotating the
  // (free-to-mint) clientId can't multiply the quota. Scoped to this app instance so
  // each test server starts clean and the map can't grow unbounded across the process.
  const aiRoleDraftRateLimits = new Map<string, RateLimitEntry>();
  const consumeAIRoleDraftRateLimit = (ip: string | undefined, nowMs = Date.now()) => {
    const key = ip || 'unknown';
    const current = aiRoleDraftRateLimits.get(key);
    if (!current || nowMs - current.windowStartMs >= AI_ROLE_DRAFT_RATE_LIMIT_WINDOW_MS) {
      aiRoleDraftRateLimits.set(key, { windowStartMs: nowMs, count: 1 });
      return true;
    }
    if (current.count >= AI_ROLE_DRAFT_RATE_LIMIT_MAX_REQUESTS) {
      return false;
    }
    current.count += 1;
    return true;
  };

  const deleteMediaObjectBestEffort = async (objectKey: string, reason: string) => {
    if (!mediaObjectStorage.deleteMediaObject) {
      return;
    }

    try {
      await mediaObjectStorage.deleteMediaObject(objectKey);
    } catch (error) {
      routeLogger.error('Failed to delete media object', { error, objectKey, reason });
    }
  };

  const sweepExpiredPendingMediaUploads = async () => {
    if (!mediaObjectStorage.deleteMediaObject) {
      return;
    }

    try {
      const now = new Date(getNowMs()).toISOString();
      const expiredUploads = await store.claimExpiredPendingMediaUploads(now, sweepBatchSize);
      for (const upload of expiredUploads) {
        await deleteMediaObjectBestEffort(upload.objectKey, 'pending-media-upload-expired');
      }
      if (expiredUploads.length > 0) {
        routeLogger.info('Swept expired pending media uploads', { count: expiredUploads.length });
      }
    } catch (error) {
      routeLogger.error('Failed to sweep expired pending media uploads', { error });
    }
  };

  if (!mediaUploadCleanup.disabled && sweepIntervalMs > 0 && mediaObjectStorage.deleteMediaObject) {
    const sweepTimer = setInterval(() => {
      void sweepExpiredPendingMediaUploads();
    }, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  const shouldRegisterLocalMediaRoutes =
    mediaObjectStorage instanceof LocalMediaObjectStorage &&
    (process.env.NODE_ENV || 'development') !== 'production';

  if (shouldRegisterLocalMediaRoutes) {
    app.put('/api/media/local-objects/:encodedObjectKey', express.raw({ type: '*/*', limit: MEDIA_UPLOAD_LIMIT_BYTES.video }), async (req: Request, res: Response) => {
      try {
        const objectKey = decodeLocalMediaObjectKey(req.params.encodedObjectKey);
        const body = Buffer.isBuffer(req.body) ? req.body : null;
        const mimeType = typeof req.header('content-type') === 'string' ? req.header('content-type')!.split(';')[0].trim().toLowerCase() : 'application/octet-stream';

        if (!objectKey || !body || body.length === 0) {
          return res.status(400).json({ error: 'Valid media object key and body are required' });
        }

        await mediaObjectStorage.putMediaObject({
          objectKey,
          body,
          mimeType,
          byteSize: body.length,
        });

        return res.status(204).send();
      } catch (error) {
        routeLogger.error('Failed to store local media object', { error, endpoint: 'PUT /api/media/local-objects/:encodedObjectKey', ip: req.ip });
        return res.status(500).json({ error: 'Failed to store media object' });
      }
    });

    app.get('/api/media/local-objects/:encodedObjectKey', async (req: Request, res: Response) => {
      try {
        const objectKey = decodeLocalMediaObjectKey(req.params.encodedObjectKey);
        if (!objectKey || !mediaObjectStorage.getMediaObject) {
          return res.status(404).json({ error: 'Media object not found' });
        }

        const head = await mediaObjectStorage.headObject({ objectKey });
        if (!head.exists) {
          return res.status(404).json({ error: 'Media object not found' });
        }

        const object = await mediaObjectStorage.getMediaObject(objectKey);
        const mimeType = object.mimeType || head.mimeType || 'application/octet-stream';
        res.type(mimeType);
        if (shouldForceLocalMediaAttachment(objectKey, mimeType)) {
          const assetId = getAssetIdFromMediaObjectKey(objectKey);
          const asset = assetId ? await store.getMediaAsset(assetId) : null;
          res.setHeader('Content-Disposition', buildAttachmentContentDisposition(asset?.filename || assetId || 'download'));
        }
        res.setHeader('Content-Length', object.byteSize);
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        return res.send(object.body);
      } catch (error) {
        routeLogger.error('Failed to read local media object', { error, endpoint: 'GET /api/media/local-objects/:encodedObjectKey', ip: req.ip });
        return res.status(500).json({ error: 'Failed to read media object' });
      }
    });
  }

  const getQueryClientId = (req: Request): string | null => {
    // Prefer the X-Client-Id header so the clientId (which acts as a bearer
    // secret) stays out of the URL/query string — query strings leak into
    // browser history, proxy/CDN access logs, and the Referer header. Fall back
    // to the legacy ?clientId= param so older clients keep working during rollout.
    const headerId = req.header('x-client-id');
    if (typeof headerId === 'string' && headerId.trim()) {
      return headerId.trim();
    }
    const clientId = req.query.clientId;
    return typeof clientId === 'string' && clientId.trim() ? clientId : null;
  };

  const getBodyClientId = (req: Request): string | null => {
    const clientId = req.body?.clientId;
    return typeof clientId === 'string' && clientId.trim() ? clientId : null;
  };

  const getClientAuthToken = (req: Request): string | null => {
    const headerToken = req.header('x-client-auth-token');
    if (typeof headerToken === 'string' && headerToken.trim()) {
      return headerToken.trim();
    }
    const bodyToken = req.body?.clientAuthToken;
    if (typeof bodyToken === 'string' && bodyToken.trim()) {
      return bodyToken.trim();
    }
    const queryToken = req.query.clientAuthToken;
    if (typeof queryToken === 'string' && queryToken.trim()) {
      return queryToken.trim();
    }
    return null;
  };

  const authorizeClientRequest = async (req: Request, res: Response, clientId: string, endpoint: string) => {
    if (await isClientRequestAuthorized(store, clientId, getClientAuthToken(req))) {
      return true;
    }

    routeLogger.warn('Rejected request with invalid client auth token', { endpoint, clientId, ip: req.ip });
    res.status(401).json({ error: 'User ID password login is required' });
    return false;
  };

  const runningAudioTranscriptionJobs = new Set<string>();
  const scheduleAudioTranscriptionJob = (record: AudioTranscriptionRecord, asset: MediaAsset) => {
    if (record.status === 'completed' || runningAudioTranscriptionJobs.has(record.assetId)) {
      return;
    }

    runningAudioTranscriptionJobs.add(record.assetId);
    if (!audioTranscriptionRunner) {
      void store.updateAudioTranscription(record.assetId, {
        status: 'failed',
        error: 'Audio transcription is not configured',
        completedAt: null,
      }).finally(() => {
        runningAudioTranscriptionJobs.delete(record.assetId);
      });
      return;
    }

    void audioTranscriptionRunner({ record, asset })
      .catch((error) => {
        routeLogger.error('Audio transcription runner rejected', {
          error: error instanceof Error ? error.message : error,
          assetId: record.assetId,
          roomId: record.roomId,
          messageId: record.messageId,
        });
      })
      .finally(() => {
        runningAudioTranscriptionJobs.delete(record.assetId);
      });
  };

  const resolveAudioMessageForTranscription = async (req: Request, res: Response, input: {
    roomId: string;
    messageId: string;
    clientId: string | null;
    endpoint: string;
  }): Promise<{ message: Message; asset: MediaAsset } | null> => {
    const { roomId, messageId, clientId, endpoint } = input;
    if (!roomId || !messageId || !clientId) {
      res.status(400).json({ error: 'roomId, messageId, and clientId are required' });
      return null;
    }
    if (!(await authorizeClientRequest(req, res, clientId, endpoint))) {
      return null;
    }
    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized audio transcription request', { endpoint, clientId, roomId, messageId, ip: req.ip });
      res.status(403).json({ error: 'Not authorized to access this room' });
      return null;
    }

    const messages = await store.readMessagesByRoom(roomId);
    const message = messages.find(item => item.id === messageId);
    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return null;
    }
    if (message.messageType !== 'media' || message.mediaAsset?.kind !== 'audio') {
      res.status(400).json({ error: 'Message is not an audio message' });
      return null;
    }

    const asset = message.mediaAsset?.id
      ? await store.getMediaAsset(message.mediaAsset.id)
      : await store.getMediaAssetByMessageId(messageId);
    if (!asset || asset.roomId !== roomId || asset.kind !== 'audio' || asset.messageId !== messageId) {
      res.status(404).json({ error: 'Audio media asset not found' });
      return null;
    }

    return { message, asset };
  };

  app.get('/api/push/vapid-public-key', (_req: Request, res: Response) => {
    return res.json(getPushPublicConfig());
  });

  app.post('/api/push/subscriptions', async (req: Request, res: Response) => {
    const subscription = parsePushSubscriptionBody(req.body);
    if (!subscription) {
      return res.status(400).json({ error: 'clientId and a valid push subscription are required' });
    }
    if (!(await authorizeClientRequest(req, res, subscription.clientId, 'POST /api/push/subscriptions'))) {
      return;
    }

    await store.savePushSubscription(subscription);
    return res.status(204).send();
  });

  app.delete('/api/push/subscriptions', async (req: Request, res: Response) => {
    const clientId = getBodyClientId(req);
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
    if (!clientId || !endpoint) {
      return res.status(400).json({ error: 'clientId and endpoint are required' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'DELETE /api/push/subscriptions'))) {
      return;
    }

    await store.deletePushSubscription(clientId, endpoint);
    return res.status(204).send();
  });

  app.get('/api/auth/account', async (req: Request, res: Response) => {
    const clientId = getQueryClientId(req);
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'GET /api/auth/account'))) {
      return;
    }

    const [account, passwordHash] = await Promise.all([
      store.getAccountByClientId(clientId),
      store.getClientPasswordHash(clientId),
    ]);
    return res.json({
      clientId,
      hasPassword: Boolean(passwordHash),
      googleConfigured: googleClientIds.length > 0,
      account: serializeClientAccount(account),
    });
  });

  app.post('/api/auth/google', async (req: Request, res: Response) => {
    const credential = typeof req.body?.credential === 'string' ? req.body.credential : '';
    const requestedClientId = getBodyClientId(req);
    const verified = await verifyGoogleCredentialFn(credential, googleClientIds);
    if (!verified.ok) {
      return res.status(verified.status).json({ error: verified.error });
    }

    const profile = verified.profile;
    let account = await store.getAccountByGoogleSubject(profile.providerSubject);
    if (account) {
      account = await store.updateGoogleAccountLogin(account.accountId, profile) || account;
    } else {
      if (!requestedClientId) {
        return res.status(400).json({ error: 'clientId is required' });
      }

      const existingClientAccount = await store.getAccountByClientId(requestedClientId);
      if (existingClientAccount) {
        return res.status(409).json({ error: 'This User ID is already linked to another Google account' });
      }

      if (!(await authorizeClientRequest(req, res, requestedClientId, 'POST /api/auth/google'))) {
        return;
      }

      account = await store.createGoogleAccountForClient({
        ...profile,
        accountId: uuidv4(),
        clientId: requestedClientId,
      });
      if (!account) {
        return res.status(409).json({ error: 'Failed to link Google account to this User ID' });
      }
    }

    const clientAuthToken = await issueClientAuthToken(store, account.primaryClientId, {
      accountId: account.accountId,
      authMethod: 'google',
    });
    const [passwordHash, nicknames] = await Promise.all([
      store.getClientPasswordHash(account.primaryClientId),
      store.getClientNicknames([account.primaryClientId]),
    ]);
    const nickname = nicknames[account.primaryClientId] || profile.displayName || null;
    if (!nicknames[account.primaryClientId] && profile.displayName) {
      await store.setClientNickname(account.primaryClientId, profile.displayName);
    }

    return res.json({
      clientId: account.primaryClientId,
      clientAuthToken,
      hasPassword: Boolean(passwordHash),
      nickname,
      account: serializeClientAccount(account),
    });
  });

  app.get('/api/client-auth/:clientId/status', async (req: Request, res: Response) => {
    const clientId = req.params.clientId;
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    const [passwordHash, account] = await Promise.all([
      store.getClientPasswordHash(clientId),
      store.getAccountByClientId(clientId),
    ]);
    return res.json({ clientId, hasPassword: Boolean(passwordHash), hasAccount: Boolean(account) });
  });

  app.post('/api/client-auth/password', async (req: Request, res: Response) => {
    const clientId = getBodyClientId(req);
    const password = req.body?.password;
    if (!clientId || !validateClientPassword(password)) {
      return res.status(400).json({ error: 'clientId and a password of 8 to 128 characters are required' });
    }

    const existingPasswordHash = await store.getClientPasswordHash(clientId);
    if (existingPasswordHash) {
      const currentPassword = req.body?.currentPassword;
      const hasValidCurrentPassword = typeof currentPassword === 'string'
        ? await verifyClientPassword(currentPassword, existingPasswordHash)
        : false;
      const hasValidToken = await isClientRequestAuthorized(store, clientId, getClientAuthToken(req));
      if (!hasValidCurrentPassword && !hasValidToken) {
        return res.status(401).json({ error: 'Current password or valid login token is required' });
      }
    }

    await store.setClientPasswordHash(clientId, await hashClientPassword(password));
    await store.deleteClientAuthTokens(clientId);
    const clientAuthToken = await issueClientAuthToken(store, clientId);
    return res.json({ clientId, clientAuthToken, hasPassword: true });
  });

  app.post('/api/client-auth/login', async (req: Request, res: Response) => {
    const clientId = getBodyClientId(req);
    const password = req.body?.password;
    if (!clientId || typeof password !== 'string') {
      return res.status(400).json({ error: 'clientId and password are required' });
    }

    const passwordHash = await store.getClientPasswordHash(clientId);
    if (!passwordHash || !(await verifyClientPassword(password, passwordHash))) {
      return res.status(401).json({ error: 'Invalid user ID or password' });
    }

    const clientAuthToken = await issueClientAuthToken(store, clientId);
    const nicknames = await store.getClientNicknames([clientId]);
    return res.json({ clientId, clientAuthToken, hasPassword: true, nickname: nicknames[clientId] ?? null });
  });

  app.post('/api/client-auth/logout', async (req: Request, res: Response) => {
    const clientId = getBodyClientId(req);
    const token = getClientAuthToken(req);
    if (!clientId || !token) {
      return res.status(400).json({ error: 'clientId and clientAuthToken are required' });
    }

    await store.deleteClientAuthToken(clientId, hashClientAuthToken(token));
    return res.status(204).send();
  });

  app.get('/api/rooms/:roomId/media-history', async (req: Request, res: Response) => {
    try {
      if (!mediaObjectStorage.isConfigured()) {
        return res.status(503).json({ error: 'Media object storage is not configured' });
      }

      const { roomId } = req.params;
      const clientId = getQueryClientId(req);
      if (!roomId || !clientId) {
        return res.status(400).json({ error: 'roomId and clientId are required' });
      }
      if (!(await authorizeClientRequest(req, res, clientId, 'GET /api/rooms/:roomId/media-history'))) {
        return;
      }

      if (!(await hasRoomAccess(store, roomId, clientId))) {
        routeLogger.warn('Unauthorized media history request', { endpoint: 'GET /api/rooms/:roomId/media-history', clientId, roomId, ip: req.ip });
        return res.status(403).json({ error: 'Not authorized to access this room' });
      }

      const limit = parseMediaHistoryLimit(req.query.limit);
      const page = await store.readMediaHistoryPageByRoom(roomId, {
        limit,
        before: decodeMediaHistoryCursor(req.query.before),
        since: resolveMediaHistoryCutoff(),
        kinds: parseMediaHistoryKinds(req.query.kind),
      });
      const items = await Promise.all(page.assets.map(async (asset) => {
        const signedDownload = await mediaObjectStorage.createReadUrl({
          objectKey: asset.objectKey,
          expiresInSeconds: 15 * 60,
        });

        return {
          assetId: asset.id,
          messageId: asset.messageId,
          kind: asset.kind,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          width: asset.width,
          height: asset.height,
          durationMs: asset.durationMs,
          createdAt: asset.createdAt,
          url: signedDownload.url,
          expiresAt: signedDownload.expiresAt,
        };
      }));
      const lastAsset = page.assets[page.assets.length - 1];

      return res.json({
        roomId,
        items,
        hasMore: page.hasMore,
        nextCursor: page.hasMore && lastAsset ? encodeMediaHistoryCursor(lastAsset.createdAt, lastAsset.id) : null,
        windowMonths: MEDIA_HISTORY_MONTH_WINDOW,
      });
    } catch (error) {
      routeLogger.error('Failed to read media history', { error, endpoint: 'GET /api/rooms/:roomId/media-history', roomId: req.params.roomId, ip: req.ip });
      return res.status(500).json({ error: 'Failed to load media history' });
    }
  });

  app.get('/api/rooms/:roomId/messages', async (req: Request, res: Response) => {
    const { roomId } = req.params;
    if (!roomId) {
      routeLogger.warn('API request missing room ID', { endpoint: '/api/rooms/:roomId/messages', ip: req.ip });
      return res.status(400).json({ error: 'Room ID is required' });
    }

    const clientId = getQueryClientId(req);
    if (!clientId) {
      routeLogger.warn('Unauthorized API request for room messages', { endpoint: '/api/rooms/:roomId/messages', roomId, hasClientId: !!clientId, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'GET /api/rooms/:roomId/messages'))) {
      return;
    }
    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized API request for room messages', { endpoint: '/api/rooms/:roomId/messages', roomId, hasClientId: !!clientId, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
    }

    routeLogger.info('API request for room messages', { endpoint: '/api/rooms/:roomId/messages', roomId, clientId, ip: req.ip });
    const filteredMessages = await store.readMessagesByRoom(roomId);
    return res.json(filteredMessages);
  });

  app.get('/api/rooms/:roomId/messages/:messageId/audio-transcription', async (req: Request, res: Response) => {
    try {
      const { roomId, messageId } = req.params;
      const resolved = await resolveAudioMessageForTranscription(req, res, {
        roomId,
        messageId,
        clientId: getQueryClientId(req),
        endpoint: 'GET /api/rooms/:roomId/messages/:messageId/audio-transcription',
      });
      if (!resolved) {
        return;
      }

      const record = await store.getAudioTranscription(resolved.asset.id);
      if (!record) {
        return res.json({
          assetId: resolved.asset.id,
          roomId,
          messageId,
          status: 'not_requested',
        });
      }

      if (record.status === 'pending' || record.status === 'processing') {
        scheduleAudioTranscriptionJob(record, resolved.asset);
      }
      return res.json(serializeAudioTranscription(record));
    } catch (error) {
      routeLogger.error('Failed to read audio transcription', { error, endpoint: 'GET /api/rooms/:roomId/messages/:messageId/audio-transcription', roomId: req.params.roomId, messageId: req.params.messageId, ip: req.ip });
      return res.status(500).json({ error: 'Failed to load audio transcription' });
    }
  });

  app.post('/api/rooms/:roomId/messages/:messageId/audio-transcription', async (req: Request, res: Response) => {
    try {
      const { roomId, messageId } = req.params;
      const clientId = getBodyClientId(req);
      const resolved = await resolveAudioMessageForTranscription(req, res, {
        roomId,
        messageId,
        clientId,
        endpoint: 'POST /api/rooms/:roomId/messages/:messageId/audio-transcription',
      });
      if (!resolved || !clientId) {
        return;
      }

      const now = new Date().toISOString();
      let record = await store.getAudioTranscription(resolved.asset.id);
      if (!record) {
        record = await store.createAudioTranscription({
          assetId: resolved.asset.id,
          roomId,
          messageId,
          requestedByClientId: clientId,
          status: 'pending',
          provider: 'assemblyai',
          createdAt: now,
          updatedAt: now,
        });
      } else if (record.status === 'failed') {
        record = await store.updateAudioTranscription(record.assetId, {
          status: 'pending',
          transcript: null,
          languageCode: null,
          providerTranscriptId: null,
          error: null,
          completedAt: null,
          updatedAt: now,
        }) || record;
      }

      if (record.status !== 'completed') {
        scheduleAudioTranscriptionJob(record, resolved.asset);
      }

      return res.status(record.status === 'completed' ? 200 : 202).json(serializeAudioTranscription(record));
    } catch (error) {
      routeLogger.error('Failed to start audio transcription', { error, endpoint: 'POST /api/rooms/:roomId/messages/:messageId/audio-transcription', roomId: req.params.roomId, messageId: req.params.messageId, ip: req.ip });
      return res.status(500).json({ error: 'Failed to start audio transcription' });
    }
  });

  app.get('/api/clients/:clientId/rooms', async (req: Request, res: Response) => {
    const { clientId } = req.params;
    if (!clientId) {
      routeLogger.warn('API request missing client ID', { endpoint: '/api/clients/:clientId/rooms', ip: req.ip });
      return res.status(400).json({ error: 'Client ID is required' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'GET /api/clients/:clientId/rooms'))) {
      return;
    }

    routeLogger.info('API request for client rooms', { endpoint: '/api/clients/:clientId/rooms', clientId, ip: req.ip });
    const myRooms = await store.readRoomsByUser(clientId);
    return res.json(myRooms);
  });

  app.post('/api/clients/:clientId/rooms', async (req: Request, res: Response) => {
    const { clientId } = req.params;
    if (!clientId) {
      routeLogger.warn('API request missing client ID', { endpoint: 'POST /api/clients/:clientId/rooms', ip: req.ip });
      return res.status(400).json({ error: 'Client ID is required' });
    }

    const roomData = req.body;
    if (!roomData?.name || !clientId) {
      routeLogger.warn('Invalid room creation via API', { endpoint: 'POST /api/clients/:clientId/rooms', clientId, hasRoomName: !!roomData?.name, ip: req.ip });
      return res.status(400).json({ error: 'Room name and client ID are required' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'POST /api/clients/:clientId/rooms'))) {
      return;
    }

    const roomId = await store.generateUniqueRoomId();
    const timestamp = new Date().toISOString();
    const room: Room = {
      id: roomId,
      name: roomData.name,
      description: roomData.description || '',
      createdAt: timestamp,
      lastActivityAt: timestamp,
      creatorId: clientId,
    };

    routeLogger.info('Room creation via API', { endpoint: 'POST /api/clients/:clientId/rooms', clientId, roomId, roomName: roomData.name, ip: req.ip });

    const savedRoom = await store.saveRoom(room);
    if (!savedRoom) {
      routeLogger.error('Failed to create room via API', { clientId, roomId, ip: req.ip });
      return res.status(500).json({ error: 'Failed to create room' });
    }

    io.to(clientId).emit('new_room', savedRoom);
    return res.status(201).json(savedRoom);
  });

  app.post('/api/rooms/:roomId/messages', async (req: Request, res: Response) => {
    const { roomId } = req.params;
    const { clientId, content, messageType } = req.body;

    if (!clientId || !content || !roomId) {
      routeLogger.warn('Invalid message creation via API', { endpoint: 'POST /api/rooms/:roomId/messages', hasClientId: !!clientId, hasContent: !!content, hasRoomId: !!roomId, ip: req.ip });
      return res.status(400).json({ error: 'Client ID, room ID, and message content are required' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'POST /api/rooms/:roomId/messages'))) {
      return;
    }

    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized message creation via API', { endpoint: 'POST /api/rooms/:roomId/messages', clientId, roomId, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
    }

    const postAuth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'message.post' },
    });
    if (!postAuth.ok) {
      return res.status(postAuth.code === 'posting_closed' ? 403 : 403).json({ error: postAuth.message });
    }

    if (messageType && messageType !== 'text') {
      routeLogger.warn('Rejected media creation through text API', { endpoint: 'POST /api/rooms/:roomId/messages', clientId, roomId, messageType, ip: req.ip });
      return res.status(400).json({ error: 'Media messages must use the media upload API' });
    }

    const message: Message = {
      id: uuidv4(),
      clientId,
      content,
      roomId,
      timestamp: new Date().toISOString(),
      messageType: 'text',
    };

    const loggableMessage = routeLogger.formatMessageForLog(message);
    routeLogger.info('Received HTTP API message', { ...loggableMessage, ip: req.ip });

    const updatedRoom = await store.appendMessage(message);
    if (!updatedRoom) {
      routeLogger.error('Failed to append message via API', { roomId, messageId: message.id, ip: req.ip });
      return res.status(500).json({ error: 'Failed to create message' });
    }

    io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
    io.to(roomId).emit('new_message', message);
    notifyRoomMessageBestEffort({ store, room: updatedRoom, message, logger: routeLogger });
    return res.status(201).json(message);
  });

  app.post('/api/media/uploads', async (req: Request, res: Response) => {
    if (!mediaObjectStorage.isConfigured()) {
      return res.status(503).json({ error: 'Media object storage is not configured' });
    }

    const clientId = getBodyClientId(req);
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : '';
    const kind = req.body?.kind;
    const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType.trim().toLowerCase() : '';
    const byteSize = parseByteSize(req.body?.byteSize);
    const filenameResult = sanitizeUploadFilename(req.body?.filename);

    if (!clientId || !roomId || !isMediaKind(kind) || !mimeType || !byteSize) {
      return res.status(400).json({ error: 'clientId, roomId, kind, mimeType, and byteSize are required' });
    }
    if (!filenameResult.ok) {
      return res.status(400).json({ error: filenameResult.error });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'POST /api/media/uploads'))) {
      return;
    }

    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized media upload URL request', { endpoint: 'POST /api/media/uploads', clientId, roomId, kind, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
    }

    const postAuth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'message.post' },
    });
    if (!postAuth.ok) {
      return res.status(403).json({ error: postAuth.message });
    }

    if (!isAllowedMediaMimeType(kind, mimeType)) {
      return res.status(400).json({ error: 'Unsupported media MIME type' });
    }

    if (byteSize > MEDIA_UPLOAD_LIMIT_BYTES[kind]) {
      return res.status(413).json({ error: 'Media file is too large' });
    }

    if (!consumeMediaUploadRateLimit(clientId, req.ip, getNowMs())) {
      routeLogger.warn('Rate limited media upload URL request', { endpoint: 'POST /api/media/uploads', clientId, roomId, kind, ip: req.ip });
      return res.status(429).json({ error: 'Too many media upload requests. Please try again later.' });
    }

    const assetId = uuidv4();
    const objectKey = buildMediaObjectKey(roomId, kind, assetId);
    const signedUpload = await mediaObjectStorage.createWriteUrl({
      objectKey,
      mimeType,
      byteSize,
      expiresInSeconds: 15 * 60,
    });
    const nowMs = getNowMs();
    const pendingUpload: PendingMediaUpload = {
      assetId,
      roomId,
      objectKey,
      kind,
      mimeType,
      byteSize,
      uploadedByClientId: clientId,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + pendingUploadTtlMs).toISOString(),
    };
    if (filenameResult.filename !== undefined) {
      pendingUpload.filename = filenameResult.filename;
    }
    await store.savePendingMediaUpload(pendingUpload);

    return res.status(201).json({
      assetId,
      uploadUrl: signedUpload.url,
      objectKey,
      expiresAt: signedUpload.expiresAt,
    });
  });

  app.post('/api/media/uploads/:assetId/complete', async (req: Request, res: Response) => {
    if (!mediaObjectStorage.isConfigured()) {
      return res.status(503).json({ error: 'Media object storage is not configured' });
    }

    const { assetId } = req.params;
    const clientId = getBodyClientId(req);
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : '';
    const kind = req.body?.kind;
    const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType.trim().toLowerCase() : '';
    const byteSize = parseByteSize(req.body?.byteSize);
    const objectKey = typeof req.body?.objectKey === 'string' ? req.body.objectKey : '';
    const content = typeof req.body?.caption === 'string' ? req.body.caption : '';
    const width = parseOptionalInteger(req.body?.width);
    const height = parseOptionalInteger(req.body?.height);
    const durationMs = parseOptionalInteger(req.body?.durationMs);
    const filenameResult = sanitizeUploadFilename(req.body?.filename);

    if (!assetId || !clientId || !roomId || !isMediaKind(kind) || !mimeType || !byteSize || !objectKey) {
      return res.status(400).json({ error: 'assetId, clientId, roomId, kind, mimeType, byteSize, and objectKey are required' });
    }
    if (!filenameResult.ok) {
      return res.status(400).json({ error: filenameResult.error });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'POST /api/media/uploads/:assetId/complete'))) {
      return;
    }

    if (objectKey !== buildMediaObjectKey(roomId, kind, assetId)) {
      return res.status(400).json({ error: 'Invalid media object key' });
    }

    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized media upload completion', { endpoint: 'POST /api/media/uploads/:assetId/complete', clientId, roomId, assetId, kind, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
    }

    const postAuth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'message.post' },
    });
    if (!postAuth.ok) {
      return res.status(403).json({ error: postAuth.message });
    }

    if (!isAllowedMediaMimeType(kind, mimeType)) {
      return res.status(400).json({ error: 'Unsupported media MIME type' });
    }

    if (byteSize > MEDIA_UPLOAD_LIMIT_BYTES[kind]) {
      return res.status(413).json({ error: 'Media file is too large' });
    }

    if (await store.getMediaAsset(assetId)) {
      return res.status(409).json({ error: 'Media upload has already been completed' });
    }

    const pendingUpload = await store.getPendingMediaUpload(assetId);
    if (!pendingUpload) {
      return res.status(409).json({ error: 'Media upload was not initialized or has expired' });
    }
    if (
      pendingUpload.roomId !== roomId ||
      pendingUpload.objectKey !== objectKey ||
      pendingUpload.kind !== kind ||
      pendingUpload.mimeType !== mimeType ||
      pendingUpload.byteSize !== byteSize ||
      pendingUpload.uploadedByClientId !== clientId
    ) {
      return res.status(409).json({ error: 'Media upload metadata does not match the initialized upload' });
    }
    if (Date.parse(pendingUpload.expiresAt) <= getNowMs()) {
      await store.deletePendingMediaUpload(assetId);
      await deleteMediaObjectBestEffort(objectKey, 'pending-media-upload-expired-on-complete');
      return res.status(410).json({ error: 'Media upload has expired' });
    }
    const pendingFilenameResult = sanitizeUploadFilename(pendingUpload.filename);
    if (!pendingFilenameResult.ok) {
      return res.status(400).json({ error: pendingFilenameResult.error });
    }
    const filename = pendingFilenameResult.filename || filenameResult.filename;

    const objectHead = await mediaObjectStorage.headObject({ objectKey });
    if (!objectHead.exists) {
      return res.status(409).json({ error: 'Uploaded media object was not found' });
    }
    if (objectHead.byteSize !== undefined && objectHead.byteSize !== byteSize) {
      await store.deletePendingMediaUpload(assetId);
      await deleteMediaObjectBestEffort(objectKey, 'media-complete-size-mismatch');
      return res.status(409).json({ error: 'Uploaded media object size does not match' });
    }
    if (objectHead.mimeType && objectHead.mimeType.toLowerCase() !== mimeType) {
      await store.deletePendingMediaUpload(assetId);
      await deleteMediaObjectBestEffort(objectKey, 'media-complete-mime-mismatch');
      return res.status(409).json({ error: 'Uploaded media object MIME type does not match' });
    }

    let replyTo;
    if (typeof req.body?.replyToMessageId === 'string' && req.body.replyToMessageId) {
      const roomMessages = await store.readMessagesByRoom(roomId);
      const quotedMessage = roomMessages.find(message => message.id === req.body.replyToMessageId);
      if (!quotedMessage) {
        return res.status(400).json({ error: 'Quoted message not found' });
      }
      replyTo = createReplyReference(quotedMessage);
    }

    const message = createMediaMessage({
      id: uuidv4(),
      clientId,
      roomId,
      content,
      kind,
      assetId,
      mimeType,
      byteSize,
      filename,
      width,
      height,
      durationMs,
      username: typeof req.body?.username === 'string' ? req.body.username : undefined,
      avatar: req.body?.avatar,
      replyTo,
      clientMessageId: typeof req.body?.clientMessageId === 'string' ? req.body.clientMessageId : undefined,
    });

    const asset: MediaAsset = {
      id: assetId,
      roomId,
      messageId: message.id,
      objectKey,
      kind,
      mimeType,
      byteSize,
      width,
      height,
      durationMs,
      uploadedByClientId: clientId,
      createdAt: message.timestamp,
    };
    if (filename !== undefined) {
      asset.filename = filename;
    }

    const appendResult = await store.appendMediaMessageWithAsset(message, asset);
    if (!appendResult) {
      await store.deletePendingMediaUpload(assetId);
      await deleteMediaObjectBestEffort(objectKey, 'media-complete-persistence-failed');
      return res.status(500).json({ error: 'Failed to create media message' });
    }

    await store.deletePendingMediaUpload(assetId);
    io.to(appendResult.room.creatorId).emit('room_updated', appendResult.room);
    io.to(roomId).emit('new_message', appendResult.message);
    notifyRoomMessageBestEffort({ store, room: appendResult.room, message: appendResult.message, logger: routeLogger });
    return res.status(201).json(appendResult.message);
  });

  app.get('/api/media/:assetId/download-url', async (req: Request, res: Response) => {
    if (!mediaObjectStorage.isConfigured()) {
      return res.status(503).json({ error: 'Media object storage is not configured' });
    }

    const { assetId } = req.params;
    const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : '';
    const clientId = getQueryClientId(req);

    if (!assetId || !roomId || !clientId) {
      return res.status(400).json({ error: 'assetId, roomId, and clientId are required' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'GET /api/media/:assetId/download-url'))) {
      return;
    }

    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized media download URL request', { endpoint: 'GET /api/media/:assetId/download-url', clientId, roomId, assetId, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
    }

    const asset = await store.getMediaAsset(assetId);
    if (!asset || asset.roomId !== roomId) {
      return res.status(404).json({ error: 'Media asset not found' });
    }

    const signedDownload = await mediaObjectStorage.createReadUrl({
      objectKey: asset.objectKey,
      expiresInSeconds: 15 * 60,
      responseCacheControl: 'private, max-age=900',
      responseContentDisposition: asset.kind === 'file'
        ? buildAttachmentContentDisposition(asset.filename || asset.id)
        : undefined,
    });
    return res.json(signedDownload);
  });

  app.get('/api/ai-models', (_req: Request, res: Response) => {
    res.json(getAIModelResponse());
  });

  app.get('/api/features', (req: Request, res: Response) => {
    const clientId = getQueryClientId(req) ?? undefined;
    return res.json({
      coco: {
        ...cocoAccess.toFeaturePayload(clientId),
        mode: cocoMode,
      },
    });
  });

  // Public sticker catalog: a fixed, shared library clients load once. Stickers are
  // referenced by id in sticker messages, never re-uploaded per room.
  app.get('/api/stickers/catalog', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(getStickerCatalog());
  });

  // Sticker image bytes. In dev (or wherever STICKER_LOCAL_DIR points), serve the
  // immutable files straight from disk. Catalog urls are /api/stickers/asset/<id>.jpg
  // so the same path can later stream from object storage in production.
  const stickerLocalDir = process.env.STICKER_LOCAL_DIR
    || path.resolve(process.cwd(), '.local-stickers');
  if (fs.existsSync(stickerLocalDir)) {
    app.use('/api/stickers/asset', express.static(stickerLocalDir, {
      immutable: true,
      maxAge: '7d',
      fallthrough: true,
    }));
  }
  app.get('/api/stickers/asset/*', async (req: Request, res: Response) => {
    if (!mediaObjectStorage.isConfigured()) {
      return res.status(404).json({ error: 'Sticker asset not found' });
    }

    const assetPath = parseStickerAssetPath(req.params[0]);
    if (!assetPath) {
      return res.status(400).json({ error: 'Invalid sticker asset path' });
    }

    const objectKey = `${STICKER_OBJECT_PREFIX}${assetPath}`;
    try {
      const head = await mediaObjectStorage.headObject({ objectKey });
      if (!head.exists) {
        return res.status(404).json({ error: 'Sticker asset not found' });
      }

      const signedDownload = await mediaObjectStorage.createReadUrl({
        objectKey,
        expiresInSeconds: STICKER_ASSET_SIGNED_URL_TTL_SECONDS,
        responseCacheControl: STICKER_ASSET_RESPONSE_CACHE_CONTROL,
      });
      res.set('Cache-Control', `public, max-age=${STICKER_ASSET_REDIRECT_CACHE_SECONDS}, immutable`);
      return res.redirect(302, signedDownload.url);
    } catch (error) {
      routeLogger.error('Failed to create sticker asset download URL', { error, endpoint: 'GET /api/stickers/asset/*', objectKey, ip: req.ip });
      return res.status(500).json({ error: 'Failed to read sticker asset' });
    }
  });

  app.post('/api/ai-role-draft', async (req: Request, res: Response) => {
    const idea = typeof req.body?.idea === 'string' ? req.body.idea.trim() : '';
    const clientId = getBodyClientId(req);
    if (!idea || idea.length > MAX_AI_ROLE_IDEA_LENGTH) {
      return res.status(400).json({ error: 'Role idea is required and must be 2000 characters or fewer' });
    }
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'POST /api/ai-role-draft'))) {
      return;
    }

    if (!consumeAIRoleDraftRateLimit(req.ip)) {
      routeLogger.warn('Rate limited AI role draft request', { endpoint: 'POST /api/ai-role-draft', clientId, ip: req.ip });
      return res.status(429).json({ error: 'Too many AI role draft requests. Please try again later.' });
    }

    try {
      return res.json(await generateAIRoleDraft(idea));
    } catch (error) {
      routeLogger.error('Failed to generate AI role draft', {
        error: error instanceof Error ? error.message : error,
        ip: req.ip,
      });
      return res.status(502).json({ error: 'Failed to generate AI role draft' });
    }
  });

  app.get('/api/rooms/:roomId/ai-cost', async (req: Request, res: Response) => {
    const { roomId } = req.params;
    if (!roomId) {
      routeLogger.warn('API request missing room ID', { endpoint: '/api/rooms/:roomId/ai-cost', ip: req.ip });
      return res.status(400).json({ error: 'Room ID is required' });
    }

    const clientId = getQueryClientId(req);
    if (!clientId) {
      routeLogger.warn('Unauthorized API request for room AI cost', { endpoint: '/api/rooms/:roomId/ai-cost', roomId, hasClientId: !!clientId, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'GET /api/rooms/:roomId/ai-cost'))) {
      return;
    }
    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized API request for room AI cost', { endpoint: '/api/rooms/:roomId/ai-cost', roomId, hasClientId: !!clientId, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
    }

    return res.json(await store.readRoomAICost(roomId));
  });

  app.get('/api/clients/:clientId/rooms/:roomId/workspace', async (req: Request, res: Response) => {
    const { clientId, roomId } = req.params;
    if (!clientId || !roomId) {
      routeLogger.warn('Workspace snapshot request missing parameters', {
        endpoint: 'GET /api/clients/:clientId/rooms/:roomId/workspace',
        hasClientId: !!clientId,
        hasRoomId: !!roomId,
        ip: req.ip,
      });
      return res.status(400).json({ error: 'Client ID and room ID are required' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'GET /api/clients/:clientId/rooms/:roomId/workspace'))) {
      return;
    }
    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized workspace snapshot request', {
        endpoint: 'GET /api/clients/:clientId/rooms/:roomId/workspace',
        clientId,
        roomId,
        ip: req.ip,
      });
      return res.status(403).json({ error: 'Not authorized to access this room' });
    }

    const access = cocoAccess.canUse(clientId);
    if (!access.allowed) {
      routeLogger.warn('Workspace snapshot rejected by Coco rollout controls', {
        endpoint: 'GET /api/clients/:clientId/rooms/:roomId/workspace',
        clientId,
        roomId,
        reason: access.reason,
        ip: req.ip,
      });
      return res.status(403).json({ error: access.message || 'Coco is unavailable' });
    }

    try {
      const room = await store.getRoomById(roomId);
      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }
      if (room.type !== 'coco') {
        return res.status(400).json({ error: 'Workspace snapshots are only available for Coco rooms' });
      }

      const messages = await store.readMessagesByRoom(roomId);
      return res.json(buildCodeAgentWorkspaceSnapshot(room, messages));
    } catch (error) {
      routeLogger.error('Failed to build workspace snapshot', { error, clientId, roomId, ip: req.ip });
      return res.status(500).json({ error: 'Failed to load workspace snapshot' });
    }
  });

  app.get('/api/clients/:clientId/rooms/:roomId', async (req: Request, res: Response) => {
    const { clientId, roomId } = req.params;

    if (!clientId) {
      routeLogger.warn('API request missing client ID', { endpoint: '/api/clients/:clientId/rooms/:roomId', roomId, ip: req.ip });
      return res.status(400).json({ error: 'Client ID is required' });
    }
    if (!(await authorizeClientRequest(req, res, clientId, 'GET /api/clients/:clientId/rooms/:roomId'))) {
      return;
    }

    const room = await store.getRoomById(roomId);
    if (!room || !(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Room not found or not accessible by client', { endpoint: '/api/clients/:clientId/rooms/:roomId', clientId, roomId, found: !!room, ip: req.ip });
      return res.status(404).json({ error: 'Room not found' });
    }

    routeLogger.info('Room details requested via API', { endpoint: '/api/clients/:clientId/rooms/:roomId', clientId, roomId, roomName: room.name, ip: req.ip });
    return res.json(room);
  });

  app.get('/api/status', async (req: Request, res: Response) => {
    try {
      const redisStatus = redisClient.isOpen ? 'connected' : 'disconnected';
      const roomCount = await store.countRooms();

      routeLogger.info('System status requested', { endpoint: '/api/status', ip: req.ip });

      return res.json({
        status: 'online',
        persistenceStore,
        redis: redisStatus,
        socketAdapterReady: io.of('/').adapter ? true : false,
        features: {
          coco: {
            enabled: cocoAccess.enabled,
            rollout: !cocoAccess.enabled ? 'disabled' : cocoAccess.hasAllowlist ? 'allowlist' : 'all',
            mode: cocoMode,
          },
        },
        rooms: roomCount,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      routeLogger.error('Error getting system status', { error, ip: req.ip });
      return res.status(500).json({ error: 'Error getting system status' });
    }
  });

  if (process.env.E2E_TEST_MODE === 'true') {
    app.post('/api/e2e/reset', async (_req: Request, res: Response) => {
      try {
        if (store.resetAllDataForTests) {
          await store.resetAllDataForTests();
        } else {
          await redisClient.flushDb();
        }
        routeLogger.warn('E2E database reset');
        return res.json({ ok: true });
      } catch (error) {
        routeLogger.error('Failed to reset E2E database', { error });
        return res.status(500).json({ error: 'Failed to reset E2E database' });
      }
    });
  }
}
