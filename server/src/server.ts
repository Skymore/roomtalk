// 导入日志类
import { Logger, httpLogger } from './logger';

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { createClient, RedisClientType } from 'redis';
import dotenv from 'dotenv';
import { RedisStore } from './repositories/redisStore';
import { createPostgresPool } from './repositories/postgresPool';
import { PostgresStore } from './repositories/postgresStore';
import { CompositeRoomStore, RoomStore } from './repositories/store';
import { createAIModelRegistry, DEFAULT_AI_MODEL_ID } from './services/aiModels';
import { registerApiRoutes } from './routes/apiRoutes';
import { registerSocketHandlers } from './socket/registerSocketHandlers';
import { createAIClients } from './services/aiClients';
import { createCocoAccessControl } from './services/cocoAccessControl';
import { createCodeAgentRunner } from './services/codeAgentRunner';
import { CocoSandboxLifecycleService } from './services/cocoSandboxLifecycle';
import { CocoSessionService } from './services/cocoSessionService';
import { E2BCocoSandboxService, E2BSandboxDriver } from './services/e2bCocoSandboxService';
import { createE2BSdkDriver } from './services/e2bSdkDriver';
import { COCO_RUNNER_SCHEMA_VERSION } from './services/cocoRunnerProtocol';
import { resolveCocoRuntimeConfig } from './services/cocoRuntimeConfig';
import { FakeCocoRunnerClient } from './services/fakeCocoRunner';
import { FakeCocoSandboxService } from './services/fakeCocoSandboxService';
import { JsonlCocoRunnerClient } from './services/jsonlCocoRunner';

dotenv.config();

// 创建各模块的日志记录器
const serverLogger = new Logger('Server');
const redisLogger = new Logger('Redis');
const postgresLogger = new Logger('PostgreSQL');
const socketLogger = new Logger('SocketIO');
const routeLogger = new Logger('Routes');
const openaiLogger = new Logger('OpenAI');
const cocoLogger = new Logger('Coco');

const aiModelRegistry = createAIModelRegistry({
  defaultModelId: process.env.AI_MODEL || process.env.OPENROUTER_MODEL || DEFAULT_AI_MODEL_ID,
  configuredModelOptions: process.env.AI_MODEL_OPTIONS || process.env.OPENROUTER_MODEL_OPTIONS,
  logger: openaiLogger,
});
const { normalizeAIModel, getAIModelResponse } = aiModelRegistry;
const { getAIClientForModel } = createAIClients(process.env);

const resolveClientDistPath = () => {
  const candidates = [
    path.join(__dirname, '../../../client-heroui/dist'),
    path.join(__dirname, '../../client-heroui/dist'),
  ];

  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
};
const clientDistPath = resolveClientDistPath();

// 初始化 Express 应用
const app = express();
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  methods: ['GET', 'POST'],
  credentials: true,
}));
console.log(`process.env.CLIENT_URL: ${process.env.CLIENT_URL}`);
app.use(express.json());

// 添加HTTP请求日志中间件
app.use(httpLogger);

// 提供前端构建后的静态文件服务
app.use(express.static(clientDistPath));

// 创建 HTTP 服务器
const server = http.createServer(app);

// 从环境变量获取 Redis URL
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// 初始化 Redis 客户端
const redisClient: RedisClientType = createClient({
  url: REDIS_URL
});
const redisStore = new RedisStore(redisClient, redisLogger);

const PERSISTENCE_STORE = (process.env.PERSISTENCE_STORE || 'redis').toLowerCase();
let activePersistenceStore = 'redis';
let store: RoomStore = redisStore;
let postgresStore: PostgresStore | null = null;

if (PERSISTENCE_STORE === 'postgres') {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('PERSISTENCE_STORE=postgres requires DATABASE_URL');
  }

  postgresStore = new PostgresStore(createPostgresPool(databaseUrl, postgresLogger), postgresLogger);
  store = new CompositeRoomStore(postgresStore, redisStore, redisStore);
  activePersistenceStore = 'postgres';
} else if (PERSISTENCE_STORE !== 'redis') {
  serverLogger.warn('Unknown PERSISTENCE_STORE value, falling back to Redis', { persistenceStore: PERSISTENCE_STORE });
}

const parsePositiveIntegerEnv = (name: string, fallback: number) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const cocoRuntimeConfig = resolveCocoRuntimeConfig(process.env);
const cocoAccess = createCocoAccessControl({
  enabled: cocoRuntimeConfig.enabled,
  allowedClientIds: cocoRuntimeConfig.allowedClientIds,
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

const createE2BDriver = (): E2BSandboxDriver => createE2BSdkDriver({
  apiKey: process.env.E2B_API_KEY,
  accessToken: process.env.E2B_ACCESS_TOKEN,
  domain: process.env.E2B_DOMAIN,
  apiUrl: process.env.E2B_API_URL,
  sandboxUrl: process.env.E2B_SANDBOX_URL,
  requestTimeoutMs: parsePositiveIntegerEnv('E2B_REQUEST_TIMEOUT_MS', 60_000),
});

if (cocoRuntimeConfig.enabled && cocoRuntimeConfig.sandboxProvider === 'e2b') {
  cocoLogger.info('E2B sandbox provider selected', { artifactMode: cocoRuntimeConfig.artifactMode });
}

const cocoSandboxService = cocoRuntimeConfig.enabled && cocoRuntimeConfig.sandboxProvider === 'e2b'
  ? new E2BCocoSandboxService(createE2BDriver(), {
    templateId: cocoRuntimeConfig.e2bTemplateId || '',
    workspace: cocoRuntimeConfig.e2bWorkspace,
    artifactVersion: cocoRuntimeConfig.artifactVersion,
    cocoSourceRef: cocoRuntimeConfig.cocoSourceRef,
    logger: cocoLogger,
  })
  : new FakeCocoSandboxService();
const cocoTurnTimeoutMs = parsePositiveIntegerEnv('COCO_TURN_TIMEOUT_MS', 5 * 60 * 1000);
const cocoSandboxLifecycle = new CocoSandboxLifecycleService(store, cocoSandboxService, cocoLogger, {
  sandboxTtlMs: parsePositiveIntegerEnv('COCO_SANDBOX_TTL_MS', 60 * 60 * 1000),
  turnTimeoutMs: cocoTurnTimeoutMs,
  creatingStaleMs: parsePositiveIntegerEnv('COCO_CREATING_STALE_MS', 2 * 60 * 1000),
  maxActiveSandboxes: parsePositiveIntegerEnv('COCO_MAX_ACTIVE_SANDBOXES', Number.POSITIVE_INFINITY),
  maxActiveSandboxesPerUser: parsePositiveIntegerEnv('COCO_MAX_ACTIVE_SANDBOXES_PER_USER', Number.POSITIVE_INFINITY),
});
const fakeCocoToolOutput = [
  'stdout: hello from Coco fake runner',
  'stderr: simulated warning for UI coverage',
  'line '.repeat(260).trim(),
].join('\n');
const cocoRunnerClient = cocoRuntimeConfig.runnerClient === 'jsonl' ? new JsonlCocoRunnerClient() : new FakeCocoRunnerClient([
  { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'status', turnId: 'fake', status: 'starting', message: 'Coco fake runner starting' },
  { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'fake-ai', delta: 'Coco fake runner received the task.' },
  { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'fake-tool-1', name: 'Shell', args: { command: 'printf "hello from Coco fake runner\\n"' } },
  { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'fake-tool-1', name: 'Shell', success: false, output: fakeCocoToolOutput, exitCode: 2, truncated: true },
  { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'fake-ai', answer: 'Coco fake runner received the task.', sessionId: 'fake-coco-session' },
], { eventDelayMs: parsePositiveIntegerEnv('COCO_FAKE_RUNNER_EVENT_DELAY_MS', 0) });
const codeAgentRunner = createCodeAgentRunner(cocoRuntimeConfig.backend, cocoRunnerClient);
const cocoSessionService = new CocoSessionService(
  store,
  io,
  cocoSandboxLifecycle,
  cocoSandboxService,
  codeAgentRunner,
  cocoLogger,
  {
    enabled: cocoRuntimeConfig.enabled,
    allowedClientIds: cocoRuntimeConfig.allowedClientIds,
    mode: cocoRuntimeConfig.mode,
    runnerCommand: cocoRuntimeConfig.runnerCommand,
    turnTimeoutMs: cocoTurnTimeoutMs,
    allowedPaths: cocoRuntimeConfig.allowedPaths,
    runnerEnv: cocoRuntimeConfig.runnerEnv,
    runnerProviderEnvByProvider: cocoRuntimeConfig.runnerProviderEnvByProvider,
  }
);

// 初始化 Redis、PostgreSQL schema 和 Socket.IO 适配器
const infrastructureReady = (async () => {
  try {
    // 连接所有 Redis 客户端
    await Promise.all([
      redisClient.connect(),
      pubClient.connect(),
      subClient.connect()
    ]);
    
    // 设置 Socket.IO Redis 适配器
    io.adapter(createAdapter(pubClient, subClient));

    if (postgresStore) {
      await postgresStore.initializeSchema();
    }
    if (process.env.E2E_TEST_MODE === 'true' && process.env.E2E_RESET_ON_START === 'true') {
      await store.resetAllDataForTests?.();
      serverLogger.warn('E2E data reset on startup', { persistenceStore: activePersistenceStore });
    }
    await store.failInterruptedStreamingMessages?.('Response interrupted.');
    await cocoSandboxLifecycle.recoverInterruptedSandboxes();
    
    redisLogger.info('Connected to Redis and Socket.IO adapter initialized', { persistenceStore: activePersistenceStore });
  } catch (err) {
    redisLogger.error('Failed to connect to Redis, PostgreSQL, or initialize adapter', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    throw err;
  }
})();

registerSocketHandlers({
  io,
  store,
  socketLogger,
  openaiLogger,
  normalizeAIModel,
  getAIClientForModel,
  cocoSessionService,
  cocoAccess,
});

registerApiRoutes(app, {
  store,
  io,
  redisClient,
  routeLogger,
  getAIModelResponse,
  persistenceStore: activePersistenceStore,
  cocoAccess,
  cocoMode: cocoRuntimeConfig.mode,
});

// Catch-all 路由，返回前端应用的入口 HTML 文件（支持前端路由）
app.get('*', (req: Request, res: Response) => {
  routeLogger.debug('Serving client application', { path: req.path, ip: req.ip });
  res.sendFile(path.join(clientDistPath, 'index.html'));
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

infrastructureReady
  .then(() => {
    server.listen(PORT, HOST, () => {
      serverLogger.info(`Server started`, { port: PORT, host: HOST, env: process.env.NODE_ENV || 'development', persistenceStore: activePersistenceStore });
    });
  })
  .catch((error) => {
    serverLogger.error('Server startup aborted', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      persistenceStore: activePersistenceStore,
    });
    process.exit(1);
  });
