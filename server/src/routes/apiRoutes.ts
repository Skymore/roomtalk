import { Express, Request, Response } from 'express';
import { Server } from 'socket.io';
import { RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { RedisStore } from '../repositories/redisStore';
import { Message, Room } from '../types';

interface ApiRouteOptions {
  store: RedisStore;
  io: Server;
  redisClient: RedisClientType;
  routeLogger: Logger;
  getAIModelResponse: () => unknown;
}

export function registerApiRoutes(app: Express, options: ApiRouteOptions) {
  const { store, io, redisClient, routeLogger, getAIModelResponse } = options;

  app.get('/api/rooms/:roomId/messages', async (req: Request, res: Response) => {
    const { roomId } = req.params;
    if (!roomId) {
      routeLogger.warn('API request missing room ID', { endpoint: '/api/rooms/:roomId/messages', ip: req.ip });
      return res.status(400).json({ error: 'Room ID is required' });
    }

    routeLogger.info('API request for room messages', { endpoint: '/api/rooms/:roomId/messages', roomId, ip: req.ip });
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
    const room: Room = {
      id: roomId,
      name: roomData.name,
      description: roomData.description || '',
      createdAt: new Date().toISOString(),
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

    const message: Message = {
      id: uuidv4(),
      clientId,
      content,
      roomId,
      timestamp: new Date().toISOString(),
      messageType: messageType || 'text',
    };

    const loggableMessage = routeLogger.formatMessageForLog(message);
    routeLogger.info('Received HTTP API message', { ...loggableMessage, ip: req.ip });

    await store.appendMessage(message);
    io.to(roomId).emit('new_message', message);
    return res.status(201).json(message);
  });

  app.get('/api/ai-models', (_req: Request, res: Response) => {
    res.json(getAIModelResponse());
  });

  app.get('/api/rooms/:roomId/ai-cost', async (req: Request, res: Response) => {
    const { roomId } = req.params;
    if (!roomId) {
      routeLogger.warn('API request missing room ID', { endpoint: '/api/rooms/:roomId/ai-cost', ip: req.ip });
      return res.status(400).json({ error: 'Room ID is required' });
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
    if (!room || room.creatorId !== clientId) {
      routeLogger.warn('Room not found or not owned by client', { endpoint: '/api/clients/:clientId/rooms/:roomId', clientId, roomId, found: !!room, authorized: room?.creatorId === clientId, ip: req.ip });
      return res.status(404).json({ error: 'Room not found' });
    }

    routeLogger.info('Room details requested via API', { endpoint: '/api/clients/:clientId/rooms/:roomId', clientId, roomId, roomName: room.name, ip: req.ip });
    return res.json(room);
  });

  app.get('/api/status', async (req: Request, res: Response) => {
    try {
      const redisStatus = redisClient.isOpen ? 'connected' : 'disconnected';
      const roomCount = await redisClient.hLen('rooms');

      routeLogger.info('System status requested', { endpoint: '/api/status', ip: req.ip });

      return res.json({
        status: 'online',
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
        await redisClient.flushDb();
        routeLogger.warn('E2E Redis database reset');
        return res.json({ ok: true });
      } catch (error) {
        routeLogger.error('Failed to reset E2E Redis database', { error });
        return res.status(500).json({ error: 'Failed to reset E2E database' });
      }
    });
  }
}
