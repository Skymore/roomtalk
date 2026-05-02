// 导入日志类
import { Logger, httpLogger, defaultLogger } from './logger';

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import path from 'path';
import { createClient, RedisClientType } from 'redis';
import dotenv from 'dotenv';
import { customAlphabet } from 'nanoid';
import sharp from 'sharp'; // 新增：用于无损压缩图片
import OpenAI from 'openai'; // 添加 OpenAI SDK

dotenv.config();

// 创建各模块的日志记录器
const serverLogger = new Logger('Server');
const redisLogger = new Logger('Redis');
const socketLogger = new Logger('SocketIO');
const routeLogger = new Logger('Routes');
const openaiLogger = new Logger('OpenAI');

// nanoid生成器保持不变
const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 10);

// OpenAI SDK also supports OpenAI-compatible endpoints; OpenRouter is the primary provider.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '', // 从环境变量获取 API 密钥
});

const openrouterHeaders: Record<string, string> = {
  'X-Title': process.env.OPENROUTER_APP_NAME || 'RoomTalk',
};

const openrouterReferer = process.env.OPENROUTER_HTTP_REFERER || process.env.CLIENT_URL;
if (openrouterReferer) {
  openrouterHeaders['HTTP-Referer'] = openrouterReferer;
}

const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || 'missing-openrouter-api-key',
  baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  defaultHeaders: openrouterHeaders,
});

// 设置默认的 AI 助手系统消息
const DEFAULT_SYSTEM_MESSAGE = 'You are a helpful, creative, friendly assistant. Respond concisely and clearly.';

type AIModelProvider = 'openai' | 'openrouter';

interface AIModelPricing {
  currency: 'USD';
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}

interface AIModelOption {
  id: string;
  apiModel: string;
  provider: AIModelProvider;
  label: string;
  description: string;
  pricing?: AIModelPricing;
  isDefault?: boolean;
}

interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  source: 'reported' | 'estimated';
}

interface AICost {
  currency: 'USD';
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  estimated: boolean;
}

interface RoomAICostTotal {
  roomId: string;
  currency: 'USD';
  totalUsd: number;
}

const DEFAULT_AI_MODEL_ID = process.env.AI_MODEL || process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5';
const CONFIGURED_AI_MODEL_OPTIONS =
  process.env.AI_MODEL_OPTIONS ||
  process.env.OPENROUTER_MODEL_OPTIONS ||
  process.env.OPENAI_MODEL_OPTIONS;

const REQUESTED_AI_MODEL_CATALOG: AIModelOption[] = [
  {
    id: 'gpt-5.5',
    apiModel: 'openai/gpt-5.5',
    provider: 'openrouter',
    label: 'GPT-5.5',
    description: 'OpenAI GPT-5.5 routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
  },
  {
    id: 'claude-sonnet-4.6',
    apiModel: 'anthropic/claude-sonnet-4.6',
    provider: 'openrouter',
    label: 'Claude Sonnet 4.6',
    description: 'Anthropic Sonnet model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 3, outputPerMillion: 15 },
  },
  {
    id: 'deepseek-v4-pro',
    apiModel: 'deepseek/deepseek-v4-pro',
    provider: 'openrouter',
    label: 'DeepSeek V4 Pro',
    description: 'DeepSeek long-context reasoning model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.74, outputPerMillion: 3.48 },
  },
  {
    id: 'kimi-k2.6',
    apiModel: 'moonshotai/kimi-k2.6',
    provider: 'openrouter',
    label: 'Kimi K2.6',
    description: 'Moonshot Kimi model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.74, outputPerMillion: 3.49 },
  },
  {
    id: 'glm-5.1',
    apiModel: 'z-ai/glm-5.1',
    provider: 'openrouter',
    label: 'GLM 5.1',
    description: 'Latest GLM model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.05, outputPerMillion: 3.5 },
  },
  {
    id: 'minimax-m2.7',
    apiModel: 'minimax/minimax-m2.7',
    provider: 'openrouter',
    label: 'MiniMax M2.7',
    description: 'Latest MiniMax model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.3, outputPerMillion: 1.2 },
  },
];

const LEGACY_AI_MODEL_CATALOG: AIModelOption[] = [
  {
    id: 'gpt-5',
    apiModel: 'openai/gpt-5',
    provider: 'openrouter',
    label: 'GPT-5',
    description: 'OpenAI GPT-5 routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  },
  {
    id: 'gpt-5-mini',
    apiModel: 'openai/gpt-5-mini',
    provider: 'openrouter',
    label: 'GPT-5 mini',
    description: 'OpenAI GPT-5 mini routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
  },
  {
    id: 'gpt-5-nano',
    apiModel: 'openai/gpt-5-nano',
    provider: 'openrouter',
    label: 'GPT-5 nano',
    description: 'OpenAI GPT-5 nano routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 },
  },
];

const AI_MODEL_CATALOG = [...REQUESTED_AI_MODEL_CATALOG, ...LEGACY_AI_MODEL_CATALOG];

const normalizeModelLookupKey = (value: string) => value.trim().toLowerCase();

const createConfiguredOpenRouterModel = (model: string): AIModelOption => ({
  id: model,
  apiModel: model,
  provider: 'openrouter',
  label: model,
  description: 'Configured OpenRouter model',
});

const resolveCatalogModel = (model: string): AIModelOption | undefined => {
  const key = normalizeModelLookupKey(model);
  return AI_MODEL_CATALOG.find(option =>
    normalizeModelLookupKey(option.id) === key ||
    normalizeModelLookupKey(option.apiModel) === key
  );
};

const resolveAIModelOption = (model: string): AIModelOption => {
  return resolveCatalogModel(model) || createConfiguredOpenRouterModel(model);
};

const addUniqueModel = (models: AIModelOption[], model: AIModelOption) => {
  if (!models.some(existing => existing.id === model.id)) {
    models.push({ ...model });
  }
};

const parseAIModelOptions = (value?: string): AIModelOption[] => {
  const configuredModels = value
    ?.split(',')
    .map(model => model.trim())
    .filter(Boolean) ?? [];

  const models: AIModelOption[] = [];
  const defaultModel = resolveAIModelOption(DEFAULT_AI_MODEL_ID);

  addUniqueModel(models, defaultModel);
  configuredModels.forEach(model => addUniqueModel(models, resolveAIModelOption(model)));
  REQUESTED_AI_MODEL_CATALOG.forEach(model => addUniqueModel(models, model));

  return models.map(model => ({
    ...model,
    isDefault: model.id === defaultModel.id,
  }));
};

const AI_MODEL_OPTIONS = parseAIModelOptions(CONFIGURED_AI_MODEL_OPTIONS);
const DEFAULT_AI_MODEL = AI_MODEL_OPTIONS.find(model => model.isDefault) || AI_MODEL_OPTIONS[0];

const normalizeAIModel = (requestedModel?: string): AIModelOption => {
  if (requestedModel) {
    const requested = normalizeModelLookupKey(requestedModel);
    const selectedModel = AI_MODEL_OPTIONS.find(model =>
      normalizeModelLookupKey(model.id) === requested ||
      normalizeModelLookupKey(model.apiModel) === requested
    );

    if (selectedModel) {
      return selectedModel;
    }

    openaiLogger.warn('Requested AI model is not allowed, using default model', {
      requestedModel,
      defaultModel: DEFAULT_AI_MODEL.id,
    });
  }

  return DEFAULT_AI_MODEL;
};

const getAIModelResponse = () => ({
  defaultModel: DEFAULT_AI_MODEL.id,
  models: AI_MODEL_OPTIONS.map(model => ({
    id: model.id,
    apiModel: model.apiModel,
    provider: model.provider,
    label: model.label,
    description: model.description,
    pricing: model.pricing,
    isDefault: model.isDefault,
  })),
});

// 最大上下文消息数量，避免超出 token 限制
const MAX_CONTEXT_MESSAGES = 40;

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
  messageType: 'text' | 'image' | 'ai';
  username?: string;
  avatar?: {
    text: string;
    color: string;
  };
  mimeType?: string;
  status?: 'streaming' | 'complete' | 'error';
  aiModel?: {
    id: string;
    apiModel: string;
    provider: AIModelProvider;
    label: string;
  };
  usage?: AIUsage;
  cost?: AICost;
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

redisClient.on('error', (err: Error) => {
  redisLogger.error('Redis connection error', { error: err.message, stack: err.stack });
});

// 创建 Redis 适配器所需的客户端
const pubClient = createClient({ url: REDIS_URL });
const subClient = pubClient.duplicate();

// 监听 Redis 客户端错误
pubClient.on('error', (err: Error) => {
  redisLogger.error('Redis Pub Client Error:', { error: err.message, stack: err.stack });
});

subClient.on('error', (err: Error) => {
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
async function appendMessage(message: Message): Promise<void> {
  try {
    await redisClient.rPush(`room:${message.roomId}:messages`, JSON.stringify(message));
    redisLogger.debug('Message appended to Redis list', { messageId: message.id, roomId: message.roomId });
  } catch (error) {
    redisLogger.error('Error appending message to Redis', { error, messageId: message.id, roomId: message.roomId });
    // Consider throwing the error or handling it based on requirements
  }
}

async function saveMessageHistory(roomId: string, messages: Message[]): Promise<void> {
  try {
    const messageKey = `room:${roomId}:messages`;
    await redisClient.del(messageKey);
    if (messages.length > 0) {
      const messageStrings = messages.map(msg => JSON.stringify(msg));
      await redisClient.rPush(messageKey, messageStrings);
    }
    redisLogger.debug('Message history saved/overwritten to Redis', { roomId, count: messages.length });
  } catch (error) {
    redisLogger.error('Error saving message history to Redis', { error, roomId });
  }
}

async function readMessagesByRoom(roomId: string): Promise<Message[]> {
  try {
    const messages = await redisClient.lRange(`room:${roomId}:messages`, 0, -1);
    redisLogger.debug('Messages read from Redis', { roomId, count: messages.length });
    return messages.map((msg: string) => JSON.parse(msg));
  } catch (error) {
    redisLogger.error('Error reading messages from Redis', { error, roomId });
    return [];
  }
}

function getRoomAICostKey(roomId: string): string {
  return `room:${roomId}:ai_cost_total_usd`;
}

async function readRoomAICost(roomId: string): Promise<RoomAICostTotal> {
  try {
    const total = await redisClient.get(getRoomAICostKey(roomId));
    const totalUsd = Number.parseFloat(total || '0');

    return {
      roomId,
      currency: 'USD',
      totalUsd: Number.isFinite(totalUsd) ? totalUsd : 0,
    };
  } catch (error) {
    redisLogger.error('Error reading room AI cost total', { error, roomId });
    return { roomId, currency: 'USD', totalUsd: 0 };
  }
}

async function incrementRoomAICost(roomId: string, cost: AICost | null): Promise<RoomAICostTotal> {
  if (!cost || !Number.isFinite(cost.totalUsd) || cost.totalUsd <= 0) {
    return readRoomAICost(roomId);
  }

  try {
    const total = await redisClient.incrByFloat(getRoomAICostKey(roomId), cost.totalUsd);
    const totalUsd = typeof total === 'number' ? total : Number.parseFloat(String(total));
    return {
      roomId,
      currency: 'USD',
      totalUsd: Number.isFinite(totalUsd) ? totalUsd : cost.totalUsd,
    };
  } catch (error) {
    redisLogger.error('Error incrementing room AI cost total', { error, roomId, cost });
    return readRoomAICost(roomId);
  }
}

function getAIClientForModel(model: AIModelOption): OpenAI {
  if (model.provider === 'openrouter') {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is required for OpenRouter models');
    }

    return openrouter;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for OpenAI models');
  }

  return openai;
}

function estimateTokenCount(text: string): number {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimatePromptTokens(messages: Array<{ content: any }>): number {
  return messages.reduce((total, message) => {
    if (typeof message.content === 'string') {
      return total + estimateTokenCount(message.content);
    }

    if (Array.isArray(message.content)) {
      return total + message.content.reduce((itemTotal: number, item: any) => {
        if (item.type === 'text' && typeof item.text === 'string') {
          return itemTotal + estimateTokenCount(item.text);
        }

        if (item.type === 'image_url') {
          return itemTotal + 1000;
        }

        return itemTotal;
      }, 0);
    }

    return total;
  }, 0);
}

function normalizeUsage(apiUsage: any, messages: Array<{ content: any }>, outputContent: string): AIUsage {
  if (apiUsage && typeof apiUsage.prompt_tokens === 'number' && typeof apiUsage.completion_tokens === 'number') {
    const cachedPromptTokens = apiUsage.prompt_tokens_details?.cached_tokens;
    return {
      promptTokens: apiUsage.prompt_tokens,
      completionTokens: apiUsage.completion_tokens,
      totalTokens: typeof apiUsage.total_tokens === 'number'
        ? apiUsage.total_tokens
        : apiUsage.prompt_tokens + apiUsage.completion_tokens,
      cachedPromptTokens: typeof cachedPromptTokens === 'number' ? cachedPromptTokens : undefined,
      source: 'reported',
    };
  }

  const promptTokens = estimatePromptTokens(messages);
  const completionTokens = estimateTokenCount(outputContent);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    source: 'estimated',
  };
}

function calculateAICost(model: AIModelOption, usage: AIUsage): AICost | undefined {
  if (!model.pricing) {
    return undefined;
  }

  const cachedPromptTokens = Math.min(usage.cachedPromptTokens || 0, usage.promptTokens);
  const uncachedPromptTokens = Math.max(usage.promptTokens - cachedPromptTokens, 0);
  const cachedInputPerMillion = model.pricing.cachedInputPerMillion;
  const inputUsd =
    (uncachedPromptTokens / 1_000_000) * model.pricing.inputPerMillion +
    (cachedPromptTokens / 1_000_000) * (cachedInputPerMillion ?? model.pricing.inputPerMillion);
  const outputUsd = (usage.completionTokens / 1_000_000) * model.pricing.outputPerMillion;

  return {
    currency: model.pricing.currency,
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    inputPerMillion: model.pricing.inputPerMillion,
    outputPerMillion: model.pricing.outputPerMillion,
    cachedInputPerMillion,
    estimated: usage.source === 'estimated',
  };
}

function getMessageAIModel(model: AIModelOption): Message['aiModel'] {
  return {
    id: model.id,
    apiModel: model.apiModel,
    provider: model.provider,
    label: model.label,
  };
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
      roomIds.map((id: string) => redisClient.hGet("rooms", id))
    );
    redisLogger.debug('Rooms read by user from Redis', { clientId, count: roomIds.length });
    // Filter out null rooms in case of deletion race conditions
    return rooms.filter(room => room).map((room: string | undefined) => JSON.parse(room!)); 
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
io.on('connection', (socket: Socket) => {
  socketLogger.info('Socket connected', { socketId: socket.id });

  // 存储当前连接的分段上传会话，格式为：fileId -> { chunks: Buffer[], totalChunks, roomId, clientId }
  const imageUploadSessions: Record<string, { chunks: Buffer[]; totalChunks: number; roomId: string; clientId: string }> = {};

  // ----------------- 新增：AI 助手相关 -----------------
  const aiAvatar = { text: 'AI', color: 'secondary' }; // AI 头像信息
  const aiUsername = 'AI Assistant'; // AI 用户名
  // ----------------- 结束：AI 助手相关 -----------------

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
    socket.emit('ai_cost_total', await readRoomAICost(roomId));
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
    socket.emit('ai_cost_total', await readRoomAICost(roomId));
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
    
    // === 使用 appendMessage 保存新消息 ===
    await appendMessage(message); // Use appendMessage here
    
    io.to(messageData.roomId).emit('new_message', message);
  });

  // ----------------- 新增：分段图片上传事件 -----------------

  // 客户端开始上传图片时发送，payload 包含 fileId、totalChunks、roomId
  socket.on('start_image_upload', async (payload: { fileId: string; totalChunks: number; roomId: string; username?: string; avatar?: { text: string; color: string } }) => {
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
  socket.on('finish_image_upload', async (payload: { fileId: string, username?: string, avatar?: { text: string; color: string } }) => {
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
        mimeType: 'image/webp',
        username: payload.username,
        avatar: payload.avatar
      };
      await appendMessage(message);
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

  // --- Modified: Handle AI request using history context --- 
  socket.on('ask_ai', async (data: {
    roomId: string;
    systemPrompt?: string;
    roleName?: string;
    model?: string;
    editedMessageId?: string; // ID of the message that was just edited
    retryForMessageId?: string; // ID of the AI message to retry generating
  }) => {
    const clientId = await getClientId(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    if (!data.roomId) {
      socket.emit('error', { message: 'Room ID is required for AI request' });
      return;
    }

    const { roomId, systemPrompt = DEFAULT_SYSTEM_MESSAGE, roleName = 'AI Assistant', editedMessageId, retryForMessageId } = data;
    const selectedModel = normalizeAIModel(data.model);

    socketLogger.info(`Received AI request (history-based)${editedMessageId ? ' after edit ' + editedMessageId : ''}${retryForMessageId ? ' as retry for ' + retryForMessageId : ''}`, {
      socketId: socket.id,
      clientId,
      roomId,
      roleName,
      model: selectedModel.id,
      apiModel: selectedModel.apiModel,
      provider: selectedModel.provider,
    });

    // 创建头像和用户名
    const aiAvatar = { text: 'AI', color: 'secondary' };
    const aiUsername = roleName || 'AI Assistant';

    // 1. 创建初始 AI 消息结构 (给客户端占位)
    const aiMessageId = uuidv4();
    const initialAiMessage: Message = {
      id: aiMessageId,
      clientId: 'ai_assistant',
      content: '',
      roomId,
      timestamp: new Date().toISOString(),
      messageType: 'ai',
      username: aiUsername,
      avatar: aiAvatar,
      status: 'streaming',
      aiModel: getMessageAIModel(selectedModel),
    };
    io.to(roomId).emit('new_message', initialAiMessage); // 发送占位消息

    // 2. 获取并处理上下文消息
    let contextMessages: Message[] = [];
    let historyUsedForContext: Message[] = [];

    try {
      const fullHistory = await readMessagesByRoom(roomId);
      historyUsedForContext = fullHistory; // 默认使用完整历史

      // 处理重试：截断到重试消息之前
      if (retryForMessageId) {
        const retryIndex = historyUsedForContext.findIndex(msg => msg.id === retryForMessageId);
        if (retryIndex !== -1) {
          openaiLogger.info('Truncating message history for retry', { roomId, retryForMessageId, originalCount: historyUsedForContext.length, newCount: retryIndex });
          historyUsedForContext = historyUsedForContext.slice(0, retryIndex);
        } else {
          openaiLogger.warn('Retry message ID not found in history, using full history', { roomId, retryForMessageId });
        }
      }
      // 处理编辑：截断到编辑消息（包含）
      else if (editedMessageId) {
        const editIndex = historyUsedForContext.findIndex(msg => msg.id === editedMessageId);
        if (editIndex !== -1) {
          openaiLogger.info('Truncating message history after edit', { roomId, editedMessageId, originalCount: historyUsedForContext.length, newCount: editIndex + 1 });
          historyUsedForContext = historyUsedForContext.slice(0, editIndex + 1);
        } else {
          openaiLogger.warn('Edited message ID not found in history, using full history', { roomId, editedMessageId });
        }
      }
      // 普通请求：historyUsedForContext 保持为 fullHistory

      // 检查处理后的历史记录是否为空（比如重试第一条消息）
      if (historyUsedForContext.length === 0) {
           // 对于普通请求，客户端应该已经发送了第一条消息，所以这里通常只会在重试空历史时发生
           openaiLogger.warn('History for context is empty after processing.', { roomId, editedMessageId, retryForMessageId });
           // 即使历史为空，我们仍然可以尝试调用 OpenAI，仅使用系统提示
           // 如果 OpenAI 需要至少一条 user/assistant 消息，它会报错，错误处理逻辑会捕获
      }

      // 处理提示和控制消息，并从上下文中移除
      const processedMessages: Message[] = [];
      for (const msg of historyUsedForContext) {
        // 普通消息
        processedMessages.push(msg);
      }

      // 应用 MAX_CONTEXT_MESSAGES 限制
      if (processedMessages.length > MAX_CONTEXT_MESSAGES) {
        contextMessages = processedMessages.slice(-MAX_CONTEXT_MESSAGES);
        openaiLogger.debug('Applying MAX_CONTEXT limit to determined history', {
          roomId,
          originalCount: processedMessages.length,
          limitedCount: contextMessages.length
        });
      } else {
        contextMessages = processedMessages;
      }

    } catch (error) {
      openaiLogger.error('Error loading/processing context messages', { error, roomId });
      contextMessages = []; // 出错时继续，但没有上下文
      // 即使加载历史出错，我们仍然可以尝试仅用系统提示调用 OpenAI
    }

    openaiLogger.debug("contextMessages", contextMessages);

    // 3. 调用 OpenAI API
    try {
      // 准备消息格式 - 不再需要 finalPrompt
      const messagesForAPI = [
        { role: 'system', content: systemPrompt },
        // 直接映射处理后的上下文历史
        ...contextMessages.map(msg => {
            if (msg.messageType === 'image') {
              const formatedImageUrl = msg.content.startsWith('data:')
                            ? msg.content
                            : `data:${msg.mimeType || 'image/png'};base64,${msg.content}`;
              return {
                role: msg.clientId === 'ai_assistant' ? 'assistant' : 'user', // Corrected based on previous fix
                content: [
                  {
                    type: "image_url",
                    image_url: {
                      url: formatedImageUrl,
                      detail: "auto"
                    }
                  }
                ]
              };
            } else {
              // 文本或AI消息
              return {
                role: msg.clientId === 'ai_assistant' ? 'assistant' : 'user', // Corrected based on previous fix
                content: msg.content
              };
            }
        })
      ];

      // 过滤掉空的 content 消息
      const validMessagesForAPI = messagesForAPI.filter(msg => {
          if (Array.isArray(msg.content)) {
             return msg.content.length > 0 && msg.content.every(item => item.type === 'image_url' && item.image_url?.url);
          }
          return typeof msg.content === 'string' && msg.content.trim() !== '';
      });

      // 确保至少有一条 user 或 assistant 消息（如果 context 为空，这里会阻止调用）
      const hasUserOrAssistantMessage = validMessagesForAPI.some(msg => msg.role === 'user' || msg.role === 'assistant');
      if (!hasUserOrAssistantMessage && validMessagesForAPI.length <= 1) {
        openaiLogger.error('Cannot call OpenAI API without user or assistant messages in context.', { roomId });
        io.to(roomId).emit('ai_stream_error', {
          messageId: aiMessageId,
          error: 'Sorry, cannot generate a response without any context or question.',
          roomId
        });
        // 清理掉已发送的占位消息 (可选，或者让它显示错误)
         saveMessageHistory(roomId, historyUsedForContext).catch(err => openaiLogger.error('Failed to save history after empty context error', { error: err }));
        return; 
      }

      openaiLogger.debug('Sending messages to AI provider (history-based)', {
        messages: validMessagesForAPI,
        contextLengthUsed: contextMessages.length,
        model: selectedModel.id,
        apiModel: selectedModel.apiModel,
        provider: selectedModel.provider,
      });

      // 创建流式请求
      const aiClient = getAIClientForModel(selectedModel);
      const stream = await aiClient.chat.completions.create({
        model: selectedModel.apiModel,
        messages: validMessagesForAPI as any,
        stream: true,
        temperature: 1,
        stream_options: { include_usage: true },
      } as any);

      let fullContent = '';
      let reportedUsage: any = null;
      for await (const chunk of stream as any) {
           if (chunk.usage) {
              reportedUsage = chunk.usage;
            }
           if (chunk.choices[0]?.delta?.content) {
              const contentChunk = chunk.choices[0].delta.content;
              fullContent += contentChunk;
              io.to(roomId).emit('ai_chunk', { messageId: aiMessageId, chunk: contentChunk, roomId });
              if (fullContent.length % 100 === 0) {
                openaiLogger.debug('Streaming AI chunk', { messageId: aiMessageId, contentLength: fullContent.length });
              }
            }
        }

      const usage = normalizeUsage(reportedUsage, validMessagesForAPI, fullContent);
      const cost = calculateAICost(selectedModel, usage);
      const roomCostTotal = await incrementRoomAICost(roomId, cost || null);

      io.to(roomId).emit('ai_stream_end', {
        messageId: aiMessageId,
        roomId,
        aiModel: getMessageAIModel(selectedModel),
        usage,
        cost,
        sessionCost: roomCostTotal,
      });
      io.to(roomId).emit('ai_cost_total', roomCostTotal);
      openaiLogger.info('AI stream ended', {
        messageId: aiMessageId,
        contentLength: fullContent.length,
        model: selectedModel.id,
        usage,
        cost,
        roomCostTotal,
      });

      // --- 保存最终的 AI 消息和它所基于的上下文 --- 
      const finalAiMessage: Message = {
        ...initialAiMessage,
        content: fullContent,
        status: 'complete',
        timestamp: new Date().toISOString(),
        aiModel: getMessageAIModel(selectedModel),
        usage,
        cost,
      };
      // 将新 AI 消息附加到 *用于生成它* 的上下文历史后面
      const finalHistoryToSave = [...contextMessages, finalAiMessage];

      // 保存这个新的历史状态回 Redis
      saveMessageHistory(roomId, finalHistoryToSave).then(() => {
        openaiLogger.info('Saved final AI message and its context history to Redis', {
          messageId: aiMessageId,
          historyLength: finalHistoryToSave.length,
          contextLengthUsed: contextMessages.length
        });
      }).catch(err => {
        openaiLogger.error('Failed to save final AI history to Redis', { error: err, messageId: aiMessageId });
      });
      // --- End Save Logic --- 

    } catch (error) {
        socketLogger.error('Error processing AI stream request', {
          error: error instanceof Error ? error.message : error,
          socketId: socket.id,
          clientId,
          roomId
        });
        io.to(roomId).emit('ai_stream_error', {
          messageId: aiMessageId,
          error: 'Sorry, an error occurred while generating the AI response.',
          roomId
        });
       // 可以在这里更新 Redis 中占位消息的状态为 error (可选)
       const errorAiMessage: Message = { ...initialAiMessage, status: 'error', content: 'Error generating response.' };
       saveMessageHistory(roomId, [...contextMessages, errorAiMessage]).catch(err => openaiLogger.error('Failed to save error AI history', { error: err }));
    }
  });
  // --- End Modified ask_ai ---

  // --- New: Handle Edit Message --- 
  socket.on('edit_message', async (data: { roomId: string; messageId: string; newContent: string }, callback?: (response: { success: boolean; updatedMessage?: Message; error?: string }) => void) => {
    const clientId = await getClientId(socket.id); // Still get clientId for logging/context
    if (!clientId) {
      return callback?.({ success: false, error: 'Not registered' });
    }
    if (!data.roomId || !data.messageId || typeof data.newContent !== 'string') {
      return callback?.({ success: false, error: 'Missing required fields' });
    }

    socketLogger.info('Received edit message request', { ...data, editorClientId: clientId }); // Log who initiated the edit

    try {
      const messages = await readMessagesByRoom(data.roomId);
      const messageIndex = messages.findIndex(m => m.id === data.messageId);

      if (messageIndex === -1) {
        return callback?.({ success: false, error: 'Message not found' });
      }

      const messageToEdit = messages[messageIndex];
      
      // 移除限制，允许编辑所有类型的消息（包括AI消息）
      // 原来有文本类型检查: if (messageToEdit.messageType !== 'text') { ... }

      // Update message content and timestamp
      const updatedMessage: Message = {
        ...messageToEdit,
        content: data.newContent,
        timestamp: new Date().toISOString(), // Update timestamp on edit
      };
      messages[messageIndex] = updatedMessage;

      // Save the entire updated history back to Redis
      await saveMessageHistory(data.roomId, messages);

      // Broadcast the update to the room
      io.to(data.roomId).emit('message_edited', updatedMessage);
      socketLogger.info('Message edited successfully', { messageId: data.messageId, roomId: data.roomId, editorClientId: clientId });

      // Send success back to the sender (including the updated message)
      callback?.({ success: true, updatedMessage });

    } catch (error) {
      socketLogger.error('Error editing message', { error, ...data, editorClientId: clientId });
      callback?.({ success: false, error: 'Server error while editing message' });
    }
  });
  // --- End Edit Message --- 

  // --- New: Handle Delete Message --- 
  socket.on('delete_message', async (data: { roomId: string; messageId: string }, callback?: (response: { success: boolean; error?: string }) => void) => {
    const clientId = await getClientId(socket.id); // Still get clientId for logging/context
    if (!clientId) {
      return callback?.({ success: false, error: 'Not registered' });
    }
    if (!data.roomId || !data.messageId) {
      return callback?.({ success: false, error: 'Missing required fields' });
    }

    socketLogger.info('Received delete message request', { ...data, deleterClientId: clientId }); // Log who initiated delete

    try {
      const messages = await readMessagesByRoom(data.roomId);
      const messageIndex = messages.findIndex(m => m.id === data.messageId);

      if (messageIndex === -1) {
        socketLogger.warn('Attempted to delete message not found', { ...data, deleterClientId: clientId });
        return callback?.({ success: true }); 
      }

      // Filter out the message
      const updatedMessages = messages.filter(m => m.id !== data.messageId);

      // Save the updated history back to Redis
      await saveMessageHistory(data.roomId, updatedMessages);

      // Broadcast the deletion to the room
      io.to(data.roomId).emit('message_deleted', data.messageId, data.roomId);
      socketLogger.info('Message deleted successfully', { messageId: data.messageId, roomId: data.roomId, deleterClientId: clientId });

      // Send success back to the sender
      callback?.({ success: true });

    } catch (error) {
      socketLogger.error('Error deleting message', { error, ...data, deleterClientId: clientId });
      callback?.({ success: false, error: 'Server error while deleting message' });
    }
  });
  // --- End Delete Message --- 

  // --- 新增：处理清空房间消息事件 ---
  socket.on('clear_room_messages', async (roomId: string) => {
    const clientId = await getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to clear messages', { socketId: socket.id, roomId });
      socket.emit('error', { message: 'You are not registered' });
      return;
    }
    if (!roomId) {
      socketLogger.warn('Client tried to clear messages without room ID', { socketId: socket.id, clientId });
      socket.emit('error', { message: 'Room ID is required' });
      return;
    }

    // TODO: Add permission check here if needed (e.g., only creator can clear)

    try {
      const messageKey = `room:${roomId}:messages`;
      const result = await redisClient.del(messageKey);
      if (result > 0) {
        socketLogger.info('Cleared room messages from Redis', { socketId: socket.id, clientId, roomId });
        // 向房间内所有客户端广播消息已清空事件
        io.to(roomId).emit('messages_cleared', roomId);
        io.to(roomId).emit('ai_cost_total', await readRoomAICost(roomId));
      } else {
        socketLogger.debug('No messages to clear or key did not exist', { socketId: socket.id, clientId, roomId });
        // 即使没有消息删除，也通知客户端刷新状态，确保UI一致
        io.to(roomId).emit('messages_cleared', roomId);
        io.to(roomId).emit('ai_cost_total', await readRoomAICost(roomId));
      }
    } catch (error) {
      socketLogger.error('Error clearing room messages from Redis', { error, socketId: socket.id, clientId, roomId });
      socket.emit('error', { message: 'Failed to clear room messages' });
    }
  });
  // --- 结束：处理清空房间消息事件 ---

  // --- 新增：处理删除房间事件 ---
  socket.on('delete_room', async (roomId: string, callback?: (result: { success: boolean; message?: string }) => void) => {
    const clientId = await getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to delete room', { socketId: socket.id, roomId });
      if (callback) callback({ success: false, message: 'You are not registered' });
      return;
    }
    if (!roomId) {
      socketLogger.warn('Client tried to delete room without room ID', { socketId: socket.id, clientId });
      if (callback) callback({ success: false, message: 'Room ID is required' });
      return;
    }

    try {
      const room = await getRoomById(roomId);
      if (!room) {
        socketLogger.warn('Attempted to delete non-existent room', { socketId: socket.id, clientId, roomId });
        if (callback) callback({ success: false, message: 'Room not found' });
        return;
      }

      // 权限检查：只有创建者可以删除
      if (room.creatorId !== clientId) {
        socketLogger.warn('Unauthorized attempt to delete room', { socketId: socket.id, clientId, roomId, creatorId: room.creatorId });
        if (callback) callback({ success: false, message: 'You are not authorized to delete this room' });
        return;
      }

      socketLogger.info('Attempting to delete room', { socketId: socket.id, clientId, roomId, roomName: room.name });

      // 执行删除操作
      const deletePromises = [
        redisClient.hDel("rooms", roomId),               // 删除房间详情
        redisClient.del(`room:${roomId}:messages`),      // 删除房间消息
        redisClient.del(getRoomAICostKey(roomId)),        // 删除房间 AI 费用累计
        redisClient.del(`room:${roomId}:members`),       // 删除房间成员列表
        redisClient.sRem(`user:${clientId}:rooms`, roomId) // 从创建者列表中移除
      ];

      await Promise.all(deletePromises);

      socketLogger.info('Room deleted successfully', { socketId: socket.id, clientId, roomId });

      // 向创建者发送更新后的房间列表 (重要：要发送给 clientId 对应的所有 socket 连接)
      const userSockets = await io.in(clientId).allSockets(); 
      const updatedRooms = await readRoomsByUser(clientId);
      userSockets.forEach(sid => {
        io.to(sid).emit('room_list', updatedRooms);
      });
      
      if (callback) callback({ success: true });

    } catch (error) {
      socketLogger.error('Error deleting room', { 
         error: error instanceof Error ? error.message : String(error), 
         stack: error instanceof Error ? error.stack : undefined,
         socketId: socket.id, 
         clientId, 
         roomId 
      });
      if (callback) callback({ success: false, message: 'Failed to delete room due to server error' });
    }
  });
  // --- 结束：处理删除房间事件 ---

  // 断开连接时清理数据
  socket.on('disconnect', async (reason: string) => {
    const userId = await getClientId(socket.id);
    if (userId) {
      socketLogger.info('Client disconnected', { socketId: socket.id, userId, reason });
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
        io.to(roomId).emit('room_member_change', leaveEvent);
        socketLogger.debug('Client left room due to disconnect', { socketId: socket.id, userId, roomId, memberCount });
      }
      await removeClientSession(socket.id);
      await storeUserRooms(socket.id, []);
    } else {
      socketLogger.info(`Unidentified socket disconnected: ${socket.id}`, { reason });
    }
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
  
  await appendMessage(message);
  io.to(roomId).emit('new_message', message);
  res.status(201).json(message);
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

  res.json(await readRoomAICost(roomId));
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
const PORT: number = parseInt(process.env.PORT || '3012', 10);
const HOST: string = '0.0.0.0';

server.listen(PORT, HOST, () => { 
  serverLogger.info(`Server started`, { port: PORT, host: HOST, env: process.env.NODE_ENV || 'development' });
});
