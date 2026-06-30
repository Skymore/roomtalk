import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { AIModelOption, Message, Room } from '../types';
import { calculateAICost, getMessageAIModel } from './aiModels';
import { CocoSandboxLifecycleService, EnsureCocoSandboxResult } from './cocoSandboxLifecycle';
import { CocoSandboxService, CocoRunnerProcess } from './cocoSandboxService';
import { mapCocoRunnerEvent } from './cocoEventMapper';
import { CodeAgentRunner } from './codeAgentRunner';
import { COCO_RUNNER_SCHEMA_VERSION, CocoRunnerEvent, CocoRunnerMode } from './cocoRunnerProtocol';
import { DEFAULT_COCO_RUNNER_COMMAND } from './cocoRuntimeConfig';
import { createAIPlaceholderMessage } from './messageDomain';
import { CocoModelGateway } from './cocoModelGateway';
import { buildCocoPriorMessages } from './cocoTranscript';

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
  runnerCommand?: string;
  turnTimeoutMs?: number;
  allowedPaths?: string[];
  runnerEnv?: Record<string, string>;
  runnerProviderEnvByProvider?: Partial<Record<AIModelOption['provider'], Record<string, string>>>;
  now?: () => Date;
  createId?: () => string;
}

export interface CocoTurnInput {
  roomId: string;
  clientId: string;
  selectedModel: AIModelOption;
  roleName?: string;
  mode?: CocoRunnerMode;
  maxContextMessages?: number;
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

    if (!this.options.enabled) {
      return ack({ success: false, error: 'Coco is disabled' });
    }
    if (this.options.allowedClientIds?.length && !this.options.allowedClientIds.includes(input.clientId)) {
      return ack({ success: false, error: 'Coco is not enabled for this user' });
    }

    const room = await this.store.getRoomById(input.roomId);
    const member = room ? await this.store.getRoomMember(input.roomId, input.clientId) : null;
    const validation = this.validateRoom(room, input.clientId, member?.role);
    if (!validation.success) {
      return ack(validation);
    }

    if (this.activeTurns.has(input.roomId)) {
      return ack({ success: false, error: 'A Coco task is already running in this room' });
    }

    const turnMode = this.resolveTurnMode(input.mode);
    if (!turnMode.ok) {
      return ack({ success: false, error: turnMode.error });
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
          roleName: input.roleName || 'Coco',
          model: input.selectedModel,
          now: this.now(),
        }),
        turnId,
      };

      const promptContext = await this.readLatestPromptContext(input.roomId, input.clientId, input.maxContextMessages);
      if (!promptContext) {
        return ack({ success: false, error: 'Coco requires a text prompt in the room history' });
      }

      const sandbox = await this.sandboxLifecycle.ensureReadySandbox(input.roomId, input.clientId);
      if (!sandbox.ok) {
        return ack({ success: false, error: this.describeSandboxFailure(sandbox) });
      }

      const runningRoom = await this.patchRoom(input.roomId, { cocoStatus: 'running' });
      if (!runningRoom) {
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
        return ack({ success: false, error: 'Unable to start a durable Coco response' });
      }
      this.emitter.to(placeholderRoom.creatorId).emit('room_updated', placeholderRoom);
      this.emitter.to(input.roomId).emit('new_message', aiMessage);
      placeholderAnnounced = true;
      ack({ success: true, messageId: aiMessageId });

      runnerProcess = await this.sandboxService.startRunner({
        handle: sandbox.handle,
        command: this.options.runnerCommand || DEFAULT_COCO_RUNNER_COMMAND,
        env: this.buildRunnerEnv(input.selectedModel, {
          roomId: input.roomId,
          clientId: input.clientId,
          turnId,
          mode: turnMode.mode,
        }),
        timeoutMs: this.options.turnTimeoutMs,
      });

      streamState = {
        activeMessageId: aiMessageId,
        segmentContent: '',
        fullContent: '',
        needsNewSegment: false,
        segmentIds: [aiMessageId],
        nonEmptySegmentIds: new Set(),
      };
      const runResult = await this.runner.run({
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'run',
        roomId: input.roomId,
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
      }, {
        onEvent: async event => {
          await this.handleRunnerEvent(event, input.roomId, turnId, aiMessage!, input.selectedModel, streamState!);
        },
      }, {
        process: runnerProcess,
        sandbox: sandbox.handle,
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
      return { success: true, messageId: aiMessageId };
    } catch (error) {
      const errorTargetId = streamState?.activeMessageId || aiMessageId;
      this.logger.error('Coco turn failed', { error, roomId: input.roomId, messageId: errorTargetId });
      if (placeholderAnnounced && aiMessage) {
        const errorTargetMessage: Message = { ...aiMessage, id: errorTargetId };
        await this.saveCocoError(input.roomId, errorTargetMessage, error);
      } else if (roomMarkedRunning) {
        const errorRoom = await this.patchRoom(input.roomId, { cocoStatus: 'error' });
        if (errorRoom) {
          this.emitter.to(errorRoom.creatorId).emit('room_updated', errorRoom);
        }
      }
      if (!callbackSent) {
        ack({ success: false, error: 'Coco task failed' });
      }
      return { success: false, messageId: aiMessageId || undefined, error: 'Coco task failed' };
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

  private validateRoom(room: Room | null, clientId: string, memberRole?: string): CocoTurnAck {
    if (!room) {
      return { success: false, error: 'Room not found' };
    }
    if (room.type !== 'coco') {
      return { success: false, error: 'Room is not a Coco room' };
    }
    const access = room.cocoAccess || 'owner';
    if (access === 'owner') {
      if (room.creatorId !== clientId) {
        return { success: false, error: 'You do not have access to this Coco room' };
      }
    } else if (access === 'admin') {
      if (room.creatorId !== clientId && memberRole !== 'admin') {
        return { success: false, error: 'You do not have access to this Coco room' };
      }
    }
    return { success: true };
  }

  private resolveTurnMode(requestedMode?: CocoRunnerMode): { ok: true; mode: CocoRunnerMode } | { ok: false; error: string } {
    const availableModes = this.availableModes();
    const defaultMode = this.defaultMode(availableModes);
    if (!requestedMode) {
      return { ok: true, mode: defaultMode };
    }
    if (availableModes.includes(requestedMode)) {
      return { ok: true, mode: requestedMode };
    }
    if (requestedMode === 'acceptEdits') {
      return { ok: false, error: 'Coco edit mode is not enabled' };
    }
    return { ok: false, error: `Coco mode is not enabled: ${requestedMode}` };
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
    state: CocoTurnStreamState
  ) {
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

  private async saveCocoError(roomId: string, aiMessage: Message, error: unknown) {
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
      error: 'Coco task failed.',
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

  private buildRunnerEnv(selectedModel: AIModelOption, context: {
    roomId: string;
    clientId: string;
    turnId: string;
    mode: CocoRunnerMode;
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

    if (context.mode === 'acceptEdits') {
      env.ROOMTALK_COCO_ALLOW_WRITE_TOOLS = 'true';
    } else if (env.ROOMTALK_COCO_ALLOW_WRITE_TOOLS === 'true') {
      delete env.ROOMTALK_COCO_ALLOW_WRITE_TOOLS;
    }

    return env;
  }
}
