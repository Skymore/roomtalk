import express, { Request, Response } from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import path from 'path';
import {createClient, RedisClientType } from 'redis';
import dotenv from 'dotenv';
import { customAlphabet } from 'nanoid';

dotenv.config();

// 创建nanoid生成器 - 使用字母和数字，生成10位ID
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
    console.log(`Room ID collision detected, retrying (${attempts}/${maxAttempts})...`);
  }
  
  // 如果多次尝试后仍有冲突，生成更长的ID
  console.log("Multiple collisions detected, using longer ID");
  return nanoid(12); // 使用12位ID降低碰撞概率
}

// ---------------------- 类型定义 ----------------------
interface Message {
  id: string;
  clientId: string;
  content: string;
  roomId: string;
  timestamp: string;
  messageType: 'text' | 'image'; // 新增消息类型字段，区分文本和图片
  username?: string; // 添加用户名字段
  avatar?: {
    text: string;
    color: string;
  }; // 添加头像信息
}

interface Room {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  creatorId: string;
}

// 用户信息类型
interface UserInfo {
  id: string;
  // 可以在此添加更多用户信息字段，如用户名、头像等
}

// 房间成员变动事件类型
interface RoomMemberEvent {
  roomId: string;
  user: UserInfo;
  count: number; // 房间内当前成员数量
  action: 'join' | 'leave'; // 加入或离开
  timestamp: string;
}

// ---------------------- 初始化 Express 应用 ----------------------
const app = express();
app.use(cors());
app.use(express.json());
// 提供前端构建后的静态文件服务
app.use(express.static(path.join(__dirname, '../../client-heroui/dist')));

// ---------------------- 创建 HTTP 服务器 ----------------------
const server = http.createServer(app);

// ---------------------- 初始化 Socket.IO 服务器 ----------------------
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ---------------------- 初始化 Redis 客户端 ----------------------
const redisClient: RedisClientType = createClient();

redisClient.on('error', (err) => {
  console.error('Redis error:', err);
});

redisClient.connect().then(() => {
  console.log('Connected to Redis');
}).catch(err => {
  console.error('Failed to connect to Redis:', err);
});

// ---------------------- Redis 数据存储操作 ----------------------

// 按房间分离消息存储：键名格式为 room:{roomId}:messages
async function saveMessage(message: Message): Promise<void> {
  try {
    await redisClient.rPush(`room:${message.roomId}:messages`, JSON.stringify(message));
  } catch (error) {
    console.error("Error saving message to Redis:", error);
  }
}

// 读取指定房间的消息列表
async function readMessagesByRoom(roomId: string): Promise<Message[]> {
  try {
    const messages = await redisClient.lRange(`room:${roomId}:messages`, 0, -1);
    return messages.map((msg) => JSON.parse(msg));
  } catch (error) {
    console.error("Error reading messages from Redis:", error);
    return [];
  }
}

// 房间存储：使用 Redis 哈希存储房间详情，并建立用户房间索引
async function saveRoom(room: Room): Promise<Room | null> {
  try {
    await redisClient.hSet("rooms", room.id, JSON.stringify(room));
    await redisClient.sAdd(`user:${room.creatorId}:rooms`, room.id);
    return room;
  } catch (error) {
    console.error("Error saving room to Redis:", error);
    return null;
  }
}

// 根据用户 ID 读取该用户创建的所有房间
async function readRoomsByUser(clientId: string): Promise<Room[]> {
  try {
    const roomIds = await redisClient.sMembers(`user:${clientId}:rooms`);
    const rooms = await Promise.all(
      roomIds.map(id => redisClient.hGet("rooms", id))
    );
    // room 可能为 null，因此使用非空断言（根据业务保证数据正确性）
    return rooms.map(room => JSON.parse(room!));
  } catch (error) {
    console.error("Error reading rooms for user from Redis:", error);
    return [];
  }
}

// 根据房间 ID 获取房间详情
async function getRoomById(roomId: string): Promise<Room | null> {
  try {
    const roomStr = await redisClient.hGet("rooms", roomId);
    return roomStr ? JSON.parse(roomStr) : null;
  } catch (error) {
    console.error("Error reading room by id from Redis:", error);
    return null;
  }
}

// 处理日志输出时的消息格式化
function formatMessageForLog(message: Message): any {
  // 创建消息对象的副本，避免修改原始数据
  const logMessage = { ...message };
  
  // 如果是图片消息，截断内容
  if (logMessage.messageType === 'image' && logMessage.content) {
    // 只保留前30个字符，后面用...代替
    const contentStart = logMessage.content.substring(0, 30);
    logMessage.content = `${contentStart}... [BASE64_IMAGE_DATA_TRUNCATED]`;
  }
  
  return logMessage;
}

// ---------------------- 初始化变量 ----------------------
const connectedClients = new Map<string, string>(); // 映射 socket.id -> clientId
const userRooms = new Map<string, string[]>();      // 映射 socket.id -> [roomId]
const roomMembers = new Map<string, Set<string>>();  // 映射 roomId -> Set<clientId>

// 更新并获取房间成员数
function updateRoomMemberCount(roomId: string, clientId: string, isJoining: boolean): number {
  if (!roomMembers.has(roomId)) {
    roomMembers.set(roomId, new Set());
  }
  
  const members = roomMembers.get(roomId)!;
  
  if (isJoining) {
    members.add(clientId);
  } else if (members.has(clientId)) {
    members.delete(clientId);
  }
  
  return members.size;
}

// 获取指定房间的成员计数
function getRoomMemberCount(roomId: string): number {
  return roomMembers.has(roomId) ? roomMembers.get(roomId)!.size : 0;
}

// ---------------------- Socket.IO 逻辑 ----------------------
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // 客户端注册：传入 clientId 或自动生成
  socket.on('register', async (clientId: string) => {
    const userId = clientId || uuidv4();
    connectedClients.set(socket.id, userId);
    console.log(`Socket ${socket.id} registered, client ID: ${userId}`);
    // 将当前连接加入以 userId 命名的房间，实现向该用户所有连接广播消息
    socket.join(userId);
    const myRooms = await readRoomsByUser(userId);
    socket.emit('room_list', myRooms);
  });

  // 获取当前客户端创建的房间列表
  socket.on('get_rooms', async () => {
    const clientId = connectedClients.get(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    const myRooms = await readRoomsByUser(clientId);
    socket.emit('room_list', myRooms);
  });

  // 创建房间
  socket.on('create_room', async (roomData: { name: string; description?: string }, callback?: (roomId: string) => void) => {
    const clientId = connectedClients.get(socket.id);
    if (!clientId || !roomData?.name) {
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
    const savedRoom = await saveRoom(room);
    if (savedRoom) {
      io.to(clientId).emit('new_room', savedRoom);
      if (callback) callback(room.id);
    }
  });

  // 加入房间
  socket.on('join_room', async (roomId: string) => {
    const userId = connectedClients.get(socket.id);
    if (!userId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    
    // 离开之前加入的所有房间
    if (userRooms.has(socket.id)) {
      const prevRooms = userRooms.get(socket.id)!;
      for (const r of prevRooms) {
        // 通知房间其他成员该用户已离开
        const memberCount = updateRoomMemberCount(r, userId, false);
        const leaveEvent: RoomMemberEvent = {
          roomId: r,
          user: { id: userId },
          count: memberCount,
          action: 'leave',
          timestamp: new Date().toISOString()
        };
        socket.to(r).emit('room_member_change', leaveEvent);
        socket.leave(r);
      }
    }
    
    // 检查房间是否存在
    const room = await getRoomById(roomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    socket.join(roomId);
    userRooms.set(socket.id, [roomId]);
    
    // 更新房间成员计数并通知所有房间成员
    const memberCount = updateRoomMemberCount(roomId, userId, true);
    const joinEvent: RoomMemberEvent = {
      roomId,
      user: { id: userId },
      count: memberCount,
      action: 'join',
      timestamp: new Date().toISOString()
    };
    
    // 通知房间内所有成员（包括新加入者）
    io.to(roomId).emit('room_member_change', joinEvent);
    
    console.log(`Socket ${socket.id} joined room ${roomId}. Current member count: ${memberCount}`);
    
    // 发送房间消息历史
    const roomMessages = await readMessagesByRoom(roomId);
    socket.emit('message_history', roomMessages);
    
    // 发送当前房间成员数
    socket.emit('room_member_count', { roomId, count: memberCount });
  });

  // 离开房间
  socket.on('leave_room', (roomId: string) => {
    const userId = connectedClients.get(socket.id);
    if (!userId) return;
    
    socket.leave(roomId);
    
    // 更新房间成员计数并通知所有房间成员
    const memberCount = updateRoomMemberCount(roomId, userId, false);
    const leaveEvent: RoomMemberEvent = {
      roomId,
      user: { id: userId },
      count: memberCount,
      action: 'leave',
      timestamp: new Date().toISOString()
    };
    
    // 通知房间内剩余成员
    io.to(roomId).emit('room_member_change', leaveEvent);
    
    console.log(`Socket ${socket.id} left room ${roomId}. Current member count: ${memberCount}`);
    
    if (userRooms.has(socket.id)) {
      const rooms = userRooms.get(socket.id)!.filter(id => id !== roomId);
      userRooms.set(socket.id, rooms);
    }
  });

  // 获取指定房间的消息历史记录
  socket.on('get_room_messages', async (roomId: string) => {
    const roomMessages = await readMessagesByRoom(roomId);
    socket.emit('message_history', roomMessages);
  });

  // 发送新消息
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
    const clientId = connectedClients.get(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    if (!messageData.roomId) {
      socket.emit('error', { message: 'Room ID is required' });
      return;
    }
    const message: Message = {
      id: uuidv4(),
      clientId,
      content: messageData.content,
      roomId: messageData.roomId,
      timestamp: new Date().toISOString(),
      messageType: messageData.messageType || 'text', // 默认为文本消息
      username: messageData.username, // 添加用户名字段
      avatar: messageData.avatar // 添加头像信息
    };
    console.log(`Received WebSocket message: ${JSON.stringify(formatMessageForLog(message))}`);
    await saveMessage(message);
    io.to(messageData.roomId).emit('new_message', message);
  });

  // 根据房间 ID 获取房间详细信息（通过 Socket 回调返回）
  socket.on('get_room_by_id', async (roomId: string, callback: (room: Room | null) => void) => {
    const room = await getRoomById(roomId);
    if (room) {
      console.log(`Socket ${socket.id} requested info for room: ${roomId}, room: ${JSON.stringify(room, null, 2)}`);
      callback(room);
    } else {
      console.log(`Socket ${socket.id} requested info for non-existent room: ${roomId}`);
      callback(null);
    }
  });

  // 断开连接时清理数据
  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
    const userId = connectedClients.get(socket.id);
    
    // 处理用户离开所有加入的房间
    if (userId && userRooms.has(socket.id)) {
      const rooms = userRooms.get(socket.id)!;
      for (const roomId of rooms) {
        // 更新房间成员计数并通知所有房间成员
        const memberCount = updateRoomMemberCount(roomId, userId, false);
        const leaveEvent: RoomMemberEvent = {
          roomId,
          user: { id: userId },
          count: memberCount,
          action: 'leave',
          timestamp: new Date().toISOString()
        };
        
        // 通知房间内剩余成员
        io.to(roomId).emit('room_member_change', leaveEvent);
      }
    }
    
    connectedClients.delete(socket.id);
    userRooms.delete(socket.id);
  });
});

// ---------------------- HTTP API 端点 ----------------------

// 1. 获取指定房间的消息记录
app.get('/api/rooms/:roomId/messages', async (req: Request, res: Response) => {
  const { roomId } = req.params;
  if (!roomId) {
    return res.status(400).json({ error: 'Room ID is required' });
  }
  const filteredMessages = await readMessagesByRoom(roomId);
  return res.json(filteredMessages);
});

// 2. 获取指定客户端创建的房间列表
app.get('/api/clients/:clientId/rooms', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  if (!clientId) {
    return res.status(400).json({ error: 'Client ID is required' });
  }
  const myRooms = await readRoomsByUser(clientId);
  res.json(myRooms);
});

// 3. 创建新房间（通过 HTTP API）
app.post('/api/clients/:clientId/rooms', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  if (!clientId) {
    return res.status(400).json({ error: 'Client ID is required' });
  }
  
  const roomData = req.body;
  if (!roomData?.name || !clientId) {
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
  const savedRoom = await saveRoom(room);
  if (!savedRoom) {
    return res.status(500).json({ error: 'Failed to create room' });
  }
  io.to(clientId).emit('new_room', savedRoom);
  res.status(201).json(savedRoom);
});

// 4. 发送新消息到指定房间（房间 ID 从 URL 中获取）
app.post('/api/rooms/:roomId/messages', async (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { clientId, content, messageType } = req.body;
  if (!clientId || !content || !roomId) {
    return res.status(400).json({ error: 'Client ID, room ID, and message content are required' });
  }
  const message: Message = {
    id: uuidv4(),
    clientId,
    content,
    roomId,
    timestamp: new Date().toISOString(),
    messageType: messageType || 'text' // 默认为文本消息
  };
  console.log(`Received HTTP API message: ${JSON.stringify(formatMessageForLog(message))}`);
  await saveMessage(message);
  io.to(roomId).emit('new_message', message);
  res.status(201).json(message);
});

// 5. 获取指定房间详细信息（验证房间归属关系：客户端 ID 和房间 ID 均通过 URL 传递）
app.get('/api/clients/:clientId/rooms/:roomId', async (req: Request, res: Response) => {
  const { clientId, roomId } = req.params;
  if (!clientId) {
    return res.status(400).json({ error: 'Client ID is required' });
  }
  const room = await getRoomById(roomId);
  if (!room || room.creatorId !== clientId) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json(room);
});

// 6. Catch-all 路由：返回前端应用的入口 HTML 文件（支持前端路由）
app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../../client-heroui/dist', 'index.html'));
});

// ---------------------- 启动服务器 ----------------------
const PORT = process.env.PORT || 3012;
server.listen(PORT, () => {
  console.log(`Server running on port: ${PORT}`);
});
