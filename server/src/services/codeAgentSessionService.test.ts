import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { AIModelOption, CodeAgentMode, Message, Room, RoomAICostTotal } from '../types';
import { CodeAgentRunnerAdapter, CodeAgentBackend } from './codeAgentRunner';
import { CodeAgentDaemonProcessRegistry } from './codeAgentDaemonRegistry';
import { CodeAgentSandboxLifecycleService } from './codeAgentSandboxLifecycle';
import { CodeAgentSessionService } from './codeAgentSessionService';
import { CODE_AGENT_RUNNER_SCHEMA_VERSION, CodeAgentRunnerEvent, CodeAgentRunnerRunRequest } from './codeAgentRunnerProtocol';
import { CodeAgentRunnerClient, CodeAgentRunnerRunResult } from './fakeCodeAgentRunner';
import { FakeCodeAgentRunnerClient } from './fakeCodeAgentRunner';
import { FakeCodeAgentSandboxService } from './fakeCodeAgentSandboxService';
import { DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND, DEFAULT_CODEX_CLI_RUNNER_COMMAND, DEFAULT_CODE_AGENT_DAEMON_COMMAND, DEFAULT_CODE_AGENT_RUNNER_COMMAND } from './codeAgentRuntimeConfig';
import { CodeAgentModelGateway, InMemoryCodeAgentModelGatewayTokenStateStore } from './codeAgentModelGateway';
import { PublishedStaticSiteService } from './publishedStaticSite';
import { MemoryMediaObjectStorage } from '../testUtils/memoryMediaObjectStorage';
import { ObservabilityEventInput } from './observabilityEvents';

type RoomEmit = {
  roomId: string;
  event: string;
  args: unknown[];
};

class FakeEmitter {
  roomEmits: RoomEmit[] = [];
  onEmit?: (event: RoomEmit) => void;

  to(roomId: string) {
    return {
      emit: (event: string, ...args: unknown[]) => {
        const roomEmit = { roomId, event, args };
        this.roomEmits.push(roomEmit);
        this.onEmit?.(roomEmit);
      },
    };
  }
}

const createMemoryObservability = () => {
  const events: ObservabilityEventInput[] = [];
  return {
    events,
    recorder: {
      async recordEvent(event: ObservabilityEventInput) {
        events.push(event);
        return {
          id: `event-${events.length}`,
          createdAt: '2026-05-03T00:00:00.000Z',
          payload: {},
          ...event,
        } as any;
      },
    },
  };
};

class MemoryCodeAgentStore {
  rooms = new Map<string, Room>();
  messages = new Map<string, Message[]>();
  members = new Map<string, { roomId: string; clientId: string; role: string; joinedAt: string }[]>();
  appendFailures = 0;
  upsertFailures = 0;
  roomCost: RoomAICostTotal = { roomId: 'room-1', currency: 'USD', totalUsd: 0 };

  constructor(initialRoom: Room, initialMessages: Message[] = []) {
    this.rooms.set(initialRoom.id, initialRoom);
    this.messages.set(initialRoom.id, initialMessages);
    this.members.set(initialRoom.id, [
      { roomId: initialRoom.id, clientId: initialRoom.creatorId, role: 'owner', joinedAt: initialRoom.createdAt },
    ]);
  }

  async getRoomById(roomId: string) {
    return this.rooms.get(roomId) || null;
  }

  async getRoomMember(roomId: string, clientId: string) {
    const members = this.members.get(roomId) || [];
    return members.find(m => m.clientId === clientId) || null;
  }

  addMember(roomId: string, clientId: string, role: string) {
    const list = this.members.get(roomId) || [];
    list.push({ roomId, clientId, role, joinedAt: '2026-05-03T00:00:00.000Z' });
    this.members.set(roomId, list);
  }

  async readMessagesByRoom(roomId: string) {
    return this.messages.get(roomId) || [];
  }

  async saveRoom(room: Room) {
    const current = this.rooms.get(room.id);
    if (!current) return null;
    const saved = { ...current, ...room };
    this.rooms.set(room.id, saved);
    return saved;
  }

  async upsertMessage(message: Message) {
    if (this.upsertFailures > 0) {
      this.upsertFailures--;
      return null;
    }
    const room = this.rooms.get(message.roomId);
    if (!room) return null;
    const messages = this.messages.get(message.roomId) || [];
    const index = messages.findIndex(item => item.id === message.id);
    if (index === -1) {
      messages.push(message);
    } else {
      messages[index] = message;
    }
    this.messages.set(message.roomId, messages);
    return { ...room, lastActivityAt: message.timestamp };
  }

  async appendMessageWithAtomicPosition(message: Message) {
    if (this.appendFailures > 0) {
      this.appendFailures--;
      return null;
    }
    const room = this.rooms.get(message.roomId);
    if (!room) return null;
    this.messages.set(message.roomId, [...(this.messages.get(message.roomId) || []), message]);
    return { ...room, lastActivityAt: message.timestamp };
  }

  async deleteMessageById(roomId: string, messageId: string) {
    const messages = this.messages.get(roomId);
    if (!messages) return null;
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return null;
    messages.splice(index, 1);
    return { roomId, messageId };
  }

  async incrementRoomAICost(roomId: string, cost: any) {
    this.roomCost = {
      roomId,
      currency: 'USD',
      totalUsd: this.roomCost.totalUsd + (cost?.totalUsd || 0),
    };
    return this.roomCost;
  }

  async compareAndSetRoomSandboxStatus(roomId: string, expectedStatuses: string[], nextStatus: any, updatedAt = '2026-05-03T00:00:00.000Z') {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const current = room.sandboxStatus || 'none';
    if (!expectedStatuses.includes(current)) return null;
    const updated = { ...room, sandboxStatus: nextStatus, sandboxUpdatedAt: updatedAt };
    this.rooms.set(roomId, updated);
    return updated;
  }

  async replaceRoomSandbox(roomId: string, expectedSandboxId: string, next: any) {
    const room = this.rooms.get(roomId);
    if (!room || room.sandboxId !== expectedSandboxId) return null;
    const updated = { ...room, ...next };
    this.rooms.set(roomId, updated);
    return updated;
  }
}

class BlockingRunner implements CodeAgentRunnerClient {
  requests: CodeAgentRunnerRunRequest[] = [];
  private releaseRun!: () => void;
  private markStarted!: () => void;
  started = new Promise<void>(resolve => {
    this.markStarted = resolve;
  });
  private blocked = new Promise<void>(resolve => {
    this.releaseRun = resolve;
  });

  release() {
    this.releaseRun();
  }

  async run(request: CodeAgentRunnerRunRequest): Promise<CodeAgentRunnerRunResult> {
    this.requests.push(request);
    this.markStarted();
    await this.blocked;
    const finalEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'final' as const,
      messageId: 'ai',
      answer: 'done',
      sessionId: 'session-blocking',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' as const },
    };
    return { events: [finalEvent], finalEvent };
  }
}

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
} as unknown as Logger;

const selectedModel: AIModelOption = {
  id: 'deepseek-v4-pro',
  apiModel: 'deepseek-v4-pro',
  provider: 'deepseek',
  label: 'DeepSeek V4 Pro',
  description: 'Test model',
  pricing: { currency: 'USD', inputPerMillion: 0.27, cachedInputPerMillion: 0.07, outputPerMillion: 1.1 },
};

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Code Agent Room',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  lastActivityAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  type: 'codeAgent',
  ...overrides,
});

const userMessage = (content = 'inspect the project'): Message => ({
  id: 'user-1',
  clientId: 'client-1',
  content,
  roomId: 'room-1',
  timestamp: '2026-05-03T00:00:00.000Z',
  messageType: 'text',
});

const createService = (options: {
  store?: MemoryCodeAgentStore;
  runner?: CodeAgentRunnerClient;
  backend?: CodeAgentBackend;
  enabled?: boolean;
  allowedClientIds?: string[];
  ids?: string[];
  runnerEnv?: Record<string, string>;
  runnerClient?: 'fake' | 'jsonl' | 'daemon';
  runnerCommand?: string;
  runnerCommandByBackend?: Partial<Record<CodeAgentBackend, string>>;
  daemonCommand?: string;
  daemonRegistry?: CodeAgentDaemonProcessRegistry;
  runnerEnvByBackend?: Partial<Record<CodeAgentBackend, Record<string, string>>>;
  runnerProviderEnvByProvider?: Partial<Record<AIModelOption['provider'], Record<string, string>>>;
  codexBackendEnabled?: boolean;
  codexConnectionService?: any;
  mode?: CodeAgentMode;
  availableModes?: CodeAgentMode[];
  defaultMode?: CodeAgentMode;
  modelGateway?: CodeAgentModelGateway;
  staticSitePublisher?: PublishedStaticSiteService;
  observability?: ReturnType<typeof createMemoryObservability>['recorder'];
  aiStreamOwnerId?: string;
  activeSandboxTtlMs?: number;
  idleSandboxTtlMs?: number;
} = {}) => {
  const store = options.store || new MemoryCodeAgentStore(room(), [userMessage()]);
  const emitter = new FakeEmitter();
  const sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-05-03T00:00:00.000Z'));
  const lifecycle = new CodeAgentSandboxLifecycleService(store as any, sandboxService, logger, {
    sandboxTtlMs: 60 * 60 * 1000,
    activeSandboxTtlMs: options.activeSandboxTtlMs ?? 60 * 60 * 1000,
    idleSandboxTtlMs: options.idleSandboxTtlMs ?? 2 * 60 * 1000,
    turnTimeoutMs: 5 * 60 * 1000,
    creatingStaleMs: 2 * 60 * 1000,
    maxActiveSandboxes: 10,
    maxActiveSandboxesPerUser: 10,
  }, () => new Date('2026-05-03T00:00:00.000Z'));
  const ids = [...(options.ids || ['ai-1', 'turn-1', 'status-1', 'result-1', 'error-1'])];
  const service = new CodeAgentSessionService(
    store as any,
    emitter,
    lifecycle,
    sandboxService,
    new CodeAgentRunnerAdapter(options.runner || new FakeCodeAgentRunnerClient([]), options.backend || 'code-agent'),
    logger,
    {
      enabled: options.enabled ?? true,
      allowedClientIds: options.allowedClientIds,
      mode: options.mode,
      availableModes: options.availableModes,
      defaultMode: options.defaultMode,
      modelGateway: options.modelGateway,
      backend: options.backend,
      runnerClient: options.runnerClient,
      runnerCommand: options.runnerCommand,
      runnerCommandByBackend: options.runnerCommandByBackend,
      daemonCommand: options.daemonCommand,
      daemonRegistry: options.daemonRegistry,
      staticSitePublisher: options.staticSitePublisher,
      runnerEnv: options.runnerEnv,
      runnerEnvByBackend: options.runnerEnvByBackend,
      runnerProviderEnvByProvider: options.runnerProviderEnvByProvider,
      codexBackendEnabled: options.codexBackendEnabled,
      codexConnectionService: options.codexConnectionService,
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      createId: () => ids.shift() || 'id-fallback',
      observability: options.observability,
      aiStreamOwnerId: options.aiStreamOwnerId,
    }
  );
  return { emitter, lifecycle, sandboxService, service, store };
};

describe('CodeAgentSessionService', () => {
  it('runs a full fake code-agent turn and persists runner events', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'status', turnId: 'turn-1', status: 'starting', message: 'starting' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Working...' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Read', args: { file_path: 'README.md' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Read', success: true, output: '# RoomTalk' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, source: 'reported' },
      },
    ]);
    const observability = createMemoryObservability();
    const { emitter, sandboxService, service, store } = createService({ runner, observability: observability.recorder, aiStreamOwnerId: 'owner-1' });
    let ack: unknown;

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    }, response => {
      ack = response;
    });

    assert.deepEqual(ack, { success: true, messageId: 'ai-1' });
    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    assert.equal(sandboxService.startedRunnerCommands[0], DEFAULT_CODE_AGENT_RUNNER_COMMAND);
    assert.deepEqual(sandboxService.startedRunnerEnvs[0], { PYTHONUNBUFFERED: '1' });
    assert.equal(runner.requests[0].prompt, 'inspect the project');
    assert.equal(runner.requests[0].clientId, 'client-1');
    assert.deepEqual(runner.requests[0].priorMessages, []);
    assert.equal(runner.requests[0].apiModel, 'deepseek-v4-pro');
    assert.equal(runner.requests[0].mode, 'plan');
    assert.equal(runner.requests[0].workspace, '/workspace/room-1');
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai', 'tool_call', 'tool_result', 'ai']);
    assert.equal(messages[1].status, 'complete');
    assert.equal(messages[1].content, 'Working...');
    assert.equal((messages[1] as any).aiStreamOwnerId, 'owner-1');
    const emittedPlaceholder = emitter.roomEmits.find(event => event.event === 'new_message')?.args[0] as Message;
    assert.equal((emittedPlaceholder as any).aiStreamOwnerId, undefined);
    assert.equal(messages[2].toolCallId, 'tool-1');
    assert.equal(messages[3].toolOutputPreview, '# RoomTalk');
    assert.equal(messages[3].content, '# RoomTalk');
    assert.equal(messages[4].status, 'complete');
    assert.equal(messages[4].content, 'Done');
    assert.ok(Math.abs((messages[4].cost?.totalUsd || 0) - 0.000049) < 1e-12);
    assert.ok(Math.abs(store.roomCost.totalUsd - 0.000049) < 1e-12);
    const streamEnd = emitter.roomEmits.find(event => event.event === 'ai_stream_end' && (event.args[0] as any)?.messageId === messages[4].id);
    assert.ok(Math.abs(((streamEnd?.args[0] as any)?.cost?.totalUsd || 0) - 0.000049) < 1e-12);
    assert.equal((await store.getRoomById('room-1'))?.codeAgentStatus, 'idle');
    assert.equal((await store.getRoomById('room-1'))?.codeAgentSessionId, 'session-1');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_chunk'), true);
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_end'), true);
    assert.equal(sandboxService.stoppedRunnerCommands.length, 1);
    assert.deepEqual(observability.events.map(event => event.event), [
      'code_agent.turn.started',
      'code_agent.sandbox.ensure',
      'code_agent.runner.started',
      'code_agent.runner.status',
      'code_agent.runner.tool_call',
      'code_agent.runner.tool_result',
      'code_agent.runner.final',
      'code_agent.turn.completed',
    ]);
    assert.equal((observability.events[3].payload as any)?.message, 'starting');
    assert.equal((observability.events[5].payload as any)?.outputLength, '# RoomTalk'.length);
    assert.equal(observability.events.some(event => event.event === 'code_agent.runner.text_delta'), false);
  });

  it('fails loudly when a Coco runner omits provider usage', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    const messages = store.messages.get('room-1') || [];
    const finalMessage = messages[messages.length - 1];
    assert.equal(result.success, false);
    assert.equal(finalMessage.status, 'error');
    assert.match(finalMessage.content, /without provider-reported usage/);
  });

  it('rejects estimated usage from a Coco runner', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, source: 'estimated' },
      },
    ]);
    const { service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    const messages = store.messages.get('room-1') || [];
    const finalMessage = messages[messages.length - 1];
    assert.equal(result.success, false);
    assert.equal(finalMessage.status, 'error');
    assert.match(finalMessage.content, /without provider-reported usage/);
  });

  it('extends sandbox timeout while a turn is active and shortens it after completion', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { sandboxService, service } = createService({
      runner,
      activeSandboxTtlMs: 60 * 60 * 1000,
      idleSandboxTtlMs: 2 * 60 * 1000,
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(sandboxService.sandboxTimeoutUpdates.map(update => update.ttlMs), [
      60 * 60 * 1000,
      2 * 60 * 1000,
    ]);
  });

  it('reuses one sandbox daemon process across sequential turns while passing per-turn env', async () => {
    const contexts: Array<{ command?: string; backend?: CodeAgentBackend; runnerEnv?: Record<string, string> }> = [];
    const runner: CodeAgentRunnerClient = {
      async run(_request, handlers, context): Promise<CodeAgentRunnerRunResult> {
        contexts.push({
          command: context?.process.command,
          backend: context?.backend,
          runnerEnv: context?.runnerEnv,
        });
        const finalEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final' as const,
          messageId: 'ai-1',
          answer: 'Done',
          sessionId: `session-${contexts.length}`,
        };
        await handlers.onEvent(finalEvent);
        return { events: [finalEvent], finalEvent };
      },
    };
    const { sandboxService, service } = createService({
      runner,
      runnerClient: 'daemon',
      daemonRegistry: new CodeAgentDaemonProcessRegistry(),
      daemonCommand: DEFAULT_CODE_AGENT_DAEMON_COMMAND,
      runnerEnv: { PYTHONUNBUFFERED: '1' },
      ids: ['ai-1', 'turn-1', 'ai-2', 'turn-2'],
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(sandboxService.startedRunnerCommands, [DEFAULT_CODE_AGENT_DAEMON_COMMAND]);
    assert.deepEqual(sandboxService.startedRunnerTimeouts, [0]);
    assert.deepEqual(sandboxService.stoppedRunnerCommands, []);
    assert.deepEqual(contexts.map(context => context.command), [
      DEFAULT_CODE_AGENT_DAEMON_COMMAND,
      DEFAULT_CODE_AGENT_DAEMON_COMMAND,
    ]);
    assert.deepEqual(contexts.map(context => context.backend), ['code-agent', 'code-agent']);
    assert.deepEqual(contexts.map(context => context.runnerEnv), [
      { PYTHONUNBUFFERED: '1' },
      { PYTHONUNBUFFERED: '1' },
    ]);
  });

  it('runs Codex backend turns with sandbox secret auth injection and refreshed auth persistence', async () => {
    const initialAuthJson = JSON.stringify({ OPENAI_AUTH: { access_token: 'initial-access', refresh_token: 'initial-refresh' } });
    const refreshedAuthJson = JSON.stringify({ OPENAI_AUTH: { access_token: 'refreshed-access', refresh_token: 'initial-refresh' } });
    const authCalls: Array<{ clientId: string; runId: string }> = [];
    const refreshedAuths: Array<string | undefined> = [];
    let sandboxService: FakeCodeAgentSandboxService;
    const runner: CodeAgentRunnerClient = {
      async run(request, handlers, context): Promise<CodeAgentRunnerRunResult> {
        assert.equal(request.codexModel, 'gpt-5.6-sol');
        assert.equal(request.codexReasoningEffort, 'high');
        assert.equal(request.codexPermissionMode, 'fullAccess');
        assert.equal(request.codexServiceTier, 'priority');
        const env = sandboxService.startedRunnerEnvs[sandboxService.startedRunnerEnvs.length - 1];
        assert.ok(env.ROOMTALK_CODEX_AUTH_JSON_PATH);
        assert.ok(env.ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH);
        await sandboxService.writeSecretFile(context!.sandbox, {
          path: env.ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH,
          content: refreshedAuthJson,
        });
        const textEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta' as const,
          messageId: 'codex-turn-1',
          delta: 'Codex done',
        };
        const finalEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final' as const,
          messageId: 'codex-turn-1',
          answer: 'Codex done',
          sessionId: 'codex-session-1',
          usage: {
            promptTokens: 1200,
            completionTokens: 100,
            totalTokens: 1300,
            cachedPromptTokens: 900,
            cacheHitRate: 0.75,
            source: 'reported' as const,
          },
        };
        await handlers.onEvent(textEvent);
        await handlers.onEvent(finalEvent);
        return { events: [textEvent, finalEvent], finalEvent };
      },
    };
    const codexConnectionService = {
      async withCodexAuth(clientId: string, runId: string, work: (authJson: string) => Promise<any>) {
        authCalls.push({ clientId, runId });
        const workResult = await work(initialAuthJson);
        refreshedAuths.push(workResult.refreshedAuthJson);
        return workResult.result;
      },
    };
    const setup = createService({
      backend: 'codex',
      runner,
      runnerCommand: DEFAULT_CODEX_CLI_RUNNER_COMMAND,
      runnerEnv: { PYTHONUNBUFFERED: '1', CODEX_CLI_BIN: '/usr/local/bin/codex' },
      codexConnectionService,
      ids: ['ai-1', 'turn-1'],
    });
    sandboxService = setup.sandboxService;

    const result = await setup.service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      codexRunSettings: { model: 'gpt-5.6-sol', reasoningEffort: 'high', permissionMode: 'fullAccess', serviceTier: 'priority' },
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    assert.deepEqual(authCalls, [{ clientId: 'client-1', runId: 'turn-1' }]);
    assert.deepEqual(refreshedAuths, [refreshedAuthJson]);
    assert.equal(sandboxService.startedRunnerCommands[0], DEFAULT_CODEX_CLI_RUNNER_COMMAND);
    const env = sandboxService.startedRunnerEnvs[0];
    assert.match(env.ROOMTALK_CODEX_AUTH_JSON_PATH, /^\/tmp\/roomtalk-codex\/turn-1-auth\.json$/);
    assert.match(env.ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH, /^\/tmp\/roomtalk-codex\/turn-1-refreshed-auth\.json$/);
    assert.equal(JSON.stringify(env).includes('initial-access'), false);
    assert.deepEqual(sandboxService.deletedSecretFilePaths.sort(), [
      '/tmp/roomtalk-codex/turn-1-auth.json',
      '/tmp/roomtalk-codex/turn-1-refreshed-auth.json',
    ]);
    const messages = setup.store.messages.get('room-1') || [];
    assert.equal(messages[messages.length - 1].content, 'Codex done');
    assert.deepEqual(messages[messages.length - 1].aiModel, {
      id: 'gpt-5.6-sol',
      apiModel: 'gpt-5.6-sol',
      provider: 'openai',
      label: 'GPT-5.6-Sol High',
    });
    assert.deepEqual(messages[messages.length - 1].usage, {
      promptTokens: 1200,
      completionTokens: 100,
      totalTokens: 1300,
      cachedPromptTokens: 900,
      cacheHitRate: 0.75,
      source: 'reported',
    });
    assert.equal(messages[messages.length - 1].cost, undefined);
    assert.equal(setup.store.roomCost.totalUsd, 0);
  });

  it('lets a room select Codex while the service default backend remains the code-agent backend', async () => {
    const authCalls: Array<{ clientId: string; runId: string }> = [];
    let sandboxService: FakeCodeAgentSandboxService;
    const runner: CodeAgentRunnerClient = {
      async run(_request, handlers): Promise<CodeAgentRunnerRunResult> {
        const env = sandboxService.startedRunnerEnvs[sandboxService.startedRunnerEnvs.length - 1];
        assert.equal(env.CODEX_CLI_BIN, '/usr/local/bin/codex');
        assert.ok(env.ROOMTALK_CODEX_AUTH_JSON_PATH);
        const textEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta' as const,
          messageId: 'codex-turn-1',
          delta: 'Room-level Codex done',
        };
        const finalEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final' as const,
          messageId: 'codex-turn-1',
          answer: 'Room-level Codex done',
          sessionId: 'codex-session-1',
        };
        await handlers.onEvent(textEvent);
        await handlers.onEvent(finalEvent);
        return { events: [textEvent, finalEvent], finalEvent };
      },
    };
    const codexConnectionService = {
      async withCodexAuth(clientId: string, runId: string, work: (authJson: string) => Promise<any>) {
        authCalls.push({ clientId, runId });
        const workResult = await work(JSON.stringify({ OPENAI_AUTH: { access_token: 'room-token' } }));
        return workResult.result;
      },
    };
    const setup = createService({
      store: new MemoryCodeAgentStore(room({ codeAgentBackend: 'codex' }), [userMessage()]),
      runner,
      backend: 'code-agent',
      runnerCommandByBackend: {
        'code-agent': DEFAULT_CODE_AGENT_RUNNER_COMMAND,
        codex: DEFAULT_CODEX_CLI_RUNNER_COMMAND,
      },
      runnerEnvByBackend: {
        codex: { CODEX_CLI_BIN: '/usr/local/bin/codex' },
      },
      codexBackendEnabled: true,
      codexConnectionService,
      ids: ['ai-1', 'turn-1'],
    });
    sandboxService = setup.sandboxService;

    const result = await setup.service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    assert.deepEqual(authCalls, [{ clientId: 'client-1', runId: 'turn-1' }]);
    assert.equal(sandboxService.startedRunnerCommands[0], DEFAULT_CODEX_CLI_RUNNER_COMMAND);
    const messages = setup.store.messages.get('room-1') || [];
    assert.equal(messages[1].username, 'Codex');
    assert.equal(messages[messages.length - 1].content, 'Room-level Codex done');
  });

  it('lets a room select Codex app-server while reusing Codex subscription auth', async () => {
    const authCalls: Array<{ clientId: string; runId: string }> = [];
    let sandboxService: FakeCodeAgentSandboxService;
    const runner: CodeAgentRunnerClient = {
      async run(request, handlers, context): Promise<CodeAgentRunnerRunResult> {
        assert.equal(request.codexModel, 'gpt-5.5');
        assert.equal(request.codexReasoningEffort, 'xhigh');
        assert.equal(request.codexServiceTier, 'default');
        assert.equal(context?.backend, 'codex-app-server');
        const env = sandboxService.startedRunnerEnvs[sandboxService.startedRunnerEnvs.length - 1];
        assert.equal(env.CODEX_CLI_BIN, '/usr/local/bin/codex');
        assert.ok(env.ROOMTALK_CODEX_AUTH_JSON_PATH);
        const textEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta' as const,
          messageId: 'codex-app-turn-1',
          delta: 'Codex app-server done',
        };
        const finalEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final' as const,
          messageId: 'codex-app-turn-1',
          answer: 'Codex app-server done',
          sessionId: 'codex-app-session-1',
        };
        const usageEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'usage' as const,
          turnId: request.turnId,
          usage: {
            promptTokens: 106_000,
            completionTokens: 0,
            totalTokens: 106_000,
            modelContextWindow: 200_000,
            source: 'reported' as const,
          },
        };
        await handlers.onEvent(usageEvent);
        await handlers.onEvent(textEvent);
        await handlers.onEvent(finalEvent);
        return { events: [usageEvent, textEvent, finalEvent], finalEvent };
      },
    };
    const codexConnectionService = {
      async withCodexAuth(clientId: string, runId: string, work: (authJson: string) => Promise<any>) {
        authCalls.push({ clientId, runId });
        const workResult = await work(JSON.stringify({ OPENAI_AUTH: { access_token: 'app-server-token' } }));
        return workResult.result;
      },
    };
    const setup = createService({
      store: new MemoryCodeAgentStore(room({ codeAgentBackend: 'codex-app-server' }), [userMessage()]),
      runner,
      backend: 'code-agent',
      runnerCommandByBackend: {
        'code-agent': DEFAULT_CODE_AGENT_RUNNER_COMMAND,
        codex: DEFAULT_CODEX_CLI_RUNNER_COMMAND,
        'codex-app-server': DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
      },
      runnerEnvByBackend: {
        'codex-app-server': { CODEX_CLI_BIN: '/usr/local/bin/codex' },
      },
      codexBackendEnabled: true,
      codexConnectionService,
      ids: ['ai-1', 'turn-1'],
    });
    sandboxService = setup.sandboxService;

    const result = await setup.service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      codexRunSettings: { model: 'gpt-5.5', reasoningEffort: 'xhigh', permissionMode: 'approveForMe', serviceTier: 'default' },
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    assert.deepEqual(authCalls, [{ clientId: 'client-1', runId: 'turn-1' }]);
    assert.equal(sandboxService.startedRunnerCommands[0], DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND);
    const usageUpdate = setup.emitter.roomEmits.find(event => event.event === 'ai_usage_update');
    assert.deepEqual(usageUpdate?.args[0], {
      messageId: 'ai-1',
      roomId: 'room-1',
      usage: {
        promptTokens: 106_000,
        completionTokens: 0,
        totalTokens: 106_000,
        modelContextWindow: 200_000,
        source: 'reported',
      },
    });
    const messages = setup.store.messages.get('room-1') || [];
    assert.equal(messages[1].username, 'Codex');
    assert.equal(messages[messages.length - 1].content, 'Codex app-server done');
    assert.deepEqual(messages[messages.length - 1].aiModel, {
      id: 'gpt-5.5',
      apiModel: 'gpt-5.5',
      provider: 'openai',
      label: 'GPT-5.5 Extra High',
    });
  });

  it('fails Codex backend turns without a configured Codex connection service before starting the runner', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'unexpected', sessionId: 'session-1' },
    ]);
    const { sandboxService, service, store } = createService({
      backend: 'codex',
      runner,
      runnerCommand: DEFAULT_CODEX_CLI_RUNNER_COMMAND,
      ids: ['ai-1', 'turn-1'],
    });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.equal(result.success, false);
    assert.equal(sandboxService.startedRunnerCommands.length, 0);
    assert.equal(runner.requests.length, 0);
    const messages = store.messages.get('room-1') || [];
    assert.equal(messages[1].status, 'error');
    assert.equal(messages[1].content, 'Codex connection service is not configured');
  });

  it('persists interleaved AI text and tool events in runner order', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'I will inspect.' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Glob', args: { pattern: '**/*' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Glob', success: true, output: 'No files found matching the pattern.' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'The current directory is empty.' },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'I will inspect.The current directory is empty.',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { service, store } = createService({ runner });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai', 'tool_call', 'tool_result', 'ai']);
    assert.equal(messages[1].content, 'I will inspect.');
    assert.equal(messages[1].status, 'complete');
    assert.equal(messages[2].toolName, 'Glob');
    assert.deepEqual(messages[2].toolArgs, { pattern: '**/*' });
    assert.equal(messages[3].toolOutputPreview, 'No files found matching the pattern.');
    assert.equal(messages[3].content, 'No files found matching the pattern.');
    assert.equal(messages[4].content, 'The current directory is empty.');
    assert.equal(messages[4].status, 'complete');
    assert.equal(messages[4].turnId, messages[1].turnId);
  });

  it('passes prior RoomTalk Workspace history to the runner and excludes the current prompt', async () => {
    const initialMessages: Message[] = [
      userMessage('list files'),
      {
        id: 'ai-prev-1',
        clientId: 'ai_assistant',
        content: 'I will inspect.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:01.000Z',
        messageType: 'ai',
        status: 'complete',
        turnId: 'turn-prev',
      },
      {
        id: 'tool-prev-1',
        clientId: 'code_agent_runner',
        content: 'Glob {"pattern":"**/*"}',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:02.000Z',
        messageType: 'tool_call',
        username: 'Coco',
        status: 'complete',
        turnId: 'turn-prev',
        toolCallId: 'tool-prev',
        toolName: 'Glob',
        toolArgs: { pattern: '**/*' },
      },
      {
        id: 'tool-result-prev-1',
        clientId: 'code_agent_runner',
        content: 'No files found matching the pattern.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:03.000Z',
        messageType: 'tool_result',
        username: 'Coco',
        status: 'complete',
        turnId: 'turn-prev',
        toolCallId: 'tool-prev',
        toolName: 'Glob',
        toolOutputPreview: 'No files found matching the pattern.',
      },
      {
        id: 'ai-prev-2',
        clientId: 'ai_assistant',
        content: 'The directory is empty.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:04.000Z',
        messageType: 'ai',
        status: 'complete',
        turnId: 'turn-prev',
      },
      {
        ...userMessage('what did I ask before?'),
        id: 'user-2',
        timestamp: '2026-05-03T00:00:05.000Z',
      },
    ];
    const store = new MemoryCodeAgentStore(room({ codeAgentSessionId: 'session-prev' }), initialMessages);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'You asked me to list files.', sessionId: 'session-prev' },
    ]);
    const { service } = createService({ store, runner });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(runner.requests[0].prompt, 'what did I ask before?');
    assert.equal(runner.requests[0].sessionId, 'session-prev');
    assert.deepEqual(runner.requests[0].priorMessages, [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect.' },
          { type: 'tool_use', id: 'tool-prev', name: 'Glob', input: { pattern: '**/*' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-prev', content: 'No files found matching the pattern.' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'The directory is empty.' },
        ],
      },
    ]);
  });

  it('limits prior messages when maxContextMessages is set', async () => {
    const initialMessages: Message[] = [
      userMessage('list files'),
      {
        id: 'ai-prev-1',
        clientId: 'ai_assistant',
        content: 'I will inspect.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:01.000Z',
        messageType: 'ai',
        status: 'complete',
        turnId: 'turn-prev',
      },
      {
        id: 'tool-prev-1',
        clientId: 'code_agent_runner',
        content: 'Glob {"pattern":"**/*"}',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:02.000Z',
        messageType: 'tool_call',
        username: 'Coco',
        status: 'complete',
        turnId: 'turn-prev',
        toolCallId: 'tool-prev',
        toolName: 'Glob',
        toolArgs: { pattern: '**/*' },
      },
      {
        id: 'tool-result-prev-1',
        clientId: 'code_agent_runner',
        content: 'No files found matching the pattern.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:03.000Z',
        messageType: 'tool_result',
        username: 'Coco',
        status: 'complete',
        turnId: 'turn-prev',
        toolCallId: 'tool-prev',
        toolName: 'Glob',
        toolOutputPreview: 'No files found matching the pattern.',
      },
      {
        id: 'ai-prev-2',
        clientId: 'ai_assistant',
        content: 'The directory is empty.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:04.000Z',
        messageType: 'ai',
        status: 'complete',
        turnId: 'turn-prev',
      },
      {
        ...userMessage('what did I ask before?'),
        id: 'user-2',
        timestamp: '2026-05-03T00:00:05.000Z',
      },
    ];
    const store = new MemoryCodeAgentStore(room(), initialMessages);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'You asked about files.', sessionId: 'session-1' },
    ]);
    const { service } = createService({ store, runner });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel, maxContextMessages: 2 });

    assert.equal(runner.requests[0].prompt, 'what did I ask before?');
    assert.deepEqual(runner.requests[0].priorMessages, [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'The directory is empty.' },
        ],
      },
    ]);
  });

  it('sends all prior messages when maxContextMessages is not set', async () => {
    const initialMessages: Message[] = [
      userMessage('list files'),
      {
        id: 'ai-prev-1',
        clientId: 'ai_assistant',
        content: 'Done.',
        roomId: 'room-1',
        timestamp: '2026-05-03T00:00:01.000Z',
        messageType: 'ai',
        status: 'complete',
      },
      {
        ...userMessage('now what?'),
        id: 'user-2',
        timestamp: '2026-05-03T00:00:02.000Z',
      },
    ];
    const store = new MemoryCodeAgentStore(room(), initialMessages);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'ok', sessionId: 'session-1' },
    ]);
    const { service } = createService({ store, runner });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(runner.requests[0].prompt, 'now what?');
    assert.deepEqual(runner.requests[0].priorMessages, [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]);
  });

  it('removes the unused AI placeholder when tool events arrive before text', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Write', args: { file_path: 'hello.py' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Write', success: true, output: 'wrote hello.py' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-2', name: 'Shell', args: { command: 'python3 hello.py' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-2', name: 'Shell', success: true, output: 'Hello, World!' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done. The program prints Hello, World!' },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done. The program prints Hello, World!',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { emitter, service, store } = createService({
      runner,
      ids: ['ai-1', 'turn-1', 'tool-result-msg-1', 'tool-result-msg-2', 'ai-2'],
    });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'ai']);
    assert.equal(messages.some(message => message.id === 'ai-1'), false);
    assert.equal(messages[5].id, 'ai-2');
    assert.equal(messages[5].status, 'complete');
    assert.equal(messages[5].content, 'Done. The program prints Hello, World!');
    assert.deepEqual(
      emitter.roomEmits
        .filter(event => event.event === 'message_deleted')
        .map(event => event.args[0]),
      ['ai-1']
    );
  });

  it('does not render final answers when a tool-only turn sends no text delta', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Shell', args: { command: 'python3 hello.py' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Shell', success: true, output: 'Hello, World!' },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'The script printed Hello, World!',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { emitter, service, store } = createService({
      runner,
      ids: ['ai-1', 'turn-1', 'tool-result-msg-1', 'ai-2'],
    });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'tool_call', 'tool_result']);
    assert.equal(messages.some(message => message.id === 'ai-1'), false);
    assert.deepEqual(
      emitter.roomEmits
        .filter(event => event.event === 'message_deleted')
        .map(event => event.args[0]),
      ['ai-1']
    );
  });

  it('stops the runner before broadcasting the final stream end', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { emitter, sandboxService, service } = createService({ runner });
    const stopCountsAtStreamEnd: number[] = [];
    emitter.onEmit = event => {
      if (event.event === 'ai_stream_end') {
        stopCountsAtStreamEnd.push(sandboxService.stoppedRunnerCommands.length);
      }
    };

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(stopCountsAtStreamEnd, [1]);
  });

  it('passes only explicit minimal environment to runner processes', async () => {
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'must-not-leak';
    try {
      const runner = new FakeCodeAgentRunnerClient([
        { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
      ]);
      const { sandboxService, service } = createService({
        runner,
        runnerEnv: { CODE_AGENT_SOURCE_DIR: '/sandbox/code-agent-engine/src' },
      });

      await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

      assert.deepEqual(sandboxService.startedRunnerEnvs[0], {
        PYTHONUNBUFFERED: '1',
        CODE_AGENT_SOURCE_DIR: '/sandbox/code-agent-engine/src',
      });
      assert.equal('ANTHROPIC_API_KEY' in sandboxService.startedRunnerEnvs[0], false);
    } finally {
      if (previousAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      }
    }
  });

  it('passes only the selected model provider env to runner processes', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { sandboxService, service } = createService({
      runner,
      runnerProviderEnvByProvider: {
        deepseek: { DEEPSEEK_API_KEY: 'deepseek-key' },
        anthropic: { ANTHROPIC_API_KEY: 'anthropic-key' },
      },
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(sandboxService.startedRunnerEnvs[0], {
      PYTHONUNBUFFERED: '1',
      DEEPSEEK_API_KEY: 'deepseek-key',
    });
  });

  it('allows each code-agent turn to choose plan mode within an edit-capable server configuration', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'plan' }), [userMessage()]);
    const { service } = createService({ store, runner, mode: 'acceptEdits' });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.equal(runner.requests[0].mode, 'plan');
  });

  it('rejects edit mode requests when the server is configured for plan mode only', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'acceptEdits' }), [userMessage()]);
    const { service } = createService({ store, runner, mode: 'plan' });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    assert.deepEqual(result, { success: false, error: 'Agent edit mode is not enabled' });
    assert.equal(runner.requests.length, 0);
  });

  it('keeps host provider keys out of proxied runner environments', async () => {
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'host-openai-key';
    process.env.ANTHROPIC_API_KEY = 'host-anthropic-key';
    try {
      const runner = new FakeCodeAgentRunnerClient([
        { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
      ]);
      const { sandboxService, service } = createService({
        runner,
        runnerEnv: {
          CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
          CODE_AGENT_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
        },
      });

      await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

      assert.deepEqual(sandboxService.startedRunnerEnvs[0], {
        PYTHONUNBUFFERED: '1',
        CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
        CODE_AGENT_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
      });
      assert.equal('OPENAI_API_KEY' in sandboxService.startedRunnerEnvs[0], false);
      assert.equal('ANTHROPIC_API_KEY' in sandboxService.startedRunnerEnvs[0], false);
    } finally {
      if (previousOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAIKey;
      }
      if (previousAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      }
    }
  });

  it('injects a per-turn model gateway token and write tools only for edit turns', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const gateway = new CodeAgentModelGateway({
      publicBaseUrl: 'https://room.example/api/code-agent/model-gateway',
      tokenSecret: 'gateway-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      nowMs: () => 1_800_000_000_000,
      stateStore: new InMemoryCodeAgentModelGatewayTokenStateStore(() => 1_800_000_000_000),
    });
    const { sandboxService, service } = createService({
      store: new MemoryCodeAgentStore(room({ codeAgentMode: 'acceptEdits' }), [userMessage()]),
      runner,
      availableModes: ['plan', 'acceptEdits'],
      defaultMode: 'plan',
      modelGateway: gateway,
      runnerProviderEnvByProvider: {
        deepseek: { DEEPSEEK_API_KEY: 'must-not-leak' },
      },
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.CODE_AGENT_MODEL_PROXY_URL, 'https://room.example/api/code-agent/model-gateway/v1');
    assert.equal(typeof env.CODE_AGENT_MODEL_PROXY_TOKEN, 'string');
    assert.notEqual(env.CODE_AGENT_MODEL_PROXY_TOKEN, 'deepseek-provider-key');
    assert.equal(env.ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS, 'true');
    assert.equal('DEEPSEEK_API_KEY' in env, false);
    assert.equal(runner.requests[0].mode, 'edit');
  });

  it('injects a scoped static publish token for configured full access turns', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.example',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'static-publish-token-id',
    });
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'fullAccess' }), [userMessage()]);
    const { sandboxService, service } = createService({
      store,
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      staticSitePublisher,
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
    });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH, 'true');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_URL, 'https://room.example/api/code-agent/publish-static-site');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL, 'https://room.example');
    const claims = staticSitePublisher.verifyTurnToken(env.ROOMTALK_STATIC_PUBLISH_TOKEN);
    assert.equal(claims?.roomId, 'room-1');
    assert.equal(claims?.clientId, 'client-1');
    assert.equal(claims?.turnId, 'turn-1');
    assert.equal(claims?.mode, 'fullAccess');
  });

  it('injects static publish URLs using the allowed production client origin', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.ruit.me',
      allowedPublicBaseUrls: ['https://room.ruit.me', 'https://room.ruit.me'],
      nodeEnv: 'production',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'static-publish-token-id',
    });
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'fullAccess' }), [userMessage()]);
    const { sandboxService, service } = createService({
      store,
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      staticSitePublisher,
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      clientOrigin: 'https://room.ruit.me',
      serverOrigin: 'http://127.0.0.1:3012',
    });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_URL, 'https://room.ruit.me/api/code-agent/publish-static-site');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL, 'https://room.ruit.me');
  });

  it('injects local static publish URLs from the local server origin outside production', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.ruit.me',
      nodeEnv: 'development',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'static-publish-token-id',
    });
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'fullAccess' }), [userMessage()]);
    const { sandboxService, service } = createService({
      store,
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      staticSitePublisher,
    });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      clientOrigin: 'http://127.0.0.1:3011',
      serverOrigin: 'http://127.0.0.1:3012',
    });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_URL, 'http://127.0.0.1:3012/api/code-agent/publish-static-site');
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL, 'http://127.0.0.1:3012');
  });

  it('does not inject static publish credentials into plan turns', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.example',
    });
    const { sandboxService, service } = createService({
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      staticSitePublisher,
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal('ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH' in env, false);
    assert.equal('ROOMTALK_STATIC_PUBLISH_TOKEN' in env, false);
  });

  it('defaults code-agent turns to plan even when edit mode is available', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { sandboxService, service } = createService({
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      runnerEnv: { ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS: 'true' },
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(runner.requests[0].mode, 'plan');
    assert.equal('ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS' in sandboxService.startedRunnerEnvs[0], false);
  });

  it('rejects concurrent turns in the same code-agent room', async () => {
    const runner = new BlockingRunner();
    const { service } = createService({ runner });
    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;

    const second = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    assert.deepEqual(second, { success: false, error: 'An agent task is already running in this workspace' });

    runner.release();
    assert.deepEqual(await first, { success: true, messageId: 'ai-1' });
  });

  it('rejects disabled, unauthorized, non-code-agent, and allowlist-mismatched turns', async () => {
    assert.deepEqual(await createService({ enabled: false }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'Workspace is disabled',
    });
    assert.deepEqual(await createService({ allowedClientIds: ['other-client'] }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'Workspace is not enabled for this user',
    });
    assert.deepEqual(await createService({ store: new MemoryCodeAgentStore(room({ creatorId: 'client-2' }), [userMessage()]) }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'You do not have access to this Workspace room',
    });
    assert.deepEqual(await createService({ store: new MemoryCodeAgentStore(room({ type: 'chat' }), [userMessage()]) }).service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }), {
      success: false,
      error: 'Room is not a Workspace room',
    });
  });

  it('allows admins when codeAgentAccess is admin', async () => {
    const store = new MemoryCodeAgentStore(room({ codeAgentAccess: 'admin' }), [
      { ...userMessage(), clientId: 'admin-1' },
    ]);
    store.addMember('room-1', 'admin-1', 'admin');
    const runner = new FakeCodeAgentRunnerClient([
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'ok',
        sessionId: 's1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { service } = createService({ store, runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'admin-1', selectedModel });
    assert.equal(result.success, true);
  });

  it('rejects regular members when codeAgentAccess is admin', async () => {
    const store = new MemoryCodeAgentStore(room({ codeAgentAccess: 'admin' }), [
      { ...userMessage(), clientId: 'member-1' },
    ]);
    store.addMember('room-1', 'member-1', 'member');
    const { service } = createService({ store });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'member-1', selectedModel });
    assert.deepEqual(result, { success: false, error: 'You do not have access to this Workspace room' });
  });

  it('allows all members when codeAgentAccess is member', async () => {
    const store = new MemoryCodeAgentStore(room({ codeAgentAccess: 'member' }), [
      { ...userMessage(), clientId: 'member-1' },
    ]);
    store.addMember('room-1', 'member-1', 'member');
    const runner = new FakeCodeAgentRunnerClient([
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'ok',
        sessionId: 's1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { service } = createService({ store, runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'member-1', selectedModel });
    assert.equal(result.success, true);
  });

  it('defaults to owner-only access when codeAgentAccess is not set', async () => {
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    store.addMember('room-1', 'member-1', 'member');

    const result = await createService({ store }).service.startTurn({ roomId: 'room-1', clientId: 'member-1', selectedModel });
    assert.deepEqual(result, { success: false, error: 'You do not have access to this Workspace room' });
  });

  it('stops runner processing when a tool event cannot be persisted', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Read', args: { file_path: 'README.md' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Read', success: true, output: '# RoomTalk' },
    ]);
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    store.appendFailures = 1;
    const { emitter, service } = createService({ runner, store });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    assert.equal(runner.requests.length, 1);
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai']);
    assert.equal(messages[1].status, 'error');
    assert.equal(messages[1].content, 'Unable to persist agent tool_call event');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_error'), true);
  });

  it('broadcasts room error state when placeholder persistence is rejected after running state was emitted', async () => {
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    store.upsertFailures = 1;
    const { emitter, service } = createService({ store });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(result, { success: false, error: 'Unable to start a durable agent response' });
    assert.equal((await store.getRoomById('room-1'))?.codeAgentStatus, 'error');
    const roomUpdates = emitter.roomEmits.filter(event => event.event === 'room_updated');
    assert.equal((roomUpdates[0].args[0] as Room).codeAgentStatus, 'running');
    assert.equal((roomUpdates[1].args[0] as Room).codeAgentStatus, 'error');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_error'), false);
  });

  it('marks the AI placeholder as error when the runner returns an error event', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'error', message: 'runner crashed', code: 'runner_exit', retryable: false },
    ]);
    const { emitter, service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const messages = store.messages.get('room-1') || [];
    assert.equal(messages[1].messageType, 'ai');
    assert.equal(messages[1].status, 'error');
    assert.equal(messages[1].content, 'runner crashed');
    assert.equal(messages[2].messageType, 'sandbox_status');
    assert.equal(messages[2].isError, true);
    assert.equal((await store.getRoomById('room-1'))?.codeAgentStatus, 'error');
    const errorBroadcast = emitter.roomEmits.find(event =>
      event.event === 'new_message' && (event.args[0] as Message).id === messages[1].id
      && (event.args[0] as Message).status === 'error'
    );
    assert.equal((errorBroadcast?.args[0] as Message | undefined)?.status, 'error');
    assert.equal((errorBroadcast?.args[0] as Message | undefined)?.content, 'runner crashed');
  });

  it('closes pending tool calls with failed results when the runner errors', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Shell', args: { command: 'python3 -m http.server 4173 --directory dist' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'error', message: 'code agent runner process failed: E2B command wait failed', code: 'runner_process_error', retryable: false },
    ]);
    const { emitter, service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'ai', 'tool_call', 'tool_result', 'sandbox_status']);
    assert.equal(messages[3].toolCallId, 'tool-1');
    assert.equal(messages[3].toolName, 'Shell');
    assert.equal(messages[3].status, 'error');
    assert.equal(messages[3].isError, true);
    assert.match(messages[3].content, /Tool interrupted before completion/);
    assert.match(messages[3].content, /E2B command wait failed/);
    const toolResultBroadcast = emitter.roomEmits.find(event =>
      event.event === 'new_message' && (event.args[0] as Message).messageType === 'tool_result'
    );
    assert.equal((toolResultBroadcast?.args[0] as Message | undefined)?.toolCallId, 'tool-1');
  });
});
