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

export interface CocoRoomEmitter {
  to(roomId: string): {
    emit(event: string, ...args: unknown[]): void;
  };
}

export interface CocoSessionServiceOptions {
  enabled: boolean;
  allowedClientIds?: string[];
  mode?: CocoRunnerMode;
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
}

export type CocoTurnAck = { success: boolean; messageId?: string; error?: string };
export type CocoTurnAckCallback = (response: CocoTurnAck) => void;

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
    const validation = this.validateRoom(room, input.clientId);
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

      const prompt = await this.readLatestPrompt(input.roomId, input.clientId);
      if (!prompt) {
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
        env: this.buildRunnerEnv(input.selectedModel),
        timeoutMs: this.options.turnTimeoutMs,
      });

      let fullContent = '';
      const runResult = await this.runner.run({
        schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
        type: 'run',
        roomId: input.roomId,
        turnId,
        sessionId: room!.cocoSessionId || null,
        prompt,
        mode: turnMode.mode,
        provider: input.selectedModel.provider,
        modelId: input.selectedModel.id,
        apiModel: input.selectedModel.apiModel,
        workspace: sandbox.handle.workspace,
        allowedPaths: this.options.allowedPaths || ['.'],
      }, {
        onEvent: async event => {
          fullContent = await this.handleRunnerEvent(event, input.roomId, turnId, aiMessageId, fullContent);
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

      const answer = runResult.finalEvent.answer || fullContent;
      const usage = runResult.finalEvent.usage;
      const cost = usage ? calculateAICost(input.selectedModel, usage) : undefined;
      const roomCostTotal = await this.store.incrementRoomAICost(input.roomId, cost || null);
      const finalMessage: Message = {
        ...aiMessage,
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

      const idleRoom = await this.patchRoom(input.roomId, {
        cocoStatus: 'idle',
        cocoSessionId: runResult.finalEvent.sessionId,
      });
      this.emitter.to(input.roomId).emit('ai_stream_end', {
        messageId: aiMessageId,
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
      this.logger.error('Coco turn failed', { error, roomId: input.roomId, messageId: aiMessageId });
      if (placeholderAnnounced && aiMessage) {
        await this.saveCocoError(input.roomId, aiMessage, error);
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
        await runnerProcess.stop().catch(error => {
          this.logger.warn('Failed to stop Coco runner process', { error, roomId: input.roomId });
        });
      }
      this.activeTurns.delete(input.roomId);
    }
  }

  private validateRoom(room: Room | null, clientId: string): CocoTurnAck {
    if (!room) {
      return { success: false, error: 'Room not found' };
    }
    if (room.type !== 'coco') {
      return { success: false, error: 'Room is not a Coco room' };
    }
    if (room.creatorId !== clientId) {
      return { success: false, error: 'You do not have access to this Coco room' };
    }
    return { success: true };
  }

  private resolveTurnMode(requestedMode?: CocoRunnerMode): { ok: true; mode: CocoRunnerMode } | { ok: false; error: string } {
    const configuredMode = this.options.mode || 'plan';
    if (!requestedMode || requestedMode === configuredMode) {
      return { ok: true, mode: configuredMode };
    }
    if (requestedMode === 'plan') {
      return { ok: true, mode: 'plan' };
    }
    if (requestedMode === 'acceptEdits' && configuredMode !== 'acceptEdits') {
      return { ok: false, error: 'Coco edit mode is not enabled' };
    }
    return { ok: true, mode: requestedMode };
  }

  private async readLatestPrompt(roomId: string, clientId: string) {
    const messages = await this.store.readMessagesByRoom(roomId);
    const promptMessage = [...messages]
      .reverse()
      .find(message =>
        message.clientId === clientId &&
        message.messageType === 'text' &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0
      );
    return promptMessage?.content.trim() || '';
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
    aiMessageId: string,
    fullContent: string
  ) {
    const mapped = mapCocoRunnerEvent(event, {
      roomId,
      turnId,
      now: this.now(),
      createMessageId: prefix => `${prefix}_${this.createId()}`,
    });

    if (mapped.kind === 'ai_delta') {
      const nextContent = `${fullContent}${mapped.delta}`;
      this.emitter.to(roomId).emit('ai_chunk', { messageId: aiMessageId, chunk: mapped.delta, roomId });
      return nextContent;
    }

    if (mapped.kind === 'message') {
      const updatedRoom = await this.store.appendMessageWithAtomicPosition(mapped.message);
      if (!updatedRoom) {
        throw new Error(`Unable to persist Coco ${mapped.message.messageType} event`);
      }
      this.emitter.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
      this.emitter.to(roomId).emit('new_message', mapped.message);
    }

    return fullContent;
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

  private buildRunnerEnv(selectedModel: AIModelOption) {
    // This is the complete runner environment. Do not merge process.env here:
    // Coco subprocesses must only receive explicit sandbox/model credentials.
    return {
      PYTHONUNBUFFERED: '1',
      ...(this.options.runnerEnv || {}),
      ...(this.options.runnerProviderEnvByProvider?.[selectedModel.provider] || {}),
    };
  }
}
