// 引入所需模块
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');  // 实现实时通信
const { v4: uuidv4 } = require('uuid');     // 用于生成唯一 ID
const cors = require('cors');               // 跨域支持
const path = require('path');               // 路径处理
const redis = require('redis');             // 使用 redis 作为存储
require('dotenv').config();

// 初始化 Express 应用
const app = express();
app.use(cors());
app.use(express.json());
// 提供前端构建后的静态文件服务
app.use(express.static(path.join(__dirname, '../client-heroui/dist')));

// 创建 HTTP 服务器
const server = http.createServer(app);

// 初始化 Socket.IO 服务器
const io = new Server(server, {
  cors: {
    origin: "*", // 允许所有来源
    methods: ['GET', 'POST']
  }
});

// ---------------------- 初始化 Redis 客户端 ----------------------

// 创建 Redis 客户端，默认连接到本地 Redis（localhost:6379）
const redisClient = redis.createClient();

redisClient.on('error', (err) => {
  console.error('Redis error:', err);
});

// 连接 Redis（注意：在 redis v4 中，connect() 返回 Promise）
redisClient.connect().then(() => {
  console.log('Connected to Redis');
}).catch(err => {
  console.error('Failed to connect to Redis:', err);
});

// ---------------------- Redis 数据存储操作 ----------------------

// 消息存储：将所有消息存储在 Redis 列表 "messages" 中，每条消息以 JSON 字符串存储
async function readMessages() {
  try {
    // 读取整个列表中的所有消息（下标 0 到 -1 表示所有元素）
    const messages = await redisClient.lRange("messages", 0, -1);
    return messages.map(msg => JSON.parse(msg));
  } catch (error) {
    console.error("Error reading messages from Redis:", error);
    return [];
  }
}

async function saveMessage(message) {
  try {
    // 将消息转换为 JSON 字符串，追加到 "messages" 列表尾部
    await redisClient.rPush("messages", JSON.stringify(message));
  } catch (error) {
    console.error("Error saving message to Redis:", error);
  }
}

// 房间存储：使用 Redis 哈希 "rooms"，字段为 room.id，值为 JSON 字符串
async function readRooms() {
  try {
    // hGetAll 返回一个对象，键为房间 ID，值为房间的 JSON 字符串
    const roomsObj = await redisClient.hGetAll("rooms");
    return Object.values(roomsObj).map(room => JSON.parse(room));
  } catch (error) {
    console.error("Error reading rooms from Redis:", error);
    return [];
  }
}

async function saveRoom(room) {
  try {
    // 将房间对象转换为 JSON 字符串存储到 "rooms" 哈希中，字段为 room.id
    await redisClient.hSet("rooms", room.id, JSON.stringify(room));
    return room;
  } catch (error) {
    console.error("Error saving room to Redis:", error);
    return null;
  }
}

// ---------------------- Socket.IO 逻辑 ----------------------

// 存储已连接客户端及其加入的房间
const connectedClients = new Map(); // 映射 socket.id -> clientId
const userRooms = new Map();        // 映射 socket.id -> [roomIds]

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  
  // 1. 客户端注册：客户端发送 'register' 事件（传入 clientId 或自动生成）
  socket.on('register', async (clientId) => {
    // 如果没有传入 clientId，则生成一个新的
    const userId = clientId || uuidv4();
    connectedClients.set(socket.id, userId);
    console.log(`Socket ${socket.id} registered, client ID: ${userId}`);
    // 将当前连接加入以 userId 命名的房间，实现广播到该用户所有连接
    socket.join(userId);
    
    // 注册后发送当前用户创建的房间
    const allRooms = await readRooms();
    const myRooms = allRooms.filter(room => room.creatorId === userId);
    socket.emit('room_list', myRooms);
  });

  // 2. 获取当前客户端创建的房间列表
  socket.on('get_rooms', async () => {
    const clientId = connectedClients.get(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    
    // 强制从Redis读取最新数据
    const allRooms = await readRooms();
    // 只返回由当前 clientId 创建的房间
    const myRooms = allRooms.filter(room => room.creatorId === clientId);
    socket.emit('room_list', myRooms);
  });

  // 3. 创建房间
  socket.on('create_room', async (roomData, callback) => {
    const clientId = connectedClients.get(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    
    // 构造房间对象
    const room = {
      id: uuidv4(),
      name: roomData.name,
      description: roomData.description || "",
      createdAt: new Date().toISOString(),
      creatorId: clientId
    };
    
    // 保存房间到 Redis
    const savedRoom = await saveRoom(room);
    // 向该用户所有连接广播新房间信息
    io.to(clientId).emit('new_room', savedRoom);
    // 如果提供回调，则返回房间 ID
    if (callback) callback(room.id);
  });

  // 4. 加入房间：客户端发送 'join_room' 事件，传入 roomId
  socket.on('join_room', async (roomId) => {
    const userId = connectedClients.get(socket.id);
    if (!userId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    
    // 离开之前加入的所有房间
    if (userRooms.has(socket.id)) {
      const prevRooms = userRooms.get(socket.id);
      for (const r of prevRooms) {
        socket.leave(r);
      }
    }
    
    // 让客户端加入新的房间
    socket.join(roomId);
    userRooms.set(socket.id, [roomId]);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
    
    // 读取该房间的消息历史记录并发送给客户端
    const messages = await readMessages();
    const roomMessages = messages.filter(msg => msg.roomId === roomId);
    socket.emit('message_history', roomMessages);
  });

  // 5. 离开房间
  socket.on('leave_room', (roomId) => {
    socket.leave(roomId);
    console.log(`Socket ${socket.id} left room ${roomId}`);
    if (userRooms.has(socket.id)) {
      const rooms = userRooms.get(socket.id).filter(id => id !== roomId);
      userRooms.set(socket.id, rooms);
    }
  });

  // 6. 获取指定房间的消息历史记录（WebSocket 方式）
  socket.on('get_room_messages', async (roomId) => {
    const messages = await readMessages();
    const roomMessages = messages.filter(msg => msg.roomId === roomId);
    socket.emit('message_history', roomMessages);
  });

  // 7. 发送新消息
  socket.on('send_message', async (messageData) => {
    const clientId = connectedClients.get(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    if (!messageData.roomId) {
      socket.emit('error', { message: 'Room ID is required' });
      return;
    }
    
    // 构造消息对象
    const message = {
      id: uuidv4(),
      clientId,
      content: messageData.content,
      roomId: messageData.roomId,
      timestamp: new Date().toISOString()
    };
    console.log(`Received WebSocket message: ${JSON.stringify(message)}`);
    
    // 保存消息到 Redis 列表
    await saveMessage(message);
    // 向该房间广播新消息
    io.to(messageData.roomId).emit('new_message', message);
  });

  // 8. 根据房间 ID 获取房间详细信息（供通过 URL 参数加入房间时调用）
  socket.on('get_room_by_id', async (roomId, callback) => {
    const allRooms = await readRooms();
    const room = allRooms.find(r => r.id === roomId);
    if (room) {
      console.log(`Socket ${socket.id} requested info for room: ${roomId}`);
      callback(room);
    } else {
      console.log(`Socket ${socket.id} requested info for non-existent room: ${roomId}`);
      callback(null);
    }
  });

  // 9. 断开连接时清理相关数据
  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
    connectedClients.delete(socket.id);
    userRooms.delete(socket.id);
  });
});

// ---------------------- HTTP API 端点 ----------------------

// 获取消息记录接口：要求传入 clientId，若传入 roomId，还需检查该房间是否属于当前 clientId
app.get('/api/messages', async (req, res) => {
  const { clientId, roomId } = req.query;
  if (!clientId) {
    return res.status(400).json({ error: 'Client ID is required' });
  }
  
  const messages = await readMessages();

  if (roomId) {
    // 检查该房间是否存在并且是否由当前 clientId 创建
    const rooms = await readRooms();
    const room = rooms.find(r => r.id === roomId);
    if (!room || room.creatorId !== clientId) {
      return res.status(403).json({ error: 'Access denied: Room does not belong to client' });
    }
    // 返回当前 client 在该房间中发送的消息
    const filteredMessages = messages.filter(
      msg => msg.roomId === roomId && msg.clientId === clientId
    );
    return res.json(filteredMessages);
  }
  
  // 未传入 roomId 时，返回当前 client 发送的所有消息
  const filteredMessages = messages.filter(msg => msg.clientId === clientId);
  return res.json(filteredMessages);
});

// 获取当前客户端创建的房间列表（必须传入 clientId）
app.get('/api/rooms', async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) {
    return res.status(400).json({ error: 'Client ID is required' });
  }
  
  const rooms = await readRooms();
  const myRooms = rooms.filter(room => room.creatorId === clientId);
  res.json(myRooms);
});

// 创建新房间接口
app.post('/api/rooms', async (req, res) => {
  const { name, description, clientId } = req.body;
  if (!name || !clientId) {
    return res.status(400).json({ error: 'Room name and client ID are required' });
  }
  
  const room = {
    id: uuidv4(),
    name,
    description: description || "",
    createdAt: new Date().toISOString(),
    creatorId: clientId
  };
  
  const savedRoom = await saveRoom(room);
  if (!savedRoom) {
    return res.status(500).json({ error: 'Failed to create room' });
  }
  
  // 只向当前用户的所有连接广播新房间信息
  io.to(clientId).emit('new_room', savedRoom);
  res.status(201).json(savedRoom);
});

// 通过 HTTP POST 发送新消息接口
app.post('/api/messages', async (req, res) => {
  const { clientId, content, roomId } = req.body;
  if (!clientId || !content || !roomId) {
    return res.status(400).json({ error: 'Client ID, room ID, and message content are required' });
  }
  
  const message = {
    id: uuidv4(),
    clientId,
    content,
    roomId,
    timestamp: new Date().toISOString()
  };
  
  console.log(`Received HTTP API message: ${JSON.stringify(message)}`);
  
  await saveMessage(message);
  io.to(roomId).emit('new_message', message);
  res.status(201).json(message);
});

// 通过房间 ID 获取房间详细信息接口（需传入 clientId，且只返回当前 client 创建的房间）
app.get('/api/rooms/:id', async (req, res) => {
  const roomId = req.params.id;
  const clientId = req.query.clientId;
  if (!clientId) {
    return res.status(400).json({ error: 'Client ID is required' });
  }
  
  const rooms = await readRooms();
  const room = rooms.find(r => r.id === roomId && r.creatorId === clientId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json(room);
});

// Catch-all 路由：返回前端应用的入口 HTML 文件（支持前端路由）
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client-heroui/dist', 'index.html'));
});

// 启动服务器，监听指定端口（默认为 3012）
const PORT = process.env.PORT || 3012;
server.listen(PORT, () => {
  console.log(`Server running on port: ${PORT}`);
});
