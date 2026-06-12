import express, { Express, Request, Response } from 'express';
import { Server } from 'socket.io';
import { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { MediaHistoryPageCursor, RoomStore } from '../repositories/store';
import { MediaAsset, MediaKind, Message, Room } from '../types';
import { AIRoleDraft, MAX_AI_ROLE_IDEA_LENGTH } from '../services/aiRoleGenerator';
import { hasRoomAccess } from '../socket/roomAccess';
import { authorizeRoomAction } from '../socket/roomAuthorization';
import { createMediaMessage, createReplyReference } from '../services/messageDomain';
import { decodeLocalMediaObjectKey, LocalMediaObjectStorage, MediaObjectStorage } from '../services/mediaObjectStorage';
import { getPushPublicConfig, notifyRoomMessageBestEffort } from '../services/pushNotifications';
import {
  hashClientAuthToken,
  hashClientPassword,
  isClientRequestAuthorized,
  issueClientAuthToken,
  validateClientPassword,
  verifyClientPassword,
} from '../services/clientAuth';

interface ApiRouteOptions {
  store: RoomStore;
  io: Server;
  redisClient: RedisClientType;
  routeLogger: Logger;
  getAIModelResponse: () => unknown;
  generateAIRoleDraft: (idea: string) => Promise<AIRoleDraft>;
  persistenceStore?: string;
  mediaObjectStorage: MediaObjectStorage;
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

type RateLimitEntry = {
  windowStartMs: number;
  count: number;
};

const aiRoleDraftRateLimits = new Map<string, RateLimitEntry>();
const mediaUploadRateLimits = new Map<string, RateLimitEntry>();

const isMediaKind = (kind: unknown): kind is MediaKind => (
  kind === 'image' || kind === 'audio' || kind === 'video'
);

const isAllowedMediaMimeType = (kind: MediaKind, mimeType: string) => {
  if (!mimeType || mimeType.includes('\n') || mimeType.includes('\r')) {
    return false;
  }
  if (kind === 'image') {
    return mimeType.startsWith('image/') && mimeType !== 'image/svg+xml';
  }
  return mimeType.startsWith(`${kind}/`);
};

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

const parsePushSubscriptionBody = (body: unknown) => {
  const payload = body && typeof body === 'object' ? body as Record<string, any> : {};
  const subscription = payload.subscription && typeof payload.subscription === 'object'
    ? payload.subscription as Record<string, any>
    : {};
  const keys = subscription.keys && typeof subscription.keys === 'object'
    ? subscription.keys as Record<string, any>
    : {};
  const clientId = typeof payload.clientId === 'string' ? payload.clientId.trim() : '';
  const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  const userAgent = typeof payload.userAgent === 'string' ? payload.userAgent.slice(0, 500) : undefined;

  if (!clientId || !endpoint || !p256dh || !auth) {
    return null;
  }

  return { clientId, endpoint, p256dh, auth, userAgent };
};

const consumeAIRoleDraftRateLimit = (clientId: string, ip: string | undefined, nowMs = Date.now()) => {
  const key = `${clientId}:${ip || 'unknown'}`;
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
  const { store, io, redisClient, routeLogger, getAIModelResponse, generateAIRoleDraft, persistenceStore = 'redis', mediaObjectStorage } = options;
  const mediaUploadCleanup = options.mediaUploadCleanup || {};
  const getNowMs = mediaUploadCleanup.nowMs || (() => Date.now());
  const pendingUploadTtlMs = mediaUploadCleanup.pendingUploadTtlMs ?? MEDIA_PENDING_UPLOAD_TTL_MS;
  const sweepIntervalMs = mediaUploadCleanup.sweepIntervalMs ?? MEDIA_PENDING_UPLOAD_SWEEP_INTERVAL_MS;
  const sweepBatchSize = mediaUploadCleanup.sweepBatchSize ?? MEDIA_PENDING_UPLOAD_SWEEP_BATCH_SIZE;

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
        res.type(object.mimeType || head.mimeType || 'application/octet-stream');
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

  app.get('/api/client-auth/:clientId/status', async (req: Request, res: Response) => {
    const clientId = req.params.clientId;
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    const passwordHash = await store.getClientPasswordHash(clientId);
    return res.json({ clientId, hasPassword: Boolean(passwordHash) });
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
    return res.json({ clientId, clientAuthToken, hasPassword: true });
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

    if (!clientId || !roomId || !isMediaKind(kind) || !mimeType || !byteSize) {
      return res.status(400).json({ error: 'clientId, roomId, kind, mimeType, and byteSize are required' });
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
    await store.savePendingMediaUpload({
      assetId,
      roomId,
      objectKey,
      kind,
      mimeType,
      byteSize,
      uploadedByClientId: clientId,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + pendingUploadTtlMs).toISOString(),
    });

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

    if (!assetId || !clientId || !roomId || !isMediaKind(kind) || !mimeType || !byteSize || !objectKey) {
      return res.status(400).json({ error: 'assetId, clientId, roomId, kind, mimeType, byteSize, and objectKey are required' });
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
    });
    return res.json(signedDownload);
  });

  app.get('/api/ai-models', (_req: Request, res: Response) => {
    res.json(getAIModelResponse());
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

    const rooms = await store.readRoomsByUser(clientId);
    if (rooms.length === 0) {
      routeLogger.warn('Unauthorized AI role draft request', { endpoint: 'POST /api/ai-role-draft', clientId, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to generate AI role drafts' });
    }

    if (!consumeAIRoleDraftRateLimit(clientId, req.ip)) {
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
