import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Writable } from 'node:stream';
import { Logger } from '../logger';
import { AIModelOption, CodeAgentMode, MediaAsset, Message, Room, RoomAgentTurn, RoomAICostTotal } from '../types';
import { CodeAgentRunnerAdapter, CodeAgentBackend } from './codeAgentRunner';
import { CodeAgentDaemonProcessRegistry } from './codeAgentDaemonRegistry';
import { CodeAgentSandboxLifecycleService } from './codeAgentSandboxLifecycle';
import { CodeAgentSessionService, resolveCodeAgentTurnTimeoutMs } from './codeAgentSessionService';
import { CODE_AGENT_RUNNER_SCHEMA_VERSION, CodeAgentRunnerEvent, CodeAgentRunnerRunRequest } from './codeAgentRunnerProtocol';
import { CodeAgentRunnerClient, CodeAgentRunnerHandlers, CodeAgentRunnerRunResult } from './fakeCodeAgentRunner';
import { FakeCodeAgentRunnerClient } from './fakeCodeAgentRunner';
import { FakeCodeAgentSandboxService } from './fakeCodeAgentSandboxService';
import type { CodeAgentRunnerProcess } from './codeAgentSandboxService';
import {
  DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
  DEFAULT_CODEX_CLI_RUNNER_COMMAND,
  DEFAULT_CODE_AGENT_DAEMON_COMMAND,
  DEFAULT_CODE_AGENT_RUNNER_COMMAND,
  DEFAULT_HERMES_AGENT_RUNNER_COMMAND,
  DEFAULT_OPENCODE_RUNNER_COMMAND,
} from './codeAgentRuntimeConfig';
import { CodeAgentModelGateway, InMemoryCodeAgentModelGatewayTokenStateStore } from './codeAgentModelGateway';
import { PublishedStaticSiteService } from './publishedStaticSite';
import { MemoryMediaObjectStorage } from '../testUtils/memoryMediaObjectStorage';
import { ObservabilityEventInput } from './observabilityEvents';
import { CodeAgentRoomContextService } from './codeAgentRoomContext';
import { buildCodeAgentPriorMessages } from './codeAgentTranscript';
import { CodexConnectionError } from './codexConnection';
import { getAIStreamFence, getAIStreamOwnerId, stripAIStreamRecoveryMetadata } from './aiStreamRecovery';
import { CodeAgentCheckpointBoundary, CodeAgentCheckpointRestorePlan, CodeAgentWorkspaceRevisionRecord } from '../repositories/store';

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
  agentTurns = new Map<string, RoomAgentTurn>();
  roomLeases = new Map<string, { roomId: string; turnId: string; ownerId: string; fence: number; expiresAt: string }>();
  roomLeaseFences = new Map<string, number>();
  turnInternals = new Map<string, {
    backendSessionIdBefore?: string;
    backendLastTurnIdBefore?: string;
    workspaceCheckpoint?: any;
    workspaceParentRevisionId?: string;
    workspaceRevisionId?: string;
  }>();
  workspaceRevisions = new Map<string, CodeAgentWorkspaceRevisionRecord>();
  roomRevisionHeads = new Map<string, string>();
  mediaAssetsByMessageId = new Map<string, MediaAsset>();
  members = new Map<string, { roomId: string; clientId: string; role: string; joinedAt: string }[]>();
  appendFailures = 0;
  upsertFailures = 0;
  roomCost: RoomAICostTotal = { roomId: 'room-1', currency: 'USD', totalUsd: 0 };
  turnUsageSummary: {
    roomId: string;
    turnId: string;
    costUsd: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens: number;
  } | null = null;

  constructor(initialRoom: Room, initialMessages: Message[] = []) {
    this.rooms.set(initialRoom.id, initialRoom);
    this.messages.set(initialRoom.id, initialMessages);
    this.members.set(initialRoom.id, [
      { roomId: initialRoom.id, clientId: initialRoom.creatorId, role: 'owner', joinedAt: initialRoom.createdAt },
    ]);
    const rootRevisionId = `root:${initialRoom.id}`;
    this.workspaceRevisions.set(rootRevisionId, {
      id: rootRevisionId,
      roomId: initialRoom.id,
      kind: 'root',
      traversable: true,
      createdAt: initialRoom.createdAt,
    });
    this.roomRevisionHeads.set(initialRoom.id, rootRevisionId);
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

  async getMediaAssetByMessageId(messageId: string) {
    return this.mediaAssetsByMessageId.get(messageId) || null;
  }

  async saveRoom(room: Room) {
    const current = this.rooms.get(room.id);
    if (!current) return null;
    const saved = { ...current, ...room };
    this.rooms.set(room.id, saved);
    return saved;
  }

  async acquireCodeAgentRoomLease(roomId: string, turnId: string, ownerId: string, now: string, ttlMs: number) {
    const current = this.roomLeases.get(roomId);
    if (current && Date.parse(current.expiresAt) > Date.parse(now)) {
      return null;
    }
    const fence = (this.roomLeaseFences.get(roomId) || 0) + 1;
    this.roomLeaseFences.set(roomId, fence);
    const lease = {
      roomId,
      turnId,
      ownerId,
      fence,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    };
    this.roomLeases.set(roomId, lease);
    return lease;
  }

  async renewCodeAgentRoomLease(roomId: string, turnId: string, ownerId: string, now: string, ttlMs: number, fence?: number) {
    const current = this.roomLeases.get(roomId);
    if (
      !current ||
      current.turnId !== turnId ||
      current.ownerId !== ownerId ||
      (fence !== undefined && current.fence !== fence) ||
      Date.parse(current.expiresAt) <= Date.parse(now)
    ) {
      return null;
    }
    const renewed = { ...current, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString() };
    this.roomLeases.set(roomId, renewed);
    return renewed;
  }

  async releaseCodeAgentRoomLease(roomId: string, turnId: string, ownerId: string, fence?: number) {
    const current = this.roomLeases.get(roomId);
    if (!current || current.turnId !== turnId || current.ownerId !== ownerId || (fence !== undefined && current.fence !== fence)) {
      return false;
    }
    this.roomLeases.delete(roomId);
    return true;
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

  private hasTurnClaim(claim: { roomId: string; turnId: string; ownerId: string; fence: number }) {
    const lease = this.roomLeases.get(claim.roomId);
    const turn = this.agentTurns.get(claim.turnId);
    return Boolean(
      lease
      && turn?.status === 'running'
      && lease.turnId === claim.turnId
      && lease.ownerId === claim.ownerId
      && lease.fence === claim.fence,
    );
  }

  async beginCodeAgentTurn(input: any) {
    if (this.upsertFailures > 0) {
      this.upsertFailures--;
      throw new Error('placeholder unavailable');
    }
    const room = this.rooms.get(input.roomId);
    if (!room) return { outcome: 'missing_room' as const };
    const existingLease = this.roomLeases.get(input.roomId);
    if (existingLease && Date.parse(existingLease.expiresAt) > Date.parse(input.now)) {
      return { outcome: 'busy' as const };
    }
    let materializedPrompt: Message | undefined;
    if (input.queuedMessageId) {
      const messages = this.messages.get(input.roomId) || [];
      const queued = messages.find(message => (
        message.id === input.queuedMessageId
        && message.codeAgentQueuedInput?.state === 'starting'
      ));
      if (!queued) return { outcome: 'queue_conflict' as const };
      queued.turnId = input.turn.id;
      queued.timestamp = input.now;
      queued.updatedAt = input.now;
      queued.codeAgentQueuedInput = undefined;
      materializedPrompt = { ...queued };
    }
    const lease = await this.acquireCodeAgentRoomLease(
      input.roomId,
      input.turn.id,
      input.ownerId,
      input.now,
      input.leaseTtlMs,
    );
    if (!lease) return { outcome: 'busy' as const };
    this.agentTurns.set(input.turn.id, input.turn);
    this.turnInternals.set(input.turn.id, {
      ...(input.backendSessionIdBefore ? { backendSessionIdBefore: input.backendSessionIdBefore } : {}),
      ...(input.backendLastTurnIdBefore ? { backendLastTurnIdBefore: input.backendLastTurnIdBefore } : {}),
      ...(input.captureWorkspaceRevision
        ? { workspaceParentRevisionId: this.roomRevisionHeads.get(input.roomId)! }
        : {}),
    });
    const placeholder = input.placeholder as Message;
    this.messages.set(input.roomId, [...(this.messages.get(input.roomId) || []), placeholder]);
    const updatedRoom = {
      ...room,
      codeAgentStatus: 'running' as const,
      lastActivityAt: input.now,
    };
    this.rooms.set(input.roomId, updatedRoom);
    return {
      outcome: 'started' as const,
      room: updatedRoom,
      turn: input.turn,
      placeholder,
      lease,
      ...(materializedPrompt ? { materializedPrompt } : {}),
    };
  }

  async updateCodeAgentTurn(turn: RoomAgentTurn, claim: any) {
    if (!this.hasTurnClaim(claim)) return null;
    this.agentTurns.set(turn.id, turn);
    return turn;
  }

  async appendCodeAgentMessage(message: Message, claim: any, cost?: any) {
    if (!this.hasTurnClaim(claim)) return { outcome: 'stale' as const };
    const updatedRoom = await this.appendMessageWithAtomicPosition(message);
    if (!updatedRoom) throw new Error('append unavailable');
    const roomCostTotal = await this.incrementRoomAICost(message.roomId, cost);
    return {
      outcome: 'applied' as const,
      room: updatedRoom,
      message,
      roomCostTotal,
    };
  }

  async finalizeCodeAgentMessage(message: Message, expectedOwnership: any, claim: any, cost?: any) {
    if (!this.hasTurnClaim(claim)) return { outcome: 'stale' as const };
    const result = await this.finalizeAIMessage(message, expectedOwnership);
    if (result.outcome !== 'applied') return result;
    const roomCostTotal = await this.incrementRoomAICost(message.roomId, cost);
    return { ...result, roomCostTotal };
  }

  async finishCodeAgentTurn(input: any) {
    if (!this.hasTurnClaim(input.claim)) return { outcome: 'stale' as const };
    let message: Message | undefined;
    let actualOutcome = input.outcome;
    let finalizationObsoleted = false;
    if (input.message) {
      const result = await this.finalizeAIMessage(input.message, input.expectedMessageOwnership);
      if (result.outcome !== 'applied') {
        actualOutcome = 'cancelled';
        finalizationObsoleted = true;
      } else {
        message = result.message;
      }
    }
    const messages = [...(this.messages.get(input.claim.roomId) || [])];
    if (input.appendMessage) {
      messages.push(input.appendMessage);
      message = input.appendMessage;
    }
    const deleteIds = new Set(input.deleteMessageIds || []);
    const safeDeleteIds = new Set(messages.filter(item => (
      deleteIds.has(item.id)
      && item.roomId === input.claim.roomId
      && item.turnId === input.claim.turnId
      && item.status === 'streaming'
      && item.content === ''
    )).map(item => item.id));
    if (safeDeleteIds.size !== deleteIds.size) {
      throw new Error('refused unsafe test segment cleanup');
    }
    const remainingMessages = messages.filter(item => !safeDeleteIds.has(item.id) || item.id === message?.id);
    if (remainingMessages.some(item => item.turnId === input.claim.turnId && item.status === 'streaming')) {
      throw new Error('test terminal transition left streaming messages');
    }
    const danglingToolCall = remainingMessages.find(item => (
      item.turnId === input.claim.turnId
      && item.messageType === 'tool_call'
      && item.toolCallId
      && !remainingMessages.some(candidate => (
        candidate.turnId === input.claim.turnId
        && candidate.messageType === 'tool_result'
        && candidate.toolCallId === item.toolCallId
      ))
    ));
    if (danglingToolCall) {
      throw new Error('test terminal transition left pending tools');
    }
    this.messages.set(
      input.claim.roomId,
      remainingMessages,
    );
    if (actualOutcome === 'complete') {
      await this.incrementRoomAICost(input.claim.roomId, input.cost);
    }
    const room = this.rooms.get(input.claim.roomId)!;
    const updatedRoom = {
      ...room,
      codeAgentStatus: actualOutcome === 'error' ? 'error' as const : 'idle' as const,
      ...(actualOutcome === 'complete' && input.sessionId ? { codeAgentSessionId: input.sessionId } : {}),
      ...(actualOutcome === 'complete' && input.sessionId ? { codeAgentLastTurnId: input.backendTurnId } : {}),
      lastActivityAt: input.completedAt,
    };
    this.rooms.set(input.claim.roomId, updatedRoom);
    const currentTurn = this.agentTurns.get(input.claim.turnId)!;
    const turn: RoomAgentTurn = {
      ...currentTurn,
      status: actualOutcome,
      completedAt: input.completedAt,
      finalMessageId: actualOutcome === 'cancelled' ? undefined : (message?.id || input.finalMessageId),
      phase: undefined,
      phaseMessage: undefined,
      lastHeartbeatAt: input.completedAt,
      updatedAt: input.completedAt,
      ...(input.workspaceCheckpoint ? {
        workspaceCheckpoint: {
          status: input.workspaceCheckpoint.status,
          fileCount: input.workspaceCheckpoint.manifest?.files?.length || 0,
          restorableFileCount: input.workspaceCheckpoint.manifest?.files?.filter((file: any) => file.restorable).length || 0,
        },
      } : {}),
    };
    this.agentTurns.set(turn.id, turn);
    this.turnInternals.set(turn.id, {
      ...(this.turnInternals.get(turn.id) || {}),
      ...(input.workspaceCheckpoint ? { workspaceCheckpoint: input.workspaceCheckpoint } : {}),
    });
    if (this.turnInternals.get(turn.id)?.workspaceParentRevisionId) {
      const internal = this.turnInternals.get(turn.id)!;
      const revisionId = `turn:${turn.id}`;
      const parentRevisionId = internal.workspaceParentRevisionId || this.roomRevisionHeads.get(turn.roomId)!;
      this.workspaceRevisions.set(revisionId, {
        id: revisionId,
        roomId: turn.roomId,
        parentRevisionId,
        kind: 'turn',
        turnId: turn.id,
        ...(input.sessionId ? { backendSessionId: input.sessionId } : {}),
        ...(input.backendTurnId ? { backendLastTurnId: input.backendTurnId } : {}),
        traversable: Boolean(
          input.workspaceCheckpoint?.status === 'ready'
          && input.workspaceCheckpoint?.manifest?.files?.every((file: any) => file.restorable),
        ),
        createdAt: input.completedAt,
      });
      internal.workspaceRevisionId = revisionId;
      this.roomRevisionHeads.set(turn.roomId, revisionId);
    }
    return {
      outcome: finalizationObsoleted ? 'obsolete' as const : 'applied' as const,
      room: updatedRoom,
      turn,
      ...(message ? { message } : {}),
      roomCostTotal: this.roomCost,
    };
  }

  async finalizeAIMessage(
    message: Message,
    expectedOwnership: { ownerId: string | null; fence: number },
  ) {
    const room = this.rooms.get(message.roomId);
    const messages = this.messages.get(message.roomId);
    if (!room || !messages) return { outcome: 'obsolete' as const };
    const index = messages.findIndex(item => item.id === message.id);
    const current = index >= 0 ? messages[index] : null;
    if (
      !current
      || current.status !== 'streaming'
      || (getAIStreamOwnerId(current) || null) !== expectedOwnership.ownerId
      || getAIStreamFence(current) !== expectedOwnership.fence
    ) {
      return { outcome: 'obsolete' as const };
    }
    const publicMessage = stripAIStreamRecoveryMetadata(message);
    messages[index] = publicMessage;
    const updatedRoom = { ...room, lastActivityAt: message.timestamp };
    this.rooms.set(message.roomId, updatedRoom);
    return { outcome: 'applied' as const, room: updatedRoom, message: publicMessage };
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

  async upsertRoomAgentTurn(turn: RoomAgentTurn) {
    this.agentTurns.set(turn.id, turn);
    return turn;
  }

  async hasActiveCodeAgentRoomLease(roomId: string, now: string, turnId?: string) {
    const lease = this.roomLeases.get(roomId);
    return Boolean(
      lease
      && Date.parse(lease.expiresAt) > Date.parse(now)
      && (!turnId || lease.turnId === turnId),
    );
  }

  async readCodeAgentWorkspaceCheckpoint(roomId: string, turnId: string) {
    const turn = this.agentTurns.get(turnId);
    const internal = this.turnInternals.get(turnId);
    if (!turn || turn.roomId !== roomId || !internal?.workspaceCheckpoint) return null;
    return {
      turn,
      ...(internal.backendSessionIdBefore ? { backendSessionIdBefore: internal.backendSessionIdBefore } : {}),
      ...(internal.backendLastTurnIdBefore ? { backendLastTurnIdBefore: internal.backendLastTurnIdBefore } : {}),
      checkpoint: internal.workspaceCheckpoint,
    };
  }

  async readCodeAgentCheckpointRestorePlan(
    roomId: string,
    turnId: string,
    targetBoundary: CodeAgentCheckpointBoundary = 'before',
  ): Promise<CodeAgentCheckpointRestorePlan | null> {
    const selected = this.turnInternals.get(turnId);
    const selectedRevision = selected?.workspaceRevisionId
      ? this.workspaceRevisions.get(selected.workspaceRevisionId)
      : undefined;
    const currentRevisionId = this.roomRevisionHeads.get(roomId);
    const targetRevisionId = targetBoundary === 'after'
      ? selectedRevision?.id
      : selectedRevision?.parentRevisionId;
    if (!selected || !selectedRevision || !currentRevisionId || !targetRevisionId) return null;

    const sourcePath: CodeAgentWorkspaceRevisionRecord[] = [];
    const sourceIndex = new Map<string, number>();
    let cursor: string | undefined = currentRevisionId;
    while (cursor) {
      const revision = this.workspaceRevisions.get(cursor);
      if (!revision) throw new Error(`missing revision ${cursor}`);
      sourceIndex.set(cursor, sourcePath.length);
      sourcePath.push(revision);
      cursor = revision.parentRevisionId;
    }
    const targetBranch: CodeAgentWorkspaceRevisionRecord[] = [];
    cursor = targetRevisionId;
    while (cursor && !sourceIndex.has(cursor)) {
      const revision = this.workspaceRevisions.get(cursor);
      if (!revision) throw new Error(`missing revision ${cursor}`);
      targetBranch.push(revision);
      cursor = revision.parentRevisionId;
    }
    if (!cursor) throw new Error('missing common revision ancestor');
    const undo = sourcePath.slice(0, sourceIndex.get(cursor)!);
    const redo = targetBranch.reverse();
    const traversed = [...undo, ...redo];
    if (traversed.some(revision => !revision.traversable)) throw new Error('incomplete workspace revision');
    const steps = [
      ...undo.map(revision => ({ revision, direction: 'before' as const })),
      ...redo.map(revision => ({ revision, direction: 'after' as const })),
    ].flatMap(({ revision, direction }) => {
      if (!revision.turnId) return [];
      const checkpoint = this.turnInternals.get(revision.turnId)?.workspaceCheckpoint;
      if (!checkpoint) throw new Error(`missing checkpoint ${revision.turnId}`);
      return [{ revisionId: revision.id, turnId: revision.turnId, direction, checkpoint }];
    });
    return {
      roomId,
      checkpointTurnId: turnId,
      targetBoundary,
      currentRevisionId,
      targetRevisionId,
      alreadyAtTarget: traversed.every(revision => revision.kind === 'restore'),
      targetBackend: this.agentTurns.get(turnId)?.backend,
      ...((targetBoundary === 'before' ? selected.backendSessionIdBefore : selectedRevision.backendSessionId)
        ? { targetBackendSessionId: targetBoundary === 'before' ? selected.backendSessionIdBefore : selectedRevision.backendSessionId }
        : {}),
      ...((targetBoundary === 'before' ? selected.backendLastTurnIdBefore : selectedRevision.backendLastTurnId)
        ? { targetBackendLastTurnId: targetBoundary === 'before' ? selected.backendLastTurnIdBefore : selectedRevision.backendLastTurnId }
        : {}),
      steps,
    };
  }

  async commitCodeAgentCheckpointRestore(input: any) {
    const lease = this.roomLeases.get(input.roomId);
    const room = this.rooms.get(input.roomId);
    const turn = this.agentTurns.get(input.checkpointTurnId);
    if (
      !lease || !room || !turn
      || lease.turnId !== input.lease.turnId
      || lease.ownerId !== input.lease.ownerId
      || lease.fence !== input.lease.fence
      || this.roomRevisionHeads.get(input.roomId) !== input.sourceRevisionId
    ) return null;
    const updatedRoom = {
      ...room,
      codeAgentSessionId: input.sessionId,
      codeAgentLastTurnId: input.lastTurnId,
      codeAgentStatus: 'idle' as const,
    };
    this.rooms.set(input.roomId, updatedRoom);
    const revision: CodeAgentWorkspaceRevisionRecord = {
      id: input.resultRevisionId,
      roomId: input.roomId,
      parentRevisionId: input.targetRevisionId,
      kind: 'restore',
      restoreId: input.restoreId,
      restoredFromRevisionId: input.sourceRevisionId,
      restoreTargetRevisionId: input.targetRevisionId,
      ...(input.sessionId ? { backendSessionId: input.sessionId } : {}),
      ...(input.lastTurnId ? { backendLastTurnId: input.lastTurnId } : {}),
      traversable: true,
      createdAt: input.restoredAt,
    };
    this.workspaceRevisions.set(revision.id, revision);
    this.roomRevisionHeads.set(input.roomId, revision.id);
    this.roomLeases.delete(input.roomId);
    return { room: updatedRoom, turn, revision };
  }

  async appendMessage(message: Message) {
    return this.appendMessageWithAtomicPosition(message);
  }

  async appendMessageIdempotent(message: Message) {
    const room = this.rooms.get(message.roomId);
    if (!room) return null;
    const messages = this.messages.get(message.roomId) || [];
    const existingMessage = message.clientMessageId
      ? messages.find(item => item.clientId === message.clientId && item.clientMessageId === message.clientMessageId)
      : undefined;
    if (existingMessage) {
      return { room, message: existingMessage, inserted: false };
    }
    const updatedRoom = await this.appendMessage(message);
    return updatedRoom ? { room: updatedRoom, message, inserted: true } : null;
  }

  async updateCodeAgentQueuedMessage(roomId: string, messageId: string, update: any) {
    const room = this.rooms.get(roomId);
    const messages = this.messages.get(roomId);
    if (!room || !messages) return null;
    const index = messages.findIndex(item => item.id === messageId && item.codeAgentQueuedInput?.state === update.expectedState);
    if (index === -1) return { room, found: false };
    const updatedMessage: Message = {
      ...messages[index],
      ...(update.content !== undefined ? { content: update.content } : {}),
      updatedAt: update.updatedAt,
      codeAgentQueuedInput: update.queuedInput || undefined,
    };
    messages[index] = updatedMessage;
    return { room, found: true, updatedMessage };
  }

  async materializeCodeAgentQueuedMessage(roomId: string, messageId: string, expectedState: string, turnId?: string, insertedAt = '2026-05-03T00:00:00.000Z') {
    const room = this.rooms.get(roomId);
    const messages = this.messages.get(roomId);
    if (!room || !messages) return null;
    const index = messages.findIndex(item => item.id === messageId && item.codeAgentQueuedInput?.state === expectedState);
    if (index === -1) return { room, found: false };
    const updatedMessage: Message = {
      ...messages[index],
      timestamp: insertedAt,
      updatedAt: insertedAt,
      turnId,
      codeAgentQueuedInput: undefined,
    };
    messages.splice(index, 1);
    messages.push(updatedMessage);
    return { room, found: true, updatedMessage };
  }

  async materializeCodeAgentQueuedMessageForTurn(roomId: string, messageId: string, expectedState: string, claim: any, insertedAt?: string) {
    if (!this.hasTurnClaim(claim)) {
      const room = this.rooms.get(roomId);
      return room ? { room, found: false } : null;
    }
    return this.materializeCodeAgentQueuedMessage(roomId, messageId, expectedState, claim.turnId, insertedAt);
  }

  async claimNextCodeAgentQueuedMessage(roomId: string, updatedAt = '2026-05-03T00:00:00.000Z') {
    const room = this.rooms.get(roomId);
    const messages = this.messages.get(roomId);
    if (!room || !messages) return null;
    const message = messages.find(item => item.codeAgentQueuedInput?.state === 'queued');
    if (!message?.codeAgentQueuedInput) return null;
    message.codeAgentQueuedInput = { ...message.codeAgentQueuedInput, state: 'starting', updatedAt, lastError: undefined };
    message.updatedAt = updatedAt;
    return { room, message: { ...message, codeAgentQueuedInput: { ...message.codeAgentQueuedInput } } };
  }

  async deleteCodeAgentQueuedMessage(roomId: string, messageId: string, expectedState = 'queued') {
    const room = this.rooms.get(roomId);
    const messages = this.messages.get(roomId);
    if (!room || !messages) return null;
    const index = messages.findIndex(item => item.id === messageId && item.codeAgentQueuedInput?.state === expectedState);
    if (index === -1) return { room, deleted: false };
    messages.splice(index, 1);
    return { room, deleted: true };
  }

  async findRoomsWithQueuedCodeAgentMessages() {
    return Array.from(this.messages.entries())
      .filter(([, messages]) => messages.some(message => message.codeAgentQueuedInput?.state === 'queued'))
      .map(([roomId]) => roomId);
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

  async readRoomAIUsageForTurn(roomId: string, turnId: string) {
    const summary = this.turnUsageSummary;
    return summary?.roomId === roomId && summary.turnId === turnId ? summary : null;
  }

  async compareAndSetRoomSandboxStatus(
    roomId: string,
    expectedStatuses: string[],
    nextStatus: any,
    updatedAt = '2026-05-03T00:00:00.000Z',
    expectedSandboxId?: string,
  ) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const current = room.sandboxStatus || 'none';
    if (!expectedStatuses.includes(current)) return null;
    if (expectedSandboxId !== undefined && (room.sandboxId || '') !== expectedSandboxId) return null;
    const updated = { ...room, sandboxStatus: nextStatus, sandboxUpdatedAt: updatedAt };
    this.rooms.set(roomId, updated);
    return updated;
  }

  async replaceRoomSandbox(roomId: string, expectedSandboxId: string, next: any) {
    const room = this.rooms.get(roomId);
    if (!room || (room.sandboxId || '') !== expectedSandboxId) return null;
    const updated = { ...room, ...next };
    delete updated.codeAgentSessionId;
    delete updated.codeAgentLastTurnId;
    this.rooms.set(roomId, updated);
    return updated;
  }
}

class BlockingContextStore extends MemoryCodeAgentStore {
  contextReadOptions?: { limit?: number; beforeMessageId?: string };
  private releaseContext!: () => void;
  private readonly contextBlocked = new Promise<void>(resolve => {
    this.releaseContext = resolve;
  });
  private markContextRead!: () => void;
  readonly contextReadStarted = new Promise<void>(resolve => {
    this.markContextRead = resolve;
  });

  releaseContextRead() {
    this.releaseContext();
  }

  async readMessagePageByRoom(roomId: string, options: { limit?: number; beforeMessageId?: string } = {}) {
    this.contextReadOptions = options;
    this.markContextRead();
    await this.contextBlocked;
    const messages = this.messages.get(roomId) || [];
    const end = options.beforeMessageId
      ? Math.max(0, messages.findIndex(message => message.id === options.beforeMessageId))
      : messages.length;
    const limit = options.limit || 80;
    return {
      roomId,
      messages: messages.slice(Math.max(0, end - limit), end),
      hasMore: end > limit,
    };
  }
}

const cocoModelStep = (
  sequence: number,
  hasText: boolean,
  toolCallIds: string[],
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens?: number }
): CodeAgentRunnerEvent => ({
  schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
  type: 'model_step',
  turnId: 'turn-1',
  stepId: `turn-1:step:${sequence}`,
  sequence,
  hasText,
  toolCallIds,
  usage: { ...usage, source: 'reported' },
});

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

  async run(request: CodeAgentRunnerRunRequest, handlers: CodeAgentRunnerHandlers): Promise<CodeAgentRunnerRunResult> {
    this.requests.push(request);
    this.markStarted();
    await this.blocked;
    const textEvent: CodeAgentRunnerEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'text_delta',
      messageId: 'ai',
      delta: 'done',
    };
    const stepEvent = cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    const finalEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'final' as const,
      messageId: 'ai',
      answer: 'done',
      sessionId: 'session-blocking',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' as const },
    };
    await handlers.onEvent(textEvent);
    await handlers.onEvent(stepEvent);
    await handlers.onEvent(finalEvent);
    return { events: [textEvent, stepEvent, finalEvent], finalEvent };
  }
}

class PendingToolBlockingRunner implements CodeAgentRunnerClient {
  requests: CodeAgentRunnerRunRequest[] = [];
  private markStarted!: () => void;
  readonly started = new Promise<void>(resolve => {
    this.markStarted = resolve;
  });

  async run(request: CodeAgentRunnerRunRequest, handlers: CodeAgentRunnerHandlers): Promise<CodeAgentRunnerRunResult> {
    this.requests.push(request);
    await handlers.onEvent(cocoModelStep(1, false, ['tool-timeout'], {
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    }));
    await handlers.onEvent({
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'tool_call',
      id: 'tool-timeout',
      name: 'terminal: ROOMTALK_TEST_SECRET=must-not-be-logged sleep 999',
      args: { kind: 'execute' },
    });
    this.markStarted();
    return new Promise<CodeAgentRunnerRunResult>(() => undefined);
  }
}

class ControlledTurnDeadline {
  callback?: () => void;
  delayMs?: number;
  cleared = false;

  schedule = (callback: () => void, delayMs: number) => {
    this.callback = callback;
    this.delayMs = delayMs;
    return this;
  };

  clear = () => {
    this.cleared = true;
  };

  fire() {
    this.callback?.();
  }
}

class SequencedBlockingRunner implements CodeAgentRunnerClient {
  requests: CodeAgentRunnerRunRequest[] = [];
  completed = 0;
  private releases: Array<() => void> = [];

  release(index: number) {
    this.releases[index]?.();
  }

  async waitForRuns(count: number) {
    const deadline = Date.now() + 2_000;
    while (this.requests.length < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(this.requests.length >= count, true, `expected ${count} runner requests`);
  }

  async waitForCompletions(count: number) {
    const deadline = Date.now() + 2_000;
    while (this.completed < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(this.completed >= count, true, `expected ${count} completed runner requests`);
  }

  async run(request: CodeAgentRunnerRunRequest, handlers: CodeAgentRunnerHandlers): Promise<CodeAgentRunnerRunResult> {
    this.requests.push(request);
    await new Promise<void>(resolve => this.releases.push(resolve));
    const textEvent: CodeAgentRunnerEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'text_delta',
      messageId: request.turnId,
      delta: `done ${this.requests.length}`,
    };
    const stepEvent: CodeAgentRunnerEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'model_step',
      turnId: request.turnId,
      stepId: `${request.turnId}:step:1`,
      sequence: 1,
      hasText: true,
      toolCallIds: [],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
    };
    const finalEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'final' as const,
      messageId: request.turnId,
      answer: `done ${this.requests.length}`,
      sessionId: `session-${this.requests.length}`,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' as const },
    };
    await handlers.onEvent(textEvent);
    await handlers.onEvent(stepEvent);
    await handlers.onEvent(finalEvent);
    this.completed += 1;
    return { events: [textEvent, stepEvent, finalEvent], finalEvent };
  }
}

class ControlBlockingRunner implements CodeAgentRunnerClient {
  requests: CodeAgentRunnerRunRequest[] = [];
  handlers?: CodeAgentRunnerHandlers;
  private releaseRun!: () => void;
  started = new Promise<void>(resolve => {
    this.markStarted = resolve;
  });
  private markStarted!: () => void;
  private blocked = new Promise<void>(resolve => {
    this.releaseRun = resolve;
  });

  constructor(private readonly acceptControls = true) {}

  async receiveControl(control: any) {
    await this.handlers?.onEvent({
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'control_result',
      turnId: control.turnId,
      controlId: control.controlId,
      controlType: control.type,
      accepted: this.acceptControls,
      message: this.acceptControls ? undefined : 'turn already completed',
    });
    if (control.type === 'steer' && control.messageId && this.acceptControls) {
      await this.handlers?.onEvent({
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'user_input_inserted',
        turnId: control.turnId,
        messageId: control.messageId,
      });
    }
    if (control.type === 'interrupt' && this.acceptControls) {
      this.releaseRun();
    }
  }

  release() {
    this.releaseRun();
  }

  async run(request: CodeAgentRunnerRunRequest, handlers: CodeAgentRunnerHandlers): Promise<CodeAgentRunnerRunResult> {
    this.requests.push(request);
    this.handlers = handlers;
    this.markStarted();
    await this.blocked;
    const textEvent: CodeAgentRunnerEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'text_delta',
      messageId: request.turnId,
      delta: 'stopped',
    };
    const stepEvent: CodeAgentRunnerEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'model_step',
      turnId: request.turnId,
      stepId: `${request.turnId}:step:1`,
      sequence: 1,
      hasText: true,
      toolCallIds: [],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
    };
    const finalEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'final' as const,
      messageId: request.turnId,
      answer: 'stopped',
      sessionId: 'session-controlled',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' as const },
    };
    await handlers.onEvent(textEvent);
    await handlers.onEvent(stepEvent);
    await handlers.onEvent(finalEvent);
    return { events: [textEvent, stepEvent, finalEvent], finalEvent };
  }
}

class InterruptibleRunner implements CodeAgentRunnerClient {
  requests: CodeAgentRunnerRunRequest[] = [];
  private handlers?: CodeAgentRunnerHandlers;
  private releaseRun!: () => void;
  private readonly blocked = new Promise<void>(resolve => {
    this.releaseRun = resolve;
  });
  private markStarted!: () => void;
  readonly started = new Promise<void>(resolve => {
    this.markStarted = resolve;
  });

  constructor(
    private readonly acknowledgeInterrupt = false,
    private readonly emitPendingTool = false,
  ) {}

  async receiveControl(control: any) {
    if (!this.acknowledgeInterrupt) return;
    await this.handlers?.onEvent({
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'control_result',
      turnId: control.turnId,
      controlId: control.controlId,
      controlType: control.type,
      accepted: true,
    });
  }

  release() {
    this.releaseRun();
  }

  async run(request: CodeAgentRunnerRunRequest, handlers: CodeAgentRunnerHandlers): Promise<CodeAgentRunnerRunResult> {
    this.requests.push(request);
    this.handlers = handlers;
    if (this.emitPendingTool) {
      await handlers.onEvent(cocoModelStep(1, false, ['tool-interrupt'], {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
      }));
      await handlers.onEvent({
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'tool_call',
        id: 'tool-interrupt',
        name: 'Shell',
        args: { command: 'sleep 999' },
      });
    }
    this.markStarted();
    await this.blocked;
    return { events: [] };
  }
}

const createInterruptibleProcess = (
  input: { command: string },
  runner: InterruptibleRunner,
  acknowledgeControl: boolean,
) => {
  const state = { terminateCount: 0 };
  const process: CodeAgentRunnerProcess = {
    command: input.command,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        if (!acknowledgeControl) {
          callback();
          return;
        }
        void runner.receiveControl(JSON.parse(String(chunk))).then(() => callback(), callback);
      },
    }),
    stop: async () => undefined,
    terminate: async () => {
      state.terminateCount += 1;
      runner.release();
    },
  };
  return { process, state };
};

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

const invalidToolPair = (
  id: string,
  options: {
    name?: string;
    kind?: string;
    success?: boolean;
    secret?: string;
    failureCode?: 'invalid_tool';
  } = {},
): CodeAgentRunnerEvent[] => {
  const name = options.name ?? 'invalid';
  return [
    {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'tool_call',
      id,
      messageId: `call-${id}`,
      name,
      args: {
        kind: options.kind ?? 'other',
        ...(options.secret ? { opaqueInput: options.secret } : {}),
      },
    },
    {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'tool_result',
      id,
      messageId: `result-${id}`,
      name,
      success: options.success ?? false,
      output: options.secret || (options.success
        ? 'recovered'
        : options.failureCode
          ? 'OpenCode rejected an invalid tool request.'
          : 'invalid tool request'),
      ...(options.failureCode ? { failureCode: options.failureCode } : {}),
    },
  ];
};

const acpFinalEvent = (backend: CodeAgentBackend, answer = 'Recovered normally.'): CodeAgentRunnerEvent => ({
  schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
  type: 'final',
  messageId: `${backend}-final-message`,
  answer,
  sessionId: `acp:${backend}:session-1`,
});

const createTestModelGateway = () => new CodeAgentModelGateway({
  publicBaseUrl: 'https://room.example/api/code-agent/model-gateway',
  tokenSecret: 'gateway-secret',
  providerApiKeys: { deepseek: 'deepseek-provider-key' },
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
  githubConnectionService?: any;
  mode?: CodeAgentMode;
  availableModes?: CodeAgentMode[];
  defaultMode?: CodeAgentMode;
  availableBackends?: CodeAgentBackend[];
  modelGateway?: CodeAgentModelGateway;
  staticSitePublisher?: PublishedStaticSiteService;
  roomContext?: CodeAgentRoomContextService;
  observability?: ReturnType<typeof createMemoryObservability>['recorder'];
  mediaObjectStorage?: MemoryMediaObjectStorage;
  aiStreamOwnerId?: string;
  activeSandboxTtlMs?: number;
  idleSandboxTtlMs?: number;
  roomLeaseTtlMs?: number;
  turnTimeoutMs?: number;
  scheduleTurnDeadline?: (callback: () => void, delayMs: number) => unknown;
  clearTurnDeadline?: (handle: unknown) => void;
  now?: () => Date;
  logger?: Logger;
} = {}) => {
  const store = options.store || new MemoryCodeAgentStore(room(), [userMessage()]);
  const emitter = new FakeEmitter();
  const now = options.now || (() => new Date('2026-05-03T00:00:00.000Z'));
  const serviceLogger = options.logger || logger;
  const sandboxService = new FakeCodeAgentSandboxService(now);
  const lifecycle = new CodeAgentSandboxLifecycleService(store as any, sandboxService, serviceLogger, {
    sandboxTtlMs: 60 * 60 * 1000,
    activeSandboxTtlMs: options.activeSandboxTtlMs ?? 60 * 60 * 1000,
    idleSandboxTtlMs: options.idleSandboxTtlMs ?? 2 * 60 * 1000,
    creatingStaleMs: 2 * 60 * 1000,
    maxActiveSandboxes: 10,
    maxActiveSandboxesPerUser: 10,
  }, now);
  const ids = [...(options.ids || ['ai-1', 'turn-1', 'status-1', 'result-1', 'error-1'])];
  const service = new CodeAgentSessionService(
    store as any,
    emitter,
    lifecycle,
    sandboxService,
    new CodeAgentRunnerAdapter(options.runner || new FakeCodeAgentRunnerClient([]), options.backend || 'code-agent'),
    serviceLogger,
    {
      enabled: options.enabled ?? true,
      allowedClientIds: options.allowedClientIds,
      mode: options.mode,
      availableModes: options.availableModes,
      defaultMode: options.defaultMode,
      availableBackends: options.availableBackends,
      modelGateway: options.modelGateway,
      backend: options.backend,
      runnerClient: options.runnerClient,
      runnerCommand: options.runnerCommand,
      runnerCommandByBackend: options.runnerCommandByBackend,
      daemonCommand: options.daemonCommand,
      daemonRegistry: options.daemonRegistry,
      staticSitePublisher: options.staticSitePublisher,
      roomContext: options.roomContext,
      runnerEnv: options.runnerEnv,
      runnerEnvByBackend: options.runnerEnvByBackend,
      runnerProviderEnvByProvider: options.runnerProviderEnvByProvider,
      codexBackendEnabled: options.codexBackendEnabled,
      codexConnectionService: options.codexConnectionService,
      githubConnectionService: options.githubConnectionService,
      now,
      createId: () => ids.shift() || 'id-fallback',
      observability: options.observability,
      mediaObjectStorage: options.mediaObjectStorage,
      aiStreamOwnerId: options.aiStreamOwnerId,
      roomLeaseTtlMs: options.roomLeaseTtlMs,
      turnTimeoutMs: options.turnTimeoutMs,
      scheduleTurnDeadline: options.scheduleTurnDeadline,
      clearTurnDeadline: options.clearTurnDeadline,
    }
  );
  return { emitter, lifecycle, sandboxService, service, store };
};

describe('CodeAgentSessionService', () => {
  it('restores a workspace revision atomically and forks Codex context at the pre-turn boundary', async () => {
    const store = new MemoryCodeAgentStore(room({
      codeAgentBackend: 'codex-app-server',
      codeAgentSessionId: 'thread-current',
      codeAgentLastTurnId: 'turn-current',
      codeAgentStatus: 'idle',
    }));
    const mediaObjectStorage = new MemoryMediaObjectStorage();
    const { lifecycle, sandboxService, service } = createService({
      store,
      backend: 'codex-app-server',
      codexBackendEnabled: true,
      mediaObjectStorage,
      ids: ['restore-1'],
    });
    const ready = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(ready.ok, true);
    if (!ready.ok) return;

    await sandboxService.writeWorkspaceFile(ready.handle, { path: 'src/safe.txt', content: 'before safe' });
    await sandboxService.writeWorkspaceFile(ready.handle, { path: 'src/conflict.txt', content: 'before conflict' });
    await sandboxService.beginWorkspaceCheckpoint(ready.handle, 'turn-checkpoint');
    await sandboxService.writeWorkspaceFile(ready.handle, { path: 'src/safe.txt', content: 'agent safe' });
    await sandboxService.writeWorkspaceFile(ready.handle, { path: 'src/conflict.txt', content: 'agent conflict' });
    const archive = await sandboxService.finalizeWorkspaceCheckpoint(ready.handle, 'turn-checkpoint');
    const objectKey = 'code-agent-checkpoints/v1/room-1/turn-checkpoint.tar.gz';
    await mediaObjectStorage.putMediaObject({
      objectKey,
      body: archive.body,
      mimeType: 'application/gzip',
      byteSize: archive.byteSize,
    });
    const checkpoint = {
      schemaVersion: 1 as const,
      status: 'ready' as const,
      objectKey,
      archiveByteSize: archive.byteSize,
      manifest: archive.manifest,
    };
    const checkpointTurn: RoomAgentTurn = {
      id: 'turn-checkpoint',
      roomId: 'room-1',
      status: 'complete',
      startedAt: '2026-05-03T00:00:00.000Z',
      completedAt: '2026-05-03T00:01:00.000Z',
      backend: 'codex-app-server',
      assistantName: 'Codex',
      updatedAt: '2026-05-03T00:01:00.000Z',
      workspaceCheckpoint: { status: 'ready', fileCount: 2, restorableFileCount: 2 },
    };
    store.agentTurns.set(checkpointTurn.id, checkpointTurn);
    store.turnInternals.set(checkpointTurn.id, {
      backendSessionIdBefore: 'thread-before',
      backendLastTurnIdBefore: 'turn-before',
      workspaceCheckpoint: checkpoint,
      workspaceParentRevisionId: 'root:room-1',
      workspaceRevisionId: 'turn:turn-checkpoint',
    });
    store.workspaceRevisions.set('turn:turn-checkpoint', {
      id: 'turn:turn-checkpoint',
      roomId: 'room-1',
      parentRevisionId: 'root:room-1',
      kind: 'turn',
      turnId: 'turn-checkpoint',
      backendSessionId: 'thread-current',
      backendLastTurnId: 'turn-current',
      traversable: true,
      createdAt: checkpointTurn.completedAt!,
    });
    store.roomRevisionHeads.set('room-1', 'turn:turn-checkpoint');

    let forkRequest: any;
    (service as any).runCodexThreadQuery = async (input: any) => {
      forkRequest = input.request;
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'thread_fork_result',
        threadId: 'thread-forked',
      };
    };

    const restored = await service.restoreWorkspaceCheckpoint({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-checkpoint',
    });

    assert.deepEqual(restored, {
      success: true,
      restoredPaths: ['src/conflict.txt', 'src/safe.txt'],
      conflictPaths: [],
      unavailablePaths: [],
      sessionId: 'thread-forked',
      sourceRevisionId: 'turn:turn-checkpoint',
      targetRevisionId: 'root:room-1',
      resultRevisionId: 'restore:restore-1',
    });
    assert.equal((await sandboxService.readWorkspaceFile(ready.handle, 'src/safe.txt')).content, 'before safe');
    assert.equal((await sandboxService.readWorkspaceFile(ready.handle, 'src/conflict.txt')).content, 'before conflict');
    assert.equal(forkRequest.threadId, 'thread-before');
    assert.equal(forkRequest.lastTurnId, 'turn-before');
    assert.equal((await store.getRoomById('room-1'))?.codeAgentSessionId, 'thread-forked');
    assert.equal((await store.getRoomById('room-1'))?.codeAgentLastTurnId, 'turn-before');
  });

  it('moves backward and forward across workspace revision branches', async () => {
    const store = new MemoryCodeAgentStore(room({
      codeAgentBackend: 'codex-app-server',
      codeAgentSessionId: 'thread-after-c',
      codeAgentLastTurnId: 'backend-c',
      codeAgentStatus: 'idle',
    }));
    const mediaObjectStorage = new MemoryMediaObjectStorage();
    const { lifecycle, sandboxService, service } = createService({
      store,
      backend: 'codex-app-server',
      codexBackendEnabled: true,
      mediaObjectStorage,
      ids: ['restore-back', 'restore-noop', 'restore-forward', 'restore-leaf'],
    });
    const ready = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(ready.ok, true);
    if (!ready.ok) return;

    await sandboxService.writeWorkspaceFile(ready.handle, { path: 'state.txt', content: 'S0' });
    const checkpoints: any[] = [];
    for (const [turnId, content] of [['turn-a', 'A'], ['turn-b', 'B'], ['turn-c', 'C']] as const) {
      await sandboxService.beginWorkspaceCheckpoint(ready.handle, turnId);
      await sandboxService.writeWorkspaceFile(ready.handle, { path: 'state.txt', content });
      const archive = await sandboxService.finalizeWorkspaceCheckpoint(ready.handle, turnId);
      const objectKey = `code-agent-checkpoints/v1/room-1/${turnId}.tar.gz`;
      await mediaObjectStorage.putMediaObject({
        objectKey,
        body: archive.body,
        mimeType: 'application/gzip',
        byteSize: archive.byteSize,
      });
      checkpoints.push({ ...archive, objectKey });
    }

    const turnIds = ['turn-a', 'turn-b', 'turn-c'];
    const backendBefore = [
      ['thread-root', 'backend-root'],
      ['thread-after-a', 'backend-a'],
      ['thread-after-b', 'backend-b'],
    ];
    let parentRevisionId = 'root:room-1';
    turnIds.forEach((turnId, index) => {
      const revisionId = `turn:${turnId}`;
      const checkpoint = {
        schemaVersion: 1 as const,
        status: 'ready' as const,
        objectKey: checkpoints[index].objectKey,
        archiveByteSize: checkpoints[index].byteSize,
        manifest: checkpoints[index].manifest,
      };
      const turnRecord: RoomAgentTurn = {
        id: turnId,
        roomId: 'room-1',
        status: 'complete',
        startedAt: `2026-05-03T00:0${index}:00.000Z`,
        completedAt: `2026-05-03T00:0${index}:30.000Z`,
        backend: 'codex-app-server',
        assistantName: 'Codex',
        updatedAt: `2026-05-03T00:0${index}:30.000Z`,
        workspaceCheckpoint: { status: 'ready', fileCount: 1, restorableFileCount: 1 },
      };
      store.agentTurns.set(turnId, turnRecord);
      store.turnInternals.set(turnId, {
        backendSessionIdBefore: backendBefore[index][0],
        backendLastTurnIdBefore: backendBefore[index][1],
        workspaceCheckpoint: checkpoint,
        workspaceParentRevisionId: parentRevisionId,
        workspaceRevisionId: revisionId,
      });
      store.workspaceRevisions.set(revisionId, {
        id: revisionId,
        roomId: 'room-1',
        parentRevisionId,
        kind: 'turn',
        turnId,
        backendSessionId: `thread-after-${turnId.at(-1)}`,
        backendLastTurnId: `backend-${turnId.at(-1)}`,
        traversable: true,
        createdAt: turnRecord.completedAt!,
      });
      parentRevisionId = revisionId;
    });
    store.roomRevisionHeads.set('room-1', 'turn:turn-c');

    const forkRequests: any[] = [];
    (service as any).runCodexThreadQuery = async (input: any) => {
      forkRequests.push(input.request);
      return {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'thread_fork_result',
        threadId: `fork-${forkRequests.length}`,
      };
    };

    const backward = await service.restoreWorkspaceCheckpoint({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-b',
    });
    assert.equal(backward.success, true);
    assert.equal((await sandboxService.readWorkspaceFile(ready.handle, 'state.txt')).content, 'A');
    assert.equal(backward.sourceRevisionId, 'turn:turn-c');
    assert.equal(backward.targetRevisionId, 'turn:turn-a');
    assert.equal(store.workspaceRevisions.get('restore:restore-back')?.parentRevisionId, 'turn:turn-a');
    assert.equal(forkRequests[0].threadId, 'thread-after-a');
    assert.equal(forkRequests[0].lastTurnId, 'backend-a');

    const noOp = await service.restoreWorkspaceCheckpoint({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-b',
    });
    assert.equal(noOp.success, true);
    assert.equal(noOp.alreadyAtTarget, true);
    assert.equal(forkRequests.length, 1);

    const forward = await service.restoreWorkspaceCheckpoint({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-c',
    });
    assert.equal(forward.success, true);
    assert.equal((await sandboxService.readWorkspaceFile(ready.handle, 'state.txt')).content, 'B');
    assert.equal(forward.sourceRevisionId, 'restore:restore-back');
    assert.equal(forward.targetRevisionId, 'turn:turn-b');
    assert.equal(store.workspaceRevisions.get('restore:restore-forward')?.parentRevisionId, 'turn:turn-b');
    assert.equal(forkRequests[1].threadId, 'thread-after-b');
    assert.equal(forkRequests[1].lastTurnId, 'backend-b');

    const leaf = await service.restoreWorkspaceCheckpoint({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-c',
      targetBoundary: 'after',
    });
    assert.equal(leaf.success, true);
    assert.equal((await sandboxService.readWorkspaceFile(ready.handle, 'state.txt')).content, 'C');
    assert.equal(leaf.sourceRevisionId, 'restore:restore-forward');
    assert.equal(leaf.targetRevisionId, 'turn:turn-c');
    assert.equal(store.workspaceRevisions.get('restore:restore-leaf')?.parentRevisionId, 'turn:turn-c');
    assert.equal(forkRequests[2].threadId, 'thread-after-c');
    assert.equal(forkRequests[2].lastTurnId, 'backend-c');
  });

  it('rolls back an earlier DAG step when an intermediate user edit makes the target ambiguous', async () => {
    const store = new MemoryCodeAgentStore(room({
      codeAgentBackend: 'codex-app-server',
      codeAgentSessionId: 'thread-after-b',
      codeAgentLastTurnId: 'backend-b',
      codeAgentStatus: 'idle',
    }));
    const mediaObjectStorage = new MemoryMediaObjectStorage();
    const { lifecycle, sandboxService, service } = createService({
      store,
      backend: 'codex-app-server',
      codexBackendEnabled: true,
      mediaObjectStorage,
      ids: ['restore-conflict'],
    });
    const ready = await lifecycle.ensureReadySandbox('room-1', 'client-1');
    assert.equal(ready.ok, true);
    if (!ready.ok) return;

    await sandboxService.writeWorkspaceFile(ready.handle, { path: 'state.txt', content: 'S0' });
    await sandboxService.beginWorkspaceCheckpoint(ready.handle, 'turn-a');
    await sandboxService.writeWorkspaceFile(ready.handle, { path: 'state.txt', content: 'A' });
    const archiveA = await sandboxService.finalizeWorkspaceCheckpoint(ready.handle, 'turn-a');
    await sandboxService.writeWorkspaceFile(ready.handle, { path: 'state.txt', content: 'USER' });
    await sandboxService.beginWorkspaceCheckpoint(ready.handle, 'turn-b');
    await sandboxService.writeWorkspaceFile(ready.handle, { path: 'state.txt', content: 'B' });
    const archiveB = await sandboxService.finalizeWorkspaceCheckpoint(ready.handle, 'turn-b');

    for (const [turnId, archive] of [['turn-a', archiveA], ['turn-b', archiveB]] as const) {
      const objectKey = `code-agent-checkpoints/v1/room-1/${turnId}.tar.gz`;
      await mediaObjectStorage.putMediaObject({ objectKey, body: archive.body, mimeType: 'application/gzip', byteSize: archive.byteSize });
      const parentRevisionId = turnId === 'turn-a' ? 'root:room-1' : 'turn:turn-a';
      const revisionId = `turn:${turnId}`;
      store.agentTurns.set(turnId, {
        id: turnId,
        roomId: 'room-1',
        status: 'complete',
        startedAt: '2026-05-03T00:00:00.000Z',
        completedAt: '2026-05-03T00:01:00.000Z',
        backend: 'codex-app-server',
        assistantName: 'Codex',
        updatedAt: '2026-05-03T00:01:00.000Z',
        workspaceCheckpoint: { status: 'ready', fileCount: 1, restorableFileCount: 1 },
      });
      store.turnInternals.set(turnId, {
        backendSessionIdBefore: turnId === 'turn-a' ? 'thread-root' : 'thread-after-a',
        backendLastTurnIdBefore: turnId === 'turn-a' ? 'backend-root' : 'backend-a',
        workspaceCheckpoint: {
          schemaVersion: 1,
          status: 'ready',
          objectKey,
          archiveByteSize: archive.byteSize,
          manifest: archive.manifest,
        },
        workspaceParentRevisionId: parentRevisionId,
        workspaceRevisionId: revisionId,
      });
      store.workspaceRevisions.set(revisionId, {
        id: revisionId,
        roomId: 'room-1',
        parentRevisionId,
        kind: 'turn',
        turnId,
        traversable: true,
        createdAt: '2026-05-03T00:01:00.000Z',
      });
    }
    store.roomRevisionHeads.set('room-1', 'turn:turn-b');
    let forked = false;
    (service as any).runCodexThreadQuery = async () => {
      forked = true;
      throw new Error('must not fork on conflict');
    };

    const result = await service.restoreWorkspaceCheckpoint({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-a',
    });
    assert.equal(result.success, false);
    assert.deepEqual(result.conflictPaths, ['state.txt']);
    assert.equal((await sandboxService.readWorkspaceFile(ready.handle, 'state.txt')).content, 'B');
    assert.equal(store.roomRevisionHeads.get('room-1'), 'turn:turn-b');
    assert.equal(forked, false);
  });

  it('signs linked object-storage images for the runner without writing sandbox files', async () => {
    const imageMessage: Message = {
      id: 'image-message-1',
      roomId: 'room-1',
      clientId: 'client-1',
      content: '',
      timestamp: '2026-05-03T00:00:00.000Z',
      messageType: 'media',
      mediaAsset: { id: 'asset-1', kind: 'image', mimeType: 'image/png', byteSize: 3 },
    };
    const promptMessage: Message = {
      ...userMessage('inspect this screenshot'),
      id: 'prompt-with-image',
      codeAgentImageMessageIds: [imageMessage.id],
    };
    const store = new MemoryCodeAgentStore(room(), [imageMessage, promptMessage]);
    store.mediaAssetsByMessageId.set(imageMessage.id, {
      ...imageMessage.mediaAsset!,
      roomId: 'room-1',
      messageId: imageMessage.id,
      objectKey: 'rooms/room-1/media/image/asset-1',
      createdAt: imageMessage.timestamp,
    });
    const mediaObjectStorage = new MemoryMediaObjectStorage();
    await mediaObjectStorage.putMediaObject({
      objectKey: 'rooms/room-1/media/image/asset-1',
      body: Buffer.from('png'),
      mimeType: 'image/png',
      byteSize: 3,
    });
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { sandboxService, service } = createService({ store, runner, mediaObjectStorage });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(runner.requests[0].images, [{
      url: 'https://download.example/rooms%2Froom-1%2Fmedia%2Fimage%2Fasset-1',
    }]);
    assert.deepEqual(mediaObjectStorage.readUrlRequests, [{
      objectKey: 'rooms/room-1/media/image/asset-1',
      expiresInSeconds: 2 * 60 * 60,
    }]);
    assert.deepEqual(sandboxService.deletedSecretFilePaths, []);
  });

  it('rejects image input on the deprecated Codex CLI backend', async () => {
    const imageMessage: Message = {
      id: 'legacy-image-message',
      roomId: 'room-1',
      clientId: 'client-1',
      content: '',
      timestamp: '2026-05-03T00:00:00.000Z',
      messageType: 'media',
      mediaAsset: { id: 'legacy-asset', kind: 'image', mimeType: 'image/png', byteSize: 3 },
    };
    const promptMessage: Message = {
      ...userMessage('inspect this screenshot'),
      id: 'legacy-prompt-with-image',
      codeAgentImageMessageIds: [imageMessage.id],
    };
    const store = new MemoryCodeAgentStore(
      room({ codeAgentBackend: 'codex' }),
      [imageMessage, promptMessage],
    );
    const runner = new FakeCodeAgentRunnerClient([]);
    const { service } = createService({
      store,
      runner,
      backend: 'codex',
      codexBackendEnabled: true,
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(result, {
      success: false,
      error: 'Image input requires Codex app-server or Coco',
    });
    assert.equal(runner.requests.length, 0);
  });

  it('rejects turns for a backend that is not currently available', async () => {
    const store = new MemoryCodeAgentStore(
      room({ codeAgentBackend: 'opencode' }),
      [userMessage()],
    );
    const runner = new FakeCodeAgentRunnerClient([]);
    const { service } = createService({
      store,
      runner,
      availableBackends: ['code-agent'],
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(result, { success: false, error: 'OpenCode backend is not enabled' });
    assert.equal(runner.requests.length, 0);
  });

  it('runs a full fake code-agent turn and persists runner events', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'status', turnId: 'turn-1', status: 'starting', message: 'starting' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Working...' },
      cocoModelStep(1, true, ['tool-1'], { promptTokens: 60, completionTokens: 10, totalTokens: 70 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Read', args: { file_path: 'README.md' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Read', success: true, output: '# RoomTalk' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      cocoModelStep(2, true, [], { promptTokens: 40, completionTokens: 10, totalTokens: 50 }),
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
    assert.deepEqual(sandboxService.startedRunnerTimeouts, [0]);
    assert.deepEqual(sandboxService.startedRunnerEnvs[0], {
      PYTHONUNBUFFERED: '1',
      ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true',
    });
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
    assert.equal((messages[1] as any).aiStreamOwnerId, undefined);
    assert.equal((messages[1] as any).aiStreamFence, undefined);
    assert.equal(messages[2].toolCallId, 'tool-1');
    assert.equal(messages[3].toolOutputPreview, '# RoomTalk');
    assert.equal(messages[3].content, '# RoomTalk');
    assert.equal(messages[4].status, 'complete');
    assert.equal(messages[4].content, 'Done');
    assert.ok(Math.abs((messages[1].cost?.totalUsd || 0) - 0.0000272) < 1e-12);
    assert.ok(Math.abs((messages[4].cost?.totalUsd || 0) - 0.0000218) < 1e-12);
    assert.ok(Math.abs(store.roomCost.totalUsd - 0.000049) < 1e-12);
    const streamEnd = emitter.roomEmits.find(event => event.event === 'ai_stream_end' && (event.args[0] as any)?.messageId === messages[4].id);
    assert.ok(Math.abs(((streamEnd?.args[0] as any)?.cost?.totalUsd || 0) - 0.0000218) < 1e-12);
    assert.equal((await store.getRoomById('room-1'))?.codeAgentStatus, 'idle');
    assert.equal((await store.getRoomById('room-1'))?.codeAgentSessionId, 'session-1');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_chunk'), true);
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_end'), true);
    const persistedTurn = [...store.agentTurns.values()][0];
    assert.equal(persistedTurn.status, 'complete');
    assert.equal(persistedTurn.finalMessageId, messages[4].id);
    assert.ok(persistedTurn.completedAt);
    const turnUpdates = emitter.roomEmits
      .filter(event => event.event === 'agent_turn_updated')
      .map(event => event.args[0] as RoomAgentTurn);
    assert.deepEqual(turnUpdates.map(turn => turn.phase), [
      'preparing_context',
      'preparing_sandbox',
      'starting_agent',
      'running',
      'completing',
      undefined,
    ]);
    assert.deepEqual(turnUpdates.map(turn => turn.status), [
      'running',
      'running',
      'running',
      'running',
      'running',
      'complete',
    ]);
    assert.equal(sandboxService.stoppedRunnerCommands.length, 1);
    assert.deepEqual(observability.events.map(event => event.event), [
      'code_agent.turn.started',
      'code_agent.sandbox.ensure',
      'code_agent.runner.started',
      'code_agent.runner.status',
      'code_agent.runner.model_step',
      'code_agent.runner.tool_call',
      'code_agent.runner.tool_result',
      'code_agent.runner.model_step',
      'code_agent.runner.final',
      'code_agent.turn.completed',
    ]);
    assert.equal((observability.events[3].payload as any)?.messageLength, 'starting'.length);
    assert.equal('message' in (observability.events[3].payload as any), false);
    assert.equal((observability.events[6].payload as any)?.outputLength, '# RoomTalk'.length);
    assert.equal(observability.events.some(event => event.event === 'code_agent.runner.text_delta'), false);
  });

  it('persists an ACP final answer when the harness does not stream text deltas', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done without streaming',
        sessionId: 'acp:hermes-agent:session-1',
      },
    ]);
    const { service, store } = createService({
      runner,
      backend: 'hermes-agent',
      availableBackends: ['hermes-agent'],
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, true);
    const aiMessage = (store.messages.get('room-1') || []).find(message => message.messageType === 'ai');
    assert.equal(aiMessage?.status, 'complete');
    assert.equal(aiMessage?.content, 'Done without streaming');
    assert.equal((await store.getRoomById('room-1'))?.codeAgentSessionId, 'acp:hermes-agent:session-1');
  });

  it('uses every gateway settlement for an ACP message cost', async () => {
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'hermes-agent' }), [userMessage()]);
    store.turnUsageSummary = {
      roomId: 'room-1',
      turnId: 'turn-1',
      costUsd: 0.010415255,
      promptTokens: 123937,
      completionTokens: 505,
      totalTokens: 124442,
      cachedPromptTokens: 51584,
    };
    const gateway = new CodeAgentModelGateway({
      publicBaseUrl: 'https://room.example/api/code-agent/model-gateway',
      tokenSecret: 'gateway-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      stateStore: new InMemoryCodeAgentModelGatewayTokenStateStore(),
    });
    const runner = new FakeCodeAgentRunnerClient([{
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'final',
      messageId: 'ai-1',
      answer: 'Done',
      sessionId: 'acp:hermes-agent:session-1',
      usage: {
        promptTokens: 123563,
        completionTokens: 445,
        totalTokens: 124008,
        cachedPromptTokens: 51584,
        source: 'reported',
      },
    }]);
    const { emitter, service } = createService({
      store,
      runner,
      backend: 'hermes-agent',
      availableBackends: ['hermes-agent'],
      modelGateway: gateway,
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, true);
    const aiMessage = (store.messages.get('room-1') || []).find(message => message.messageType === 'ai');
    assert.equal(aiMessage?.usage?.promptTokens, 123937);
    assert.equal(aiMessage?.usage?.completionTokens, 505);
    assert.equal(aiMessage?.usage?.totalTokens, 124442);
    assert.equal(aiMessage?.cost?.totalUsd, 0.010415255);
    const streamEnd = emitter.roomEmits.find(event => event.event === 'ai_stream_end');
    assert.equal((streamEnd?.args[0] as any)?.cost?.totalUsd, 0.010415255);
  });

  it('fails an ACP turn that finalizes without text or tool activity', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: '',
        sessionId: 'acp:hermes-agent:stale-session',
      },
    ]);
    const { service, store } = createService({
      runner,
      backend: 'hermes-agent',
      availableBackends: ['hermes-agent'],
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const aiMessage = (store.messages.get('room-1') || []).find(message => message.messageType === 'ai');
    assert.equal(aiMessage?.status, 'error');
    assert.equal(aiMessage?.content, 'Hermes task failed. Retry, or switch engines if the problem continues.');
    assert.equal([...store.agentTurns.values()][0]?.status, 'error');
    assert.equal((await store.getRoomById('room-1'))?.codeAgentSessionId, undefined);
  });

  it('starts a fresh ACP session in the same turn that replaces its sandbox', async () => {
    const store = new MemoryCodeAgentStore(room({
      sandboxId: 'expired-sandbox',
      sandboxStatus: 'expired',
      sandboxUpdatedAt: '2026-05-02T00:00:00.000Z',
      codeAgentSessionId: 'acp:hermes-agent:stale-session',
      codeAgentLastTurnId: 'stale-turn',
    }), [userMessage()]);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Fresh session' },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Fresh session',
        sessionId: 'acp:hermes-agent:fresh-session',
      },
    ]);
    const { service } = createService({
      store,
      runner,
      backend: 'hermes-agent',
      availableBackends: ['hermes-agent'],
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, true);
    assert.equal(runner.requests[0].sessionId, null);
    assert.equal((await store.getRoomById('room-1'))?.codeAgentSessionId, 'acp:hermes-agent:fresh-session');
    assert.equal((await store.getRoomById('room-1'))?.codeAgentLastTurnId, undefined);
  });

  it('uses the adopted sandbox room state instead of a stale pre-ensure ACP session', async () => {
    const store = new MemoryCodeAgentStore(room({
      codeAgentBackend: 'hermes-agent',
      codeAgentSessionId: 'acp:hermes-agent:stale-session',
      codeAgentLastTurnId: 'stale-turn',
    }), [userMessage()]);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Fresh adopted session' },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Fresh adopted session',
        sessionId: 'acp:hermes-agent:fresh-session',
      },
    ]);
    const setup = createService({
      store,
      runner,
      backend: 'hermes-agent',
      availableBackends: ['hermes-agent'],
    });
    const adoptedHandle = await setup.sandboxService.create({
      roomId: 'room-1',
      creatorId: 'client-1',
      ttlMs: 60 * 60 * 1000,
    });
    setup.lifecycle.ensureReadySandbox = async () => ({
      ok: true,
      created: false,
      handle: adoptedHandle,
      room: {
        ...(await store.getRoomById('room-1'))!,
        sandboxId: adoptedHandle.id,
        sandboxStatus: 'ready',
        sandboxUpdatedAt: adoptedHandle.createdAt,
        codeAgentSessionId: undefined,
        codeAgentLastTurnId: undefined,
      },
    });

    const result = await setup.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, true);
    assert.equal(runner.requests[0].sessionId, null);
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
    assert.equal(finalMessage.content, 'Coco task failed. Retry, or switch engines if the problem continues.');
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
    assert.equal(finalMessage.content, 'Coco task failed. Retry, or switch engines if the problem continues.');
  });

  it('extends sandbox timeout while a turn is active and shortens it after completion', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const deadline = new ControlledTurnDeadline();
    const turnTimeoutMs = resolveCodeAgentTurnTimeoutMs(60 * 60 * 1000, 60 * 60 * 1000, 30_000);
    const { sandboxService, service } = createService({
      runner,
      activeSandboxTtlMs: 60 * 60 * 1000,
      idleSandboxTtlMs: 2 * 60 * 1000,
      turnTimeoutMs,
      scheduleTurnDeadline: deadline.schedule,
      clearTurnDeadline: deadline.clear,
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
    assert.equal(turnTimeoutMs, 3_570_000);
    assert.equal(deadline.delayMs, turnTimeoutMs);
    assert.equal(deadline.cleared, true);
  });

  it('drains an already queued heartbeat update before terminal persistence and prevents later running updates', async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let heartbeatCallback: (() => void) | undefined;
    let heartbeatCleared = false;
    (global as any).setInterval = (callback: () => void) => {
      heartbeatCallback = callback;
      return { unref() {} };
    };
    (global as any).clearInterval = () => {
      heartbeatCleared = true;
    };
    try {
      const runner = new SequencedBlockingRunner();
      const deadline = new ControlledTurnDeadline();
      const store = new MemoryCodeAgentStore(room(), [userMessage()]);
      const originalRenew = store.renewCodeAgentRoomLease.bind(store);
      const originalUpdate = store.updateCodeAgentTurn.bind(store);
      const originalFinish = store.finishCodeAgentTurn.bind(store);
      let renewCalls = 0;
      let markRenewStarted!: () => void;
      const renewStarted = new Promise<void>(resolve => {
        markRenewStarted = resolve;
      });
      let releaseRenew!: () => void;
      const renewBlocked = new Promise<void>(resolve => {
        releaseRenew = resolve;
      });
      let terminalPersisted = false;
      let updatesAfterTerminal = 0;
      store.renewCodeAgentRoomLease = async (...args) => {
        renewCalls += 1;
        if (renewCalls === 1) {
          markRenewStarted();
          await renewBlocked;
        }
        return originalRenew(...args);
      };
      store.updateCodeAgentTurn = async (...args) => {
        if (terminalPersisted) updatesAfterTerminal += 1;
        return originalUpdate(...args);
      };
      store.finishCodeAgentTurn = async input => {
        assert.equal(deadline.cleared, true);
        const terminal = await originalFinish(input);
        if (terminal.outcome !== 'stale') terminalPersisted = true;
        return terminal;
      };
      const { service } = createService({
        store,
        runner,
        ids: ['ai-1', 'turn-1'],
        scheduleTurnDeadline: deadline.schedule,
        clearTurnDeadline: deadline.clear,
      });
      const active = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
      await runner.waitForRuns(1);

      heartbeatCallback?.();
      await renewStarted;
      runner.release(0);
      await Promise.resolve();
      assert.equal(store.agentTurns.get('turn-1')?.status, 'running');

      releaseRenew();
      assert.deepEqual(await active, { success: true, messageId: 'ai-1' });
      assert.equal(heartbeatCleared, true);
      assert.equal(terminalPersisted, true);
      assert.equal(updatesAfterTerminal, 0);
      assert.equal(renewCalls, 5);
    } finally {
      (global as any).setInterval = originalSetInterval;
      (global as any).clearInterval = originalClearInterval;
    }
  });

  it('keeps renewing through blocked error cleanup, then stops heartbeat before terminal persistence', async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let heartbeatCallback: (() => void) | undefined;
    (global as any).setInterval = (callback: () => void) => {
      heartbeatCallback = callback;
      return { unref() {} };
    };
    (global as any).clearInterval = () => undefined;
    try {
      const store = new MemoryCodeAgentStore(room(), [userMessage()]);
      const originalRenew = store.renewCodeAgentRoomLease.bind(store);
      const originalUpdate = store.updateCodeAgentTurn.bind(store);
      const originalFinish = store.finishCodeAgentTurn.bind(store);
      let renewCalls = 0;
      let terminalPersisted = false;
      let updatesAfterTerminal = 0;
      store.renewCodeAgentRoomLease = async (...args) => {
        renewCalls += 1;
        return originalRenew(...args);
      };
      store.updateCodeAgentTurn = async (...args) => {
        if (terminalPersisted) updatesAfterTerminal += 1;
        return originalUpdate(...args);
      };
      store.finishCodeAgentTurn = async input => {
        const terminal = await originalFinish(input);
        if (terminal.outcome !== 'stale') terminalPersisted = true;
        return terminal;
      };
      const setup = createService({
        store,
        runner: new FakeCodeAgentRunnerClient([{
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'error',
          message: 'runner failed safely',
          code: 'runner_process_error',
          retryable: false,
        }]),
        ids: ['ai-1', 'turn-1'],
      });
      let markCleanupStarted!: () => void;
      const cleanupStarted = new Promise<void>(resolve => {
        markCleanupStarted = resolve;
      });
      let releaseCleanup!: () => void;
      const cleanupBlocked = new Promise<void>(resolve => {
        releaseCleanup = resolve;
      });
      (setup.service as any).flushInterruptedToolCalls = async () => {
        markCleanupStarted();
        await cleanupBlocked;
      };

      const active = setup.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
      await cleanupStarted;
      heartbeatCallback?.();
      while (renewCalls === 0) await Promise.resolve();
      assert.equal(store.agentTurns.get('turn-1')?.status, 'running');

      releaseCleanup();
      const result = await active;
      assert.equal(result.success, false);
      assert.equal(terminalPersisted, true);
      assert.equal(renewCalls, 5);
      assert.equal(updatesAfterTerminal, 0);
    } finally {
      (global as any).setInterval = originalSetInterval;
      (global as any).clearInterval = originalClearInterval;
    }
  });

  it('publishes a complete turn only after runtime cleanup so an immediate next turn can start', async () => {
    let runCount = 0;
    const runner: CodeAgentRunnerClient = {
      async run(request, handlers): Promise<CodeAgentRunnerRunResult> {
        runCount += 1;
        const textEvent: CodeAgentRunnerEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta',
          messageId: request.turnId,
          delta: `Done ${runCount}`,
        };
        const stepEvent: CodeAgentRunnerEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'model_step',
          turnId: request.turnId,
          stepId: `${request.turnId}:step:1`,
          sequence: 1,
          hasText: true,
          toolCallIds: [],
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
        };
        const finalEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final' as const,
          messageId: request.turnId,
          answer: `Done ${runCount}`,
          sessionId: `session-${runCount}`,
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' as const },
        };
        for (const event of [textEvent, stepEvent, finalEvent]) {
          await handlers.onEvent(event);
        }
        return { events: [textEvent, stepEvent, finalEvent], finalEvent };
      },
    };
    const deadline = new ControlledTurnDeadline();
    const observability = createMemoryObservability();
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    const originalReleaseLease = store.releaseCodeAgentRoomLease.bind(store);
    let releaseLeaseCalls = 0;
    store.releaseCodeAgentRoomLease = async (...args) => {
      releaseLeaseCalls += 1;
      return originalReleaseLease(...args);
    };
    const setup = createService({
      store,
      runner,
      ids: ['ai-1', 'turn-1', 'ai-2', 'turn-2'],
      activeSandboxTtlMs: 60 * 60 * 1000,
      idleSandboxTtlMs: 2 * 60 * 1000,
      scheduleTurnDeadline: deadline.schedule,
      clearTurnDeadline: deadline.clear,
      observability: observability.recorder,
    });
    const cleanupOrder: string[] = [];
    const originalShorten = setup.lifecycle.shortenSandboxAfterTurn.bind(setup.lifecycle);
    setup.lifecycle.shortenSandboxAfterTurn = async handle => {
      const shortened = await originalShorten(handle);
      cleanupOrder.push('sandbox-shortened');
      return shortened;
    };
    const wrappedReleaseLease = store.releaseCodeAgentRoomLease.bind(store);
    store.releaseCodeAgentRoomLease = async (...args) => {
      const released = await wrappedReleaseLease(...args);
      cleanupOrder.push('lease-released');
      return released;
    };

    let nextTurn: Promise<unknown> | undefined;
    let firstTerminalSeen = false;
    setup.emitter.onEmit = event => {
      const turn = event.event === 'agent_turn_updated'
        ? event.args[0] as RoomAgentTurn
        : undefined;
      const streamPayload = event.args[0] as any;
      const isFirstTerminalTurn = turn?.id === 'turn-1' && turn.status === 'complete';
      if (isFirstTerminalTurn) firstTerminalSeen = true;
      const isFirstTerminalRoom = event.event === 'room_updated'
        && streamPayload?.codeAgentStatus === 'idle'
        && firstTerminalSeen
        && runCount === 1;
      const isFirstReadiness = (
        isFirstTerminalTurn
        || (event.event === 'ai_stream_end' && streamPayload?.messageId === 'ai-1')
        || (event.event === 'ai_cost_total' && firstTerminalSeen && runCount === 1)
        || isFirstTerminalRoom
      );
      if (isFirstReadiness) {
        assert.equal((setup.service as any).activeTurns.has('room-1'), false);
        assert.equal(store.roomLeases.has('room-1'), false);
        assert.equal(setup.sandboxService.sandboxTimeoutUpdates.at(-1)?.ttlMs, 2 * 60 * 1000);
      }
      if (event.event === 'ai_stream_end' && streamPayload?.messageId === 'ai-1') cleanupOrder.push('stream-end');
      if (event.event === 'ai_cost_total' && firstTerminalSeen && runCount === 1) cleanupOrder.push('cost-emitted');
      if (isFirstTerminalRoom) cleanupOrder.push('room-emitted');
      if (turn?.id !== 'turn-1' || turn.status !== 'complete') return;
      cleanupOrder.push('terminal-emitted');
      assert.equal(releaseLeaseCalls, 1);
      nextTurn = setup.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    };

    assert.deepEqual(
      await setup.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }),
      { success: true, messageId: 'ai-1' },
    );
    assert.ok(nextTurn);
    assert.deepEqual(await nextTurn, { success: true, messageId: 'ai-2' });
    assert.equal(runCount, 2);
    assert.equal(
      observability.events.some(event => (
        event.event === 'code_agent.turn.rejected'
        && (event.payload as any)?.reason === 'room_already_running'
      )),
      false,
    );
    const terminalIndex = cleanupOrder.indexOf('terminal-emitted');
    const shortenIndex = cleanupOrder.lastIndexOf('sandbox-shortened', terminalIndex);
    const releaseIndex = cleanupOrder.lastIndexOf('lease-released', terminalIndex);
    assert.ok(shortenIndex >= 0 && shortenIndex < terminalIndex);
    assert.ok(releaseIndex >= 0 && releaseIndex < terminalIndex);
    assert.deepEqual(cleanupOrder.slice(terminalIndex, terminalIndex + 4), [
      'terminal-emitted',
      'stream-end',
      'cost-emitted',
      'room-emitted',
    ]);
  });

  it('waits for terminal cleanup when a durable room event starts the next turn before socket readiness', async () => {
    const runner = new SequencedBlockingRunner();
    const observability = createMemoryObservability();
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    const originalFinish = store.finishCodeAgentTurn.bind(store);
    let service!: CodeAgentSessionService;
    let nextTurn: Promise<unknown> | undefined;
    let nextTurnSettled = false;
    store.finishCodeAgentTurn = async input => {
      const terminal = await originalFinish(input);
      if (input.claim.turnId === 'turn-1' && terminal.outcome === 'applied') {
        nextTurn = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
        void nextTurn.finally(() => {
          nextTurnSettled = true;
        });
      }
      return terminal;
    };
    const setup = createService({
      store,
      runner,
      ids: ['ai-1', 'turn-1', 'ai-2', 'turn-2'],
      observability: observability.recorder,
    });
    service = setup.service;
    let markShortenStarted!: () => void;
    const shortenStarted = new Promise<void>(resolve => {
      markShortenStarted = resolve;
    });
    let releaseShorten!: () => void;
    const shortenBlocked = new Promise<void>(resolve => {
      releaseShorten = resolve;
    });
    const originalShorten = setup.lifecycle.shortenSandboxAfterTurn.bind(setup.lifecycle);
    setup.lifecycle.shortenSandboxAfterTurn = async handle => {
      markShortenStarted();
      await shortenBlocked;
      return originalShorten(handle);
    };

    const firstTurn = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.waitForRuns(1);
    runner.release(0);
    await shortenStarted;
    assert.ok(nextTurn);
    await Promise.resolve();
    assert.equal(nextTurnSettled, false);
    assert.equal((service as any).activeTurns.get('room-1')?.terminalClosing?.promise instanceof Promise, true);

    releaseShorten();
    assert.deepEqual(await firstTurn, { success: true, messageId: 'ai-1' });
    await runner.waitForRuns(2);
    runner.release(1);
    assert.deepEqual(await nextTurn, { success: true, messageId: 'ai-2' });
    assert.equal(observability.events.some(event => (
      event.event === 'code_agent.turn.rejected'
      && (event.payload as any)?.reason === 'room_already_running'
    )), false);
  });

  it('retains the fenced room lease across sandbox cleanup so another service cannot start early', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    const first = createService({ store, runner, ids: ['ai-1', 'turn-1'] });
    const second = createService({
      store,
      runner: new FakeCodeAgentRunnerClient([]),
      ids: ['other-ai', 'other-turn'],
    });
    let markShortenStarted!: () => void;
    const shortenStarted = new Promise<void>(resolve => {
      markShortenStarted = resolve;
    });
    let releaseShorten!: () => void;
    const shortenBlocked = new Promise<void>(resolve => {
      releaseShorten = resolve;
    });
    const originalShorten = first.lifecycle.shortenSandboxAfterTurn.bind(first.lifecycle);
    first.lifecycle.shortenSandboxAfterTurn = async handle => {
      markShortenStarted();
      await shortenBlocked;
      return originalShorten(handle);
    };

    const active = first.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await shortenStarted;
    assert.equal(store.roomLeases.get('room-1')?.turnId, 'turn-1');
    assert.equal(first.emitter.roomEmits.some(event => (
      event.event === 'agent_turn_updated'
      && (event.args[0] as RoomAgentTurn).status === 'complete'
    )), false);
    assert.deepEqual(
      await second.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }),
      { success: false, error: 'An agent task is already running in this workspace' },
    );

    releaseShorten();
    assert.deepEqual(await active, { success: true, messageId: 'ai-1' });
    assert.equal(store.roomLeases.has('room-1'), false);
  });

  it('heartbeats the fenced lease throughout cleanup that spans multiple lease TTLs', async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const intervals = new Map<object, () => void>();
    let intervalId = 0;
    (global as any).setInterval = (callback: () => void) => {
      const handle = { id: ++intervalId, unref() {} };
      intervals.set(handle, callback);
      return handle;
    };
    (global as any).clearInterval = (handle: object) => {
      intervals.delete(handle);
    };
    try {
      let nowMs = Date.parse('2026-05-03T00:00:00.000Z');
      const now = () => new Date(nowMs);
      const store = new MemoryCodeAgentStore(room(), [userMessage()]);
      const first = createService({
        store,
        now,
        roomLeaseTtlMs: 30_000,
        ids: ['ai-1', 'turn-1'],
        runner: new FakeCodeAgentRunnerClient([
          { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
          cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
          {
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'final',
            messageId: 'ai-1',
            answer: 'Done',
            sessionId: 'session-1',
            usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
          },
        ]),
      });
      const secondRunner = new SequencedBlockingRunner();
      const second = createService({
        store,
        now,
        roomLeaseTtlMs: 30_000,
        runner: secondRunner,
        ids: [
          'other-ai-1', 'other-turn-1',
          'other-ai-2', 'other-turn-2',
          'other-ai-3', 'other-turn-3',
          'other-ai-4', 'other-turn-4',
        ],
      });
      let markShortenStarted!: () => void;
      const shortenStarted = new Promise<void>(resolve => {
        markShortenStarted = resolve;
      });
      let releaseShorten!: () => void;
      const shortenBlocked = new Promise<void>(resolve => {
        releaseShorten = resolve;
      });
      const originalShorten = first.lifecycle.shortenSandboxAfterTurn.bind(first.lifecycle);
      first.lifecycle.shortenSandboxAfterTurn = async handle => {
        markShortenStarted();
        await shortenBlocked;
        return originalShorten(handle);
      };

      const firstTurn = first.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
      await shortenStarted;
      assert.equal(intervals.size, 1);
      for (let cycle = 0; cycle < 3; cycle += 1) {
        nowMs += 20_000;
        for (const callback of [...intervals.values()]) callback();
        const expectedExpiry = new Date(nowMs + 30_000).toISOString();
        for (let attempt = 0; attempt < 20 && store.roomLeases.get('room-1')?.expiresAt !== expectedExpiry; attempt += 1) {
          await Promise.resolve();
        }
        assert.equal(store.roomLeases.get('room-1')?.expiresAt, expectedExpiry);
        assert.deepEqual(
          await second.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }),
          { success: false, error: 'An agent task is already running in this workspace' },
        );
      }

      releaseShorten();
      assert.deepEqual(await firstTurn, { success: true, messageId: 'ai-1' });
      assert.equal(store.roomLeases.has('room-1'), false);

      const secondTurn = second.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
      await secondRunner.waitForRuns(1);
      secondRunner.release(0);
      assert.deepEqual(await secondTurn, { success: true, messageId: 'other-ai-4' });
    } finally {
      (global as any).setInterval = originalSetInterval;
      (global as any).clearInterval = originalClearInterval;
    }
  });

  it('aborts an in-flight idle timeout when cleanup loses its fence before a new owner extends the sandbox', async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const intervals = new Map<object, () => void>();
    (global as any).setInterval = (callback: () => void) => {
      const handle = { unref() {} };
      intervals.set(handle, callback);
      return handle;
    };
    (global as any).clearInterval = (handle: object) => {
      intervals.delete(handle);
    };
    try {
      let nowMs = Date.parse('2026-05-03T00:00:00.000Z');
      const now = () => new Date(nowMs);
      const store = new MemoryCodeAgentStore(room(), [userMessage()]);
      const first = createService({
        store,
        now,
        roomLeaseTtlMs: 30_000,
        ids: ['ai-1', 'turn-1'],
        runner: new FakeCodeAgentRunnerClient([
          { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
          cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
          {
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'final',
            messageId: 'ai-1',
            answer: 'Done',
            sessionId: 'session-1',
            usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
          },
        ]),
      });
      const secondRunner = new SequencedBlockingRunner();
      const second = createService({
        store,
        now,
        roomLeaseTtlMs: 30_000,
        runner: secondRunner,
        ids: ['other-ai', 'other-turn'],
      });
      const mutationOrder: string[] = [];
      const originalSecondExtend = second.lifecycle.extendSandboxForActiveTurn.bind(second.lifecycle);
      second.lifecycle.extendSandboxForActiveTurn = async handle => {
        const extended = await originalSecondExtend(handle);
        mutationOrder.push('new-active');
        return extended;
      };
      let markOldShortenStarted!: () => void;
      const oldShortenStarted = new Promise<void>(resolve => {
        markOldShortenStarted = resolve;
      });
      let releaseOldShorten!: () => void;
      const oldShortenBlocked = new Promise<void>(resolve => {
        releaseOldShorten = resolve;
      });
      let cleanupOptions: {
        requestTimeoutMs?: number;
        signal?: AbortSignal;
        failClosed?: boolean;
      } | undefined;
      const originalFirstShorten = first.lifecycle.shortenSandboxAfterTurn.bind(first.lifecycle);
      first.lifecycle.shortenSandboxAfterTurn = async (handle, options) => {
        cleanupOptions = options;
        markOldShortenStarted();
        await oldShortenBlocked;
        if (options?.signal?.aborted) {
          mutationOrder.push('old-idle-aborted');
          const abortError = new Error('idle timeout update aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
        mutationOrder.push('old-idle');
        return originalFirstShorten(handle, options);
      };

      const firstTurn = first.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
      await oldShortenStarted;
      assert.equal(cleanupOptions?.requestTimeoutMs, 10_000);
      assert.equal(cleanupOptions?.failClosed, true);
      assert.equal(cleanupOptions?.signal?.aborted, false);
      assert.equal(intervals.size, 1);

      const originalRenew = store.renewCodeAgentRoomLease.bind(store);
      store.renewCodeAgentRoomLease = async () => null;
      for (const callback of [...intervals.values()]) callback();
      for (let attempt = 0; attempt < 20 && !cleanupOptions?.signal?.aborted; attempt += 1) {
        await Promise.resolve();
      }
      assert.equal(cleanupOptions?.signal?.aborted, true);
      store.renewCodeAgentRoomLease = originalRenew;

      nowMs += 31_000;
      const secondTurn = second.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
      await secondRunner.waitForRuns(1);
      assert.deepEqual(mutationOrder, ['new-active']);
      assert.equal(store.roomLeases.get('room-1')?.turnId, 'other-turn');

      releaseOldShorten();
      assert.deepEqual(await firstTurn, { success: true, messageId: 'ai-1' });
      assert.deepEqual(mutationOrder, ['new-active', 'old-idle-aborted']);
      assert.equal(first.emitter.roomEmits.some(event => (
        event.event === 'agent_turn_updated'
        && (event.args[0] as RoomAgentTurn).status === 'complete'
      )), false);
      assert.equal(store.roomLeases.get('room-1')?.turnId, 'other-turn');

      secondRunner.release(0);
      assert.deepEqual(await secondTurn, { success: true, messageId: 'other-ai' });
    } finally {
      (global as any).setInterval = originalSetInterval;
      (global as any).clearInterval = originalClearInterval;
    }
  });

  it('clears local activity but suppresses readiness when cleanup lease verification or release fails', async () => {
    for (const failure of [
      'renew-throws',
      'renew-insufficient-window',
      'release-false',
      'release-throws',
      'shorten-throws',
      'requeue-throws',
    ] as const) {
      const runner: CodeAgentRunnerClient = {
        async run(request, handlers): Promise<CodeAgentRunnerRunResult> {
          const textEvent: CodeAgentRunnerEvent = {
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'text_delta',
            messageId: request.turnId,
            delta: 'Done',
          };
          const stepEvent: CodeAgentRunnerEvent = {
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'model_step',
            turnId: request.turnId,
            stepId: `${request.turnId}:step:1`,
            sequence: 1,
            hasText: true,
            toolCallIds: [],
            usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
          };
          const finalEvent = {
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'final' as const,
            messageId: request.turnId,
            answer: 'Done',
            sessionId: 'session-1',
            usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' as const },
          };
          for (const event of [textEvent, stepEvent, finalEvent]) {
            await handlers.onEvent(event);
          }
          return { events: [textEvent, stepEvent, finalEvent], finalEvent };
        },
      };
      const store = new MemoryCodeAgentStore(room(), [userMessage()]);
      const originalRenew = store.renewCodeAgentRoomLease.bind(store);
      const originalRelease = store.releaseCodeAgentRoomLease.bind(store);
      if (failure === 'renew-throws') {
        store.renewCodeAgentRoomLease = async () => {
          throw new Error('fake renew failure');
        };
      } else if (failure === 'renew-insufficient-window') {
        store.renewCodeAgentRoomLease = async (...args) => {
          const renewed = await originalRenew(...args);
          return renewed ? {
            ...renewed,
            expiresAt: new Date(Date.parse(renewed.expiresAt) - 40_000).toISOString(),
          } : null;
        };
      } else {
        store.renewCodeAgentRoomLease = originalRenew;
      }
      if (failure === 'release-false') {
        store.releaseCodeAgentRoomLease = async (...args) => {
          await originalRelease(...args);
          return false;
        };
      } else if (failure === 'release-throws') {
        store.releaseCodeAgentRoomLease = async (...args) => {
          await originalRelease(...args);
          throw new Error('fake release failure');
        };
      }
      const setup = createService({
        store,
        runner,
        ids: ['ai-1', 'turn-1', 'ai-2', 'turn-2'],
      });
      if (failure === 'shorten-throws') {
        setup.lifecycle.shortenSandboxAfterTurn = async () => {
          throw new Error('fake shorten failure');
        };
      }
      if (failure === 'requeue-throws') {
        (setup.service as any).requeuePendingSteers = async () => {
          throw new Error('fake requeue failure');
        };
      }

      assert.deepEqual(
        await setup.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }),
        { success: true, messageId: 'ai-1' },
        failure,
      );
      assert.equal((setup.service as any).activeTurns.has('room-1'), false, failure);
      assert.equal((setup.service as any).queueDrains.has('room-1'), false, failure);
      assert.equal(store.roomLeases.has('room-1'), false, failure);
      assert.equal(setup.emitter.roomEmits.some(event => (
        event.event === 'ai_stream_end'
        || event.event === 'ai_stream_error'
        || (event.event === 'agent_turn_updated' && (event.args[0] as RoomAgentTurn).status !== 'running')
      )), false, failure);

      assert.deepEqual(
        await setup.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }),
        { success: true, messageId: 'ai-2' },
        failure,
      );
    }
  });

  it('publishes error and cancelled turns only after active runtime cleanup', async () => {
    for (const outcome of ['error', 'cancelled'] as const) {
      const store = new MemoryCodeAgentStore(room(), [userMessage()]);
      const runner = outcome === 'error'
        ? new FakeCodeAgentRunnerClient([{
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'error',
            message: 'runner failed safely',
            code: 'runner_process_error',
            retryable: false,
          }])
        : new InterruptibleRunner();
      const setup = createService({
        store,
        runner,
        activeSandboxTtlMs: 60 * 60 * 1000,
        idleSandboxTtlMs: 2 * 60 * 1000,
      });
      if (outcome === 'cancelled') {
        setup.sandboxService.startRunner = async input => createInterruptibleProcess(
          input,
          runner as InterruptibleRunner,
          false,
        ).process;
      }
      let terminalObserved = false;
      const readinessOrder: string[] = [];
      setup.emitter.onEmit = event => {
        const turn = event.event === 'agent_turn_updated'
          ? event.args[0] as RoomAgentTurn
          : undefined;
        if (turn?.status === outcome) {
          terminalObserved = true;
          readinessOrder.push('turn');
        } else if (terminalObserved && event.event === 'room_updated') {
          readinessOrder.push('room');
        } else if (terminalObserved && event.event === 'ai_stream_error') {
          readinessOrder.push('stream-error');
        } else {
          return;
        }
        assert.equal((setup.service as any).activeTurns.has('room-1'), false);
        assert.equal(store.roomLeases.has('room-1'), false);
        assert.equal(setup.sandboxService.sandboxTimeoutUpdates.at(-1)?.ttlMs, 2 * 60 * 1000);
      };

      const active = setup.service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
      if (outcome === 'cancelled') {
        await (runner as InterruptibleRunner).started;
        assert.deepEqual(await setup.service.interruptTurn('room-1', 'client-1'), { success: true });
      }
      await active;
      assert.equal(terminalObserved, true);
      assert.deepEqual(readinessOrder, ['turn', 'room', 'stream-error']);
    }
  });

  it('owns the hard turn timeout before the sandbox TTL and closes pending tools without logging command data', async () => {
    const startedAtMs = Date.parse('2026-05-03T00:00:00.000Z');
    let currentMs = startedAtMs;
    const deadline = new ControlledTurnDeadline();
    const runner = new PendingToolBlockingRunner();
    const observability = createMemoryObservability();
    const { sandboxService, service, store } = createService({
      runner,
      observability: observability.recorder,
      now: () => new Date(currentMs),
      turnTimeoutMs: 5_000,
      activeSandboxTtlMs: 60 * 60 * 1000,
      idleSandboxTtlMs: 2 * 60 * 1000,
      scheduleTurnDeadline: deadline.schedule,
      clearTurnDeadline: deadline.clear,
    });

    const active = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;
    assert.equal(deadline.delayMs, 5_000);
    assert.deepEqual(sandboxService.sandboxTimeoutUpdates.map(update => update.ttlMs), [60 * 60 * 1000]);

    currentMs += 5_000;
    deadline.fire();
    assert.deepEqual(await service.interruptTurn('room-1', 'client-1'), { success: true });
    assert.equal((service as any).activeTurns.get('room-1')?.interruptedByUser, false);
    const result = await active;

    assert.equal(result.success, false);
    assert.match(result.error || '', /task time limit/);
    assert.equal(deadline.cleared, true);
    assert.deepEqual(sandboxService.sandboxTimeoutUpdates.map(update => update.ttlMs), [
      60 * 60 * 1000,
      2 * 60 * 1000,
    ]);
    assert.equal(sandboxService.stoppedRunnerCommands.length, 1);
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(item => item.messageType), ['text', 'tool_call', 'tool_result', 'ai']);
    assert.equal(messages[2].toolCallId, 'tool-timeout');
    assert.equal(messages[2].status, 'error');
    assert.equal(messages[3].status, 'error');
    assert.equal(messages.some(item => item.status === 'streaming'), false);
    const failed = observability.events.find(item => item.event === 'code_agent.turn.failed');
    assert.equal(failed?.errorCode, 'turn_timeout');
    assert.equal((failed?.payload as any)?.turnTimeoutMs, 5_000);
    const syntheticResult = observability.events.find(item => (
      item.event === 'code_agent.runner.tool_result'
      && (item.payload as any)?.timedOut
    ));
    assert.equal(syntheticResult?.durationMs, 5_000);
    assert.equal((syntheticResult?.payload as any)?.toolCallId, 'tool-timeout');
    assert.equal((syntheticResult?.payload as any)?.toolName, 'terminal');
    assert.equal(JSON.stringify(observability.events).includes('ROOMTALK_TEST_SECRET'), false);
  });

  it('acknowledges a durable preparing turn before paged context loading completes', async () => {
    const prompt = userMessage('inspect the latest changes');
    const store = new BlockingContextStore(room(), [prompt]);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const { service } = createService({ store, runner });
    let resolveAck!: (response: unknown) => void;
    const acked = new Promise<unknown>(resolve => {
      resolveAck = resolve;
    });

    const turn = service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      promptMessageId: prompt.id,
      promptMessage: prompt,
    }, resolveAck);

    await store.contextReadStarted;
    assert.deepEqual(await acked, { success: true, messageId: 'ai-1' });
    const preparing = [...store.agentTurns.values()][0];
    assert.equal(preparing.phase, 'preparing_context');
    assert.ok(preparing.lastHeartbeatAt);
    assert.deepEqual(store.contextReadOptions, { beforeMessageId: prompt.id, limit: 100 });

    store.releaseContextRead();
    assert.deepEqual(await turn, { success: true, messageId: 'ai-1' });
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
      { PYTHONUNBUFFERED: '1', ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true' },
      { PYTHONUNBUFFERED: '1', ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true' },
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
        assert.match(env.ROOMTALK_GITHUB_TOKEN_PATH, /^\/tmp\/roomtalk-codex\/turn-1-github-token$/);
        assert.match(env.GIT_CONFIG_GLOBAL, /^\/tmp\/roomtalk-codex\/turn-1-github-gitconfig$/);
        assert.equal(env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(JSON.stringify(env).includes('github_pat_test_secret'), false);
        assert.equal(
          await sandboxService.readSecretFile(context!.sandbox, env.ROOMTALK_GITHUB_TOKEN_PATH),
          'github_pat_test_secret'
        );
        assert.match(
          await sandboxService.readSecretFile(context!.sandbox, env.GIT_CONFIG_GLOBAL),
          /gh auth git-credential/
        );
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
      async withCodexAuth(clientId: string, runId: string, work: (authJson: string, snapshot: { authVersion: number }) => Promise<any>) {
        authCalls.push({ clientId, runId });
        const workResult = await work(initialAuthJson, { authVersion: 1 });
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
      githubConnectionService: {
        async getAccessToken(clientId: string) {
          assert.equal(clientId, 'client-1');
          return 'github_pat_test_secret';
        },
      },
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
      '/tmp/roomtalk-codex/turn-1-github-gitconfig',
      '/tmp/roomtalk-codex/turn-1-github-token',
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
      async withCodexAuth(clientId: string, runId: string, work: (authJson: string, snapshot: { authVersion: number }) => Promise<any>) {
        authCalls.push({ clientId, runId });
        const workResult = await work(
          JSON.stringify({ OPENAI_AUTH: { access_token: 'room-token' } }),
          { authVersion: 1 }
        );
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
      async withCodexAuth(clientId: string, runId: string, work: (authJson: string, snapshot: { authVersion: number }) => Promise<any>) {
        authCalls.push({ clientId, runId });
        const workResult = await work(
          JSON.stringify({ OPENAI_AUTH: { access_token: 'app-server-token' } }),
          { authVersion: 1 }
        );
        return workResult.result;
      },
    };
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'codex-app-server' }), [userMessage()]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.example',
    });
    const roomContext = new CodeAgentRoomContextService(store as any, {
      tokenSecret: 'room-context-secret',
      createId: () => 'room-context-token-id',
    });
    const setup = createService({
      store,
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
      staticSitePublisher,
      roomContext,
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
    const runnerEnv = sandboxService.startedRunnerEnvs[0];
    assert.equal(runnerEnv.ROOMTALK_CODEX_AUTH_VERSION, '1');
    assert.equal(runnerEnv.ROOMTALK_CODEX_AUTH_REFRESH_URL, 'https://room.example/api/code-agent/codex-auth/refresh');
    const roomContextClaims = roomContext.verifyTurnToken(runnerEnv.ROOMTALK_ROOM_CONTEXT_TOKEN)!;
    const authRefreshClaims = roomContext.verifyTurnToken(runnerEnv.ROOMTALK_CODEX_AUTH_REFRESH_TOKEN)!;
    assert.equal(authRefreshClaims.roomId, 'room-1');
    assert.equal(authRefreshClaims.clientId, 'client-1');
    assert.equal(authRefreshClaims.turnId, 'turn-1');
    assert.ok(authRefreshClaims.exp > roomContextClaims.exp);
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

  it('persists reused OpenCode tool message IDs independently across sequential turns', async () => {
    let runCount = 0;
    const runner: CodeAgentRunnerClient = {
      async run(_request, handlers): Promise<CodeAgentRunnerRunResult> {
        runCount += 1;
        const toolCall = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'tool_call' as const,
          id: 'reused-tool-call',
          name: 'bash',
          args: { kind: 'execute', cwd: '/workspace' },
          messageId: 'acp_tool_call_reused-tool-call',
        };
        const toolResult = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'tool_result' as const,
          id: toolCall.id,
          name: toolCall.name,
          success: true,
          output: 'clean',
          messageId: 'acp_tool_result_reused-tool-call',
        };
        const finalEvent = {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final' as const,
          messageId: `runner-final-${runCount}`,
          answer: `Done ${runCount}`,
          sessionId: 'acp:opencode:continued-session',
        };
        for (const event of [toolCall, toolResult, finalEvent]) {
          await handlers.onEvent(event);
        }
        return { events: [toolCall, toolResult, finalEvent], finalEvent };
      },
    };
    const store = new MemoryCodeAgentStore(room({
      codeAgentBackend: 'opencode',
      codeAgentSessionId: 'acp:opencode:continued-session',
    }), [userMessage()]);
    const { service } = createService({
      store,
      runner,
      availableBackends: ['opencode'],
      runnerCommandByBackend: { opencode: DEFAULT_OPENCODE_RUNNER_COMMAND },
      ids: ['ai-1', 'turn-1', 'ai-2', 'turn-2'],
    });

    assert.equal((await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel })).success, true);
    assert.equal((await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel })).success, true);

    const toolMessages = (store.messages.get('room-1') || []).filter(message => (
      message.messageType === 'tool_call' || message.messageType === 'tool_result'
    ));
    assert.deepEqual(toolMessages.map(message => message.id), [
      'acp_tool_call_reused-tool-call:turn-1',
      'acp_tool_result_reused-tool-call:turn-1',
      'acp_tool_call_reused-tool-call:turn-2',
      'acp_tool_result_reused-tool-call:turn-2',
    ]);
    assert.deepEqual(toolMessages.map(message => message.toolCallId), Array(4).fill('reused-tool-call'));
    assert.equal(new Set(toolMessages.map(message => message.id)).size, 4);
  });

  it('stops OpenCode after three paired invalid-tool failures and preserves a clean terminal transcript', async () => {
    const secret = 'must-not-appear-in-observability';
    const scriptedEvents = [
      ...invalidToolPair('invalid-1', { secret }),
      ...invalidToolPair('invalid-2', { secret }),
      ...invalidToolPair('invalid-3', { secret }),
    ];
    const runner: CodeAgentRunnerClient = {
      async run(_request, handlers): Promise<CodeAgentRunnerRunResult> {
        for (const event of scriptedEvents) {
          await handlers.onEvent(event);
        }
        return new Promise<CodeAgentRunnerRunResult>(() => undefined);
      },
    };
    const logRecords: Array<{ level: string; message: string; metadata: unknown[] }> = [];
    const captureLogger = {
      debug(message: string, ...metadata: unknown[]) { logRecords.push({ level: 'debug', message, metadata }); },
      error(message: string, ...metadata: unknown[]) { logRecords.push({ level: 'error', message, metadata }); },
      info(message: string, ...metadata: unknown[]) { logRecords.push({ level: 'info', message, metadata }); },
      warn(message: string, ...metadata: unknown[]) { logRecords.push({ level: 'warn', message, metadata }); },
    } as unknown as Logger;
    const observability = createMemoryObservability();
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'opencode' }), [userMessage()]);
    const { emitter, sandboxService, service } = createService({
      store,
      runner,
      backend: 'code-agent',
      availableBackends: ['opencode'],
      runnerCommandByBackend: { opencode: DEFAULT_OPENCODE_RUNNER_COMMAND },
      modelGateway: createTestModelGateway(),
      observability: observability.recorder,
      logger: captureLogger,
      ids: ['ai-1', 'turn-1', 'terminal-error-1'],
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(result, {
      success: false,
      error: 'OpenCode repeatedly returned an invalid tool request. Retry the task, or switch models if the problem continues.',
    });
    assert.deepEqual(sandboxService.stoppedRunnerCommands, [DEFAULT_OPENCODE_RUNNER_COMMAND]);
    const turn = store.agentTurns.get('turn-1');
    assert.equal(turn?.status, 'error');
    assert.equal(turn?.finalMessageId, 'terminal-error-1');
    assert.equal((await store.getRoomById('room-1'))?.codeAgentStatus, 'error');

    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), [
      'text',
      'tool_call', 'tool_result',
      'tool_call', 'tool_result',
      'tool_call', 'tool_result',
      'ai',
    ]);
    assert.equal(messages.some(message => message.status === 'streaming'), false);
    assert.deepEqual(
      messages.filter(message => message.messageType === 'tool_call').map(message => message.toolCallId),
      ['invalid-1', 'invalid-2', 'invalid-3'],
    );
    assert.deepEqual(
      messages.filter(message => message.messageType === 'tool_result').map(message => message.toolCallId),
      ['invalid-1', 'invalid-2', 'invalid-3'],
    );
    assert.equal(messages.at(-1)?.status, 'error');
    assert.equal(messages.at(-1)?.isError, true);

    const loopEventIndex = observability.events.findIndex(event => event.event === 'code_agent.opencode.invalid_tool_loop');
    const thirdResultIndex = observability.events.findIndex(event => (
      event.event === 'code_agent.runner.tool_result' && (event.payload as any)?.toolCallId === 'invalid-3'
    ));
    assert.ok(loopEventIndex > thirdResultIndex);
    assert.deepEqual(observability.events[loopEventIndex], {
      level: 'error',
      event: 'code_agent.opencode.invalid_tool_loop',
      roomId: 'room-1',
      turnId: 'turn-1',
      provider: selectedModel.provider,
      model: selectedModel.id,
      errorCode: 'opencode_invalid_tool_loop',
      errorMessage: 'OpenCode repeatedly returned an invalid tool request. Retry the task, or switch models if the problem continues.',
      payload: { backend: 'opencode', count: 3, threshold: 3 },
    });
    const failedEvent = observability.events.find(event => event.event === 'code_agent.turn.failed');
    assert.equal(failedEvent?.errorCode, 'opencode_invalid_tool_loop');
    assert.equal((failedEvent?.payload as any)?.invalidToolLoopCount, 3);
    assert.equal((failedEvent?.payload as any)?.invalidToolLoopThreshold, 3);
    assert.equal(emitter.roomEmits.some(event => (
      event.event === 'ai_stream_error'
      && (event.args[0] as any).persisted === true
    )), true);

    const diagnosticOutput = JSON.stringify({ logRecords, events: observability.events });
    assert.equal(diagnosticOutput.includes(secret), false);
    assert.equal(diagnosticOutput.includes('opaqueInput'), false);
    const loopWarning = logRecords.find(record => record.message === 'OpenCode invalid tool loop threshold reached');
    assert.deepEqual(loopWarning, {
      level: 'warn',
      message: 'OpenCode invalid tool loop threshold reached',
      metadata: [{ roomId: 'room-1', turnId: 'turn-1', backend: 'opencode', count: 3, threshold: 3 }],
    });
  });

  it('counts completed OpenCode InvalidTool results by paired tool signature after durable persistence', async () => {
    const first = invalidToolPair('invalid-result-1', {
      name: 'bash',
      kind: 'execute',
      failureCode: 'invalid_tool',
    });
    const second = invalidToolPair('invalid-result-2', {
      name: 'bash',
      kind: 'execute',
      failureCode: 'invalid_tool',
    });
    const third = invalidToolPair('invalid-result-3', {
      name: 'bash',
      kind: 'execute',
      failureCode: 'invalid_tool',
    });
    const unrelatedCall = invalidToolPair('pending-read', { name: 'read', kind: 'read' })[0];
    const scriptedEvents = [
      ...first,
      second[0],
      unrelatedCall,
      second[1],
      ...third,
    ];
    const runner: CodeAgentRunnerClient = {
      async run(_request, handlers): Promise<CodeAgentRunnerRunResult> {
        for (const event of scriptedEvents) {
          await handlers.onEvent(event);
        }
        return new Promise<CodeAgentRunnerRunResult>(() => undefined);
      },
    };
    const observability = createMemoryObservability();
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'opencode' }), [userMessage()]);
    const { service } = createService({
      store,
      runner,
      backend: 'code-agent',
      availableBackends: ['opencode'],
      runnerCommandByBackend: { opencode: DEFAULT_OPENCODE_RUNNER_COMMAND },
      modelGateway: createTestModelGateway(),
      observability: observability.recorder,
      ids: ['ai-1', 'turn-1', 'terminal-error-1', 'pending-read-result'],
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    assert.match(result.error || '', /invalid tool request/);
    const messages = store.messages.get('room-1') || [];
    const invalidResults = messages.filter(message => (
      message.messageType === 'tool_result' && message.toolCallId?.startsWith('invalid-result-')
    ));
    assert.equal(invalidResults.length, 3);
    assert.equal(invalidResults.every(message => message.status === 'error' && message.isError === true), true);
    assert.equal(invalidResults.every(message => !('failureCode' in message)), true);
    assert.equal(messages.some(message => message.status === 'streaming'), false);
    const priorBlocks = buildCodeAgentPriorMessages(messages).flatMap(message => (
      Array.isArray(message.content) ? message.content : []
    ));
    const priorInvalidResults = priorBlocks.filter(block => (
      block.type === 'tool_result' && block.content === 'OpenCode rejected an invalid tool request.'
    ));
    assert.equal(priorInvalidResults.length, 3);
    assert.equal(priorInvalidResults.every(block => block.type === 'tool_result' && block.is_error === true), true);
    const thirdResultEvent = observability.events.findIndex(event => (
      event.event === 'code_agent.runner.tool_result'
      && (event.payload as any)?.toolCallId === 'invalid-result-3'
    ));
    const loopEvent = observability.events.findIndex(event => event.event === 'code_agent.opencode.invalid_tool_loop');
    assert.ok(loopEvent > thirdResultEvent);
  });

  it('resets the OpenCode invalid-tool counter after text, a normal tool call, or a successful result', async () => {
    const resetCases: Array<{ name: string; events: CodeAgentRunnerEvent[] }> = [
      {
        name: 'non-empty text',
        events: [{
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta',
          messageId: 'reset-text',
          delta: 'I will try a different approach.',
        }],
      },
      {
        name: 'normal failed tool',
        events: invalidToolPair('normal-reset', { name: 'read', kind: 'read' }),
      },
      {
        name: 'failed execute without invalid-tool code',
        events: invalidToolPair('failed-execute-reset', { name: 'bash', kind: 'execute' }),
      },
      {
        name: 'successful result',
        events: invalidToolPair('successful-reset', { success: true }),
      },
    ];

    for (const resetCase of resetCases) {
      const observability = createMemoryObservability();
      const events: CodeAgentRunnerEvent[] = [
        ...invalidToolPair(`${resetCase.name}-before-1`),
        ...invalidToolPair(`${resetCase.name}-before-2`),
        ...resetCase.events,
        ...invalidToolPair(`${resetCase.name}-after-1`),
        ...invalidToolPair(`${resetCase.name}-after-2`),
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta',
          messageId: `${resetCase.name}-answer`,
          delta: 'Recovered normally.',
        },
        acpFinalEvent('opencode'),
      ];
      const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'opencode' }), [userMessage()]);
      const { service } = createService({
        store,
        runner: new FakeCodeAgentRunnerClient(events),
        backend: 'code-agent',
        availableBackends: ['opencode'],
        runnerCommandByBackend: { opencode: DEFAULT_OPENCODE_RUNNER_COMMAND },
        modelGateway: createTestModelGateway(),
        observability: observability.recorder,
        ids: ['ai-1', 'turn-1', 'segment-1', 'segment-2', 'segment-3'],
      });

      const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

      assert.equal(result.success, true, resetCase.name);
      assert.equal(store.agentTurns.get('turn-1')?.status, 'complete', resetCase.name);
      assert.equal(observability.events.some(event => event.event === 'code_agent.opencode.invalid_tool_loop'), false, resetCase.name);
    }
  });

  it('requires three consecutive completed InvalidTool results with the same OpenCode signature', async () => {
    const events: CodeAgentRunnerEvent[] = [
      ...invalidToolPair('bash-1', { name: 'bash', kind: 'execute', failureCode: 'invalid_tool' }),
      ...invalidToolPair('bash-2', { name: 'bash', kind: 'execute', failureCode: 'invalid_tool' }),
      ...invalidToolPair('shell-1', { name: 'shell', kind: 'execute', failureCode: 'invalid_tool' }),
      ...invalidToolPair('bash-3', { name: 'bash', kind: 'execute', failureCode: 'invalid_tool' }),
      ...invalidToolPair('bash-4', { name: 'bash', kind: 'execute', failureCode: 'invalid_tool' }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'text_delta',
        messageId: 'answer',
        delta: 'Recovered normally.',
      },
      acpFinalEvent('opencode'),
    ];
    const observability = createMemoryObservability();
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'opencode' }), [userMessage()]);
    const { service } = createService({
      store,
      runner: new FakeCodeAgentRunnerClient(events),
      backend: 'code-agent',
      availableBackends: ['opencode'],
      runnerCommandByBackend: { opencode: DEFAULT_OPENCODE_RUNNER_COMMAND },
      modelGateway: createTestModelGateway(),
      observability: observability.recorder,
      ids: ['ai-1', 'turn-1', 'segment-1'],
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, true);
    assert.equal(store.agentTurns.get('turn-1')?.status, 'complete');
    assert.equal(observability.events.some(event => event.event === 'code_agent.opencode.invalid_tool_loop'), false);
  });

  it('does not apply the invalid-tool breaker to Hermes or non-sentinel OpenCode tools', async () => {
    const cases: Array<{ name: string; backend: 'opencode' | 'hermes-agent'; pair: (id: string) => CodeAgentRunnerEvent[] }> = [
      { name: 'Hermes sentinel', backend: 'hermes-agent', pair: id => invalidToolPair(id) },
      { name: 'OpenCode invalid with a non-other kind', backend: 'opencode', pair: id => invalidToolPair(id, { kind: 'execute' }) },
      { name: 'OpenCode other-kind normal tool', backend: 'opencode', pair: id => invalidToolPair(id, { name: 'read', kind: 'other' }) },
      {
        name: 'OpenCode non-execute invalid result code',
        backend: 'opencode',
        pair: id => invalidToolPair(id, { name: 'read', kind: 'read', failureCode: 'invalid_tool' }),
      },
      {
        name: 'Hermes invalid result code',
        backend: 'hermes-agent',
        pair: id => invalidToolPair(id, { name: 'bash', kind: 'execute', failureCode: 'invalid_tool' }),
      },
      { name: 'OpenCode unpaired failed result', backend: 'opencode', pair: id => invalidToolPair(id).slice(1) },
    ];

    for (const testCase of cases) {
      const observability = createMemoryObservability();
      const events = [
        ...testCase.pair(`${testCase.name}-1`),
        ...testCase.pair(`${testCase.name}-2`),
        ...testCase.pair(`${testCase.name}-3`),
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta',
          messageId: `${testCase.name}-answer`,
          delta: 'Completed without the breaker.',
        } as CodeAgentRunnerEvent,
        acpFinalEvent(testCase.backend, 'Completed without the breaker.'),
      ];
      const store = new MemoryCodeAgentStore(room({ codeAgentBackend: testCase.backend }), [userMessage()]);
      const { service } = createService({
        store,
        runner: new FakeCodeAgentRunnerClient(events),
        backend: 'code-agent',
        availableBackends: [testCase.backend],
        runnerCommandByBackend: {
          [testCase.backend]: testCase.backend === 'opencode'
            ? DEFAULT_OPENCODE_RUNNER_COMMAND
            : DEFAULT_HERMES_AGENT_RUNNER_COMMAND,
        },
        modelGateway: createTestModelGateway(),
        observability: observability.recorder,
        ids: ['ai-1', 'turn-1', 'segment-1'],
      });

      const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

      assert.equal(result.success, true, testCase.name);
      assert.equal(observability.events.some(event => event.event === 'code_agent.opencode.invalid_tool_loop'), false, testCase.name);
    }
  });

  it('keeps an OpenCode invalid-tool loop as first cause when the deadline fires afterward', async () => {
    const deadline = new ControlledTurnDeadline();
    const observability = createMemoryObservability();
    const runner: CodeAgentRunnerClient = {
      async run(_request, handlers): Promise<CodeAgentRunnerRunResult> {
        for (const event of [
          ...invalidToolPair('loop-first-1'),
          ...invalidToolPair('loop-first-2'),
          ...invalidToolPair('loop-first-3'),
        ]) {
          await handlers.onEvent(event);
        }
        deadline.fire();
        return new Promise<CodeAgentRunnerRunResult>(() => undefined);
      },
    };
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'opencode' }), [userMessage()]);
    const { service } = createService({
      store,
      runner,
      backend: 'code-agent',
      availableBackends: ['opencode'],
      runnerCommandByBackend: { opencode: DEFAULT_OPENCODE_RUNNER_COMMAND },
      modelGateway: createTestModelGateway(),
      observability: observability.recorder,
      scheduleTurnDeadline: deadline.schedule,
      clearTurnDeadline: deadline.clear,
      ids: ['ai-1', 'turn-1', 'terminal-error-1'],
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.match(result.error || '', /invalid tool request/);
    const failed = observability.events.find(event => event.event === 'code_agent.turn.failed');
    assert.equal(failed?.errorCode, 'opencode_invalid_tool_loop');
    assert.equal(observability.events.some(event => event.errorCode === 'turn_timeout'), false);
  });

  it('does not replace an earlier timeout or user interrupt with the OpenCode invalid-tool breaker', async () => {
    for (const firstCause of ['timeout', 'user_interrupt'] as const) {
      const deadline = new ControlledTurnDeadline();
      const observability = createMemoryObservability();
      let markReady!: () => void;
      let releaseThird!: () => void;
      const ready = new Promise<void>(resolve => { markReady = resolve; });
      const thirdReleased = new Promise<void>(resolve => { releaseThird = resolve; });
      const runner: CodeAgentRunnerClient = {
        async run(_request, handlers): Promise<CodeAgentRunnerRunResult> {
          for (const event of [
            ...invalidToolPair(`${firstCause}-1`),
            ...invalidToolPair(`${firstCause}-2`),
          ]) {
            await handlers.onEvent(event);
          }
          markReady();
          await thirdReleased;
          for (const event of invalidToolPair(`${firstCause}-3`)) {
            await handlers.onEvent(event);
          }
          const finalEvent = acpFinalEvent('opencode');
          await handlers.onEvent(finalEvent);
          return { events: [], finalEvent: finalEvent as any };
        },
      };
      const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'opencode' }), [userMessage()]);
      const { service } = createService({
        store,
        runner,
        backend: 'code-agent',
        availableBackends: ['opencode'],
        runnerCommandByBackend: { opencode: DEFAULT_OPENCODE_RUNNER_COMMAND },
        modelGateway: createTestModelGateway(),
        observability: observability.recorder,
        scheduleTurnDeadline: deadline.schedule,
        clearTurnDeadline: deadline.clear,
        ids: ['ai-1', 'turn-1', 'terminal-error-1'],
      });

      const active = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
      await ready;
      if (firstCause === 'timeout') {
        deadline.fire();
      } else {
        assert.deepEqual(await service.interruptTurn('room-1', 'client-1'), { success: true });
      }
      releaseThird();
      const result = await active;

      assert.equal(result.success, false, firstCause);
      const failed = observability.events.find(event => event.event === 'code_agent.turn.failed');
      assert.equal(failed?.errorCode, firstCause === 'timeout' ? 'turn_timeout' : 'turn_interrupted', firstCause);
      assert.equal(observability.events.some(event => event.event === 'code_agent.opencode.invalid_tool_loop'), false, firstCause);
    }
  });

  it('keeps an earlier lease loss ahead of a later OpenCode invalid-tool attempt', async () => {
    const observability = createMemoryObservability();
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'opencode' }), [userMessage()]);
    let service!: CodeAgentSessionService;
    const runner: CodeAgentRunnerClient = {
      async run(_request, handlers): Promise<CodeAgentRunnerRunResult> {
        for (const event of [
          ...invalidToolPair('lease-first-1'),
          ...invalidToolPair('lease-first-2'),
        ]) {
          await handlers.onEvent(event);
        }
        const active = (service as any).activeTurns.get('room-1');
        active.terminationReason = 'lease_lost';
        store.roomLeases.delete('room-1');
        for (const event of invalidToolPair('lease-first-3')) {
          await handlers.onEvent(event);
        }
        return new Promise<CodeAgentRunnerRunResult>(() => undefined);
      },
    };
    ({ service } = createService({
      store,
      runner,
      backend: 'code-agent',
      availableBackends: ['opencode'],
      runnerCommandByBackend: { opencode: DEFAULT_OPENCODE_RUNNER_COMMAND },
      modelGateway: createTestModelGateway(),
      observability: observability.recorder,
      ids: ['ai-1', 'turn-1', 'terminal-error-1'],
    }));

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const failed = observability.events.find(event => event.event === 'code_agent.turn.failed');
    assert.equal(failed?.errorCode, 'room_lease_lost');
    assert.equal(observability.events.some(event => event.event === 'code_agent.opencode.invalid_tool_loop'), false);
    assert.equal(store.agentTurns.get('turn-1')?.status, 'running');
    assert.equal(store.rooms.get('room-1')?.codeAgentStatus, 'running');
  });

  for (const harness of [
    {
      backend: 'opencode' as const,
      command: DEFAULT_OPENCODE_RUNNER_COMMAND,
      displayName: 'OpenCode',
    },
    {
      backend: 'hermes-agent' as const,
      command: DEFAULT_HERMES_AGENT_RUNNER_COMMAND,
      displayName: 'Hermes',
    },
  ]) {
    it(`orchestrates a complete ${harness.displayName} turn through the scoped model gateway`, async () => {
      const previousSessionId = `acp:${harness.backend}:previous-session`;
      const nextSessionId = `acp:${harness.backend}:next-session`;
      const store = new MemoryCodeAgentStore(room({
        codeAgentBackend: harness.backend,
        codeAgentSessionId: previousSessionId,
        codeAgentMode: 'fullAccess',
      }), [userMessage()]);
      const contexts: Array<{ backend?: CodeAgentBackend }> = [];
      const runner: CodeAgentRunnerClient = {
        async run(request, handlers, context): Promise<CodeAgentRunnerRunResult> {
          contexts.push({ backend: context?.backend });
          assert.equal(request.sessionId, null);
          assert.equal(request.provider, selectedModel.provider);
          assert.equal(request.modelId, selectedModel.id);
          assert.equal(request.apiModel, selectedModel.apiModel);
          assert.equal(request.codexModel, undefined);
          assert.equal(request.codexPermissionMode, undefined);

          const toolCall = {
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'tool_call' as const,
            id: `${harness.backend}-tool-1`,
            name: 'Read',
            args: { file_path: 'README.md' },
          };
          const toolResult = {
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'tool_result' as const,
            id: toolCall.id,
            name: toolCall.name,
            success: true,
            output: '# RoomTalk',
          };
          const firstText = {
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'text_delta' as const,
            messageId: `${harness.backend}-message-1`,
            delta: 'I checked the project.',
          };
          const secondText = {
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'text_delta' as const,
            messageId: `${harness.backend}-message-2`,
            delta: ' It is ready.',
          };
          const finalEvent = {
            schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
            type: 'final' as const,
            messageId: secondText.messageId,
            answer: 'I checked the project. It is ready.',
            sessionId: nextSessionId,
            usage: {
              promptTokens: 100,
              completionTokens: 20,
              totalTokens: 120,
              source: 'reported' as const,
            },
          };
          for (const event of [firstText, toolCall, toolResult, secondText, finalEvent]) {
            await handlers.onEvent(event);
          }
          return {
            events: [firstText, toolCall, toolResult, secondText, finalEvent],
            finalEvent,
          };
        },
      };
      const gateway = new CodeAgentModelGateway({
        publicBaseUrl: 'https://room.example/api/code-agent/model-gateway',
        tokenSecret: 'gateway-secret',
        providerApiKeys: { deepseek: 'deepseek-provider-key' },
        nowMs: () => 1_800_000_000_000,
        stateStore: new InMemoryCodeAgentModelGatewayTokenStateStore(() => 1_800_000_000_000),
      });
      const { emitter, sandboxService, service } = createService({
        store,
        runner,
        backend: 'code-agent',
        runnerCommandByBackend: {
          [harness.backend]: harness.command,
        },
        runnerProviderEnvByProvider: {
          deepseek: { DEEPSEEK_API_KEY: 'must-not-leak' },
        },
        modelGateway: gateway,
        availableModes: ['fullAccess'],
        mediaObjectStorage: new MemoryMediaObjectStorage(),
        ids: ['ai-1', 'turn-1', 'tool-message-1', 'tool-result-1', 'ai-2'],
      });

      const result = await service.startTurn({
        roomId: 'room-1',
        clientId: 'client-1',
        selectedModel,
      });

      assert.deepEqual(result, { success: true, messageId: 'ai-1' });
      assert.deepEqual(contexts, [{ backend: harness.backend }]);
      assert.equal(sandboxService.startedRunnerCommands[0], harness.command);
      const runnerEnv = sandboxService.startedRunnerEnvs[0];
      assert.equal(
        runnerEnv.CODE_AGENT_MODEL_PROXY_URL,
        'https://room.example/api/code-agent/model-gateway/v1',
      );
      assert.equal(typeof runnerEnv.CODE_AGENT_MODEL_PROXY_TOKEN, 'string');
      assert.equal('DEEPSEEK_API_KEY' in runnerEnv, false);

      const messages = store.messages.get('room-1') || [];
      assert.deepEqual(
        messages.map(message => message.messageType),
        ['text', 'ai', 'tool_call', 'tool_result', 'ai'],
      );
      assert.equal(messages[1].content, 'I checked the project.');
      assert.equal(messages[2].username, harness.displayName);
      assert.equal(messages[3].username, harness.displayName);
      assert.equal(messages[4].content, ' It is ready.');
      assert.equal(messages[4].status, 'complete');
      assert.equal(store.roomCost.totalUsd, 0);
      assert.deepEqual(messages[4].aiModel, {
        id: selectedModel.id,
        apiModel: selectedModel.apiModel,
        provider: selectedModel.provider,
        label: selectedModel.label,
        isPremium: selectedModel.isPremium,
      });
      assert.ok((messages[4].cost?.totalUsd || 0) > 0);
      assert.equal((await store.getRoomById('room-1'))?.codeAgentSessionId, nextSessionId);
      assert.equal([...store.agentTurns.values()][0]?.backend, harness.backend);
      assert.equal(store.workspaceRevisions.get('turn:turn-1')?.traversable, true);
      assert.equal(store.roomRevisionHeads.get('room-1'), 'turn:turn-1');
      assert.equal(
        emitter.roomEmits.some(event => event.event === 'ai_stream_end'),
        true,
      );
    });

    it(`completes a ${harness.displayName} final that arrives immediately after a tool result`, async () => {
      const runner = new FakeCodeAgentRunnerClient([
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta',
          messageId: `${harness.backend}-message-1`,
          delta: 'The inspection is complete.',
        },
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'tool_call',
          id: `${harness.backend}-tool-1`,
          name: 'Read',
          args: { file_path: 'README.md' },
        },
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'tool_result',
          id: `${harness.backend}-tool-1`,
          name: 'Read',
          success: true,
          output: '# RoomTalk',
        },
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final',
          messageId: `${harness.backend}-message-1`,
          answer: 'The inspection is complete.',
          sessionId: `acp:${harness.backend}:session-1`,
          usage: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            source: 'reported',
          },
        },
      ]);
      const gateway = new CodeAgentModelGateway({
        publicBaseUrl: 'https://room.example/api/code-agent/model-gateway',
        tokenSecret: 'gateway-secret',
        providerApiKeys: { deepseek: 'deepseek-provider-key' },
      });
      const store = new MemoryCodeAgentStore(room({
        codeAgentBackend: harness.backend,
      }), [userMessage()]);
      const { service } = createService({
        store,
        runner,
        backend: 'code-agent',
        modelGateway: gateway,
        ids: ['ai-1', 'turn-1', 'tool-message-1', 'tool-result-1'],
      });

      const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

      assert.deepEqual(result, { success: true, messageId: 'ai-1' });
      assert.equal(store.agentTurns.get('turn-1')?.status, 'complete');
      const messages = store.messages.get('room-1') || [];
      assert.equal(messages[1].status, 'complete');
      assert.equal(messages[1].content, 'The inspection is complete.');
      assert.ok((messages[1].cost?.totalUsd || 0) > 0);
    });
  }

  it("uses the room owner's Codex and GitHub connections for an authorized member turn", async () => {
    const prompt = { ...userMessage('member prompt'), clientId: 'member-1' };
    const store = new MemoryCodeAgentStore(room({
      codeAgentBackend: 'codex-app-server',
      codeAgentAccess: 'member',
    }), [prompt]);
    store.addMember('room-1', 'member-1', 'member');
    const authCalls: Array<{ clientId: string; runId: string }> = [];
    const githubCalls: string[] = [];
    const runner = new FakeCodeAgentRunnerClient([
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Shared owner Codex done',
        sessionId: 'owner-codex-session',
      },
    ]);
    const { service } = createService({
      store,
      runner,
      backend: 'codex-app-server',
      runnerCommand: DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
      codexBackendEnabled: true,
      codexConnectionService: {
        async withCodexAuth(clientId: string, runId: string, work: (authJson: string, snapshot: { authVersion: number }) => Promise<any>) {
          authCalls.push({ clientId, runId });
          const workResult = await work('{"tokens":{"access_token":"owner-token"}}', { authVersion: 3 });
          return workResult.result;
        },
      },
      githubConnectionService: {
        async getAccessToken(clientId: string) {
          githubCalls.push(clientId);
          return null;
        },
      },
      ids: ['ai-1', 'turn-1'],
    });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'member-1',
      selectedModel,
      promptMessageId: prompt.id,
      promptMessage: prompt,
    });

    assert.deepEqual(result, { success: true, messageId: 'ai-1' });
    assert.deepEqual(authCalls, [{ clientId: 'client-1', runId: 'turn-1' }]);
    assert.deepEqual(githubCalls, ['client-1']);
    assert.equal(runner.requests[0].clientId, 'member-1');
    assert.equal(runner.requests[0].prompt, 'member prompt');
  });

  it('explains when the room owner has not connected Codex without exposing a client id', async () => {
    const prompt = { ...userMessage('member prompt'), clientId: 'member-1' };
    const store = new MemoryCodeAgentStore(room({
      codeAgentBackend: 'codex-app-server',
      codeAgentAccess: 'member',
    }), [prompt]);
    store.addMember('room-1', 'member-1', 'member');
    const { service, sandboxService } = createService({
      store,
      backend: 'codex-app-server',
      runnerCommand: DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
      codexBackendEnabled: true,
      codexConnectionService: {
        async withCodexAuth(clientId: string) {
          throw new CodexConnectionError(`No Codex connection found for client ${clientId}.`, 'connection_not_found');
        },
      },
      ids: ['ai-1', 'turn-1'],
    });

    const result = await service.startTurn({
      roomId: 'room-1',
      clientId: 'member-1',
      selectedModel,
      promptMessageId: prompt.id,
      promptMessage: prompt,
    });

    assert.deepEqual(result, {
      success: false,
      error: 'The room owner must connect Codex before members can use this workspace',
    });
    assert.equal(sandboxService.startedRunnerCommands.length, 0);
    const errorMessage = store.messages.get('room-1')?.at(-1);
    assert.equal(errorMessage?.content, 'The room owner must connect Codex before members can use this workspace');
    assert.equal(errorMessage?.content.includes('client-1'), false);
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
    assert.equal(messages[1].content, 'Codex task failed. Retry, or switch engines if the problem continues.');
  });

  it('persists interleaved AI text and tool events in runner order', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'I will inspect.' },
      cocoModelStep(1, true, ['tool-1'], { promptTokens: 6, completionTokens: 1, totalTokens: 7 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Glob', args: { pattern: '**/*' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Glob', success: true, output: 'No files found matching the pattern.' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'The current directory is empty.' },
      cocoModelStep(2, true, [], { promptTokens: 4, completionTokens: 1, totalTokens: 5 }),
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
    assert.equal(runner.requests[0].sessionId, null);
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

  it('uses only the saved prompt when maxContextMessages is zero', async () => {
    const prompt = { ...userMessage('current prompt'), id: 'user-current' };
    const store = new MemoryCodeAgentStore(room(), [userMessage('older prompt'), prompt]);
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const { service } = createService({ store, runner });

    await service.startTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      maxContextMessages: 0,
      promptMessageId: prompt.id,
      promptMessage: prompt,
    });

    assert.equal(runner.requests[0].prompt, 'current prompt');
    assert.deepEqual(runner.requests[0].priorMessages, []);
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
      cocoModelStep(1, false, ['tool-1', 'tool-2'], { promptTokens: 6, completionTokens: 1, totalTokens: 7 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Write', args: { file_path: 'hello.py' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Write', success: true, output: 'wrote hello.py' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-2', name: 'Shell', args: { command: 'python3 hello.py' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-2', name: 'Shell', success: true, output: 'Hello, World!' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done. The program prints Hello, World!' },
      cocoModelStep(2, true, [], { promptTokens: 4, completionTokens: 1, totalTokens: 5 }),
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
    assert.equal(emitter.roomEmits.some(event => event.event === 'message_deleted'), false);
  });

  it('does not render final answers when a tool-only turn sends no text delta', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      cocoModelStep(1, false, ['tool-1'], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
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
    assert.ok((messages[1].cost?.totalUsd || 0) > 0);
    assert.equal(messages[1].modelStepId, 'turn-1:step:1');
    assert.equal(store.roomCost.totalUsd, messages[1].cost?.totalUsd);
    assert.equal(emitter.roomEmits.some(event => event.event === 'message_deleted'), false);
  });

  it('stops the runner before broadcasting the final stream end', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
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
        ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true',
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
      ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true',
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
        ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true',
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

  it('injects a scoped static publish token for configured approve-for-me turns', async () => {
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
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'approveForMe' }), [userMessage()]);
    const roomContext = new CodeAgentRoomContextService(store as any, {
      tokenSecret: 'room-context-secret',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'static-publish-refresh-token-id',
    });
    const { sandboxService, service } = createService({
      store,
      runner,
      availableModes: ['fullAccess'],
      defaultMode: 'plan',
      staticSitePublisher,
      roomContext,
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
    assert.equal(env.ROOMTALK_STATIC_PUBLISH_REFRESH_URL, 'https://room.example/api/code-agent/publish-static-site/token');
    const refreshClaims = roomContext.verifyTurnToken(env.ROOMTALK_STATIC_PUBLISH_REFRESH_TOKEN);
    assert.equal(refreshClaims?.turnId, 'turn-1');
    assert.equal(refreshClaims?.exp, Date.parse('2026-05-03T02:00:00.000Z') / 1000);
    const claims = staticSitePublisher.verifyTurnToken(env.ROOMTALK_STATIC_PUBLISH_TOKEN);
    assert.equal(claims?.roomId, 'room-1');
    assert.equal(claims?.clientId, 'client-1');
    assert.equal(claims?.turnId, 'turn-1');
    assert.equal(claims?.mode, 'approveForMe');
  });

  it('injects a read-only room context CLI token in every agent mode', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ]);
    const store = new MemoryCodeAgentStore(room({ codeAgentMode: 'plan', codeAgentBackend: 'code-agent' }), [userMessage()]);
    const staticSitePublisher = new PublishedStaticSiteService({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      tokenSecret: 'static-publish-secret',
      publicBaseUrl: 'https://room.example',
    });
    const roomContext = new CodeAgentRoomContextService(store as any, {
      tokenSecret: 'room-context-secret',
      nowMs: () => Date.parse('2026-05-03T00:00:00.000Z'),
      createId: () => 'room-context-token-id',
    });
    const { sandboxService, service } = createService({
      store,
      runner,
      availableModes: ['plan'],
      defaultMode: 'plan',
      staticSitePublisher,
      roomContext,
    });

    await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    const env = sandboxService.startedRunnerEnvs[0];
    assert.equal(env.ROOMTALK_ROOM_CONTEXT_URL, 'https://room.example/api/code-agent/room-context');
    const claims = roomContext.verifyTurnToken(env.ROOMTALK_ROOM_CONTEXT_TOKEN);
    assert.equal(claims?.roomId, 'room-1');
    assert.equal(claims?.clientId, 'client-1');
    assert.equal(claims?.turnId, 'turn-1');
    assert.equal(claims?.mode, 'plan');
    assert.equal(env.ROOMTALK_CODE_AGENT_ALLOW_SHELL, 'true');
    assert.equal(env.ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH, undefined);
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
      allowedPublicBaseUrls: ['https://room.ruit.me', 'https://admin.room.ruit.me'],
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

  it('rejects overlapping turns across service instances with a durable room lease', async () => {
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    const firstRunner = new BlockingRunner();
    const firstService = createService({
      store,
      runner: firstRunner,
      ids: ['ai-1', 'turn-1'],
    }).service;
    const secondService = createService({
      store,
      runner: new FakeCodeAgentRunnerClient([
        { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-2', delta: 'Done' },
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'model_step',
          turnId: 'turn-2',
          stepId: 'turn-2:step:1',
          sequence: 1,
          hasText: true,
          toolCallIds: [],
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
        },
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final',
          messageId: 'ai-2',
          answer: 'Done',
          sessionId: 'session-2',
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
        },
      ]),
      ids: ['rejected-ai', 'rejected-turn', 'ai-2', 'turn-2'],
    }).service;

    const first = firstService.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await firstRunner.started;
    assert.deepEqual(
      await secondService.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }),
      { success: false, error: 'An agent task is already running in this workspace' }
    );

    firstRunner.release();
    assert.deepEqual(await first, { success: true, messageId: 'ai-1' });
    assert.equal(store.roomLeases.has('room-1'), false);
    assert.deepEqual(
      await secondService.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }),
      { success: true, messageId: 'ai-2' }
    );
  });

  it('classifies a lost durable lease separately from the application turn deadline', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'Done' },
      cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: 'Done',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const observability = createMemoryObservability();
    const { emitter, sandboxService, service, store } = createService({ runner, observability: observability.recorder });
    sandboxService.startRunner = async input => {
      store.roomLeases.delete(input.handle.roomId);
      return { command: input.command, stop: async () => undefined };
    };

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const failed = observability.events.find(item => item.event === 'code_agent.turn.failed');
    assert.equal(failed?.errorCode, 'room_lease_lost');
    assert.notEqual(failed?.errorCode, 'turn_timeout');
    assert.deepEqual(sandboxService.sandboxTimeoutUpdates.map(update => update.ttlMs), [60 * 60 * 1000]);
    assert.equal(emitter.roomEmits.some(event => (
      event.event === 'ai_stream_end'
      || event.event === 'ai_stream_error'
      || (event.event === 'agent_turn_updated' && (event.args[0] as RoomAgentTurn).status !== 'running')
    )), false);
  });

  it('rejects approval responses from members who did not start the turn', async () => {
    const runner = new BlockingRunner();
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'codex-app-server' }), [userMessage()]);
    store.addMember('room-1', 'member-1', 'member');
    const { service } = createService({
      store,
      runner,
      backend: 'codex-app-server',
      codexBackendEnabled: true,
      codexConnectionService: {
        async withCodexAuth(
          _clientId: string,
          _runId: string,
          work: (authJson: string, snapshot: { authVersion: number }) => Promise<any>,
        ) {
          const workResult = await work('{"tokens":{"access_token":"test"}}', { authVersion: 1 });
          return workResult.result;
        },
      },
    });
    const active = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;

    assert.deepEqual(await service.respondToApproval('room-1', 'member-1', 'approval-1', 'accept'), {
      success: false,
      error: 'Only the task starter, room owner, or room admin can respond to this approval',
    });

    runner.release();
    await active;
  });

  it('persists follow-up input and starts it as the next complete turn', async () => {
    const runner = new SequencedBlockingRunner();
    const { emitter, service, store } = createService({
      runner,
      ids: ['ai-1', 'turn-1', 'ai-2', 'turn-2'],
    });
    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.waitForRuns(1);

    const queuedMessage: Message = {
      id: 'queued-1',
      clientId: 'client-1',
      content: 'run the tests next',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    };
    const queued = await service.queueTurn({
      roomId: 'room-1',
      clientId: 'client-1',
      selectedModel,
      requestedMode: 'plan',
    }, queuedMessage);
    assert.equal(queued.success, true);
    assert.equal(queued.message?.codeAgentQueuedInput?.state, 'queued');

    runner.release(0);
    assert.deepEqual(await first, { success: true, messageId: 'ai-1' });
    await runner.waitForRuns(2);
    assert.equal(runner.requests[1].prompt, 'run the tests next');
    assert.equal(runner.requests[1].mode, 'plan');
    assert.equal(runner.requests[1].priorMessages?.some(item => item.role === 'user' && item.content === 'run the tests next') ?? false, false);
    const turnUpdates = emitter.roomEmits.filter(event => event.event === 'agent_turn_updated');
    const firstTerminalIndex = turnUpdates.findIndex(event => (
      (event.args[0] as RoomAgentTurn).id === 'turn-1'
      && (event.args[0] as RoomAgentTurn).status === 'complete'
    ));
    const secondRunningIndex = turnUpdates.findIndex(event => (
      (event.args[0] as RoomAgentTurn).id === 'turn-2'
      && (event.args[0] as RoomAgentTurn).status === 'running'
    ));
    assert.ok(firstTerminalIndex >= 0 && secondRunningIndex > firstTerminalIndex);

    const deadline = Date.now() + 1_000;
    while (store.messages.get('room-1')?.find(item => item.id === 'queued-1')?.codeAgentQueuedInput?.state === 'starting' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const startedPrompt = store.messages.get('room-1')?.find(item => item.id === 'queued-1');
    assert.equal(startedPrompt?.codeAgentQueuedInput, undefined);
    assert.equal(startedPrompt?.turnId, 'turn-2');

    runner.release(1);
    await runner.waitForCompletions(2);
  });

  it('preserves zero and undefined max-context settings through queued turn claim and start', async () => {
    for (const maxContextMessages of [0, undefined]) {
      const runner = new FakeCodeAgentRunnerClient([
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'text_delta',
          messageId: 'queued-answer',
          delta: 'Done',
        },
        cocoModelStep(1, true, [], {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
        }),
        {
          schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
          type: 'final',
          messageId: 'queued-answer',
          answer: 'Done',
          sessionId: 'queued-session',
          usage: {
            promptTokens: 10,
            completionTokens: 2,
            totalTokens: 12,
            source: 'reported',
          },
        },
      ]);
      const store = new MemoryCodeAgentStore(room(), [userMessage('older prompt')]);
      const { service } = createService({
        store,
        runner,
        ids: ['ai-1', 'turn-1'],
      });
      const queued = await service.queueTurn({
        roomId: 'room-1',
        clientId: 'client-1',
        selectedModel,
        ...(maxContextMessages !== undefined ? { maxContextMessages } : {}),
      }, {
        ...userMessage('queued prompt'),
        id: `queued-${maxContextMessages ?? 'default'}`,
        timestamp: '2026-05-03T00:00:01.000Z',
      });

      assert.equal(queued.message?.codeAgentQueuedInput?.maxContextMessages, maxContextMessages);
      const requestDeadline = Date.now() + 1_000;
      while (runner.requests.length === 0 && Date.now() < requestDeadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(runner.requests.length, 1);
      assert.equal(runner.requests[0].prompt, 'queued prompt');
      assert.deepEqual(
        runner.requests[0].priorMessages,
        maxContextMessages === 0
          ? []
          : [{ role: 'user', content: 'older prompt' }],
      );
    }
  });

  it('returns only the canonical queued message for an idempotent retry and leaves durable fan-out to room_events', async () => {
    const runner = new BlockingRunner();
    const { emitter, service, store } = createService({
      runner,
      ids: ['ai-1', 'turn-1'],
    });
    const activeTurn = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;
    const canonicalMessage: Message = {
      id: 'queued-canonical',
      clientId: 'client-1',
      clientMessageId: 'queue-request-1',
      content: 'run the tests next',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    };

    const first = await service.queueTurn(
      { roomId: 'room-1', clientId: 'client-1', selectedModel },
      canonicalMessage,
    );
    const duplicate = await service.queueTurn(
      { roomId: 'room-1', clientId: 'client-1', selectedModel },
      { ...canonicalMessage, id: 'queued-ghost' },
    );

    assert.equal(first.message?.id, 'queued-canonical');
    assert.equal(duplicate.message?.id, 'queued-canonical');
    assert.equal(
      store.messages.get('room-1')?.filter(item => item.clientMessageId === 'queue-request-1').length,
      1,
    );
    assert.equal(emitter.roomEmits.some(event => event.event === 'new_message'), false);

    await service.cancelQueuedTurn('room-1', 'client-1', 'queued-canonical');
    runner.release();
    await activeTurn;
  });

  it('accepts Queue during the completion race and starts it immediately when no turn is active', async () => {
    const runner = new SequencedBlockingRunner();
    const { service, store } = createService({
      runner,
      ids: ['ai-1', 'turn-1'],
    });
    const queued = await service.queueTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }, {
      id: 'queued-race-1',
      clientId: 'client-1',
      content: 'start this queued task',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    });

    assert.equal(queued.success, true);
    await runner.waitForRuns(1);
    assert.equal(runner.requests[0].prompt, 'start this queued task');

    const deadline = Date.now() + 1_000;
    while (store.messages.get('room-1')?.find(item => item.id === 'queued-race-1')?.codeAgentQueuedInput?.state === 'starting' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(store.messages.get('room-1')?.find(item => item.id === 'queued-race-1')?.codeAgentQueuedInput, undefined);
    assert.equal(store.messages.get('room-1')?.find(item => item.id === 'queued-race-1')?.turnId, 'turn-1');

    runner.release(0);
    await runner.waitForCompletions(1);
  });

  it('force-terminates after interrupt control times out and closes pending tools as cancelled', async () => {
    const runner = new InterruptibleRunner(false, true);
    const observability = createMemoryObservability();
    const { service, store, sandboxService } = createService({
      runner,
      observability: observability.recorder,
    });
    let processState!: { terminateCount: number };
    sandboxService.startRunner = async input => {
      const created = createInterruptibleProcess(input, runner, false);
      processState = created.state;
      return created.process;
    };

    const active = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;

    assert.deepEqual(await service.interruptTurn('room-1', 'client-1'), { success: true });
    const result = await active;

    assert.equal(result.success, false);
    assert.match(result.error || '', /interrupted by the user/);
    assert.equal(processState.terminateCount, 1);
    assert.equal(store.rooms.get('room-1')?.codeAgentStatus, 'idle');
    const turn = [...store.agentTurns.values()][0];
    assert.equal(turn.status, 'cancelled');
    assert.equal(turn.finalMessageId, undefined);
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'tool_call', 'tool_result', 'ai']);
    assert.equal(messages.some(message => message.status === 'streaming'), false);
    assert.match(messages.find(message => message.messageType === 'tool_result')?.content || '', /Tool interrupted before completion/);
    assert.equal(observability.events.find(event => event.event === 'code_agent.turn.failed')?.errorCode, 'turn_interrupted');
  });

  it('force-terminates when interrupt is acknowledged but the runner does not exit', async () => {
    const runner = new InterruptibleRunner(true);
    const observability = createMemoryObservability();
    const { service, store, sandboxService } = createService({
      runner,
      observability: observability.recorder,
    });
    let processState!: { terminateCount: number };
    sandboxService.startRunner = async input => {
      const created = createInterruptibleProcess(input, runner, true);
      processState = created.state;
      return created.process;
    };

    const active = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;

    assert.deepEqual(await service.interruptTurn('room-1', 'client-1'), { success: true });
    const result = await active;

    assert.equal(result.success, false);
    assert.equal(processState.terminateCount, 1);
    assert.equal(store.rooms.get('room-1')?.codeAgentStatus, 'idle');
    assert.equal([...store.agentTurns.values()][0].status, 'cancelled');
    assert.equal((store.messages.get('room-1') || []).some(message => message.status === 'streaming'), false);
    assert.equal(observability.events.find(event => event.event === 'code_agent.turn.failed')?.errorCode, 'turn_interrupted');
  });

  it('cancels a turn when Stop arrives while startRunner is still awaiting a process', async () => {
    const runner = new InterruptibleRunner();
    const observability = createMemoryObservability();
    const { service, store, sandboxService } = createService({
      runner,
      observability: observability.recorder,
    });
    let markStartEntered!: () => void;
    const startEntered = new Promise<void>(resolve => {
      markStartEntered = resolve;
    });
    let resolveProcess!: (process: CodeAgentRunnerProcess) => void;
    const processReady = new Promise<CodeAgentRunnerProcess>(resolve => {
      resolveProcess = resolve;
    });
    let terminateCount = 0;
    sandboxService.startRunner = async input => {
      markStartEntered();
      return processReady;
    };

    const active = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await startEntered;
    assert.deepEqual(await service.interruptTurn('room-1', 'client-1'), { success: true });
    resolveProcess({
      command: 'delayed-runner',
      stop: async () => undefined,
      terminate: async () => {
        terminateCount += 1;
      },
    });

    const result = await active;
    assert.equal(result.success, false);
    assert.match(result.error || '', /interrupted by the user/);
    assert.equal(terminateCount, 1);
    assert.equal(runner.requests.length, 0);
    assert.equal(store.rooms.get('room-1')?.codeAgentStatus, 'idle');
    assert.equal([...store.agentTurns.values()][0].status, 'cancelled');
    assert.equal((store.messages.get('room-1') || []).some(message => message.status === 'streaming'), false);
    assert.equal(observability.events.find(event => event.event === 'code_agent.turn.failed')?.errorCode, 'turn_interrupted');
  });

  it('keeps lease loss as an error when Stop is marked during runner startup', async () => {
    const runner = new InterruptibleRunner();
    const observability = createMemoryObservability();
    const { service, store, sandboxService } = createService({
      runner,
      observability: observability.recorder,
    });
    let terminateCount = 0;
    sandboxService.startRunner = async input => {
      store.roomLeases.delete(input.handle.roomId);
      assert.deepEqual(await service.interruptTurn('room-1', 'client-1'), { success: true });
      return {
        command: input.command,
        stop: async () => undefined,
        terminate: async () => {
          terminateCount += 1;
        },
      };
    };

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    assert.equal(terminateCount, 1);
    assert.notEqual(store.rooms.get('room-1')?.codeAgentStatus, 'idle');
    assert.notEqual([...store.agentTurns.values()][0].status, 'cancelled');
    const failed = observability.events.find(event => event.event === 'code_agent.turn.failed');
    assert.equal(failed?.errorCode, 'room_lease_lost');
    assert.notEqual(failed?.errorCode, 'turn_interrupted');
  });

  it('preserves a first-cause user interrupt when the application deadline fires next', async () => {
    const runner = new InterruptibleRunner(true);
    const deadline = new ControlledTurnDeadline();
    const observability = createMemoryObservability();
    const { service, store, sandboxService } = createService({
      runner,
      observability: observability.recorder,
      scheduleTurnDeadline: deadline.schedule,
      clearTurnDeadline: deadline.clear,
    });
    sandboxService.startRunner = async input => createInterruptibleProcess(input, runner, true).process;

    const active = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;
    assert.deepEqual(await service.interruptTurn('room-1', 'client-1'), { success: true });
    deadline.fire();

    const result = await active;
    assert.equal(result.success, false);
    assert.equal(store.rooms.get('room-1')?.codeAgentStatus, 'idle');
    assert.equal([...store.agentTurns.values()][0].status, 'cancelled');
    const failed = observability.events.find(event => event.event === 'code_agent.turn.failed');
    assert.equal(failed?.errorCode, 'turn_interrupted');
    assert.equal(observability.events.some(event => event.errorCode === 'turn_timeout'), false);
  });

  it('keeps queued follow-up input after an explicit user interrupt', async () => {
    const runner = new ControlBlockingRunner();
    const observability = createMemoryObservability();
    const { service, store, sandboxService } = createService({ runner, observability: observability.recorder });
    sandboxService.startRunner = async input => ({
      command: input.command,
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          void runner.receiveControl(JSON.parse(String(chunk))).then(() => callback(), callback);
        },
      }),
      stop: async () => {},
    });

    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;
    await service.queueTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }, {
      id: 'queued-stop-1',
      clientId: 'client-1',
      content: 'do this after the current task',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    });

    assert.deepEqual(await service.interruptTurn('room-1', 'client-1'), { success: true });
    await first;
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(runner.requests.length, 1);
    assert.equal(store.messages.get('room-1')?.find(item => item.id === 'queued-stop-1')?.codeAgentQueuedInput?.state, 'queued');
    assert.equal(observability.events.some(item => item.errorCode === 'turn_timeout'), false);
  });

  it('returns a rejected steer to queued state instead of losing it', async () => {
    const runner = new ControlBlockingRunner(false);
    const { service, store, sandboxService } = createService({ runner });
    sandboxService.startRunner = async input => ({
      command: input.command,
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          void runner.receiveControl(JSON.parse(String(chunk))).then(() => callback(), callback);
        },
      }),
      stop: async () => {},
    });

    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;
    await service.queueTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }, {
      id: 'queued-steer-1',
      clientId: 'client-1',
      content: 'use Bing instead',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    });

    const response = await service.steerQueuedTurn('room-1', 'client-1', 'queued-steer-1');
    assert.deepEqual(response, { success: false, error: 'turn already completed' });
    const queued = store.messages.get('room-1')?.find(item => item.id === 'queued-steer-1')?.codeAgentQueuedInput;
    assert.equal(queued?.state, 'queued');
    assert.equal(queued?.lastError, 'turn already completed');

    runner.release();
    await first;
  });

  it('keeps an accepted steer pending until the runner reports its user input insertion', async () => {
    const runner = new ControlBlockingRunner(true);
    const { service, store, sandboxService } = createService({ runner });
    sandboxService.startRunner = async input => ({
      command: input.command,
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          void runner.receiveControl(JSON.parse(String(chunk))).then(() => callback(), callback);
        },
      }),
      stop: async () => {},
    });

    const first = service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });
    await runner.started;
    await service.queueTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel }, {
      id: 'queued-steer-inserted',
      clientId: 'client-1',
      content: 'use Bing instead',
      roomId: 'room-1',
      timestamp: '2026-05-03T00:00:01.000Z',
      messageType: 'text',
    });

    const response = await service.steerQueuedTurn('room-1', 'client-1', 'queued-steer-inserted');
    assert.deepEqual(response, { success: true });
    const inserted = store.messages.get('room-1')?.find(item => item.id === 'queued-steer-inserted');
    assert.equal(inserted?.codeAgentQueuedInput, undefined);
    assert.equal(inserted?.turnId, 'turn-1');

    runner.release();
    await first;
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
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'ok' },
      cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
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
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'ok' },
      cocoModelStep(1, true, [], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
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
      cocoModelStep(1, false, ['tool-1'], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
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
    assert.equal(messages[1].content, 'Coco task failed. Retry, or switch engines if the problem continues.');
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_error'), true);
  });

  it('rolls back the whole turn when placeholder persistence is rejected', async () => {
    const store = new MemoryCodeAgentStore(room(), [userMessage()]);
    store.upsertFailures = 1;
    const { emitter, service } = createService({ store });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.deepEqual(result, { success: false, error: 'Unable to start a durable agent response' });
    assert.equal((await store.getRoomById('room-1'))?.codeAgentStatus, undefined);
    const roomUpdates = emitter.roomEmits.filter(event => event.event === 'room_updated');
    assert.equal(roomUpdates.length, 0);
    assert.equal(store.agentTurns.size, 0);
    assert.equal(store.roomLeases.size, 0);
    assert.deepEqual((store.messages.get('room-1') || []).map(message => message.messageType), ['text']);
    assert.equal(emitter.roomEmits.some(event => event.event === 'ai_stream_error'), false);
  });

  it('marks the AI placeholder as error when the runner returns an error event', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'error', message: 'runner crashed', code: 'runner_exit', retryable: false },
    ]);
    const observability = createMemoryObservability();
    const { emitter, service, store } = createService({ runner, observability: observability.recorder });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const messages = store.messages.get('room-1') || [];
    assert.equal(messages[1].messageType, 'ai');
    assert.equal(messages[1].status, 'error');
    assert.equal(messages[1].content, 'Coco task failed. Retry, or switch engines if the problem continues.');
    assert.equal(messages[1].content.includes('runner crashed'), false);
    assert.equal(messages[2].messageType, 'sandbox_status');
    assert.equal(messages[2].isError, true);
    assert.equal(messages[2].content, 'Coco task failed. Retry, or switch engines if the problem continues.');
    assert.equal(messages[2].content.includes('runner crashed'), false);
    assert.equal((await store.getRoomById('room-1'))?.codeAgentStatus, 'error');
    assert.equal(emitter.roomEmits.some(event => event.event === 'new_message'), false);
    const streamError = emitter.roomEmits.find(event => event.event === 'ai_stream_error');
    assert.ok(streamError);
    assert.equal((streamError.args[0] as any).persisted, true);
    assert.deepEqual((streamError.args[0] as any).message, messages[1]);
    assert.equal(Object.prototype.hasOwnProperty.call((streamError.args[0] as any).message, 'aiStreamOwnerId'), false);
    assert.equal(
      observability.events.find(event => event.event === 'code_agent.turn.failed')?.errorMessage,
      'Code agent runner process failed.',
    );
  });

  for (const runnerFailure of [
    {
      label: 'daemon client',
      code: 'daemon_process_error',
      expectedCode: 'runner_daemon_failure',
      expectedMessage: 'Code agent runner daemon failed.',
    },
    {
      label: 'one-shot JSONL client',
      code: 'runner_process_error',
      expectedCode: 'runner_process_failure',
      expectedMessage: 'Code agent runner process failed.',
    },
  ]) {
    it(`suppresses raw ${runnerFailure.label} errors at observability and logger boundaries`, async () => {
      const secret = 'ROOMTALK_PRIVATE_TOKEN=must-not-leak';
      const rawError = `sandbox stderr Authorization: Bearer ${secret}; command=${secret}${'x'.repeat(8_000)}`;
      const runner = new FakeCodeAgentRunnerClient([{
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'error',
        message: rawError,
        code: runnerFailure.code,
        retryable: false,
      }]);
      const observability = createMemoryObservability();
      const errorLogs: Array<{ message: string; meta?: unknown }> = [];
      const capturingLogger = {
        debug() {},
        error(message: string, meta?: unknown) {
          errorLogs.push({ message, meta });
        },
        info() {},
        warn() {},
      } as unknown as Logger;
      const { service } = createService({
        runner,
        observability: observability.recorder,
        logger: capturingLogger,
      });

      const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

      assert.equal(result.success, false);
      const runnerEvent = observability.events.find(event => event.event === 'code_agent.runner.error');
      assert.equal(runnerEvent?.errorCode, runnerFailure.expectedCode);
      assert.equal(runnerEvent?.errorMessage, runnerFailure.expectedMessage);
      assert.deepEqual(runnerEvent?.payload, {
        backend: 'code-agent',
        code: runnerFailure.expectedCode,
        message: runnerFailure.expectedMessage,
        detailLength: rawError.length,
        retryable: false,
      });
      const turnFailed = observability.events.find(event => event.event === 'code_agent.turn.failed');
      assert.equal(turnFailed?.errorMessage, runnerFailure.expectedMessage);
      assert.equal((turnFailed?.payload as any)?.runnerErrorCode, runnerFailure.expectedCode);
      assert.equal((turnFailed?.payload as any)?.runnerErrorDetailLength, rawError.length);
      const turnFailureLog = errorLogs.find(log => log.message === 'Code agent turn failed');
      assert.deepEqual(turnFailureLog?.meta, {
        roomId: 'room-1',
        messageId: 'ai-1',
        backend: 'code-agent',
        errorCode: 'turn_failed',
        failureKind: 'runner',
        failureDetailLength: rawError.length,
        runnerErrorCode: runnerFailure.expectedCode,
      });
      const serialized = JSON.stringify({ observability: observability.events, logs: errorLogs });
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes('ROOMTALK_PRIVATE_TOKEN'), false);
      assert.equal(serialized.includes('Authorization: Bearer'), false);
      assert.equal(serialized.length < rawError.length, true);
    });
  }

  it('sanitizes status, approval, and control diagnostics before observability persistence', async () => {
    const fakeSecret = 'ROOMTALK_PRIVATE_TOKEN=fake-diagnostic-secret';
    const runningStatusDetail = `Authorization: Bearer fake-access-token ${fakeSecret}`;
    const statusDetail = `runner status detail ${fakeSecret}`;
    const publicStatusMessage = 'OpenCode task failed. Retry, or switch engines if the problem continues.';
    const approvalTitle = `terminal: ${fakeSecret}`;
    const controlDetail = `control detail ${fakeSecret}`;
    const runner = new FakeCodeAgentRunnerClient([
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'status',
        turnId: 'turn-1',
        status: 'running',
        message: runningStatusDetail,
      },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'status',
        turnId: 'turn-1',
        status: 'error',
        message: statusDetail,
      },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'approval_request',
        turnId: 'turn-1',
        id: 'approval-1',
        approvalType: 'command',
        title: approvalTitle,
        args: { kind: 'execute' },
      },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'control_result',
        turnId: 'turn-1',
        controlId: 'control-1',
        controlType: 'approval_response',
        accepted: false,
        message: controlDetail,
      },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: '',
        sessionId: 'session-1',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, source: 'reported' },
      },
    ]);
    const observability = createMemoryObservability();
    const logRecords: unknown[] = [];
    const capturingLogger = {
      debug(message: string, metadata?: unknown) { logRecords.push({ level: 'debug', message, metadata }); },
      error(message: string, metadata?: unknown) { logRecords.push({ level: 'error', message, metadata }); },
      info(message: string, metadata?: unknown) { logRecords.push({ level: 'info', message, metadata }); },
      warn(message: string, metadata?: unknown) { logRecords.push({ level: 'warn', message, metadata }); },
    } as unknown as Logger;
    const store = new MemoryCodeAgentStore(room({ codeAgentBackend: 'opencode' }), [userMessage()]);
    const { service } = createService({
      store,
      runner,
      backend: 'code-agent',
      availableBackends: ['opencode'],
      runnerCommandByBackend: { opencode: DEFAULT_OPENCODE_RUNNER_COMMAND },
      modelGateway: createTestModelGateway(),
      observability: observability.recorder,
      logger: capturingLogger,
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, true);
    assert.equal([...store.agentTurns.values()][0].status, 'complete');
    const statusEvents = observability.events.filter(event => event.event === 'code_agent.runner.status');
    assert.deepEqual(statusEvents.map(event => event.payload), [
      {
        backend: 'opencode',
        status: 'running',
        messageLength: runningStatusDetail.length,
      },
      {
        backend: 'opencode',
        status: 'error',
        messageLength: publicStatusMessage.length,
      },
    ]);
    const approvalEvent = observability.events.find(event => event.event === 'code_agent.runner.approval_request');
    assert.deepEqual(approvalEvent?.payload, {
      backend: 'opencode',
      approvalId: 'approval-1',
      approvalType: 'command',
      titleLength: approvalTitle.length,
    });
    const controlEvent = observability.events.find(event => event.event === 'code_agent.runner.control_result');
    assert.deepEqual(controlEvent?.payload, {
      backend: 'opencode',
      controlId: 'control-1',
      controlType: 'approval_response',
      accepted: false,
      messageLength: controlDetail.length,
    });
    const statusMessage = (store.messages.get('room-1') || []).find(message => message.messageType === 'sandbox_status');
    assert.equal(statusMessage?.content, publicStatusMessage);
    const serializedDiagnostics = JSON.stringify({ observability: observability.events, logs: logRecords });
    assert.equal(serializedDiagnostics.includes(fakeSecret), false);
    assert.equal(serializedDiagnostics.includes(runningStatusDetail), false);
    assert.equal(serializedDiagnostics.includes('Authorization: Bearer'), false);
    assert.equal(serializedDiagnostics.includes(statusDetail), false);
    assert.equal(serializedDiagnostics.includes(approvalTitle), false);
    assert.equal(serializedDiagnostics.includes(controlDetail), false);
  });

  it('closes pending tool calls with failed results when the runner errors', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      cocoModelStep(1, false, ['tool-1'], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Shell', args: { command: 'python3 -m http.server 4173 --directory dist' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'error', message: 'code agent runner process failed: E2B command wait failed', code: 'runner_process_error', retryable: false },
    ]);
    const { emitter, service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'tool_call', 'tool_result', 'sandbox_status', 'ai']);
    assert.equal(messages[2].toolCallId, 'tool-1');
    assert.equal(messages[2].toolName, 'Shell');
    assert.equal(messages[2].status, 'error');
    assert.equal(messages[2].isError, true);
    assert.ok((messages[1].cost?.totalUsd || 0) > 0);
    assert.equal(store.roomCost.totalUsd, messages[1].cost?.totalUsd);
    assert.match(messages[2].content, /Tool interrupted before completion/);
    assert.match(messages[2].content, /Coco task failed/);
    assert.doesNotMatch(messages[2].content, /E2B command wait failed/);
    assert.match(messages[3].content, /Coco task failed/);
    assert.doesNotMatch(messages[3].content, /E2B command wait failed/);
    assert.equal(messages[4].status, 'error');
    assert.match(messages[4].content, /Coco task failed/);
    assert.equal(emitter.roomEmits.some(event => event.event === 'new_message'), false);
  });

  it('preserves tool-first text and tool history while deleting every empty segment on runner error', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      cocoModelStep(1, false, ['tool-1'], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Read', args: { file_path: 'README.md' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_result', id: 'tool-1', name: 'Read', success: true, output: '# RoomTalk' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'text_delta', messageId: 'ai-1', delta: 'The project uses RoomTalk.' },
      cocoModelStep(2, true, ['tool-2'], { promptTokens: 8, completionTokens: 2, totalTokens: 10 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-2', name: 'Shell', args: { command: 'npm test' } },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'error', message: 'runner stopped', code: 'runner_exit', retryable: false },
    ]);
    const { service, store } = createService({
      runner,
      ids: [
        'ai-initial',
        'turn-1',
        'tool-result-1-message',
        'ai-text-segment',
        'tool-result-2-message',
        'runner-status-message',
        'terminal-error-message',
      ],
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const messages = store.messages.get('room-1') || [];
    assert.equal(messages.some(item => item.id === 'ai-initial'), false);
    assert.deepEqual(messages.map(item => item.messageType), [
      'text',
      'tool_call',
      'tool_result',
      'ai',
      'tool_call',
      'tool_result',
      'sandbox_status',
      'ai',
    ]);
    assert.equal(messages[3].content, 'The project uses RoomTalk.');
    assert.equal(messages[3].status, 'complete');
    assert.equal(messages[5].toolCallId, 'tool-2');
    assert.equal(messages[5].status, 'error');
    assert.equal(messages[7].id, 'terminal-error-message');
    assert.equal(messages[7].status, 'error');
    assert.equal(messages[7].isError, true);
    assert.equal(messages.filter(item => item.messageType === 'ai' && item.status === 'error').length, 1);
    assert.equal(messages.some(item => item.status === 'streaming'), false);
    const persistedTurn = [...store.agentTurns.values()][0];
    assert.equal(persistedTurn.status, 'error');
    assert.equal(persistedTurn.finalMessageId, 'terminal-error-message');
  });

  it('closes a pending ACP approval card when the runner errors', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'approval_request',
        turnId: 'turn-1',
        id: 'approval-1',
        approvalType: 'command',
        title: 'Run command',
        args: { command: 'npm test' },
      },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'error',
        message: 'ACP connection closed',
        code: 'acp_harness_failed',
        retryable: false,
      },
    ]);
    const { service, store } = createService({ runner });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    assert.equal(result.success, false);
    const messages = store.messages.get('room-1') || [];
    assert.deepEqual(messages.map(message => message.messageType), [
      'text',
      'tool_call',
      'tool_result',
      'sandbox_status',
      'ai',
    ]);
    assert.equal(messages[1].toolName, 'approval_request');
    assert.equal(messages[2].toolCallId, 'approval-1');
    assert.equal(messages[2].status, 'error');
    assert.match(messages[2].content, /Coco task failed/);
    assert.doesNotMatch(messages[2].content, /ACP connection closed/);
    assert.match(messages[3].content, /Coco task failed/);
    assert.doesNotMatch(messages[3].content, /ACP connection closed/);
    assert.equal(messages[4].status, 'error');
  });

  it('closes pending tool calls without fabricating an interruption when the runner finalizes normally', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      cocoModelStep(1, false, ['tool-1'], { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'tool_call', id: 'tool-1', name: 'Shell', args: { command: 'sleep 30' } },
      {
        schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
        type: 'final',
        messageId: 'ai-1',
        answer: '',
        sessionId: 'session-1',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, source: 'reported' },
      },
    ]);
    const observability = createMemoryObservability();
    const { emitter, service, store } = createService({
      runner,
      observability: observability.recorder,
    });

    const result = await service.startTurn({ roomId: 'room-1', clientId: 'client-1', selectedModel });

    const messages = store.messages.get('room-1') || [];
    assert.equal(result.success, true);
    assert.deepEqual(messages.map(message => message.messageType), ['text', 'tool_call', 'tool_result']);
    assert.equal(messages[2].toolCallId, 'tool-1');
    assert.equal(messages[2].status, 'error');
    assert.equal(messages[2].isError, true);
    assert.equal(messages[2].exitCode, 1);
    assert.match(messages[2].content, /without reporting a terminal result/);
    assert.equal([...store.agentTurns.values()][0].status, 'complete');
    assert.deepEqual(observability.events.find(event => event.event === 'code_agent.runner.tool_result_missing'), {
      level: 'warn',
      event: 'code_agent.runner.tool_result_missing',
      roomId: 'room-1',
      turnId: 'turn-1',
      durationMs: 0,
      payload: {
        backend: 'code-agent',
        toolCallId: 'tool-1',
        toolName: 'Shell',
        terminalTurnEvent: 'final',
      },
    });
    assert.equal(emitter.roomEmits.some(event => event.event === 'new_message'), false);
  });
});
