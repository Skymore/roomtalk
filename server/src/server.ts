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
import { PostgresPool, PostgresStore } from './repositories/postgresStore';
import { CompositeRoomStore, RoomStore } from './repositories/store';
import { AI_ROLE_GENERATOR_MODEL_ID, createAIModelRegistry, DEFAULT_AI_MODEL_ID } from './services/aiModels';
import { registerApiRoutes } from './routes/apiRoutes';
import { registerCodeWorkspaceAssetRoutes } from './routes/codeWorkspaceAssetRoutes';
import { registerPublishedStaticSiteRoutes } from './routes/publishedStaticSiteRoutes';
import { registerCodeAgentRoomContextRoutes } from './routes/codeAgentRoomContextRoutes';
import { loadStickerCatalog } from './stickers/catalog';
import { registerSocketHandlers } from './socket/registerSocketHandlers';
import { executeQueuedAssistantRun } from './socket/aiHandlers';
import { createAIClients } from './services/aiClients';
import { createAIRoleDraftGenerator } from './services/aiRoleGenerator';
import { resolveAIStreamOwnerId } from './services/aiStreamRecovery';
import { createMediaObjectStorageFromEnv } from './services/mediaObjectStorage';
import { createAssemblyAIAudioTranscriptionRunner } from './services/audioTranscription';
import { resolveCorsOrigin } from './services/corsConfig';
import { createOutboxWorkerFromEnv, OutboxWorker } from './services/outboxWorker';
import { createCodeAgentAccessControl } from './services/codeAgentAccessControl';
import { createCodeAgentRunner } from './services/codeAgentRunner';
import {
  CodeAgentSandboxLifecycleService,
  DEFAULT_ARTIFACT_MIGRATION_MAX_ARCHIVE_BYTES,
  DEFAULT_ARTIFACT_MIGRATION_TIMEOUT_MS,
} from './services/codeAgentSandboxLifecycle';
import { CodeAgentSessionService } from './services/codeAgentSessionService';
import { E2BCodeAgentSandboxService, E2BSandboxDriver } from './services/e2bCodeAgentSandboxService';
import { createE2BSdkDriver } from './services/e2bSdkDriver';
import { CODE_AGENT_RUNNER_SCHEMA_VERSION } from './services/codeAgentRunnerProtocol';
import { createCodeWorkspaceAssetAccessFromEnv } from './services/codeWorkspaceAssetAccess';
import {
  DEFAULT_CODE_AGENT_E2B_KILL_TIMEOUT_MS,
  DEFAULT_CODE_AGENT_RUNNER_PYTHONPATH,
  DEFAULT_CODE_AGENT_WORKSPACE_ROOT,
  resolveCodeAgentRuntimeConfig,
} from './services/codeAgentRuntimeConfig';
import {
  CodeAgentModelGateway,
  DEFAULT_CODE_AGENT_MODEL_GATEWAY_BASE_PATH,
  DEFAULT_CODE_AGENT_MODEL_GATEWAY_BODY_LIMIT,
  RedisCodeAgentModelGatewayTokenStateStore,
  registerCodeAgentModelGatewayRoutes,
} from './services/codeAgentModelGateway';
import { FakeCodeAgentRunnerClient } from './services/fakeCodeAgentRunner';
import { FakeCodeAgentSandboxService } from './services/fakeCodeAgentSandboxService';
import { CodeAgentDaemonProcessRegistry } from './services/codeAgentDaemonRegistry';
import { JsonlCodeAgentDaemonRunnerClient } from './services/jsonlCodeAgentDaemonRunner';
import { JsonlCodeAgentRunnerClient } from './services/jsonlCodeAgentRunner';
import {
  CODE_AGENT_STATIC_PUBLISH_API_PATH,
  createPublishedStaticSiteServiceFromEnv,
} from './services/publishedStaticSite';
import { NoopObservabilityEventRecorder, PostgresObservabilityEventRecorder } from './services/observabilityEvents';
import { createCodeAgentRoomContextServiceFromEnv } from './services/codeAgentRoomContext';
import { CodexAuthCipher, CodexConnectionService } from './services/codexConnection';
import { resolveCodexConnectionConfig } from './services/codexConnectionConfig';
import { CodexCliDeviceAuthDriver } from './services/codexCliDeviceAuthDriver';
import { assertCodexBackendStartupGate, resolveCodexCliRunnerConfig } from './services/codexCliRunnerConfig';
import { CodexDeviceAuthSessionManager } from './services/codexDeviceAuthSession';
import { PostgresCodexConnectionStore, RedisCodexConnectionStore } from './services/codexConnectionStore';

dotenv.config();

// 创建各模块的日志记录器
const serverLogger = new Logger('Server');
const redisLogger = new Logger('Redis');
const postgresLogger = new Logger('PostgreSQL');
const socketLogger = new Logger('SocketIO');
const routeLogger = new Logger('Routes');
const openaiLogger = new Logger('OpenAI');
const outboxLogger = new Logger('OutboxWorker');
const codeAgentLogger = new Logger('CodeAgent');
const codexLogger = new Logger('Codex');
const mediaStorageLogger = new Logger('MediaStorage');
const staticPublishLogger = new Logger('StaticPublish');
const mediaObjectStorage = createMediaObjectStorageFromEnv(mediaStorageLogger);
const publishedStaticSiteService = createPublishedStaticSiteServiceFromEnv({
  mediaObjectStorage,
  logger: staticPublishLogger,
});
const codeWorkspaceAssetAccess = createCodeWorkspaceAssetAccessFromEnv();
const aiStreamOwnerId = resolveAIStreamOwnerId();

const aiModelRegistry = createAIModelRegistry({
  defaultModelId: process.env.AI_MODEL || process.env.OPENROUTER_MODEL || DEFAULT_AI_MODEL_ID,
  logger: openaiLogger,
});
const { normalizeAIModel, getAIModelResponse } = aiModelRegistry;
const { getAIClientForModel } = createAIClients(process.env);
const generateAIRoleDraft = createAIRoleDraftGenerator({
  model: normalizeAIModel(AI_ROLE_GENERATOR_MODEL_ID),
  getAIClientForModel,
});

const resolveClientDistPath = () => {
  const candidates = [
    path.join(__dirname, '../../../client-heroui/dist'),
    path.join(__dirname, '../../client-heroui/dist'),
  ];

  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
};
const clientDistPath = resolveClientDistPath();
const corsOrigin = resolveCorsOrigin();

// 初始化 Express 应用
const app = express();
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
}));
console.log(`process.env.CLIENT_URL: ${process.env.CLIENT_URL}`);
console.log(`process.env.CLIENT_URLS: ${process.env.CLIENT_URLS}`);
const defaultJsonParser = express.json();
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === DEFAULT_CODE_AGENT_MODEL_GATEWAY_BASE_PATH || req.path.startsWith(`${DEFAULT_CODE_AGENT_MODEL_GATEWAY_BASE_PATH}/`)) {
    next();
    return;
  }
  if (req.path === CODE_AGENT_STATIC_PUBLISH_API_PATH) {
    next();
    return;
  }
  defaultJsonParser(req, res, next);
});

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
let postgresPool: PostgresPool | null = null;

if (PERSISTENCE_STORE === 'postgres') {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('PERSISTENCE_STORE=postgres requires DATABASE_URL');
  }

  postgresPool = createPostgresPool(databaseUrl, postgresLogger);
  postgresStore = new PostgresStore(postgresPool, postgresLogger, mediaObjectStorage);
  store = new CompositeRoomStore(postgresStore, redisStore, redisStore);
  activePersistenceStore = 'postgres';
} else if (PERSISTENCE_STORE !== 'redis') {
  serverLogger.warn('Unknown PERSISTENCE_STORE value, falling back to Redis', { persistenceStore: PERSISTENCE_STORE });
}

const parsePositiveIntegerEnv = (name: string, fallback: number) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const codexConnectionConfig = resolveCodexConnectionConfig(process.env);
const codexCliRunnerConfig = resolveCodexCliRunnerConfig(process.env);
let codexConnectionService: CodexConnectionService | undefined;
let codexDeviceAuthSessions: CodexDeviceAuthSessionManager | undefined;
if (codexConnectionConfig.enabled) {
  const codexConnectionStore = postgresPool
    ? new PostgresCodexConnectionStore(postgresPool)
    : new RedisCodexConnectionStore(redisClient);
  codexConnectionService = new CodexConnectionService(
    codexConnectionStore,
    new CodexAuthCipher(codexConnectionConfig.authEncryptionKey, 'v1'),
    new CodexCliDeviceAuthDriver({
      cliBin: codexConnectionConfig.cliBin,
      loginTimeoutMs: codexConnectionConfig.authLoginTimeoutMs,
      scriptBin: codexConnectionConfig.authScriptBin,
    }),
    {
      lockTtlMs: parsePositiveIntegerEnv('CODEX_CONNECTION_LOCK_TTL_MS', 10 * 60 * 1000),
    }
  );
  codexDeviceAuthSessions = new CodexDeviceAuthSessionManager(codexConnectionService, {
    deviceCodeTimeoutMs: parsePositiveIntegerEnv('CODEX_DEVICE_CODE_TIMEOUT_MS', 30_000),
    onBackgroundError: (error, clientId) => {
      codexLogger.warn('Codex device auth background task failed', {
        error: error instanceof Error ? error.message : String(error),
        clientId,
      });
    },
  });
}

const codeAgentRuntimeConfig = resolveCodeAgentRuntimeConfig(process.env);
const codeAgentRoomContextService = createCodeAgentRoomContextServiceFromEnv(store);
assertCodexBackendStartupGate({
  codeAgentRuntimeConfig,
  codexCliRunnerConfig,
  codexConnectionConfig,
  hasCodexConnectionService: Boolean(codexConnectionService),
});
const observabilityRecorder = postgresPool
  ? new PostgresObservabilityEventRecorder(postgresPool, new Logger('Observability'))
  : new NoopObservabilityEventRecorder();
const codeAgentAccess = createCodeAgentAccessControl({
  enabled: codeAgentRuntimeConfig.enabled,
  allowedClientIds: codeAgentRuntimeConfig.allowedClientIds,
});
const codeAgentModelGateway = codeAgentRuntimeConfig.modelGateway
  ? new CodeAgentModelGateway({
    publicBaseUrl: codeAgentRuntimeConfig.modelGateway.publicBaseUrl,
    tokenSecret: codeAgentRuntimeConfig.modelGateway.tokenSecret,
    tokenTtlSeconds: codeAgentRuntimeConfig.modelGateway.tokenTtlSeconds,
    maxRequestsPerTurn: codeAgentRuntimeConfig.modelGateway.maxRequestsPerTurn,
    turnBudgetUsd: codeAgentRuntimeConfig.modelGateway.turnBudgetUsd,
    providerApiKeys: {
      anthropic: process.env.ANTHROPIC_API_KEY,
      deepseek: process.env.DEEPSEEK_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
    },
    providerBaseUrls: {
      anthropic: process.env.ANTHROPIC_BASE_URL,
      deepseek: process.env.DEEPSEEK_BASE_URL,
      openai: process.env.OPENAI_BASE_URL,
      openrouter: process.env.OPENROUTER_BASE_URL,
    },
    stateStore: new RedisCodeAgentModelGatewayTokenStateStore(redisClient),
    logger: codeAgentLogger,
    observability: observabilityRecorder,
  })
  : undefined;

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
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  maxHttpBufferSize: parsePositiveIntegerEnv('SOCKET_MAX_HTTP_BUFFER_SIZE', 25 * 1024 * 1024),
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

if (codeAgentRuntimeConfig.enabled && codeAgentRuntimeConfig.sandboxProvider === 'e2b') {
  codeAgentLogger.info('E2B sandbox provider selected', { artifactMode: codeAgentRuntimeConfig.artifactMode });
}

const codeAgentSandboxService = codeAgentRuntimeConfig.enabled && codeAgentRuntimeConfig.sandboxProvider === 'e2b'
  ? new E2BCodeAgentSandboxService(createE2BDriver(), {
    templateId: codeAgentRuntimeConfig.e2bTemplateId || '',
    workspace: codeAgentRuntimeConfig.e2bWorkspace,
    artifactVersion: codeAgentRuntimeConfig.artifactVersion,
    codeAgentSourceRef: codeAgentRuntimeConfig.codeAgentSourceRef,
    lifecycle: codeAgentRuntimeConfig.e2bLifecycle,
    logger: codeAgentLogger,
  })
  : new FakeCodeAgentSandboxService();
const defaultCodeAgentIdleSandboxTtlMs = 2 * 60 * 1000;
const codeAgentIdleSandboxTtlMs = parsePositiveIntegerEnv(
  'CODE_AGENT_IDLE_SANDBOX_TTL_MS',
  parsePositiveIntegerEnv('CODE_AGENT_SANDBOX_TTL_MS', defaultCodeAgentIdleSandboxTtlMs)
);
const codeAgentActiveSandboxTtlMs = parsePositiveIntegerEnv(
  'CODE_AGENT_ACTIVE_SANDBOX_TTL_MS',
  DEFAULT_CODE_AGENT_E2B_KILL_TIMEOUT_MS
);
const codeAgentSandboxLifecycle = new CodeAgentSandboxLifecycleService(store, codeAgentSandboxService, codeAgentLogger, {
  sandboxTtlMs: codeAgentIdleSandboxTtlMs,
  idleSandboxTtlMs: codeAgentIdleSandboxTtlMs,
  activeSandboxTtlMs: codeAgentActiveSandboxTtlMs,
  creatingStaleMs: parsePositiveIntegerEnv('CODE_AGENT_CREATING_STALE_MS', 2 * 60 * 1000),
  maxActiveSandboxes: parsePositiveIntegerEnv('CODE_AGENT_MAX_ACTIVE_SANDBOXES', Number.POSITIVE_INFINITY),
  maxActiveSandboxesPerUser: parsePositiveIntegerEnv('CODE_AGENT_MAX_ACTIVE_SANDBOXES_PER_USER', Number.POSITIVE_INFINITY),
  reconnectTimedOutSandboxes: codeAgentRuntimeConfig.e2bLifecycle.onTimeout === 'pause',
  artifactVersion: codeAgentRuntimeConfig.artifactVersion,
  codeAgentSourceRef: codeAgentRuntimeConfig.codeAgentSourceRef,
  artifactMigrationMaxArchiveBytes: parsePositiveIntegerEnv(
    'CODE_AGENT_ARTIFACT_MIGRATION_MAX_ARCHIVE_BYTES',
    DEFAULT_ARTIFACT_MIGRATION_MAX_ARCHIVE_BYTES
  ),
  artifactMigrationTimeoutMs: parsePositiveIntegerEnv(
    'CODE_AGENT_ARTIFACT_MIGRATION_TIMEOUT_MS',
    DEFAULT_ARTIFACT_MIGRATION_TIMEOUT_MS
  ),
});
const fakeCodeAgentToolOutput = [
  'stdout: hello from Coco Agent fake runner',
  'stderr: simulated warning for UI coverage',
  'line '.repeat(260).trim(),
].join('\n');
const codeAgentDaemonRegistry = codeAgentRuntimeConfig.runnerClient === 'daemon'
  ? new CodeAgentDaemonProcessRegistry()
  : undefined;
const codeAgentDaemonRunnerClient = codeAgentRuntimeConfig.runnerClient === 'daemon'
  ? new JsonlCodeAgentDaemonRunnerClient()
  : undefined;
const codeAgentRunnerClient = codeAgentRuntimeConfig.runnerClient === 'daemon'
  ? codeAgentDaemonRunnerClient!
  : codeAgentRuntimeConfig.runnerClient === 'jsonl' ? new JsonlCodeAgentRunnerClient() : new FakeCodeAgentRunnerClient([
  { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'status', turnId: 'fake', status: 'starting', message: 'Coco Agent fake runner starting' },
  { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'fake-ai', delta: 'Coco Agent fake runner received the task.' },
  { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'fake-tool-1', name: 'Shell', args: { command: 'printf "hello from Coco Agent fake runner\\n"' } },
  { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'fake-tool-1', name: 'Shell', success: false, output: fakeCodeAgentToolOutput, exitCode: 2, truncated: true },
  { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'fake-ai', answer: 'Coco Agent fake runner received the task.', sessionId: 'fake-code-agent-session' },
], { eventDelayMs: parsePositiveIntegerEnv('CODE_AGENT_FAKE_RUNNER_EVENT_DELAY_MS', 0) });
const codeAgentRunner = createCodeAgentRunner(codeAgentRuntimeConfig.backend, codeAgentRunnerClient);
const codexRunnerEnv = {
  PYTHONPATH: codeAgentRuntimeConfig.runnerEnv.PYTHONPATH || DEFAULT_CODE_AGENT_RUNNER_PYTHONPATH,
  CODE_AGENT_WORKSPACE_ROOT: codeAgentRuntimeConfig.runnerEnv.CODE_AGENT_WORKSPACE_ROOT || codeAgentRuntimeConfig.e2bWorkspace || DEFAULT_CODE_AGENT_WORKSPACE_ROOT,
  CODEX_CLI_BIN: codexCliRunnerConfig.cliBin,
};
const codeAgentSessionService = new CodeAgentSessionService(
  store,
  io,
  codeAgentSandboxLifecycle,
  codeAgentSandboxService,
  codeAgentRunner,
  codeAgentLogger,
  {
    enabled: codeAgentRuntimeConfig.enabled,
    allowedClientIds: codeAgentRuntimeConfig.allowedClientIds,
    mode: codeAgentRuntimeConfig.mode,
    availableModes: codeAgentRuntimeConfig.availableModes,
    defaultMode: codeAgentRuntimeConfig.defaultMode,
    modelGateway: codeAgentModelGateway,
    backend: codeAgentRuntimeConfig.backend,
    runnerClient: codeAgentRuntimeConfig.runnerClient,
    runnerCommand: codeAgentRuntimeConfig.runnerCommand,
    runnerCommandByBackend: codeAgentRuntimeConfig.runnerCommandByBackend,
    daemonCommand: codeAgentRuntimeConfig.daemonCommand,
    daemonRegistry: codeAgentDaemonRegistry,
    daemonRunnerClient: codeAgentDaemonRunnerClient,
    allowedPaths: codeAgentRuntimeConfig.allowedPaths,
    runnerEnv: codeAgentRuntimeConfig.runnerEnv,
    runnerEnvByBackend: {
      codex: codexRunnerEnv,
      'codex-app-server': codexRunnerEnv,
    },
    runnerProviderEnvByProvider: codeAgentRuntimeConfig.runnerProviderEnvByProvider,
    codexBackendEnabled: codexCliRunnerConfig.enabled && Boolean(codexConnectionService),
    codexConnectionService,
    staticSitePublisher: publishedStaticSiteService,
    roomContext: codeAgentRoomContextService,
    observability: observabilityRecorder,
    aiStreamOwnerId,
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
    if (postgresPool) {
      const retentionDays = parsePositiveIntegerEnv('OBSERVABILITY_EVENT_RETENTION_DAYS', 60);
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      const deletedCount = await (observabilityRecorder as PostgresObservabilityEventRecorder).deleteEventsBefore(cutoff);
      if (deletedCount > 0) {
        serverLogger.info('Deleted old observability events', { deletedCount, retentionDays, cutoff });
      }
    }
    if (process.env.E2E_TEST_MODE === 'true' && process.env.E2E_RESET_ON_START === 'true') {
      await store.resetAllDataForTests?.();
      serverLogger.warn('E2E data reset on startup', { persistenceStore: activePersistenceStore });
    }
    await store.clearRealtimeRoomMembers?.();
    await store.failInterruptedStreamingMessages?.('Response interrupted.', { aiStreamOwnerId });
    await store.failInterruptedRoomAgentTurns?.();
    await codeAgentSandboxLifecycle.recoverInterruptedSandboxes();
    await codeAgentSessionService.resumeQueuedTurns();
    
    redisLogger.info('Connected to Redis and Socket.IO adapter initialized', { persistenceStore: activePersistenceStore });
  } catch (err) {
    redisLogger.error('Failed to connect to Redis, PostgreSQL, or initialize adapter', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    throw err;
  }
})();

const assemblyAIApiKey = process.env.ASSEMBLYAI_API_KEY;
const audioTranscriptionRunner = createAssemblyAIAudioTranscriptionRunner({
  store,
  mediaObjectStorage,
  apiKey: assemblyAIApiKey,
  logger: routeLogger,
});

registerSocketHandlers({
  io,
  store,
  socketLogger,
  openaiLogger,
  normalizeAIModel,
  getAIClientForModel,
  aiStreamOwnerId,
  assemblyAIApiKey,
  codeAgentSessionService,
  codeAgentAccess,
  codeAgentSandboxLifecycle,
  codeAgentSandboxService,
  codeWorkspaceAssetAccess,
  publishedStaticSiteService,
});

let outboxWorker: OutboxWorker | null = null;
if (process.env.OUTBOX_WORKER_ENABLED === 'true') {
  outboxWorker = createOutboxWorkerFromEnv({
    store,
    logger: outboxLogger,
    workerId: `server-${process.pid}-${aiStreamOwnerId || 'default'}`,
    eventTypes: ['ai.run_requested'],
    handlers: {
      'ai.run_requested': event => executeQueuedAssistantRun(event.payload, {
        io,
        store,
        socketLogger,
        openaiLogger,
        normalizeAIModel,
        getAIClientForModel,
        aiStreamOwnerId,
        assemblyAIApiKey,
        codeAgentSessionService,
        codeAgentAccess,
      }),
    },
  });
  infrastructureReady
    .then(() => outboxWorker?.start())
    .catch(error => {
      outboxLogger.error('Outbox worker did not start because infrastructure initialization failed', { error });
    });
} else {
  outboxLogger.info('Outbox worker disabled', { enabled: false });
}

loadStickerCatalog();

if (codeAgentModelGateway) {
  registerCodeAgentModelGatewayRoutes(
    app,
    codeAgentModelGateway,
    DEFAULT_CODE_AGENT_MODEL_GATEWAY_BASE_PATH,
    process.env.CODE_AGENT_MODEL_GATEWAY_BODY_LIMIT || DEFAULT_CODE_AGENT_MODEL_GATEWAY_BODY_LIMIT,
  );
}

registerApiRoutes(app, {
  store,
  io,
  redisClient,
  routeLogger,
  getAIModelResponse,
  generateAIRoleDraft,
  persistenceStore: activePersistenceStore,
  mediaObjectStorage,
  audioTranscriptionRunner,
  codeAgentAccess,
  codeAgentMode: codeAgentRuntimeConfig.mode,
  codeAgentAvailableModes: codeAgentRuntimeConfig.availableModes,
  codeAgentDefaultMode: codeAgentRuntimeConfig.defaultMode,
  codexConnections: {
    enabled: codexConnectionConfig.enabled,
    service: codexConnectionService,
    deviceAuthSessions: codexDeviceAuthSessions,
  },
});

registerPublishedStaticSiteRoutes(app, {
  service: publishedStaticSiteService,
  logger: staticPublishLogger,
  getRoomById: roomId => store.getRoomById(roomId),
});

registerCodeAgentRoomContextRoutes(app, {
  service: codeAgentRoomContextService,
  logger: codeAgentLogger,
  listPublishedSites: (roomId, requestBaseUrl) => publishedStaticSiteService.listSitesForRoom(roomId, requestBaseUrl),
});

registerCodeWorkspaceAssetRoutes(app, {
  assetAccess: codeWorkspaceAssetAccess,
  logger: routeLogger,
  getRoomById: roomId => store.getRoomById(roomId),
  codeAgentSandboxService,
  maxAssetBytes: parsePositiveIntegerEnv('CODE_AGENT_WORKSPACE_ASSET_MAX_BYTES', 25 * 1024 * 1024),
});

// Catch-all 路由，返回前端应用的入口 HTML 文件（支持前端路由）
app.get('*', (req: Request, res: Response) => {
  routeLogger.debug('Serving client application', { path: req.path, ip: req.ip });
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// 全局错误处理中间件
type HttpError = Error & {
  status?: number;
  statusCode?: number;
  type?: string;
};

app.use((err: HttpError, req: Request, res: Response, next: NextFunction) => {
  const errorLogger = new Logger('Error');
  errorLogger.error('Unhandled application error', { error: err.message, stack: err.stack, path: req.path, method: req.method, ip: req.ip });

  const statusCode = Number.isInteger(err.status) ? err.status as number : err.statusCode || 500;
  const safeStatusCode = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  const isPayloadTooLarge = safeStatusCode === 413 || err.type === 'entity.too.large';

  res.status(isPayloadTooLarge ? 413 : safeStatusCode).json({
    error: isPayloadTooLarge ? 'Payload too large' : 'Internal server error',
    message: process.env.NODE_ENV === 'production'
      ? (isPayloadTooLarge ? 'Request payload is too large' : 'An unexpected error occurred')
      : err.message
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

let shutdownStarted = false;
const shutdown = () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  outboxWorker?.stop();
  server.close();
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  void (codeAgentDaemonRegistry?.shutdownAll() || Promise.resolve()).finally(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

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
