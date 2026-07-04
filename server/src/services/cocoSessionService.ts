import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { AIModelOption, CodeAgentBackend, Message, Room, RoomMemberRole } from '../types';
import { calculateAICost, getMessageAIModel } from './aiModels';
import { CocoSandboxLifecycleService, EnsureCocoSandboxResult } from './cocoSandboxLifecycle';
import { CocoSandboxHandle, CocoSandboxService, CocoRunnerProcess } from './cocoSandboxService';
import { mapCocoRunnerEvent } from './cocoEventMapper';
import { CodeAgentRunner } from './codeAgentRunner';
import { COCO_RUNNER_SCHEMA_VERSION, CocoRunnerEvent, CocoRunnerMode, CocoRunnerRunRequest } from './cocoRunnerProtocol';
import { DEFAULT_CODEX_CLI_RUNNER_COMMAND, DEFAULT_COCO_RUNNER_COMMAND } from './cocoRuntimeConfig';
import { createAIPlaceholderMessage } from './messageDomain';
import { CocoModelGateway } from './cocoModelGateway';
import { buildCocoPriorMessages } from './cocoTranscript';
import { PublishedStaticSiteService } from './publishedStaticSite';
import { ObservabilityEventInput, ObservabilityEventRecorder } from './observabilityEvents';
import { canUseCocoRoom, COCO_ACCESS_DENIED_MESSAGE } from './cocoRoomAccess';
import { CodexConnectionService } from './codexConnection';
import { CocoRunnerHandlers, CocoRunnerRunResult } from './fakeCocoRunner';

export interface CocoRoomEmitter {
  to(roomId: string): {
    emit(event: string, ...args: unknown[]): void;
  };
}

export interface CocoSessionServiceOptions {
  enabled: boolean;
  allowedClientIds?: string[];
  mode?: CocoRunnerMode;
  availableModes?: CocoRunnerMode[];
  defaultMode?: CocoRunnerMode;
  modelGateway?: CocoModelGateway;
  backend?: CodeAgentBackend;
  runnerCommand?: string;
  runnerCommandByBackend?: Partial<Record<CodeAgentBackend, string>>;
  turnTimeoutMs?: number;
  allowedPaths?: string[];
  runnerEnv?: Record<string, string>;
  runnerEnvByBackend?: Partial<Record<CodeAgentBackend, Record<string, string>>>;
  runnerProviderEnvByProvider?: Partial<Record<AIModelOption['provider'], Record<string, string>>>;
  codexBackendEnabled?: boolean;
  codexConnectionService?: Pick<CodexConnectionService, 'withCodexAuth'>;
  staticSitePublisher?: PublishedStaticSiteService;
  observability?: ObservabilityEventRecorder;
  now?: () => Date;
  createId?: () => string;
}

export interface CocoTurnInput {
  roomId: string;
  clientId: string;
  selectedModel: AIModelOption;
  maxContextMessages?: number;
  requestedMode?: CocoRunnerMode;
  requestedModeSource?: 'originalTurn';
  clientOrigin?: string;
  serverOrigin?: string;
}

export type CocoTurnAck = { success: boolean; messageId?: string; error?: string };
export type CocoTurnAckCallback = (response: CocoTurnAck) => void;

interface CocoTurnStreamState {
  activeMessageId: string;
  segmentContent: string;
  fullContent: string;
  needsNewSegment: boolean;
  segmentIds: string[];
  nonEmptySegmentIds: Set<string>;
}

export class CocoSessionService {
  private readonly activeTurns = new Set<string>();
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly store: RoomStore,
    private readonly emitter: CocoRoomEmitter,
    private readonly sandboxLifecycle: CocoSandboxLifecycleService,
    private readonly sandboxService: CocoSandboxService,
    private readonly runner: CodeAgentRunner,
    private readonly logger: Logger,
    private readonly options: CocoSessionServiceOptions
  ) {
    this.now = options.now || (() => new Date());
    this.createId = options.createId || (() => uuidv4());
  }

  async startTurn(input: CocoTurnInput, callback?: CocoTurnAckCallback): Promise<CocoTurnAck> {
    let callbackSent = false;
    const ack = (response: CocoTurnAck) => {
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
        event: 'coco.turn.rejected',
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
      return rejectTurn('Coco is disabled', { reason: 'disabled' });
    }
    if (this.options.allowedClientIds?.length && !this.options.allowedClientIds.includes(input.clientId)) {
      return rejectTurn('Coco is not enabled for this user', { reason: 'not_allowed' });
    }

    const room = await this.store.getRoomById(input.roomId);
    const member = room ? await this.store.getRoomMember(input.roomId, input.clientId) : null;
    const validation = this.validateRoom(room, input.clientId, member?.role);
    if (!validation.success) {
      return rejectTurn(validation.error || 'Coco turn rejected', { reason: 'room_validation_failed' });
    }

    if (this.activeTurns.has(input.roomId)) {
      return rejectTurn('A Coco task is already running in this room', { reason: 'room_already_running' });
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

    let aiMessageId = '';
    let turnId = '';
    let aiMessage: Message | null = null;
    let runnerProcess: CocoRunnerProcess | null = null;
    let placeholderAnnounced = false;
    let roomMarkedRunning = false;
    let streamState: CocoTurnStreamState | null = null;

    try {
      this.activeTurns.add(input.roomId);
      aiMessageId = this.createId();
      turnId = this.createId();
      aiMessage = {
        ...createAIPlaceholderMessage({
          id: aiMessageId,
          roomId: input.roomId,
          roleName: this.displayBackendName(turnBackend),
          model: input.selectedModel,
          now: this.now(),
        }),
        turnId,
        codeAgentMode: turnMode.mode,
      };

      const promptContext = await this.readLatestPromptContext(input.roomId, input.clientId, input.maxContextMessages);
      if (!promptContext) {
        await this.recordTurnEvent('warn', 'coco.turn.rejected', input, turnId, turnStartedAtMs, {
          errorMessage: 'Coco requires a text prompt in the room history',
          payload: { reason: 'missing_prompt', mode: turnMode.mode },
        });
        return ack({ success: false, error: 'Coco requires a text prompt in the room history' });
      }

      await this.recordTurnEvent('info', 'coco.turn.started', input, turnId, turnStartedAtMs, {
        payload: {
          backend: turnBackend,
          mode: turnMode.mode,
          promptLength: promptContext.prompt.length,
          priorMessageCount: promptContext.priorMessages.length,
          maxContextMessages: input.maxContextMessages,
          usesModelGateway: Boolean(this.options.modelGateway),
          previousSessionId: room!.cocoSessionId || null,
        },
      });

      const sandbox = await this.sandboxLifecycle.ensureReadySandbox(input.roomId, input.clientId);
      if (!sandbox.ok) {
        const error = this.describeSandboxFailure(sandbox);
        await this.recordTurnEvent('warn', 'coco.sandbox.ensure_failed', input, turnId, turnStartedAtMs, {
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
      await this.recordTurnEvent('info', 'coco.sandbox.ensure', input, turnId, turnStartedAtMs, {
        payload: {
          backend: turnBackend,
          sandboxId: sandbox.handle.id,
          sandboxProvider: sandbox.handle.provider,
          sandboxCreated: sandbox.created,
          workspace: sandbox.handle.workspace,
        },
      });

      const runningRoom = await this.patchRoom(input.roomId, { cocoStatus: 'running' });
      if (!runningRoom) {
        await this.recordTurnEvent('error', 'coco.turn.failed', input, turnId, turnStartedAtMs, {
          errorCode: 'mark_running_failed',
          errorMessage: 'Unable to mark Coco room as running',
        });
        return ack({ success: false, error: 'Unable to mark Coco room as running' });
      }
      roomMarkedRunning = true;
      this.emitter.to(runningRoom.creatorId).emit('room_updated', runningRoom);

      const placeholderRoom = await this.store.upsertMessage(aiMessage);
      if (!placeholderRoom) {
        const errorRoom = await this.patchRoom(input.roomId, { cocoStatus: 'error' });
        if (errorRoom) {
          this.emitter.to(errorRoom.creatorId).emit('room_updated', errorRoom);
        }
        await this.recordTurnEvent('error', 'coco.turn.failed', input, turnId, turnStartedAtMs, {
          errorCode: 'placeholder_persist_failed',
          errorMessage: 'Unable to start a durable Coco response',
        });
        return ack({ success: false, error: 'Unable to start a durable Coco response' });
      }
      this.emitter.to(placeholderRoom.creatorId).emit('room_updated', placeholderRoom);
      this.emitter.to(input.roomId).emit('new_message', aiMessage);
      placeholderAnnounced = true;
      ack({ success: true, messageId: aiMessageId });

      streamState = {
        activeMessageId: aiMessageId,
        segmentContent: '',
        fullContent: '',
        needsNewSegment: false,
        segmentIds: [aiMessageId],
        nonEmptySegmentIds: new Set(),
      };
      const runnerEnv = {
        ...this.buildRunnerEnv(input.selectedModel, {
          roomId: input.roomId,
          clientId: input.clientId,
          turnId,
          mode: turnMode.mode,
          clientOrigin: input.clientOrigin,
          serverOrigin: input.serverOrigin,
        }),
        ...(this.options.runnerEnvByBackend?.[turnBackend] || {}),
      };
      const runnerRequest: CocoRunnerRunRequest = {
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'run',
        roomId: input.roomId,
        clientId: input.clientId,
        turnId,
        sessionId: room!.cocoSessionId || null,
        prompt: promptContext.prompt,
        priorMessages: promptContext.priorMessages,
        mode: turnMode.mode,
        provider: input.selectedModel.provider,
        modelId: input.selectedModel.id,
        apiModel: input.selectedModel.apiModel,
        workspace: sandbox.handle.workspace,
        allowedPaths: this.options.allowedPaths || ['.'],
      };
      const startRunnerProcess = async (env: Record<string, string>) => {
        runnerProcess = await this.sandboxService.startRunner({
          handle: sandbox.handle,
          command: this.runnerCommandForBackend(turnBackend),
          env,
          timeoutMs: this.options.turnTimeoutMs,
        });
        await this.recordTurnEvent('info', 'coco.runner.started', input, turnId, turnStartedAtMs, {
          payload: {
            backend: turnBackend,
            sandboxId: sandbox.handle.id,
            command: runnerProcess.command,
            mode: turnMode.mode,
          },
        });
        return runnerProcess;
      };
      const runnerHandlers = {
        onEvent: async (event: CocoRunnerEvent) => {
          await this.handleRunnerEvent(event, input.roomId, turnId, aiMessage!, input.selectedModel, streamState!, turnBackend);
        },
      };
      const runResult = await this.runRunnerWithBackendAuth({
        backend: turnBackend,
        clientId: input.clientId,
        turnId,
        runnerEnv,
        request: runnerRequest,
        handlers: runnerHandlers,
        sandbox: sandbox.handle,
        startRunnerProcess,
      });

      if (runResult.errorEvent) {
        throw new Error(runResult.errorEvent.message);
      }
      if (!runResult.finalEvent) {
        throw new Error('Coco runner exited without a final event');
      }

      // Seal the current segment and create a new one for the final answer
      // if tool calls occurred after the last text
      if (streamState.needsNewSegment) {
        await this.sealCurrentSegment(input.roomId, aiMessage, streamState);
        const finalAnswer = runResult.finalEvent.answer;
        if (finalAnswer) {
          const newId = this.createId();
          const segmentMessage: Message = {
            ...aiMessage,
            id: newId,
            content: '',
            status: 'streaming',
            timestamp: this.now().toISOString(),
            aiModel: getMessageAIModel(input.selectedModel),
          };
          const segmentRoom = await this.store.appendMessageWithAtomicPosition(segmentMessage);
          if (segmentRoom) {
            this.emitter.to(segmentRoom.creatorId).emit('room_updated', segmentRoom);
            this.emitter.to(input.roomId).emit('new_message', segmentMessage);
          }
          streamState.activeMessageId = newId;
          streamState.segmentContent = finalAnswer;
          streamState.segmentIds.push(newId);
          streamState.nonEmptySegmentIds.add(newId);
        }
      }

      const answer = runResult.finalEvent.answer || streamState.segmentContent || streamState.fullContent;
      const usage = runResult.finalEvent.usage;
      const cost = usage ? calculateAICost(input.selectedModel, usage) : undefined;
      const roomCostTotal = await this.store.incrementRoomAICost(input.roomId, cost || null);

      const finalActiveId = streamState.activeMessageId;
      const finalMessage: Message = {
        ...aiMessage,
        id: finalActiveId,
        content: answer,
        status: 'complete',
        timestamp: this.now().toISOString(),
        aiModel: getMessageAIModel(input.selectedModel),
        usage,
        cost,
      };
      const finalRoom = await this.store.upsertMessage(finalMessage);
      if (!finalRoom) {
        throw new Error('Unable to save the completed Coco response');
      }

      // Clean up unused initial placeholder if streaming moved to a new segment
      if (finalActiveId !== aiMessageId) {
        const firstSegmentUsed = streamState.nonEmptySegmentIds.has(aiMessageId);
        if (!firstSegmentUsed) {
          await this.store.deleteMessageById(input.roomId, aiMessageId).catch(err => {
            this.logger.warn('Failed to clean up unused Coco placeholder', { error: err, roomId: input.roomId, messageId: aiMessageId });
          });
          this.emitter.to(input.roomId).emit('message_deleted', { roomId: input.roomId, messageId: aiMessageId });
        }
      }

      const idleRoom = await this.patchRoom(input.roomId, {
        cocoStatus: 'idle',
        cocoSessionId: runResult.finalEvent.sessionId,
      });
      if (runnerProcess) {
        await this.stopRunnerProcess(runnerProcess, input.roomId);
        runnerProcess = null;
      }
      this.activeTurns.delete(input.roomId);
      this.emitter.to(input.roomId).emit('ai_stream_end', {
        messageId: finalActiveId,
        roomId: input.roomId,
        content: finalMessage.content,
        aiModel: finalMessage.aiModel,
        usage,
        cost,
        sessionCost: roomCostTotal,
      });
      this.emitter.to(input.roomId).emit('ai_cost_total', roomCostTotal);
      this.emitter.to((idleRoom || finalRoom).creatorId).emit('room_updated', idleRoom || finalRoom);
      await this.recordTurnEvent('info', 'coco.turn.completed', input, turnId, turnStartedAtMs, {
        sessionId: runResult.finalEvent.sessionId,
        costUsd: cost?.totalUsd,
        payload: {
          backend: turnBackend,
          messageId: finalActiveId,
          initialMessageId: aiMessageId,
          sessionId: runResult.finalEvent.sessionId,
          segmentCount: streamState.segmentIds.length,
          answerLength: answer.length,
          roomCostTotalUsd: roomCostTotal.totalUsd,
          usage,
          cost,
        },
      });
      return { success: true, messageId: aiMessageId };
    } catch (error) {
      const errorTargetId = streamState?.activeMessageId || aiMessageId;
      this.logger.error('Code agent turn failed', { error, roomId: input.roomId, messageId: errorTargetId, backend: turnBackend });
      await this.recordTurnEvent('error', 'coco.turn.failed', input, turnId, turnStartedAtMs, {
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
        const errorTargetMessage: Message = { ...aiMessage, id: errorTargetId };
        await this.saveCocoError(input.roomId, errorTargetMessage, error, turnBackend);
      } else if (roomMarkedRunning) {
        const errorRoom = await this.patchRoom(input.roomId, { cocoStatus: 'error' });
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
      this.activeTurns.delete(input.roomId);
    }
  }

  private async stopRunnerProcess(runnerProcess: CocoRunnerProcess, roomId: string) {
    await runnerProcess.stop().catch(error => {
      this.logger.warn('Failed to stop Coco runner process', { error, roomId });
    });
  }

  private async runRunnerWithBackendAuth(input: {
    backend: CodeAgentBackend;
    clientId: string;
    turnId: string;
    runnerEnv: Record<string, string>;
    request: CocoRunnerRunRequest;
    handlers: CocoRunnerHandlers;
    sandbox: CocoSandboxHandle;
    startRunnerProcess: (env: Record<string, string>) => Promise<CocoRunnerProcess>;
  }): Promise<CocoRunnerRunResult> {
    if (input.backend !== 'codex') {
      const process = await input.startRunnerProcess(input.runnerEnv);
      return this.runner.run(input.request, input.handlers, {
        process,
        sandbox: input.sandbox,
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
        const process = await input.startRunnerProcess({
          ...input.runnerEnv,
          ROOMTALK_CODEX_AUTH_JSON_PATH: authPath,
          ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH: refreshedAuthPath,
        });
        const result = await this.runner.run(input.request, input.handlers, {
          process,
          sandbox: input.sandbox,
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

  private async readOptionalCodexRefreshedAuth(sandbox: CocoSandboxHandle, path: string): Promise<string | undefined> {
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

  private async deleteCodexSecretFile(sandbox: CocoSandboxHandle, path: string): Promise<void> {
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

  private validateRoom(room: Room | null, clientId: string, memberRole?: RoomMemberRole): CocoTurnAck {
    if (!room) {
      return { success: false, error: 'Room not found' };
    }
    if (room.type !== 'coco') {
      return { success: false, error: 'Room is not a Coco room' };
    }
    if (!canUseCocoRoom(room, clientId, memberRole)) {
      return { success: false, error: COCO_ACCESS_DENIED_MESSAGE };
    }
    return { success: true };
  }

  private resolveTurnMode(
    requestedMode?: CocoRunnerMode,
    source?: 'originalTurn',
  ): { ok: true; mode: CocoRunnerMode } | { ok: false; error: string } {
    const availableModes = this.availableModes();
    const defaultMode = this.defaultMode(availableModes);
    if (!requestedMode) {
      return { ok: true, mode: defaultMode };
    }
    if (availableModes.includes(requestedMode)) {
      return { ok: true, mode: requestedMode };
    }
    if (requestedMode === 'acceptEdits') {
      if (source === 'originalTurn') {
        return { ok: false, error: 'This response was originally run in Edit mode, but Edit mode is no longer available.' };
      }
      return { ok: false, error: 'Coco edit mode is not enabled' };
    }
    return { ok: false, error: `Coco mode is not enabled: ${requestedMode}` };
  }

  private resolveTurnBackend(room: Room): CodeAgentBackend {
    return room.codeAgentBackend || this.options.backend || this.runner.backend || 'coco';
  }

  private validateTurnBackend(backend: CodeAgentBackend): { ok: true } | { ok: false; error: string } {
    if (backend === 'codex' && this.options.codexBackendEnabled === false) {
      return { ok: false, error: 'Codex CLI backend is not enabled' };
    }
    return { ok: true };
  }

  private displayBackendName(backend: CodeAgentBackend): string {
    return backend === 'codex' ? 'Codex' : 'Coco';
  }

  private runnerCommandForBackend(backend: CodeAgentBackend): string {
    const command = this.options.runnerCommandByBackend?.[backend];
    if (command) {
      return command;
    }
    const defaultBackend = this.options.backend || this.runner.backend || 'coco';
    if (backend === defaultBackend && this.options.runnerCommand) {
      return this.options.runnerCommand;
    }
    return backend === 'codex' ? DEFAULT_CODEX_CLI_RUNNER_COMMAND : DEFAULT_COCO_RUNNER_COMMAND;
  }

  private availableModes(): CocoRunnerMode[] {
    if (this.options.availableModes?.length) {
      return Array.from(new Set(this.options.availableModes));
    }
    if (this.options.mode === 'acceptEdits') {
      return ['plan', 'acceptEdits'];
    }
    return ['plan'];
  }

  private defaultMode(availableModes: CocoRunnerMode[]): CocoRunnerMode {
    if (this.options.defaultMode && availableModes.includes(this.options.defaultMode)) {
      return this.options.defaultMode;
    }
    if (this.options.mode && availableModes.includes(this.options.mode)) {
      return this.options.mode;
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
          priorMessages: buildCocoPriorMessages(limited),
        };
      }
    }
    return null;
  }

  private describeSandboxFailure(result: EnsureCocoSandboxResult) {
    if (result.ok) {
      return '';
    }
    switch (result.reason) {
      case 'creating':
        return 'Coco sandbox is still being prepared';
      case 'limit_exceeded':
        return 'Coco sandbox limit exceeded';
      case 'forbidden':
        return 'You do not have access to this Coco room';
      case 'not_coco_room':
        return 'Room is not a Coco room';
      case 'missing_room':
        return 'Room not found';
      case 'store_conflict':
        return 'Unable to reserve a Coco sandbox';
      case 'sandbox_error':
        return 'Unable to prepare a Coco sandbox';
    }
  }

  private async handleRunnerEvent(
    event: CocoRunnerEvent,
    roomId: string,
    turnId: string,
    baseAIMessage: Message,
    selectedModel: AIModelOption,
    state: CocoTurnStreamState,
    backend: CodeAgentBackend
  ) {
    await this.recordRunnerEvent(event, roomId, turnId, selectedModel, backend);
    const mapped = mapCocoRunnerEvent(event, {
      roomId,
      turnId,
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
          aiModel: getMessageAIModel(selectedModel),
        };
        const segmentRoom = await this.store.appendMessageWithAtomicPosition(segmentMessage);
        if (!segmentRoom) {
          throw new Error('Unable to create new AI segment message');
        }
        this.emitter.to(segmentRoom.creatorId).emit('room_updated', segmentRoom);
        this.emitter.to(roomId).emit('new_message', segmentMessage);
        state.activeMessageId = newId;
        state.segmentContent = '';
        state.needsNewSegment = false;
        state.segmentIds.push(newId);
      }
      state.segmentContent += mapped.delta;
      state.fullContent += mapped.delta;
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

      const updatedRoom = await this.store.appendMessageWithAtomicPosition(mapped.message);
      if (!updatedRoom) {
        throw new Error(`Unable to persist Coco ${mapped.message.messageType} event`);
      }
      this.emitter.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
      this.emitter.to(roomId).emit('new_message', mapped.message);
    }
  }

  private async sealCurrentSegment(roomId: string, baseAIMessage: Message, state: CocoTurnStreamState) {
    if (!state.segmentContent.trim()) return;

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
  }

  private async saveCocoError(roomId: string, aiMessage: Message, error: unknown, backend: CodeAgentBackend) {
    const content = error instanceof Error ? error.message : 'Coco task failed';
    const errorMessage: Message = {
      ...aiMessage,
      content,
      status: 'error',
      timestamp: this.now().toISOString(),
    };
    await this.store.upsertMessage(errorMessage).catch(saveError => {
      this.logger.error('Failed to persist Coco AI error state', { error: saveError, roomId, messageId: aiMessage.id });
      return null;
    });
    const errorRoom = await this.patchRoom(roomId, { cocoStatus: 'error' });
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

  private async recordTurnEvent(
    level: ObservabilityEventInput['level'],
    event: string,
    input: CocoTurnInput,
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
    event: CocoRunnerEvent,
    roomId: string,
    turnId: string,
    selectedModel: AIModelOption,
    backend: CodeAgentBackend
  ) {
    if (event.type === 'text_delta') {
      return;
    }

    const payload = this.summarizeRunnerEvent(event);
    await this.recordObservabilityEvent({
      level: event.type === 'error' ? 'error' : 'info',
      event: `coco.runner.${event.type}`,
      roomId,
      turnId,
      provider: selectedModel.provider,
      model: selectedModel.id,
      errorMessage: event.type === 'error' ? event.message : undefined,
      payload: { backend, ...payload },
    });
  }

  private summarizeRunnerEvent(event: CocoRunnerEvent): Record<string, unknown> {
    switch (event.type) {
      case 'status':
        return { status: event.status, message: event.message };
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
      case 'error':
        return {
          message: event.message,
          code: event.code,
          retryable: event.retryable,
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
      this.logger.error('Failed to record Coco session observability event', {
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
    mode: CocoRunnerMode;
    clientOrigin?: string;
    serverOrigin?: string;
  }) {
    // This is the complete runner environment. Do not merge process.env here:
    // Coco subprocesses must only receive explicit sandbox/model credentials.
    const env: Record<string, string> = {
      PYTHONUNBUFFERED: '1',
      ...(this.options.runnerEnv || {}),
    };
    if (this.options.modelGateway) {
      env.COCO_MODEL_PROXY_URL = `${this.options.modelGateway.publicBaseUrl}/v1`;
      env.COCO_MODEL_PROXY_TOKEN = this.options.modelGateway.issueTurnToken({
        roomId: context.roomId,
        clientId: context.clientId,
        turnId: context.turnId,
        mode: context.mode,
        model: selectedModel,
      });
    } else {
      Object.assign(env, this.options.runnerProviderEnvByProvider?.[selectedModel.provider] || {});
    }

    if (context.mode === 'acceptEdits' && this.options.staticSitePublisher?.isConfigured()) {
      const staticPublishPublicBaseUrl = this.options.staticSitePublisher.publicBaseUrlForRequest(
        context.clientOrigin,
        context.serverOrigin
      );
      env.ROOMTALK_COCO_ENABLE_STATIC_PUBLISH = 'true';
      env.ROOMTALK_STATIC_PUBLISH_URL = this.options.staticSitePublisher.publishApiUrlForRequest(
        context.clientOrigin,
        context.serverOrigin
      );
      env.ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL = staticPublishPublicBaseUrl || '';
      env.ROOMTALK_STATIC_PUBLISH_TOKEN = this.options.staticSitePublisher.issueTurnToken({
        roomId: context.roomId,
        clientId: context.clientId,
        turnId: context.turnId,
        mode: context.mode,
      });
    }

    if (context.mode === 'acceptEdits') {
      env.ROOMTALK_COCO_ALLOW_WRITE_TOOLS = 'true';
    } else if (env.ROOMTALK_COCO_ALLOW_WRITE_TOOLS === 'true') {
      delete env.ROOMTALK_COCO_ALLOW_WRITE_TOOLS;
    }

    return env;
  }
}
