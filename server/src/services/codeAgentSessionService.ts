import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { AIModelOption, CodeAgentBackend, Message, Room, RoomAgentTurn, RoomAICostTotal, RoomMemberRole } from '../types';
import { calculateAICost, getMessageAIModel } from './aiModels';
import { CodeAgentSandboxLifecycleService, EnsureCodeAgentSandboxResult } from './codeAgentSandboxLifecycle';
import { CodeAgentSandboxHandle, CodeAgentSandboxService, CodeAgentRunnerProcess } from './codeAgentSandboxService';
import { mapCodeAgentRunnerEvent } from './codeAgentEventMapper';
import { CodeAgentRunner } from './codeAgentRunner';
import { CodeAgentDaemonProcessRegistry } from './codeAgentDaemonRegistry';
import {
  CODE_AGENT_RUNNER_SCHEMA_VERSION,
  CodeAgentRunnerApprovalDecision,
  CodeAgentRunnerEvent,
  CodeAgentRunnerJsonlParser,
  CodeAgentRunnerModelStepEvent,
  CodeAgentRunnerMode,
  CodeAgentRunnerRunRequest,
  CodeAgentRunnerThreadListRequest,
  CodeAgentRunnerThreadListResultEvent,
  CodeAgentRunnerThreadReadRequest,
  CodeAgentRunnerThreadReadResultEvent,
} from './codeAgentRunnerProtocol';
import {
  CodeAgentRunnerClientKind,
  DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
  DEFAULT_CODEX_CLI_RUNNER_COMMAND,
  DEFAULT_CODE_AGENT_DAEMON_COMMAND,
  DEFAULT_CODE_AGENT_RUNNER_COMMAND,
} from './codeAgentRuntimeConfig';
import { createAIPlaceholderMessage } from './messageDomain';
import { stripAIStreamRecoveryMetadata, withAIStreamRecoveryMetadata } from './aiStreamRecovery';
import { CodeAgentModelGateway } from './codeAgentModelGateway';
import { buildCodeAgentPriorMessages } from './codeAgentTranscript';
import { PublishedStaticSiteService } from './publishedStaticSite';
import { CODE_AGENT_ROOM_CONTEXT_API_PREFIX, CodeAgentRoomContextService } from './codeAgentRoomContext';
import { ObservabilityEventInput, ObservabilityEventRecorder } from './observabilityEvents';
import { canUseCodeAgentRoom, CODE_AGENT_ACCESS_DENIED_MESSAGE } from './codeAgentRoomAccess';
import { CodexConnectionService } from './codexConnection';
import { CodeAgentRunnerHandlers, CodeAgentRunnerRunResult } from './fakeCodeAgentRunner';
import { writeCodeAgentRunnerRequest } from './jsonlCodeAgentRunner';
import { JsonlCodeAgentDaemonRunnerClient } from './jsonlCodeAgentDaemonRunner';
import { CodexRunSettings, getCodexMessageAIModel, normalizeCodexRunSettings } from './codexRunSettings';
import {
  codeAgentModeAllowsShell,
  codeAgentModeAllowsStaticPublish,
  codeAgentModeAllowsWriteTools,
  normalizeCodeAgentMode,
  normalizeCodeAgentModeSet,
} from './codeAgentModes';
import {
  buildCocoModelStepCost,
  CocoModelStepCostRecord,
  summarizeCocoModelStepCosts,
} from './codeAgentModelStepCosts';

const isCodexBackend = (backend: CodeAgentBackend) => (
  backend === 'codex' || backend === 'codex-app-server'
);

export interface CodeAgentRoomEmitter {
  to(roomId: string): {
    emit(event: string, ...args: unknown[]): void;
  };
}

export interface CodeAgentSessionServiceOptions {
  enabled: boolean;
  allowedClientIds?: string[];
  mode?: CodeAgentRunnerMode;
  availableModes?: CodeAgentRunnerMode[];
  defaultMode?: CodeAgentRunnerMode;
  modelGateway?: CodeAgentModelGateway;
  backend?: CodeAgentBackend;
  runnerClient?: CodeAgentRunnerClientKind;
  runnerCommand?: string;
  runnerCommandByBackend?: Partial<Record<CodeAgentBackend, string>>;
  daemonCommand?: string;
  daemonRegistry?: CodeAgentDaemonProcessRegistry;
  daemonRunnerClient?: JsonlCodeAgentDaemonRunnerClient;
  allowedPaths?: string[];
  runnerEnv?: Record<string, string>;
  runnerEnvByBackend?: Partial<Record<CodeAgentBackend, Record<string, string>>>;
  runnerProviderEnvByProvider?: Partial<Record<AIModelOption['provider'], Record<string, string>>>;
  codexBackendEnabled?: boolean;
  codexConnectionService?: Pick<CodexConnectionService, 'withCodexAuth'>;
  staticSitePublisher?: PublishedStaticSiteService;
  roomContext?: CodeAgentRoomContextService;
  observability?: ObservabilityEventRecorder;
  aiStreamOwnerId?: string;
  now?: () => Date;
  createId?: () => string;
}

export interface CodeAgentTurnInput {
  roomId: string;
  clientId: string;
  selectedModel: AIModelOption;
  codexRunSettings?: CodexRunSettings;
  maxContextMessages?: number;
  requestedMode?: CodeAgentRunnerMode;
  requestedModeSource?: 'originalTurn';
  clientOrigin?: string;
  serverOrigin?: string;
}

export type CodeAgentTurnAck = { success: boolean; messageId?: string; error?: string };
export type CodeAgentTurnAckCallback = (response: CodeAgentTurnAck) => void;

export type CodeAgentControlAck = { success: boolean; error?: string };

export interface CodeAgentThreadListResult {
  threads: unknown[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface CodeAgentThreadReadResult {
  thread: unknown;
}

interface ActiveCodeAgentTurn {
  roomId: string;
  clientId: string;
  turnId: string;
  backend: CodeAgentBackend;
  sandbox?: CodeAgentSandboxHandle;
  process?: CodeAgentRunnerProcess;
}

interface CodeAgentTurnStreamState {
  activeMessageId: string;
  lastMessageId: string;
  segmentContent: string;
  fullContent: string;
  segmentHasUnsealedText: boolean;
  needsNewSegment: boolean;
  segmentIds: string[];
  nonEmptySegmentIds: Set<string>;
  pendingToolCalls: Map<string, { name: string }>;
  modelSteps: Map<string, CocoModelStepCostRecord & {
    hasText: boolean;
    toolCallIds: string[];
    aiModel: Message['aiModel'];
    costCommitted?: boolean;
  }>;
  modelStepIdByToolCallId: Map<string, string>;
  completedAIMessageById: Map<string, Message>;
  roomCostTotal?: RoomAICostTotal;
}

export class CodeAgentSessionService {
  private readonly activeTurns = new Map<string, ActiveCodeAgentTurn>();
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly store: RoomStore,
    private readonly emitter: CodeAgentRoomEmitter,
    private readonly sandboxLifecycle: CodeAgentSandboxLifecycleService,
    private readonly sandboxService: CodeAgentSandboxService,
    private readonly runner: CodeAgentRunner,
    private readonly logger: Logger,
    private readonly options: CodeAgentSessionServiceOptions
  ) {
    this.now = options.now || (() => new Date());
    this.createId = options.createId || (() => uuidv4());
  }

  async startTurn(input: CodeAgentTurnInput, callback?: CodeAgentTurnAckCallback): Promise<CodeAgentTurnAck> {
    let callbackSent = false;
    const ack = (response: CodeAgentTurnAck) => {
      if (!callbackSent) {
        callbackSent = true;
        callback?.(response);
      }
      return response;
    };

    const turnStartedAtMs = this.now().getTime();
    const rejectTurn = async (error: string, payload: Record<string, unknown> = {}) => {
      await this.recordObservabilityEvent({
        level: 'warn',
        event: 'code_agent.turn.rejected',
        roomId: input.roomId,
        clientId: input.clientId,
        provider: input.selectedModel.provider,
        model: input.selectedModel.id,
        errorMessage: error,
        payload,
      });
      return ack({ success: false, error });
    };

    if (!this.options.enabled) {
      return rejectTurn('Workspace is disabled', { reason: 'disabled' });
    }
    if (this.options.allowedClientIds?.length && !this.options.allowedClientIds.includes(input.clientId)) {
      return rejectTurn('Workspace is not enabled for this user', { reason: 'not_allowed' });
    }

    const room = await this.store.getRoomById(input.roomId);
    const member = room ? await this.store.getRoomMember(input.roomId, input.clientId) : null;
    const validation = this.validateRoom(room, input.clientId, member?.role);
    if (!validation.success) {
      return rejectTurn(validation.error || 'code-agent turn rejected', { reason: 'room_validation_failed' });
    }

    if (this.activeTurns.has(input.roomId)) {
      return rejectTurn('An agent task is already running in this workspace', { reason: 'room_already_running' });
    }

    const turnMode = this.resolveTurnMode(input.requestedMode ?? room!.codeAgentMode, input.requestedModeSource);
    if (!turnMode.ok) {
      return rejectTurn(turnMode.error, { reason: 'mode_rejected', requestedMode: input.requestedMode ?? room!.codeAgentMode });
    }
    const turnBackend = this.resolveTurnBackend(room!);
    const backendValidation = this.validateTurnBackend(turnBackend);
    if (!backendValidation.ok) {
      return rejectTurn(backendValidation.error, { reason: 'backend_rejected', backend: turnBackend });
    }
    const codexRunSettings = normalizeCodexRunSettings(
      input.codexRunSettings?.model,
      input.codexRunSettings?.reasoningEffort,
      input.codexRunSettings?.permissionMode,
      input.codexRunSettings?.serviceTier
    );

    let aiMessageId = '';
    let turnId = '';
    let aiMessage: Message | null = null;
    let runnerProcess: CodeAgentRunnerProcess | null = null;
    let turnSandbox: CodeAgentSandboxHandle | null = null;
    let placeholderAnnounced = false;
    let roomMarkedRunning = false;
    let streamState: CodeAgentTurnStreamState | null = null;
    let turnRecord: RoomAgentTurn | null = null;

    try {
      aiMessageId = this.createId();
      turnId = this.createId();
      this.activeTurns.set(input.roomId, {
        roomId: input.roomId,
        clientId: input.clientId,
        turnId,
        backend: turnBackend,
      });
      const placeholderMessage = createAIPlaceholderMessage({
          id: aiMessageId,
          roomId: input.roomId,
          roleName: this.displayBackendName(turnBackend),
          model: input.selectedModel,
          now: this.now(),
      });
      placeholderMessage.aiModel = this.messageAIModelForBackend(turnBackend, input.selectedModel, codexRunSettings);
      aiMessage = withAIStreamRecoveryMetadata({
        ...placeholderMessage,
        turnId,
        codeAgentMode: turnMode.mode,
      }, this.options.aiStreamOwnerId);

      const promptContext = await this.readLatestPromptContext(input.roomId, input.clientId, input.maxContextMessages);
      if (!promptContext) {
        await this.recordTurnEvent('warn', 'code_agent.turn.rejected', input, turnId, turnStartedAtMs, {
          errorMessage: 'Workspace requires a text prompt in the room history',
          payload: { reason: 'missing_prompt', mode: turnMode.mode },
        });
        return ack({ success: false, error: 'Workspace requires a text prompt in the room history' });
      }

      await this.recordTurnEvent('info', 'code_agent.turn.started', input, turnId, turnStartedAtMs, {
        payload: {
          backend: turnBackend,
          mode: turnMode.mode,
          promptLength: promptContext.prompt.length,
          priorMessageCount: promptContext.priorMessages.length,
          maxContextMessages: input.maxContextMessages,
          usesModelGateway: Boolean(this.options.modelGateway),
          previousSessionId: room!.codeAgentSessionId || null,
          codexRunSettings: isCodexBackend(turnBackend) ? codexRunSettings : undefined,
        },
      });

      const sandbox = await this.sandboxLifecycle.ensureReadySandbox(input.roomId, input.clientId);
      if (!sandbox.ok) {
        const error = this.describeSandboxFailure(sandbox);
        await this.recordTurnEvent('warn', 'code_agent.sandbox.ensure_failed', input, turnId, turnStartedAtMs, {
          errorCode: sandbox.reason,
          errorMessage: error,
          payload: {
            reason: sandbox.reason,
            sandboxStatus: sandbox.room?.sandboxStatus,
            sandboxId: sandbox.room?.sandboxId,
          },
        });
        return ack({ success: false, error });
      }
      await this.recordTurnEvent('info', 'code_agent.sandbox.ensure', input, turnId, turnStartedAtMs, {
        payload: {
          backend: turnBackend,
          sandboxId: sandbox.handle.id,
          sandboxProvider: sandbox.handle.provider,
          sandboxCreated: sandbox.created,
          workspace: sandbox.handle.workspace,
        },
      });
      turnSandbox = await this.sandboxLifecycle.extendSandboxForActiveTurn(sandbox.handle);
      const activeTurn = this.activeTurns.get(input.roomId);
      if (activeTurn) {
        activeTurn.sandbox = turnSandbox;
      }

      const runningRoom = await this.patchRoom(input.roomId, { codeAgentStatus: 'running' });
      if (!runningRoom) {
        await this.recordTurnEvent('error', 'code_agent.turn.failed', input, turnId, turnStartedAtMs, {
          errorCode: 'mark_running_failed',
          errorMessage: 'Unable to mark Workspace room as running',
        });
        return ack({ success: false, error: 'Unable to mark Workspace room as running' });
      }
      roomMarkedRunning = true;
      this.emitter.to(runningRoom.creatorId).emit('room_updated', runningRoom);

      const placeholderRoom = await this.store.upsertMessage(aiMessage);
      if (!placeholderRoom) {
        const errorRoom = await this.patchRoom(input.roomId, { codeAgentStatus: 'error' });
        if (errorRoom) {
          this.emitter.to(errorRoom.creatorId).emit('room_updated', errorRoom);
        }
        await this.recordTurnEvent('error', 'code_agent.turn.failed', input, turnId, turnStartedAtMs, {
          errorCode: 'placeholder_persist_failed',
          errorMessage: 'Unable to start a durable agent response',
        });
        return ack({ success: false, error: 'Unable to start a durable agent response' });
      }
      this.emitter.to(placeholderRoom.creatorId).emit('room_updated', placeholderRoom);
      const turnStartedAt = new Date(turnStartedAtMs).toISOString();
      turnRecord = await this.publishRoomAgentTurn({
        id: turnId,
        roomId: input.roomId,
        status: 'running',
        startedAt: turnStartedAt,
        backend: turnBackend,
        assistantName: this.displayBackendName(turnBackend),
        updatedAt: turnStartedAt,
      });
      this.emitter.to(input.roomId).emit('new_message', stripAIStreamRecoveryMetadata(aiMessage));
      placeholderAnnounced = true;
      ack({ success: true, messageId: aiMessageId });

      streamState = {
        activeMessageId: aiMessageId,
        lastMessageId: aiMessageId,
        segmentContent: '',
        fullContent: '',
        segmentHasUnsealedText: false,
        needsNewSegment: false,
        segmentIds: [aiMessageId],
        nonEmptySegmentIds: new Set(),
        pendingToolCalls: new Map(),
        modelSteps: new Map(),
        modelStepIdByToolCallId: new Map(),
        completedAIMessageById: new Map(),
      };
      const runnerEnv = {
        ...this.buildRunnerEnv(input.selectedModel, {
          roomId: input.roomId,
          clientId: input.clientId,
          turnId,
          backend: turnBackend,
          mode: turnMode.mode,
          clientOrigin: input.clientOrigin,
          serverOrigin: input.serverOrigin,
        }),
        ...(this.options.runnerEnvByBackend?.[turnBackend] || {}),
      };
      const runnerRequest: CodeAgentRunnerRunRequest = {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'run',
        roomId: input.roomId,
        clientId: input.clientId,
        turnId,
        sessionId: room!.codeAgentSessionId || null,
        prompt: promptContext.prompt,
        priorMessages: promptContext.priorMessages,
        mode: turnMode.mode,
        provider: input.selectedModel.provider,
        modelId: input.selectedModel.id,
        apiModel: input.selectedModel.apiModel,
        ...(isCodexBackend(turnBackend)
          ? {
              codexModel: codexRunSettings.model,
              codexReasoningEffort: codexRunSettings.reasoningEffort,
              codexPermissionMode: codexRunSettings.permissionMode,
              codexServiceTier: codexRunSettings.serviceTier,
            }
          : {}),
        workspace: turnSandbox.workspace,
        allowedPaths: this.options.allowedPaths || ['.'],
      };
      const startRunnerProcess = async (env: Record<string, string>) => {
        const command = this.runnerCommandForBackend(turnBackend);
        if (this.options.runnerClient === 'daemon') {
          runnerProcess = await this.startDaemonProcess(turnSandbox!, env);
        } else {
          runnerProcess = await this.sandboxService.startRunner({
            handle: turnSandbox!,
            command,
            env,
            timeoutMs: 0,
          });
        }
        const active = this.activeTurns.get(input.roomId);
        if (active?.turnId === turnId) {
          active.process = runnerProcess;
          active.sandbox = turnSandbox!;
        }
        await this.recordTurnEvent('info', 'code_agent.runner.started', input, turnId, turnStartedAtMs, {
          payload: {
            backend: turnBackend,
            sandboxId: turnSandbox!.id,
            command: runnerProcess.command,
            mode: turnMode.mode,
            runnerClient: this.options.runnerClient || 'jsonl',
          },
        });
        return runnerProcess;
      };
      const runnerHandlers = {
        onEvent: async (event: CodeAgentRunnerEvent) => {
          await this.handleRunnerEvent(event, input.roomId, turnId, aiMessage!, input.selectedModel, streamState!, turnBackend, codexRunSettings);
        },
      };
      const runResult = await this.runRunnerWithBackendAuth({
        backend: turnBackend,
        clientId: input.clientId,
        turnId,
        runnerEnv,
        request: runnerRequest,
        handlers: runnerHandlers,
        sandbox: turnSandbox,
        startRunnerProcess,
      });

      if (runResult.errorEvent) {
        throw new Error(runResult.errorEvent.message);
      }
      if (!runResult.finalEvent) {
        throw new Error('code agent runner exited without a final event');
      }

      // An interrupted Codex turn can still arrive as a terminal `final` event.
      // Close any tool calls that never received a result so clients do not
      // render them as running forever after the turn has ended.
      await this.flushInterruptedToolCalls(
        input.roomId,
        turnId,
        streamState,
        new Error('agent turn ended before tool completion'),
        aiMessage,
        turnBackend
      );

      if (turnBackend !== 'code-agent' && streamState.needsNewSegment) {
        await this.sealCurrentSegment(input.roomId, aiMessage, streamState);
      }

      const answer = streamState.segmentContent || streamState.fullContent;
      const usage = runResult.finalEvent.usage;
      if (turnBackend === 'code-agent' && usage?.source !== 'reported') {
        throw new Error('Coco runner completed without provider-reported usage');
      }
      const completionMetadata = this.completionMetadataForBackend(turnBackend, input.selectedModel, codexRunSettings, usage);
      let turnUsage = completionMetadata.usage;
      let turnCost = completionMetadata.cost;
      if (turnBackend === 'code-agent') {
        const uncommittedStep = Array.from(streamState.modelSteps.values()).find(step => !step.costCommitted);
        if (uncommittedStep) {
          throw new Error(`Coco model-step cost was not committed: ${uncommittedStep.stepId}`);
        }
        const stepSummary = summarizeCocoModelStepCosts(Array.from(streamState.modelSteps.values()), usage!);
        turnUsage = stepSummary.usage;
        turnCost = stepSummary.cost;
      }

      const finalActiveId = streamState.activeMessageId;
      const hasVisibleText = streamState.nonEmptySegmentIds.size > 0;
      let finalMessage: Message | null = null;
      let finalRoom: Room | null = null;
      if (hasVisibleText) {
        if (turnBackend === 'code-agent') {
          finalMessage = streamState.completedAIMessageById.get(finalActiveId) || null;
          if (!finalMessage) {
            throw new Error(`Coco final AI segment has no model-step accounting: ${finalActiveId}`);
          }
        } else {
          finalMessage = {
            ...aiMessage,
            id: finalActiveId,
            content: answer,
            status: 'complete',
            timestamp: this.now().toISOString(),
            aiModel: completionMetadata.aiModel,
            usage: completionMetadata.usage,
            cost: completionMetadata.cost,
          };
          finalRoom = await this.store.upsertMessage(finalMessage);
          if (!finalRoom) {
            throw new Error('Unable to save the completed agent response');
          }
        }
      } else {
        const deleteResult = await this.store.deleteMessageById(input.roomId, aiMessageId).catch(err => {
          this.logger.warn('Failed to clean up empty code-agent placeholder', { error: err, roomId: input.roomId, messageId: aiMessageId });
          return null;
        });
        if (deleteResult) {
          this.emitter.to(input.roomId).emit('message_deleted', aiMessageId, input.roomId);
        }
      }

      // Clean up unused initial placeholder if streaming moved to a new segment
      if (hasVisibleText && finalActiveId !== aiMessageId) {
        const firstSegmentUsed = streamState.nonEmptySegmentIds.has(aiMessageId);
        if (!firstSegmentUsed) {
          await this.store.deleteMessageById(input.roomId, aiMessageId).catch(err => {
            this.logger.warn('Failed to clean up unused code-agent placeholder', { error: err, roomId: input.roomId, messageId: aiMessageId });
          });
          this.emitter.to(input.roomId).emit('message_deleted', aiMessageId, input.roomId);
        }
      }

      const roomCostTotal = turnBackend === 'code-agent'
        ? streamState.roomCostTotal || await this.store.readRoomAICost(input.roomId)
        : await this.store.incrementRoomAICost(input.roomId, turnCost || null);

      const idleRoom = await this.patchRoom(input.roomId, {
        codeAgentStatus: 'idle',
        codeAgentSessionId: runResult.finalEvent.sessionId,
      });
      if (runnerProcess) {
        await this.stopRunnerProcess(runnerProcess, input.roomId);
        runnerProcess = null;
      }
      const turnCompletedAt = this.now().toISOString();
      if (turnRecord) {
        turnRecord = await this.publishRoomAgentTurn({
          ...turnRecord,
          status: 'complete',
          completedAt: turnCompletedAt,
          finalMessageId: finalMessage?.id || streamState.lastMessageId,
          updatedAt: turnCompletedAt,
        });
      }
      this.activeTurns.delete(input.roomId);
      if (finalMessage) {
        this.emitter.to(input.roomId).emit('ai_stream_end', {
          messageId: finalActiveId,
          roomId: input.roomId,
          content: finalMessage.content,
          aiModel: finalMessage.aiModel,
          usage: finalMessage.usage,
          cost: finalMessage.cost,
          sessionCost: roomCostTotal,
        });
      }
      this.emitter.to(input.roomId).emit('ai_cost_total', roomCostTotal);
      const roomForUpdate = idleRoom || finalRoom;
      if (roomForUpdate) {
        this.emitter.to(roomForUpdate.creatorId).emit('room_updated', roomForUpdate);
      }
      await this.recordTurnEvent('info', 'code_agent.turn.completed', input, turnId, turnStartedAtMs, {
        sessionId: runResult.finalEvent.sessionId,
        provider: isCodexBackend(turnBackend) ? 'codex' : input.selectedModel.provider,
        model: isCodexBackend(turnBackend) ? codexRunSettings.model : input.selectedModel.id,
        costUsd: turnCost?.totalUsd,
        payload: {
          backend: turnBackend,
          messageId: finalActiveId,
          initialMessageId: aiMessageId,
          sessionId: runResult.finalEvent.sessionId,
          segmentCount: streamState.segmentIds.length,
          answerLength: answer.length,
          roomCostTotalUsd: roomCostTotal.totalUsd,
          codexRunSettings: isCodexBackend(turnBackend) ? codexRunSettings : undefined,
          usage: turnUsage,
          cost: turnCost,
        },
      });
      return { success: true, messageId: aiMessageId };
    } catch (error) {
      const errorTargetId = streamState?.activeMessageId || aiMessageId;
      this.logger.error('Code agent turn failed', { error, roomId: input.roomId, messageId: errorTargetId, backend: turnBackend });
      await this.recordTurnEvent('error', 'code_agent.turn.failed', input, turnId, turnStartedAtMs, {
        errorCode: 'turn_failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        payload: {
          backend: turnBackend,
          messageId: errorTargetId,
          placeholderAnnounced,
          roomMarkedRunning,
        },
      });
      if (placeholderAnnounced && aiMessage) {
        if (streamState) {
          await this.flushInterruptedToolCalls(input.roomId, turnId, streamState, error, aiMessage, turnBackend);
        }
        const errorTargetMessage = streamState?.completedAIMessageById.get(errorTargetId) || { ...aiMessage, id: errorTargetId };
        await this.saveCodeAgentError(input.roomId, errorTargetMessage, error, turnBackend);
        if (turnRecord) {
          const turnCompletedAt = this.now().toISOString();
          turnRecord = await this.publishRoomAgentTurn({
            ...turnRecord,
            status: 'error',
            completedAt: turnCompletedAt,
            finalMessageId: errorTargetId,
            updatedAt: turnCompletedAt,
          });
        }
      } else if (roomMarkedRunning) {
        const errorRoom = await this.patchRoom(input.roomId, { codeAgentStatus: 'error' });
        if (errorRoom) {
          this.emitter.to(errorRoom.creatorId).emit('room_updated', errorRoom);
        }
      }
      if (!callbackSent) {
        ack({ success: false, error: `${this.displayBackendName(turnBackend)} task failed` });
      }
      return { success: false, messageId: aiMessageId || undefined, error: `${this.displayBackendName(turnBackend)} task failed` };
    } finally {
      if (runnerProcess) {
        await this.stopRunnerProcess(runnerProcess, input.roomId);
      }
      if (turnSandbox) {
        await this.sandboxLifecycle.shortenSandboxAfterTurn(turnSandbox);
      }
      this.activeTurns.delete(input.roomId);
    }
  }

  async interruptTurn(roomId: string, clientId: string, reason?: string): Promise<CodeAgentControlAck> {
    const active = this.activeTurns.get(roomId);
    if (!active) {
      return { success: false, error: 'No agent turn is running in this workspace' };
    }
    if (active.clientId !== clientId) {
      this.logger.info('Code agent interrupt requested by another room member', { roomId, startedBy: active.clientId, requestedBy: clientId });
    }
    if (active.backend === 'code-agent' || active.backend === 'codex-app-server') {
      return this.writeActiveControl(roomId, {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'interrupt',
        turnId: active.turnId,
        ...(reason ? { reason } : {}),
      });
    }
    if (active.backend === 'codex') {
      if (active.process) {
        await this.stopRunnerProcess(active.process, roomId);
        return { success: true };
      }
      return { success: false, error: 'The current engine does not support interactive interrupt yet' };
    }
    return { success: false, error: 'The current engine does not support interactive interrupt yet' };
  }

  async steerTurn(roomId: string, clientId: string, prompt: string): Promise<CodeAgentControlAck> {
    const active = this.activeTurns.get(roomId);
    if (!active) {
      return { success: false, error: 'No agent turn is running in this workspace' };
    }
    if (active.backend !== 'code-agent' && active.backend !== 'codex-app-server') {
      return { success: false, error: 'The current engine does not support turn steering' };
    }
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return { success: false, error: 'Steer prompt is required' };
    }
    if (active.clientId !== clientId) {
      this.logger.info('Code agent steer requested by another room member', { roomId, startedBy: active.clientId, requestedBy: clientId });
    }
    return this.writeActiveControl(roomId, {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'steer',
      turnId: active.turnId,
      prompt: trimmedPrompt,
    });
  }

  async respondToApproval(
    roomId: string,
    clientId: string,
    approvalId: string,
    decision: CodeAgentRunnerApprovalDecision
  ): Promise<CodeAgentControlAck> {
    const active = this.activeTurns.get(roomId);
    if (!active) {
      return { success: false, error: 'No agent turn is running in this workspace' };
    }
    if (active.backend !== 'codex-app-server') {
      return { success: false, error: 'Interactive approval requires the Codex engine' };
    }
    if (active.clientId !== clientId) {
      this.logger.info('Code agent approval response from another room member', { roomId, startedBy: active.clientId, requestedBy: clientId, approvalId });
    }
    return this.writeActiveControl(roomId, {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'approval_response',
      turnId: active.turnId,
      approvalId,
      decision,
    });
  }

  async listCodexThreads(input: {
    roomId: string;
    clientId: string;
    cursor?: string | null;
    limit?: number;
    searchTerm?: string;
  }): Promise<CodeAgentThreadListResult> {
    const prepared = await this.prepareCodexThreadQuery(input.roomId, input.clientId);
    const request: CodeAgentRunnerThreadListRequest = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'thread_list',
      roomId: input.roomId,
      clientId: input.clientId,
      workspace: prepared.sandbox.workspace,
      cursor: input.cursor || null,
      limit: input.limit,
      searchTerm: input.searchTerm,
    };
    const event = await this.runCodexThreadQuery<CodeAgentRunnerThreadListResultEvent>({
      clientId: input.clientId,
      sandbox: prepared.sandbox,
      request,
      expectedType: 'thread_list_result',
    });
    return {
      threads: event.threads,
      nextCursor: event.nextCursor,
      backwardsCursor: event.backwardsCursor,
    };
  }

  async readCodexThread(input: {
    roomId: string;
    clientId: string;
    threadId: string;
    includeTurns?: boolean;
  }): Promise<CodeAgentThreadReadResult> {
    const prepared = await this.prepareCodexThreadQuery(input.roomId, input.clientId);
    const request: CodeAgentRunnerThreadReadRequest = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'thread_read',
      roomId: input.roomId,
      clientId: input.clientId,
      workspace: prepared.sandbox.workspace,
      threadId: input.threadId,
      includeTurns: input.includeTurns,
    };
    const event = await this.runCodexThreadQuery<CodeAgentRunnerThreadReadResultEvent>({
      clientId: input.clientId,
      sandbox: prepared.sandbox,
      request,
      expectedType: 'thread_read_result',
    });
    return { thread: event.thread };
  }

  private async stopRunnerProcess(runnerProcess: CodeAgentRunnerProcess, roomId: string) {
    await runnerProcess.stop().catch(error => {
      this.logger.warn('Failed to stop code agent runner process', { error, roomId });
    });
  }

  private async writeActiveControl(
    roomId: string,
    request: Parameters<typeof writeCodeAgentRunnerRequest>[1]
  ): Promise<CodeAgentControlAck> {
    const active = this.activeTurns.get(roomId);
    const stdin = active?.process?.stdin;
    if (!active || !stdin) {
      return { success: false, error: 'The running agent is not ready for control input' };
    }
    try {
      await writeCodeAgentRunnerRequest(stdin, request);
      return { success: true };
    } catch (error) {
      this.logger.warn('Failed to write code agent control request', {
        error,
        roomId,
        turnId: active.turnId,
        requestType: request.type,
      });
      return { success: false, error: 'Failed to send control request to the running agent' };
    }
  }

  private async prepareCodexThreadQuery(roomId: string, clientId: string): Promise<{ room: Room; sandbox: CodeAgentSandboxHandle }> {
    if (this.activeTurns.has(roomId)) {
      throw new Error('Codex thread browser is available after the current turn finishes');
    }
    const room = await this.store.getRoomById(roomId);
    const member = room ? await this.store.getRoomMember(roomId, clientId) : null;
    const validation = this.validateRoom(room, clientId, member?.role);
    if (!validation.success || !room) {
      throw new Error(validation.error || 'Room not found');
    }
    const backend = this.resolveTurnBackend(room);
    if (backend !== 'codex-app-server') {
      throw new Error('Codex thread browser requires the Codex engine');
    }
    const sandbox = await this.sandboxLifecycle.ensureReadySandbox(roomId, clientId);
    if (!sandbox.ok) {
      throw new Error(this.describeSandboxFailure(sandbox));
    }
    return { room, sandbox: sandbox.handle };
  }

  private async runCodexThreadQuery<T extends CodeAgentRunnerThreadListResultEvent | CodeAgentRunnerThreadReadResultEvent>(input: {
    clientId: string;
    sandbox: CodeAgentSandboxHandle;
    request: CodeAgentRunnerThreadListRequest | CodeAgentRunnerThreadReadRequest;
    expectedType: T['type'];
  }): Promise<T> {
    if (this.options.codexBackendEnabled === false) {
      throw new Error('Codex CLI backend is not enabled');
    }
    const connectionService = this.options.codexConnectionService;
    if (!connectionService) {
      throw new Error('Codex connection service is not configured');
    }
    if (!this.sandboxService.writeSecretFile || !this.sandboxService.deleteSecretFile) {
      throw new Error('Codex backend requires sandbox secret file support');
    }

    const queryId = this.createId();
    return connectionService.withCodexAuth(input.clientId, queryId, async authJson => {
      const authPath = this.codexSecretFilePath(queryId, 'auth.json');
      const refreshedAuthPath = this.codexSecretFilePath(queryId, 'refreshed-auth.json');
      await this.sandboxService.writeSecretFile!(input.sandbox, {
        path: authPath,
        content: authJson,
      });

      let refreshedAuthJson: string | undefined;
      try {
        const runnerEnv = {
          PYTHONUNBUFFERED: '1',
          ...(this.options.runnerEnv || {}),
          ...(this.options.runnerEnvByBackend?.['codex-app-server'] || {}),
          ROOMTALK_CODEX_AUTH_JSON_PATH: authPath,
          ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH: refreshedAuthPath,
        };
        const runnerProcess = this.options.runnerClient === 'daemon'
          ? await this.startDaemonProcess(input.sandbox, runnerEnv)
          : await this.sandboxService.startRunner({
              handle: input.sandbox,
              command: DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
              env: runnerEnv,
              timeoutMs: 0,
            });
        try {
          const result = this.options.runnerClient === 'daemon'
            ? await this.collectCodexDaemonThreadQueryResult<T>(runnerProcess, input.request, input.expectedType, runnerEnv)
            : await this.collectCodexThreadQueryResult<T>(runnerProcess, input.request, input.expectedType);
          refreshedAuthJson = await this.readOptionalCodexRefreshedAuth(input.sandbox, refreshedAuthPath);
          return {
            result,
            ...(refreshedAuthJson ? { refreshedAuthJson } : {}),
          };
        } finally {
          if (this.options.runnerClient !== 'daemon') {
            await this.stopRunnerProcess(runnerProcess, input.request.roomId);
          }
        }
      } finally {
        await Promise.all([
          this.deleteCodexSecretFile(input.sandbox, authPath),
          this.deleteCodexSecretFile(input.sandbox, refreshedAuthPath),
        ]);
      }
    });
  }

  private async startDaemonProcess(
    sandbox: CodeAgentSandboxHandle,
    env: Record<string, string>
  ): Promise<CodeAgentRunnerProcess> {
    if (!this.options.daemonRegistry) {
      throw new Error('Daemon process registry is not configured');
    }
    return this.options.daemonRegistry.ensure({
      handle: sandbox,
      command: this.daemonCommand(),
      env,
      start: daemonEnv => this.sandboxService.startRunner({
        handle: sandbox,
        command: this.daemonCommand(),
        env: daemonEnv,
        timeoutMs: 0,
      }),
    });
  }

  private async collectCodexDaemonThreadQueryResult<T extends CodeAgentRunnerThreadListResultEvent | CodeAgentRunnerThreadReadResultEvent>(
    runnerProcess: CodeAgentRunnerProcess,
    request: CodeAgentRunnerThreadListRequest | CodeAgentRunnerThreadReadRequest,
    expectedType: T['type'],
    runnerEnv: Record<string, string>
  ): Promise<T> {
    if (!this.options.daemonRunnerClient) {
      throw new Error('Daemon runner client is not configured');
    }
    return this.options.daemonRunnerClient.query<T>(runnerProcess, request, expectedType, runnerEnv);
  }

  private async collectCodexThreadQueryResult<T extends CodeAgentRunnerThreadListResultEvent | CodeAgentRunnerThreadReadResultEvent>(
    runnerProcess: CodeAgentRunnerProcess,
    request: CodeAgentRunnerThreadListRequest | CodeAgentRunnerThreadReadRequest,
    expectedType: T['type']
  ): Promise<T> {
    if (!runnerProcess.stdin || !runnerProcess.stdout || !runnerProcess.completed) {
      throw new Error('Codex thread browser requires a runner process with stdin, stdout, and completion');
    }
    await writeCodeAgentRunnerRequest(runnerProcess.stdin, request);
    const parser = new CodeAgentRunnerJsonlParser();
    let result: T | undefined;
    for await (const chunk of runnerProcess.stdout) {
      for (const event of parser.push(bufferToString(chunk))) {
        if (event.type === 'error') {
          throw new Error(event.message);
        }
        if (event.type === expectedType) {
          result = event as T;
        }
      }
    }
    for (const event of parser.flush()) {
      if (event.type === 'error') {
        throw new Error(event.message);
      }
      if (event.type === expectedType) {
        result = event as T;
      }
    }
    const completed = await runnerProcess.completed;
    if (completed.exitCode !== 0) {
      throw new Error(`Codex thread browser exited with code ${completed.exitCode ?? 'null'}`);
    }
    if (!result) {
      throw new Error('Codex thread browser did not return a result');
    }
    return result;
  }

  private async runRunnerWithBackendAuth(input: {
    backend: CodeAgentBackend;
    clientId: string;
    turnId: string;
    runnerEnv: Record<string, string>;
    request: CodeAgentRunnerRunRequest;
    handlers: CodeAgentRunnerHandlers;
    sandbox: CodeAgentSandboxHandle;
    startRunnerProcess: (env: Record<string, string>) => Promise<CodeAgentRunnerProcess>;
  }): Promise<CodeAgentRunnerRunResult> {
    if (!isCodexBackend(input.backend)) {
      const process = await input.startRunnerProcess(input.runnerEnv);
      return this.runner.run(input.request, input.handlers, {
        process,
        sandbox: input.sandbox,
        backend: input.backend,
        runnerEnv: input.runnerEnv,
      });
    }
    if (this.options.codexBackendEnabled === false) {
      throw new Error('Codex CLI backend is not enabled');
    }

    const connectionService = this.options.codexConnectionService;
    if (!connectionService) {
      throw new Error('Codex connection service is not configured');
    }
    if (!this.sandboxService.writeSecretFile || !this.sandboxService.deleteSecretFile) {
      throw new Error('Codex backend requires sandbox secret file support');
    }

    return connectionService.withCodexAuth(input.clientId, input.turnId, async authJson => {
      const authPath = this.codexSecretFilePath(input.turnId, 'auth.json');
      const refreshedAuthPath = this.codexSecretFilePath(input.turnId, 'refreshed-auth.json');
      await this.sandboxService.writeSecretFile!(input.sandbox, {
        path: authPath,
        content: authJson,
      });

      let refreshedAuthJson: string | undefined;
      try {
        const effectiveRunnerEnv = {
          ...input.runnerEnv,
          ROOMTALK_CODEX_AUTH_JSON_PATH: authPath,
          ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH: refreshedAuthPath,
        };
        const process = await input.startRunnerProcess(effectiveRunnerEnv);
        const result = await this.runner.run(input.request, input.handlers, {
          process,
          sandbox: input.sandbox,
          backend: input.backend,
          runnerEnv: effectiveRunnerEnv,
        });
        refreshedAuthJson = await this.readOptionalCodexRefreshedAuth(input.sandbox, refreshedAuthPath);
        return {
          result,
          ...(refreshedAuthJson ? { refreshedAuthJson } : {}),
        };
      } finally {
        await Promise.all([
          this.deleteCodexSecretFile(input.sandbox, authPath),
          this.deleteCodexSecretFile(input.sandbox, refreshedAuthPath),
        ]);
      }
    });
  }

  private async readOptionalCodexRefreshedAuth(sandbox: CodeAgentSandboxHandle, path: string): Promise<string | undefined> {
    if (!this.sandboxService.readSecretFile) {
      return undefined;
    }
    try {
      const value = await this.sandboxService.readSecretFile(sandbox, path, { maxBytes: 1024 * 1024 });
      return value.trim() ? value : undefined;
    } catch (error) {
      this.logger.warn('Codex runner did not provide refreshed auth JSON', {
        error,
        sandboxId: sandbox.id,
      });
      return undefined;
    }
  }

  private async deleteCodexSecretFile(sandbox: CodeAgentSandboxHandle, path: string): Promise<void> {
    await this.sandboxService.deleteSecretFile?.(sandbox, path).catch(error => {
      this.logger.warn('Failed to delete Codex sandbox secret file', {
        error,
        sandboxId: sandbox.id,
      });
    });
  }

  private codexSecretFilePath(turnId: string, suffix: string): string {
    const safeTurnId = turnId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeSuffix = suffix.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `/tmp/roomtalk-codex/${safeTurnId}-${safeSuffix}`;
  }

  private validateRoom(room: Room | null, clientId: string, memberRole?: RoomMemberRole): CodeAgentTurnAck {
    if (!room) {
      return { success: false, error: 'Room not found' };
    }
    if (room.type !== 'codeAgent') {
      return { success: false, error: 'Room is not a Workspace room' };
    }
    if (!canUseCodeAgentRoom(room, clientId, memberRole)) {
      return { success: false, error: CODE_AGENT_ACCESS_DENIED_MESSAGE };
    }
    return { success: true };
  }

  private resolveTurnMode(
    requestedMode?: unknown,
    source?: 'originalTurn',
  ): { ok: true; mode: CodeAgentRunnerMode } | { ok: false; error: string } {
    const availableModes = this.availableModes();
    const defaultMode = this.defaultMode(availableModes);
    if (!requestedMode) {
      return { ok: true, mode: defaultMode };
    }
    const normalizedMode = normalizeCodeAgentMode(requestedMode);
    if (!normalizedMode) {
      return { ok: false, error: `Agent mode is not enabled: ${requestedMode}` };
    }
    if (availableModes.includes(normalizedMode)) {
      return { ok: true, mode: normalizedMode };
    }
    if (normalizedMode === 'edit') {
      if (source === 'originalTurn') {
        return { ok: false, error: 'This response was originally run in Edit mode, but Edit mode is no longer available.' };
      }
      return { ok: false, error: 'Agent edit mode is not enabled' };
    }
    return { ok: false, error: `Agent mode is not enabled: ${normalizedMode}` };
  }

  private resolveTurnBackend(room: Room): CodeAgentBackend {
    if (room.codeAgentBackend) {
      return room.codeAgentBackend;
    }
    if ((room.type as string | undefined) === 'codex') {
      return 'codex-app-server';
    }
    return this.options.backend || this.runner.backend || 'code-agent';
  }

  private validateTurnBackend(backend: CodeAgentBackend): { ok: true } | { ok: false; error: string } {
    if (isCodexBackend(backend) && this.options.codexBackendEnabled === false) {
      return { ok: false, error: 'Codex CLI backend is not enabled' };
    }
    return { ok: true };
  }

  private displayBackendName(backend: CodeAgentBackend): string {
    return isCodexBackend(backend) ? 'Codex' : 'Coco';
  }

  private messageAIModelForBackend(
    backend: CodeAgentBackend,
    selectedModel: AIModelOption,
    codexRunSettings: CodexRunSettings
  ): Message['aiModel'] {
    if (isCodexBackend(backend)) {
      return getCodexMessageAIModel(codexRunSettings);
    }
    return getMessageAIModel(selectedModel);
  }

  private completionMetadataForBackend(
    backend: CodeAgentBackend,
    selectedModel: AIModelOption,
    codexRunSettings: CodexRunSettings,
    usage?: Message['usage']
  ): Pick<Message, 'aiModel' | 'usage' | 'cost'> {
    const aiModel = this.messageAIModelForBackend(backend, selectedModel, codexRunSettings);
    if (isCodexBackend(backend)) {
      return { aiModel, usage };
    }
    const cost = usage ? calculateAICost(selectedModel, usage) : undefined;
    return { aiModel, usage, cost };
  }

  private runnerCommandForBackend(backend: CodeAgentBackend): string {
    const command = this.options.runnerCommandByBackend?.[backend];
    if (command) {
      return command;
    }
    const defaultBackend = this.options.backend || this.runner.backend || 'code-agent';
    if (backend === defaultBackend && this.options.runnerCommand) {
      return this.options.runnerCommand;
    }
    if (backend === 'codex') {
      return DEFAULT_CODEX_CLI_RUNNER_COMMAND;
    }
    if (backend === 'codex-app-server') {
      return DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND;
    }
    return DEFAULT_CODE_AGENT_RUNNER_COMMAND;
  }

  private daemonCommand(): string {
    return this.options.daemonCommand || DEFAULT_CODE_AGENT_DAEMON_COMMAND;
  }

  private availableModes(): CodeAgentRunnerMode[] {
    if (this.options.availableModes?.length) {
      return normalizeCodeAgentModeSet(this.options.availableModes);
    }
    return normalizeCodeAgentModeSet([this.options.mode || 'plan']);
  }

  private defaultMode(availableModes: CodeAgentRunnerMode[]): CodeAgentRunnerMode {
    const defaultMode = normalizeCodeAgentMode(this.options.defaultMode);
    if (defaultMode && availableModes.includes(defaultMode)) {
      return defaultMode;
    }
    const configuredMode = normalizeCodeAgentMode(this.options.mode);
    if (configuredMode && availableModes.includes(configuredMode)) {
      return configuredMode;
    }
    return 'plan';
  }

  private async readLatestPromptContext(roomId: string, clientId: string, maxContextMessages?: number) {
    const messages = await this.store.readMessagesByRoom(roomId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message.clientId === clientId &&
        message.messageType === 'text' &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0
      ) {
        const prior = messages.slice(0, index);
        const limited = maxContextMessages && maxContextMessages > 0
          ? prior.slice(-maxContextMessages)
          : prior;
        return {
          prompt: message.content.trim(),
          priorMessages: buildCodeAgentPriorMessages(limited),
        };
      }
    }
    return null;
  }

  private describeSandboxFailure(result: EnsureCodeAgentSandboxResult) {
    if (result.ok) {
      return '';
    }
    switch (result.reason) {
      case 'creating':
        return 'Workspace sandbox is still being prepared';
      case 'limit_exceeded':
        return 'Workspace sandbox limit exceeded';
      case 'forbidden':
        return 'You do not have access to this Workspace room';
      case 'not_code_agent_room':
        return 'Room is not a Workspace room';
      case 'missing_room':
        return 'Room not found';
      case 'store_conflict':
        return 'Unable to reserve a Workspace sandbox';
      case 'sandbox_error':
        return 'Unable to prepare a Workspace sandbox';
    }
  }

  private async handleRunnerEvent(
    event: CodeAgentRunnerEvent,
    roomId: string,
    turnId: string,
    baseAIMessage: Message,
    selectedModel: AIModelOption,
    state: CodeAgentTurnStreamState,
    backend: CodeAgentBackend,
    codexRunSettings: CodexRunSettings
  ) {
    await this.recordRunnerEvent(event, roomId, turnId, selectedModel, backend, codexRunSettings);
    if (event.type === 'usage') {
      this.emitter.to(roomId).emit('ai_usage_update', {
        messageId: state.activeMessageId,
        roomId,
        usage: event.usage,
      });
      return;
    }
    if (event.type === 'model_step') {
      if (backend !== 'code-agent') {
        throw new Error(`Unexpected model_step event from ${backend}`);
      }
      await this.handleCocoModelStep(event, roomId, turnId, baseAIMessage, selectedModel, state);
      return;
    }
    if (event.type === 'error') {
      await this.flushInterruptedToolCalls(roomId, turnId, state, event.message, baseAIMessage, backend);
    }
    const mapped = mapCodeAgentRunnerEvent(event, {
      roomId,
      turnId,
      username: this.displayBackendName(backend),
      now: this.now(),
      createMessageId: prefix => `${prefix}_${this.createId()}`,
    });

    if (mapped.kind === 'ai_delta') {
      if (state.needsNewSegment) {
        await this.sealCurrentSegment(roomId, baseAIMessage, state);
        const newId = this.createId();
        const segmentMessage: Message = {
          ...baseAIMessage,
          id: newId,
          content: '',
          status: 'streaming',
          timestamp: this.now().toISOString(),
          aiModel: this.messageAIModelForBackend(backend, selectedModel, codexRunSettings),
        };
        const segmentRoom = await this.store.appendMessageWithAtomicPosition(segmentMessage);
        if (!segmentRoom) {
          throw new Error('Unable to create new AI segment message');
        }
        this.emitter.to(segmentRoom.creatorId).emit('room_updated', segmentRoom);
        this.emitter.to(roomId).emit('new_message', stripAIStreamRecoveryMetadata(segmentMessage));
        state.activeMessageId = newId;
        state.lastMessageId = newId;
        state.segmentContent = '';
        state.segmentHasUnsealedText = false;
        state.needsNewSegment = false;
        state.segmentIds.push(newId);
      }
      state.segmentContent += mapped.delta;
      state.fullContent += mapped.delta;
      if (mapped.delta.length > 0) {
        state.segmentHasUnsealedText = true;
      }
      if (state.segmentContent.trim()) {
        state.nonEmptySegmentIds.add(state.activeMessageId);
      }
      this.emitter.to(roomId).emit('ai_chunk', { messageId: state.activeMessageId, chunk: mapped.delta, roomId });
      return;
    }

    if (mapped.kind === 'message') {
      if (mapped.message.messageType === 'tool_call') {
        state.needsNewSegment = true;
      }
      if (baseAIMessage.codeAgentMode) {
        mapped.message.codeAgentMode = baseAIMessage.codeAgentMode;
      }
      if (backend === 'code-agent' && (event.type === 'tool_call' || event.type === 'tool_result')) {
        const stepId = state.modelStepIdByToolCallId.get(event.id);
        const step = stepId ? state.modelSteps.get(stepId) : undefined;
        if (!stepId || !step) {
          throw new Error(`Coco tool event has no model-step accounting: ${event.id}`);
        }
        mapped.message.modelStepId = step.stepId;
        mapped.message.modelStepSequence = step.sequence;
        if (event.type === 'tool_call' && !step.anchorMessageId) {
          if (step.hasText || event.id !== step.toolCallIds[0]) {
            throw new Error(`Coco model step cannot anchor tool call ${event.id}: ${step.stepId}`);
          }
          mapped.message.aiModel = step.aiModel;
          mapped.message.usage = step.usage;
          mapped.message.cost = step.cost;
          step.anchorMessageId = mapped.message.id;
        }
      }

      const updatedRoom = await this.store.appendMessageWithAtomicPosition(mapped.message);
      if (!updatedRoom) {
        throw new Error(`Unable to persist agent ${mapped.message.messageType} event`);
      }
      if (event.type === 'tool_call') {
        state.pendingToolCalls.set(event.id, { name: event.name });
        if (backend === 'code-agent') {
          const stepId = state.modelStepIdByToolCallId.get(event.id)!;
          const step = state.modelSteps.get(stepId)!;
          if (step.anchorMessageId === mapped.message.id) {
            await this.commitCocoModelStepCost(roomId, state, step);
          }
        }
      } else if (event.type === 'tool_result') {
        state.pendingToolCalls.delete(event.id);
      }
      state.lastMessageId = mapped.message.id;
      this.emitter.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
      this.emitter.to(roomId).emit('new_message', mapped.message);
    }
  }

  private async handleCocoModelStep(
    event: CodeAgentRunnerModelStepEvent,
    roomId: string,
    turnId: string,
    baseAIMessage: Message,
    selectedModel: AIModelOption,
    state: CodeAgentTurnStreamState
  ) {
    if (event.turnId !== turnId) {
      throw new Error(`Coco model-step turn mismatch: expected ${turnId}, got ${event.turnId}`);
    }
    if (state.modelSteps.has(event.stepId)) {
      throw new Error(`Duplicate Coco model step: ${event.stepId}`);
    }
    if (event.sequence !== state.modelSteps.size + 1) {
      throw new Error(`Out-of-order Coco model step: ${event.stepId}`);
    }
    if (new Set(event.toolCallIds).size !== event.toolCallIds.length) {
      throw new Error(`Coco model step repeats a tool call id: ${event.stepId}`);
    }
    for (const toolCallId of event.toolCallIds) {
      if (state.modelStepIdByToolCallId.has(toolCallId)) {
        throw new Error(`Coco tool call belongs to multiple model steps: ${toolCallId}`);
      }
    }

    const step = {
      ...buildCocoModelStepCost(event, selectedModel),
      hasText: event.hasText,
      toolCallIds: [...event.toolCallIds],
      aiModel: getMessageAIModel(selectedModel),
    };
    state.modelSteps.set(step.stepId, step);
    for (const toolCallId of step.toolCallIds) {
      state.modelStepIdByToolCallId.set(toolCallId, step.stepId);
    }

    if (event.hasText) {
      if (!state.segmentHasUnsealedText || !state.segmentContent.trim()) {
        throw new Error(`Coco model step reported text without a streamed AI segment: ${event.stepId}`);
      }
      const completedMessage: Message = {
        ...baseAIMessage,
        id: state.activeMessageId,
        content: state.segmentContent,
        status: 'complete',
        timestamp: this.now().toISOString(),
        modelStepId: event.stepId,
        modelStepSequence: event.sequence,
        aiModel: step.aiModel,
        usage: step.usage,
        cost: step.cost,
      };
      const updatedRoom = await this.store.upsertMessage(completedMessage);
      if (!updatedRoom) {
        throw new Error(`Unable to persist Coco model-step message: ${event.stepId}`);
      }
      step.anchorMessageId = completedMessage.id;
      state.completedAIMessageById.set(completedMessage.id, completedMessage);
      state.segmentHasUnsealedText = false;
      await this.commitCocoModelStepCost(roomId, state, step);
      this.emitter.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
      this.emitter.to(roomId).emit('new_message', stripAIStreamRecoveryMetadata(completedMessage));
    } else if (event.toolCallIds.length === 0) {
      throw new Error(`Coco model step has no text or tool calls: ${event.stepId}`);
    }
    state.needsNewSegment = true;
  }

  private async commitCocoModelStepCost(
    roomId: string,
    state: CodeAgentTurnStreamState,
    step: CocoModelStepCostRecord & { costCommitted?: boolean }
  ) {
    if (step.costCommitted) return;
    const roomCostTotal = await this.store.incrementRoomAICost(roomId, step.cost);
    step.costCommitted = true;
    state.roomCostTotal = roomCostTotal;
    this.emitter.to(roomId).emit('ai_cost_total', roomCostTotal);
  }

  private async flushInterruptedToolCalls(
    roomId: string,
    turnId: string,
    state: CodeAgentTurnStreamState,
    error: unknown,
    baseAIMessage: Message,
    backend: CodeAgentBackend
  ) {
    if (state.pendingToolCalls.size === 0) {
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    const pending = Array.from(state.pendingToolCalls.entries());
    state.pendingToolCalls.clear();
    for (const [toolCallId, toolCall] of pending) {
      const modelStepId = state.modelStepIdByToolCallId.get(toolCallId);
      const message: Message = {
        id: `tool_result_${toolCallId}_${this.createId()}`,
        clientId: 'code_agent_runner',
        content: `Tool interrupted before completion: ${reason}`,
        roomId,
        timestamp: this.now().toISOString(),
        messageType: 'tool_result',
        username: this.displayBackendName(backend),
        status: 'error',
        turnId,
        modelStepId,
        modelStepSequence: modelStepId ? state.modelSteps.get(modelStepId)?.sequence : undefined,
        toolCallId,
        toolName: toolCall.name,
        toolOutputPreview: `Tool interrupted before completion: ${reason}`,
        exitCode: 1,
        isError: true,
        codeAgentMode: baseAIMessage.codeAgentMode,
      };
      const updatedRoom = await this.store.appendMessageWithAtomicPosition(message).catch(err => {
        this.logger.warn('Failed to persist interrupted tool result', { error: err, roomId, turnId, toolCallId });
        return null;
      });
      if (updatedRoom) {
        this.emitter.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
        this.emitter.to(roomId).emit('new_message', message);
      }
      await this.recordObservabilityEvent({
        level: 'warn',
        event: 'code_agent.runner.tool_result',
        roomId,
        turnId,
        payload: {
          backend,
          toolCallId,
          toolName: toolCall.name,
          success: false,
          exitCode: 1,
          interrupted: true,
          reason,
        },
      });
    }
  }

  private async sealCurrentSegment(roomId: string, baseAIMessage: Message, state: CodeAgentTurnStreamState) {
    if (!state.segmentHasUnsealedText || !state.segmentContent.trim()) return;

    this.emitter.to(roomId).emit('ai_stream_end', {
      messageId: state.activeMessageId,
      roomId,
      content: state.segmentContent,
    });

    const sealedMessage: Message = {
      ...baseAIMessage,
      id: state.activeMessageId,
      content: state.segmentContent,
      status: 'complete',
      timestamp: this.now().toISOString(),
    };
    await this.store.upsertMessage(sealedMessage).catch(err => {
      this.logger.warn('Failed to seal AI segment', { error: err, roomId, messageId: state.activeMessageId });
    });
    state.segmentHasUnsealedText = false;
  }

  private async saveCodeAgentError(roomId: string, aiMessage: Message, error: unknown, backend: CodeAgentBackend) {
    const content = error instanceof Error ? error.message : 'Agent task failed';
    const errorMessage: Message = {
      ...aiMessage,
      content,
      status: 'error',
      timestamp: this.now().toISOString(),
    };
    const updatedRoom = await this.store.upsertMessage(errorMessage).catch(saveError => {
      this.logger.error('Failed to persist code-agent AI error state', { error: saveError, roomId, messageId: aiMessage.id });
      return null;
    });
    if (updatedRoom) {
      this.emitter.to(roomId).emit('new_message', stripAIStreamRecoveryMetadata(errorMessage));
    }
    const errorRoom = await this.patchRoom(roomId, { codeAgentStatus: 'error' });
    if (errorRoom) {
      this.emitter.to(errorRoom.creatorId).emit('room_updated', errorRoom);
    }
    this.emitter.to(roomId).emit('ai_stream_error', {
      messageId: aiMessage.id,
      error: `${this.displayBackendName(backend)} task failed.`,
      roomId,
    });
  }

  private async patchRoom(roomId: string, patch: Partial<Room>) {
    const currentRoom = await this.store.getRoomById(roomId);
    if (!currentRoom) {
      return null;
    }
    return this.store.saveRoom({ ...currentRoom, ...patch });
  }

  private async publishRoomAgentTurn(turn: RoomAgentTurn): Promise<RoomAgentTurn> {
    const persisted = await this.store.upsertRoomAgentTurn?.(turn).catch(error => {
      this.logger.error('Failed to persist room agent turn', { error, roomId: turn.roomId, turnId: turn.id, status: turn.status });
      return null;
    });
    const published = persisted || turn;
    this.emitter.to(turn.roomId).emit('agent_turn_updated', published);
    return published;
  }

  private async recordTurnEvent(
    level: ObservabilityEventInput['level'],
    event: string,
    input: CodeAgentTurnInput,
    turnId: string,
    startedAtMs: number,
    extra: Partial<ObservabilityEventInput> = {}
  ) {
    await this.recordObservabilityEvent({
      level,
      event,
      roomId: input.roomId,
      turnId,
      clientId: input.clientId,
      provider: input.selectedModel.provider,
      model: input.selectedModel.id,
      durationMs: Math.max(0, this.now().getTime() - startedAtMs),
      ...extra,
    });
  }

  private async recordRunnerEvent(
    event: CodeAgentRunnerEvent,
    roomId: string,
    turnId: string,
    selectedModel: AIModelOption,
    backend: CodeAgentBackend,
    codexRunSettings: CodexRunSettings
  ) {
    if (event.type === 'text_delta') {
      return;
    }

    const payload = this.summarizeRunnerEvent(event);
    await this.recordObservabilityEvent({
      level: event.type === 'error' ? 'error' : 'info',
      event: `code_agent.runner.${event.type}`,
      roomId,
      turnId,
      provider: isCodexBackend(backend) ? 'codex' : selectedModel.provider,
      model: isCodexBackend(backend) ? codexRunSettings.model : selectedModel.id,
      errorMessage: event.type === 'error' ? event.message : undefined,
      payload: { backend, ...payload },
    });
  }

  private summarizeRunnerEvent(event: CodeAgentRunnerEvent): Record<string, unknown> {
    switch (event.type) {
      case 'status':
        return { status: event.status, message: event.message };
      case 'control_result':
        return {
          controlId: event.controlId,
          controlType: event.controlType,
          accepted: event.accepted,
          message: event.message,
        };
      case 'model_step':
        return {
          stepId: event.stepId,
          sequence: event.sequence,
          hasText: event.hasText,
          toolCallIds: event.toolCallIds,
          usage: event.usage,
        };
      case 'tool_call':
        return {
          toolCallId: event.id,
          toolName: event.name,
          argsLength: JSON.stringify(event.args || {}).length,
        };
      case 'tool_result':
        return {
          toolCallId: event.id,
          toolName: event.name,
          success: event.success,
          exitCode: event.exitCode,
          outputLength: event.output.length,
          truncated: event.truncated,
        };
      case 'final':
        return {
          messageId: event.messageId,
          sessionId: event.sessionId,
          answerLength: event.answer.length,
          usage: event.usage,
        };
      case 'usage':
        return { usage: event.usage };
      case 'error':
        return {
          message: event.message,
          code: event.code,
          retryable: event.retryable,
        };
      case 'approval_request':
        return {
          approvalId: event.id,
          approvalType: event.approvalType,
          title: event.title,
        };
      case 'thread_list_result':
        return {
          roomId: event.roomId,
          threadCount: event.threads.length,
          nextCursor: event.nextCursor,
        };
      case 'thread_read_result':
        return {
          roomId: event.roomId,
          hasThread: Boolean(event.thread),
        };
      case 'text_delta':
        return { deltaLength: event.delta.length };
    }
  }

  private async recordObservabilityEvent(event: ObservabilityEventInput) {
    if (!this.options.observability) {
      return;
    }
    await this.options.observability.recordEvent(event).catch(error => {
      this.logger.error('Failed to record code-agent session observability event', {
        error,
        event: event.event,
        roomId: event.roomId,
        turnId: event.turnId,
      });
    });
  }

  private buildRunnerEnv(selectedModel: AIModelOption, context: {
    roomId: string;
    clientId: string;
    turnId: string;
    backend: CodeAgentBackend;
    mode: CodeAgentRunnerMode;
    clientOrigin?: string;
    serverOrigin?: string;
  }) {
    // This is the complete runner environment. Do not merge process.env here:
    // code-agent subprocesses must only receive explicit sandbox/model credentials.
    const env: Record<string, string> = {
      PYTHONUNBUFFERED: '1',
      ...(this.options.runnerEnv || {}),
    };
    const normalizedMode = normalizeCodeAgentMode(context.mode) || 'plan';
    if (this.options.modelGateway) {
      env.CODE_AGENT_MODEL_PROXY_URL = `${this.options.modelGateway.publicBaseUrl}/v1`;
      env.CODE_AGENT_MODEL_PROXY_TOKEN = this.options.modelGateway.issueTurnToken({
        roomId: context.roomId,
        clientId: context.clientId,
        turnId: context.turnId,
        mode: normalizedMode,
        model: selectedModel,
      });
    } else {
      Object.assign(env, this.options.runnerProviderEnvByProvider?.[selectedModel.provider] || {});
    }

    if (codeAgentModeAllowsStaticPublish(normalizedMode) && this.options.staticSitePublisher?.isConfigured()) {
      const staticPublishPublicBaseUrl = this.options.staticSitePublisher.publicBaseUrlForRequest(
        context.clientOrigin,
        context.serverOrigin
      );
      env.ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH = 'true';
      env.ROOMTALK_STATIC_PUBLISH_URL = this.options.staticSitePublisher.publishApiUrlForRequest(
        context.clientOrigin,
        context.serverOrigin
      );
      env.ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL = staticPublishPublicBaseUrl || '';
      env.ROOMTALK_STATIC_PUBLISH_TOKEN = this.options.staticSitePublisher.issueTurnToken({
        roomId: context.roomId,
        clientId: context.clientId,
        turnId: context.turnId,
        mode: normalizedMode,
      });
    }

    if (this.options.roomContext) {
      const publicBaseUrl = this.options.staticSitePublisher?.publicBaseUrlForRequest(
        context.clientOrigin,
        context.serverOrigin
      );
      env.ROOMTALK_ROOM_CONTEXT_URL = publicBaseUrl
        ? `${publicBaseUrl}${CODE_AGENT_ROOM_CONTEXT_API_PREFIX}`
        : CODE_AGENT_ROOM_CONTEXT_API_PREFIX;
      env.ROOMTALK_ROOM_CONTEXT_TOKEN = this.options.roomContext.issueTurnToken({
        roomId: context.roomId,
        clientId: context.clientId,
        turnId: context.turnId,
        mode: normalizedMode,
      });
    }

    if (codeAgentModeAllowsWriteTools(normalizedMode)) {
      env.ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS = 'true';
    } else if (env.ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS === 'true') {
      delete env.ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS;
    }
    if (codeAgentModeAllowsShell(normalizedMode)) {
      env.ROOMTALK_CODE_AGENT_ALLOW_SHELL = 'true';
    } else if (env.ROOMTALK_CODE_AGENT_ALLOW_SHELL === 'true') {
      delete env.ROOMTALK_CODE_AGENT_ALLOW_SHELL;
    }

    return env;
  }
}

const bufferToString = (chunk: unknown) => {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
};
