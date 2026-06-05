import { Express, Request, Response } from 'express';
import { Server } from 'socket.io';
import { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { MediaAsset, MediaKind, Message, Room } from '../types';
import { AIRoleDraft, MAX_AI_ROLE_IDEA_LENGTH } from '../services/aiRoleGenerator';
import { hasRoomAccess } from '../socket/roomAccess';
import { createMediaMessage, createReplyReference } from '../services/messageDomain';
import { MediaObjectStorage } from '../services/mediaObjectStorage';

interface ApiRouteOptions {
  store: RoomStore;
  io: Server;
  redisClient: RedisClientType;
  routeLogger: Logger;
  getAIModelResponse: () => unknown;
  generateAIRoleDraft: (idea: string) => Promise<AIRoleDraft>;
  persistenceStore?: string;
  mediaObjectStorage: MediaObjectStorage;
}

const MEDIA_UPLOAD_LIMIT_BYTES: Record<MediaKind, number> = {
  image: 10 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  video: 100 * 1024 * 1024,
};

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

export function registerApiRoutes(app: Express, options: ApiRouteOptions) {
  const { store, io, redisClient, routeLogger, getAIModelResponse, generateAIRoleDraft, persistenceStore = 'redis', mediaObjectStorage } = options;

  const getQueryClientId = (req: Request): string | null => {
    const clientId = req.query.clientId;
    return typeof clientId === 'string' && clientId.trim() ? clientId : null;
  };

  const getBodyClientId = (req: Request): string | null => {
    const clientId = req.body?.clientId;
    return typeof clientId === 'string' && clientId.trim() ? clientId : null;
  };

  app.get('/api/rooms/:roomId/messages', async (req: Request, res: Response) => {
    const { roomId } = req.params;
    if (!roomId) {
      routeLogger.warn('API request missing room ID', { endpoint: '/api/rooms/:roomId/messages', ip: req.ip });
      return res.status(400).json({ error: 'Room ID is required' });
    }

    const clientId = getQueryClientId(req);
    if (!clientId || !(await hasRoomAccess(store, roomId, clientId))) {
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

    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized message creation via API', { endpoint: 'POST /api/rooms/:roomId/messages', clientId, roomId, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
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

    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized media upload URL request', { endpoint: 'POST /api/media/uploads', clientId, roomId, kind, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
    }

    if (!isAllowedMediaMimeType(kind, mimeType)) {
      return res.status(400).json({ error: 'Unsupported media MIME type' });
    }

    if (byteSize > MEDIA_UPLOAD_LIMIT_BYTES[kind]) {
      return res.status(413).json({ error: 'Media file is too large' });
    }

    const assetId = uuidv4();
    const objectKey = buildMediaObjectKey(roomId, kind, assetId);
    const signedUpload = await mediaObjectStorage.createWriteUrl({
      objectKey,
      mimeType,
      byteSize,
      expiresInSeconds: 15 * 60,
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

    if (objectKey !== buildMediaObjectKey(roomId, kind, assetId)) {
      return res.status(400).json({ error: 'Invalid media object key' });
    }

    if (!(await hasRoomAccess(store, roomId, clientId))) {
      routeLogger.warn('Unauthorized media upload completion', { endpoint: 'POST /api/media/uploads/:assetId/complete', clientId, roomId, assetId, kind, ip: req.ip });
      return res.status(403).json({ error: 'Not authorized to access this room' });
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

    const objectHead = await mediaObjectStorage.headObject({ objectKey });
    if (!objectHead.exists) {
      return res.status(409).json({ error: 'Uploaded media object was not found' });
    }
    if (objectHead.byteSize !== undefined && objectHead.byteSize !== byteSize) {
      return res.status(409).json({ error: 'Uploaded media object size does not match' });
    }
    if (objectHead.mimeType && objectHead.mimeType.toLowerCase() !== mimeType) {
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
      await mediaObjectStorage.deleteMediaObject?.(objectKey);
      return res.status(500).json({ error: 'Failed to create media message' });
    }

    io.to(appendResult.room.creatorId).emit('room_updated', appendResult.room);
    io.to(roomId).emit('new_message', appendResult.message);
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
    if (!idea || idea.length > MAX_AI_ROLE_IDEA_LENGTH) {
      return res.status(400).json({ error: 'Role idea is required and must be 2000 characters or fewer' });
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
    if (!clientId || !(await hasRoomAccess(store, roomId, clientId))) {
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
