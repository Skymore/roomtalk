// 导入日志类
import { Logger, httpLogger, defaultLogger } from './logger';

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import path from 'path';
import { createClient, RedisClientType } from 'redis';
import dotenv from 'dotenv';
import { customAlphabet } from 'nanoid';
import sharp from 'sharp'; // 新增：用于无损压缩图片

dotenv.config();

// 创建各模块的日志记录器
const serverLogger = new Logger('Server');
const redisLogger = new Logger('Redis');
const socketLogger = new Logger('SocketIO');
const routeLogger = new Logger('Routes');

// nanoid生成器保持不变
const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 10);

// 生成唯一房间ID并进行碰撞检测
async function generateUniqueRoomId(redisClient: any): Promise<string> {
  let attempts = 0;
  const maxAttempts = 5; // 最多尝试5次
  
  while (attempts < maxAttempts) {
    const id = nanoid();
    // 检查ID是否已存在
    const exists = await redisClient.hExists("rooms", id);
    if (!exists) {
      return id; // 找到未使用的ID
    }
    attempts++;
    redisLogger.debug(`Room ID collision detected, retrying`, { attempt: attempts, maxAttempts });
  }
  
  // 如果多次尝试后仍有冲突，生成更长的ID
  redisLogger.warn(`Multiple collisions detected, using longer ID`);
  return nanoid(12); // 使用12位ID降低碰撞概率
}

// 类型定义保持不变
interface Message {
  id: string;
  clientId: string;
  content: string;
  roomId: string;
  timestamp: string;
  messageType: 'text' | 'image';
  username?: string;
  avatar?: {
    text: string;
    color: string;
  };
  mimeType?: string;
}

interface Room {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  creatorId: string;
}

interface UserInfo {
  id: string;
}

interface RoomMemberEvent {
  roomId: string;
  user: UserInfo;
  count: number;
  action: 'join' | 'leave';
  timestamp: string;
}

// 初始化 Express 应用
const app = express();
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  methods: ['GET', 'POST'],
  credentials: true
}));
console.log(`process.env.CLIENT_URL: ${process.env.CLIENT_URL}`);
app.use(express.json());

// 添加HTTP请求日志中间件
app.use(httpLogger);

// 提供前端构建后的静态文件服务
app.use(express.static(path.join(__dirname, '../../../client-heroui/dist')));

// 创建 HTTP 服务器
const server = http.createServer(app);

// 从环境变量获取 Redis URL
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// 初始化 Redis 客户端
const redisClient: RedisClientType = createClient({
  url: REDIS_URL
});

redisClient.on('error', (err) => {
  redisLogger.error('Redis connection error', { error: err.message, stack: err.stack });
});

// 创建 Redis 适配器所需的客户端
const pubClient = createClient({ url: REDIS_URL });
const subClient = pubClient.duplicate();

// 监听 Redis 客户端错误
pubClient.on('error', (err) => {
  redisLogger.error('Redis Pub Client Error:', { error: err.message, stack: err.stack });
});

subClient.on('error', (err) => {
  redisLogger.error('Redis Sub Client Error:', { error: err.message, stack: err.stack });
});

// 初始化 Socket.IO 服务器（暂不设置适配器，等待 Redis 连接后再设置）
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 5 * 1024 * 1024, // 设置最大消息大小为 5MB
  pingTimeout: 60000, // 60秒超时
  pingInterval: 25000 // 25秒ping一次
});

// 使用立即执行异步函数来初始化 Redis 和 Socket.IO 适配器
(async () => {
  try {
    // 连接所有 Redis 客户端
    await Promise.all([
      redisClient.connect(),
      pubClient.connect(),
      subClient.connect()
    ]);
    
    // 设置 Socket.IO Redis 适配器
    io.adapter(createAdapter(pubClient, subClient));
    
    redisLogger.info('Connected to Redis and Socket.IO adapter initialized');
  } catch (err) {
    redisLogger.error('Failed to connect to Redis or initialize adapter', { 
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
  }
})();

// Redis 数据存储操作
async function saveMessage(message: Message): Promise<void> {
  try {
    await redisClient.rPush(`room:${message.roomId}:messages`, JSON.stringify(message));
    redisLogger.debug('Message saved to Redis', { messageId: message.id, roomId: message.roomId });
  } catch (error) {
    redisLogger.error('Error saving message to Redis', { error, messageId: message.id, roomId: message.roomId });
  }
}

async function readMessagesByRoom(roomId: string): Promise<Message[]> {
  try {
    const messages = await redisClient.lRange(`room:${roomId}:messages`, 0, -1);
    redisLogger.debug('Messages read from Redis', { roomId, count: messages.length });
    return messages.map((msg) => JSON.parse(msg));
  } catch (error) {
    redisLogger.error('Error reading messages from Redis', { error, roomId });
    return [];
  }
}

async function saveRoom(room: Room): Promise<Room | null> {
  try {
    await redisClient.hSet("rooms", room.id, JSON.stringify(room));
    await redisClient.sAdd(`user:${room.creatorId}:rooms`, room.id);
    redisLogger.debug('Room saved to Redis', { roomId: room.id, creatorId: room.creatorId });
    return room;
  } catch (error) {
    redisLogger.error('Error saving room to Redis', { error, roomId: room.id });
    return null;
  }
}

async function readRoomsByUser(clientId: string): Promise<Room[]> {
  try {
    const roomIds = await redisClient.sMembers(`user:${clientId}:rooms`);
    const rooms = await Promise.all(
      roomIds.map(id => redisClient.hGet("rooms", id))
    );
    redisLogger.debug('Rooms read by user from Redis', { clientId, count: roomIds.length });
    return rooms.map(room => JSON.parse(room!));
  } catch (error) {
    redisLogger.error('Error reading rooms for user from Redis', { error, clientId });
    return [];
  }
}

async function getRoomById(roomId: string): Promise<Room | null> {
  try {
    const roomStr = await redisClient.hGet("rooms", roomId);
    redisLogger.debug('Room read by ID from Redis', { roomId, found: !!roomStr });
    return roomStr ? JSON.parse(roomStr) : null;
  } catch (error) {
    redisLogger.error('Error reading room by id from Redis', { error, roomId });
    return null;
  }
}

// 更新并获取房间成员数（将房间成员信息迁移到 Redis）
async function updateRoomMemberCount(roomId: string, clientId: string, isJoining: boolean): Promise<number> {
  try {
    const roomMembersKey = `room:${roomId}:members`;
    
    if (isJoining) {
      await redisClient.sAdd(roomMembersKey, clientId);
    } else {
      await redisClient.sRem(roomMembersKey, clientId);
    }
    
    const count = await redisClient.sCard(roomMembersKey);
    return count;
  } catch (error) {
    redisLogger.error('Error updating room member count', { error, roomId, clientId, isJoining });
    return 0;
  }
}

// 获取指定房间的成员计数
async function getRoomMemberCount(roomId: string): Promise<number> {
  try {
    const roomMembersKey = `room:${roomId}:members`;
    return await redisClient.sCard(roomMembersKey);
  } catch (error) {
    redisLogger.error('Error getting room member count', { error, roomId });
    return 0;
  }
}

// 将用户会话数据迁移到 Redis
async function storeClientSession(socketId: string, userId: string): Promise<void> {
  try {
    await redisClient.hSet('socket:clients', socketId, userId);
  } catch (error) {
    redisLogger.error('Error storing client session', { error, socketId, userId });
  }
}

async function getClientId(socketId: string): Promise<string | null> {
  try {
    const clientId = await redisClient.hGet('socket:clients', socketId);
    return clientId || null;
  } catch (error) {
    redisLogger.error('Error getting client ID', { error, socketId });
    return null;
  }
}

async function removeClientSession(socketId: string): Promise<void> {
  try {
    await redisClient.hDel('socket:clients', socketId);
  } catch (error) {
    redisLogger.error('Error removing client session', { error, socketId });
  }
}

// 存储用户的房间信息
async function storeUserRooms(socketId: string, roomIds: string[]): Promise<void> {
  try {
    if (roomIds.length > 0) {
      await redisClient.hSet('socket:rooms', socketId, JSON.stringify(roomIds));
    } else {
      await redisClient.hDel('socket:rooms', socketId);
    }
  } catch (error) {
    redisLogger.error('Error storing user rooms', { error, socketId, roomIds });
  }
}

async function getUserRooms(socketId: string): Promise<string[]> {
  try {
    const roomsJson = await redisClient.hGet('socket:rooms', socketId);
    return roomsJson ? JSON.parse(roomsJson) : [];
  } catch (error) {
    redisLogger.error('Error getting user rooms', { error, socketId });
    return [];
  }
}

// Socket.IO 逻辑
io.on('connection', (socket) => {
  socketLogger.info('Socket connected', { socketId: socket.id });

  // 存储当前连接的分段上传会话，格式为：fileId -> { chunks: Buffer[], totalChunks, roomId, clientId }
  const imageUploadSessions: Record<string, { chunks: Buffer[]; totalChunks: number; roomId: string; clientId: string }> = {};

  // 客户端注册
  socket.on('register', async (clientId: string) => {
    const userId = clientId || uuidv4();
    await storeClientSession(socket.id, userId);
    socketLogger.info('Client registered', { socketId: socket.id, clientId: userId });
    
    socket.join(userId);
    const myRooms = await readRoomsByUser(userId);
    socket.emit('room_list', myRooms);
  });

  // 获取当前客户端创建的房间列表
  socket.on('get_rooms', async () => {
    const clientId = await getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to get rooms', { socketId: socket.id });
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    
    socketLogger.debug('Client requested room list', { socketId: socket.id, clientId });
    const myRooms = await readRoomsByUser(clientId);
    socket.emit('room_list', myRooms);
  });

  // 创建房间
  socket.on('create_room', async (roomData: { name: string; description?: string }, callback?: (roomId: string) => void) => {
    const clientId = await getClientId(socket.id);
    if (!clientId || !roomData?.name) {
      socketLogger.warn('Invalid room creation attempt', { 
        socketId: socket.id, 
        clientRegistered: !!clientId,
        roomDataValid: !!roomData?.name
      });
      socket.emit('error', { message: 'You are not registered or room name is required' });
      return;
    }
    
    // 使用nanoid生成房间ID并检查重复
    const roomId = await generateUniqueRoomId(redisClient);
    
    const room: Room = {
      id: roomId,
      name: roomData.name,
      description: roomData.description || "",
      createdAt: new Date().toISOString(),
      creatorId: clientId
    };
    
    socketLogger.info('Room creation requested', { 
      socketId: socket.id, 
      clientId, 
      roomId,
      roomName: roomData.name
    });
    
    const savedRoom = await saveRoom(room);
    if (savedRoom) {
      io.to(clientId).emit('new_room', savedRoom);
      socketLogger.info('Room created successfully', { roomId, clientId });
      if (callback) callback(room.id);
    }
  });

  // 加入房间
  socket.on('join_room', async (roomId: string) => {
    const userId = await getClientId(socket.id);
    if (!userId) {
      socketLogger.warn('Unregistered client tried to join room', { socketId: socket.id, roomId });
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    
    // 离开之前加入的所有房间
    const prevRooms = await getUserRooms(socket.id);
    for (const r of prevRooms) {
      // 通知房间其他成员该用户已离开
      const memberCount = await updateRoomMemberCount(r, userId, false);
      const leaveEvent: RoomMemberEvent = {
        roomId: r,
        user: { id: userId },
        count: memberCount,
        action: 'leave',
        timestamp: new Date().toISOString()
      };
      
      socketLogger.debug('User left previous room before joining new one', {
        socketId: socket.id,
        userId,
        roomId: r,
        memberCount
      });
      
      socket.to(r).emit('room_member_change', leaveEvent);
      socket.leave(r);
    }
    
    // 检查房间是否存在
    const room = await getRoomById(roomId);
    if (!room) {
      socketLogger.warn('Client tried to join non-existent room', { socketId: socket.id, userId, roomId });
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    socket.join(roomId);
    await storeUserRooms(socket.id, [roomId]);
    
    // 更新房间成员计数并通知所有房间成员
    const memberCount = await updateRoomMemberCount(roomId, userId, true);
    const joinEvent: RoomMemberEvent = {
      roomId,
      user: { id: userId },
      count: memberCount,
      action: 'join',
      timestamp: new Date().toISOString()
    };
    
    // 通知房间内所有成员（包括新加入者）
    io.to(roomId).emit('room_member_change', joinEvent);
    
    socketLogger.info('User joined room', { 
      socketId: socket.id, 
      userId, 
      roomId, 
      roomName: room.name,
      memberCount 
    });
    
    // 发送房间消息历史
    const roomMessages = await readMessagesByRoom(roomId);
    socket.emit('message_history', roomMessages);
    
    // 发送当前房间成员数
    socket.emit('room_member_count', { roomId, count: memberCount });
  });

  // 离开房间
  socket.on('leave_room', async (roomId: string) => {
    const userId = await getClientId(socket.id);
    if (!userId) return;
    
    socket.leave(roomId);
    
    // 更新房间成员计数并通知所有房间成员
    const memberCount = await updateRoomMemberCount(roomId, userId, false);
    const leaveEvent: RoomMemberEvent = {
      roomId,
      user: { id: userId },
      count: memberCount,
      action: 'leave',
      timestamp: new Date().toISOString()
    };
    
    // 通知房间内剩余成员
    io.to(roomId).emit('room_member_change', leaveEvent);
    
    socketLogger.info('User left room', { socketId: socket.id, userId, roomId, memberCount });
    
    // 更新用户房间列表
    const userRooms = await getUserRooms(socket.id);
    const updatedRooms = userRooms.filter(id => id !== roomId);
    await storeUserRooms(socket.id, updatedRooms);
  });

  // 获取指定房间的消息历史记录
  socket.on('get_room_messages', async (roomId: string) => {
    const userId = await getClientId(socket.id);
    socketLogger.debug('Client requested message history', { socketId: socket.id, userId, roomId });
    
    const roomMessages = await readMessagesByRoom(roomId);
    socket.emit('message_history', roomMessages);
  });

  // 发送新消息（文本或图片，若图片直接通过分段上传处理则不用走这里）
  socket.on('send_message', async (messageData: { 
    roomId: string; 
    content: string; 
    messageType?: 'text' | 'image';
    username?: string;
    avatar?: { 
      text: string;
      color: string;
    }
  }) => {
    const clientId = await getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to send message', { socketId: socket.id });
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    if (!messageData.roomId) {
      socketLogger.warn('Client tried to send message without room ID', { socketId: socket.id, clientId });
      socket.emit('error', { message: 'Room ID is required' });
      return;
    }
    
    const message: Message = {
      id: uuidv4(),
      clientId,
      content: messageData.content,
      roomId: messageData.roomId,
      timestamp: new Date().toISOString(),
      messageType: messageData.messageType || 'text',
      username: messageData.username,
      avatar: messageData.avatar
    };
    
    // 使用日志格式化处理器来安全地记录消息
    const loggableMessage = socketLogger.formatMessageForLog(message);
    socketLogger.info('Received WebSocket message', loggableMessage);
    
    await saveMessage(message);
    io.to(messageData.roomId).emit('new_message', message);
  });

  // ----------------- 新增：分段图片上传事件 -----------------

  // 客户端开始上传图片时发送，payload 包含 fileId、totalChunks、roomId
  socket.on('start_image_upload', async (payload: { fileId: string; totalChunks: number; roomId: string }) => {
    const clientId = await getClientId(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    imageUploadSessions[payload.fileId] = { chunks: [], totalChunks: payload.totalChunks, roomId: payload.roomId, clientId };
    socketLogger.info('Started image upload', { fileId: payload.fileId, totalChunks: payload.totalChunks, roomId: payload.roomId, clientId });
  });

  // 客户端上传单个图片分段，payload 包含 fileId、chunkIndex 和 base64 编码后的 chunkData
  socket.on('upload_image_chunk', (payload: { fileId: string; chunkIndex: number; chunkData: string }) => {
    if (!imageUploadSessions[payload.fileId]) {
      socket.emit('error', { message: 'No upload session for this fileId' });
      return;
    }
    // 将 base64 数据转换为 Buffer 并存储到对应分段位置
    const chunkBuffer = Buffer.from(payload.chunkData, 'base64');
    imageUploadSessions[payload.fileId].chunks[payload.chunkIndex] = chunkBuffer;
    socketLogger.debug('Received image chunk', { fileId: payload.fileId, chunkIndex: payload.chunkIndex });
  });

  // 客户端通知上传完成，服务器将所有分段合并并用 sharp 进行无损压缩转换
  socket.on('finish_image_upload', async (payload: { fileId: string }) => {
    const session = imageUploadSessions[payload.fileId];
    if (!session) {
      socket.emit('error', { message: 'No upload session for this fileId' });
      return;
    }
    // 检查是否已收到所有分段
    if (session.chunks.length !== session.totalChunks) {
      socket.emit('error', { message: 'Not all chunks received' });
      return;
    }
    // 合并所有分段
    const completeBuffer = Buffer.concat(session.chunks);
    try {
      // 用 sharp 进行无损 WebP 转换
      const webpBuffer = await sharp(completeBuffer)
        .webp({ lossless: true })
        .toBuffer();
      // 生成图片消息，将图片数据以 base64 格式存储在消息 content 中
      const message: Message = {
        id: uuidv4(),
        clientId: session.clientId,
        content: webpBuffer.toString('base64'),
        roomId: session.roomId,
        timestamp: new Date().toISOString(),
        messageType: 'image',
        mimeType: 'image/webp'
      };
      await saveMessage(message);
      io.to(session.roomId).emit('new_message', message);
      socketLogger.info('Completed image upload and processed message', { fileId: payload.fileId, roomId: session.roomId, clientId: session.clientId });
    } catch (err) {
      socketLogger.error('Error processing image upload', { fileId: payload.fileId, error: err });
      socket.emit('error', { message: 'Error processing image upload' });
    }
    // 清理上传会话
    delete imageUploadSessions[payload.fileId];
  });
  // ----------------- 结束分段上传事件 -----------------

  // 断开连接时清理数据
  socket.on('disconnect', async () => {
    const userId = await getClientId(socket.id);
    socketLogger.info('Socket disconnected', { socketId: socket.id, userId });
    
    // 处理用户离开所有加入的房间
    if (userId) {
      const rooms = await getUserRooms(socket.id);
      for (const roomId of rooms) {
        const memberCount = await updateRoomMemberCount(roomId, userId, false);
        const leaveEvent: RoomMemberEvent = {
          roomId,
          user: { id: userId },
          count: memberCount,
          action: 'leave',
          timestamp: new Date().toISOString()
        };
        socketLogger.debug('User left room due to disconnect', { socketId: socket.id, userId, roomId, memberCount });
        io.to(roomId).emit('room_member_change', leaveEvent);
      }
    }
    
    // 清理会话数据
    await removeClientSession(socket.id);
    await storeUserRooms(socket.id, []);
  });
  
  // -----------------------------------
  
  // 根据房间 ID 获取房间详细信息
  socket.on('get_room_by_id', async (roomId: string, callback: (room: Room | null) => void) => {
    const room = await getRoomById(roomId);
    const userId = await getClientId(socket.id);
    
    if (room) {
      socketLogger.debug('Room info requested', { socketId: socket.id, userId, roomId, roomName: room.name });
      callback(room);
    } else {
      socketLogger.warn('Room info requested for non-existent room', { socketId: socket.id, userId, roomId });
      callback(null);
    }
  });
});

// HTTP API 端点
app.get('/api/rooms/:roomId/messages', async (req: Request, res: Response) => {
  const { roomId } = req.params;
  if (!roomId) {
    routeLogger.warn('API request missing room ID', { endpoint: '/api/rooms/:roomId/messages', ip: req.ip });
    return res.status(400).json({ error: 'Room ID is required' });
  }
  
  routeLogger.info('API request for room messages', { endpoint: '/api/rooms/:roomId/messages', roomId, ip: req.ip });
  const filteredMessages = await readMessagesByRoom(roomId);
  return res.json(filteredMessages);
});

app.get('/api/clients/:clientId/rooms', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  if (!clientId) {
    routeLogger.warn('API request missing client ID', { endpoint: '/api/clients/:clientId/rooms', ip: req.ip });
    return res.status(400).json({ error: 'Client ID is required' });
  }
  
  routeLogger.info('API request for client rooms', { endpoint: '/api/clients/:clientId/rooms', clientId, ip: req.ip });
  const myRooms = await readRoomsByUser(clientId);
  res.json(myRooms);
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
  
  // 使用nanoid生成房间ID并检查重复
  const roomId = await generateUniqueRoomId(redisClient);
  
  const room: Room = {
    id: roomId,
    name: roomData.name,
    description: roomData.description || "",
    createdAt: new Date().toISOString(),
    creatorId: clientId
  };
  
  routeLogger.info('Room creation via API', { endpoint: 'POST /api/clients/:clientId/rooms', clientId, roomId, roomName: roomData.name, ip: req.ip });
  
  const savedRoom = await saveRoom(room);
  if (!savedRoom) {
    routeLogger.error('Failed to create room via API', { clientId, roomId, ip: req.ip });
    return res.status(500).json({ error: 'Failed to create room' });
  }
  
  io.to(clientId).emit('new_room', savedRoom);
  res.status(201).json(savedRoom);
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
    messageType: messageType || 'text'
  };
  
  const loggableMessage = routeLogger.formatMessageForLog(message);
  routeLogger.info('Received HTTP API message', { ...loggableMessage, ip: req.ip });
  
  await saveMessage(message);
  io.to(roomId).emit('new_message', message);
  res.status(201).json(message);
});

app.get('/api/clients/:clientId/rooms/:roomId', async (req: Request, res: Response) => {
  const { clientId, roomId } = req.params;
  
  if (!clientId) {
    routeLogger.warn('API request missing client ID', { endpoint: '/api/clients/:clientId/rooms/:roomId', roomId, ip: req.ip });
    return res.status(400).json({ error: 'Client ID is required' });
  }
  
  const room = await getRoomById(roomId);
  if (!room || room.creatorId !== clientId) {
    routeLogger.warn('Room not found or not owned by client', { endpoint: '/api/clients/:clientId/rooms/:roomId', clientId, roomId, found: !!room, authorized: room?.creatorId === clientId, ip: req.ip });
    return res.status(404).json({ error: 'Room not found' });
  }
  
  routeLogger.info('Room details requested via API', { endpoint: '/api/clients/:clientId/rooms/:roomId', clientId, roomId, roomName: room.name, ip: req.ip });
  res.json(room);
});

app.get('/api/status', async (req: Request, res: Response) => {
  try {
    const redisStatus = redisClient.isOpen ? 'connected' : 'disconnected';
    const roomCount = await redisClient.hLen('rooms');
    
    routeLogger.info('System status requested', { endpoint: '/api/status', ip: req.ip });
    
    res.json({
      status: 'online',
      redis: redisStatus,
      socketAdapterReady: io.of('/').adapter ? true : false,
      rooms: roomCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    routeLogger.error('Error getting system status', { error, ip: req.ip });
    res.status(500).json({ error: 'Error getting system status' });
  }
});

// Catch-all 路由，返回前端应用的入口 HTML 文件（支持前端路由）
app.get('*', (req: Request, res: Response) => {
  routeLogger.debug('Serving client application', { path: req.path, ip: req.ip });
  res.sendFile(path.join(__dirname, '../../client-heroui/dist', 'index.html'));
});

// 全局错误处理中间件
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  const errorLogger = new Logger('Error');
  errorLogger.error('Unhandled application error', { error: err.message, stack: err.stack, path: req.path, method: req.method, ip: req.ip });
  
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message
  });
});

// 记录未捕获的异常和拒绝的承诺
process.on('uncaughtException', (error) => {
  const errorLogger = new Logger('Process');
  errorLogger.error('Uncaught exception', { error: error.message, stack: error.stack });
  if (process.env.NODE_ENV === 'production') {
    // 根据需要处理，比如优雅退出
  }
});

process.on('unhandledRejection', (reason, promise) => {
  const errorLogger = new Logger('Process');
  errorLogger.error('Unhandled promise rejection', { 
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : 'No stack trace available'
  });
});

// ---------------------- 启动服务器 ----------------------
const PORT = process.env.PORT || 3012;
server.listen(PORT, () => {
  serverLogger.info(`Server started`, { port: PORT, env: process.env.NODE_ENV || 'development' });
});
