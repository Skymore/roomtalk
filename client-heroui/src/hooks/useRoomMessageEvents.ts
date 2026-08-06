import { Dispatch, MutableRefObject, RefObject, SetStateAction, useEffect, useRef } from 'react';
import { requestRoomAICost, requestRoomEvents, requestRoomSnapshot, SocketRequestError, socket } from '../utils/socket';
import {
  A2UIUpdateEvent,
  AICostTotalEvent,
  AIChunkEvent,
  AIStreamEndEvent,
  AIStreamErrorEvent,
  AIUsageUpdateEvent,
  Message,
  Room,
  RoomAgentTurn,
  RoomEvent,
  RoomEventAvailable,
  RoomSnapshotPayload,
} from '../utils/types';
import { appendA2UIPayload, appendAIChunk, completeAIMessage, failAIMessage, resetStreamingAIMessage, sortMessages, upsertMessage } from '../utils/messageState';
import {
  clearCachedRoomMessageWindow,
  readCachedRoomMessageWindow,
  readMemoryRoomMessageWindow,
  writeCachedRoomMessageWindow,
} from '../utils/messageHistoryCache';
import { clearCachedMediaAsset, clearCachedMediaForRoom } from '../utils/mediaCache';
import { logRoomMessageDiagnostic } from '../utils/roomDiagnostics';
import { PendingAIEventBuffer, type PendingAITransientEvent } from '../utils/pendingAIEventBuffer';
import { RoomMessageSyncStateMachine } from '../utils/roomMessageSyncStateMachine';
import { AITransientStreamGate } from '../utils/aiTransientStreamGate';

const ROOM_MESSAGE_PAGE_LIMIT = 80;
const ROOM_EVENT_PAGE_LIMIT = 100;
const ROOM_EVENT_PAGE_MAX_BYTES = 256 * 1024;
const ROOM_EVENT_SNAPSHOT_GAP_THRESHOLD = 500;
const getEmptyAgentTurns = () => [] as RoomAgentTurn[];

interface UseRoomMessageEventsArgs {
  roomId: string;
  isRoomSessionReady?: boolean;
  messageSyncRequestId?: number;
  containerRef: RefObject<HTMLDivElement>;
  getCurrentMessages: () => Message[];
  getCurrentAgentTurns?: () => RoomAgentTurn[];
  updateMessages: (updater: SetStateAction<Message[]>) => void;
  setAgentTurns: Dispatch<SetStateAction<RoomAgentTurn[]>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setIsLoadingMore: Dispatch<SetStateAction<boolean>>;
  setHasMoreMessages: Dispatch<SetStateAction<boolean>>;
  setLastAppliedSeq: Dispatch<SetStateAction<number>>;
  setOldestMessageId: Dispatch<SetStateAction<string | undefined>>;
  setSessionCostUsd: Dispatch<SetStateAction<number | null>>;
  setShowScrollButton: Dispatch<SetStateAction<boolean>>;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  closeDeleteModal: () => void;
  closeEditModal: () => void;
  messageToDeleteId?: string;
  messageToEditId?: string;
  onAIStreamSettled?: () => void;
  onRoomUpdated?: (room: Room) => void;
  onMembersChanged?: (roomId: string) => void;
  onRoomDeleted?: (roomId: string) => void;
  onRoomAccessDenied?: (roomId: string) => void;
  requestHistoryRef: MutableRefObject<RoomMessageHistoryRequest | null>;
}

export type RoomMessageHistoryRequest = (options?: {
  beforeMessageId?: string;
  limit?: number;
  reason?: string;
}) => Promise<void>;

const mergeSnapshotWithOptimisticMessages = (snapshot: Message[], current: Message[]) => {
  let merged = current.filter(message => message.deliveryStatus === 'pending' || message.deliveryStatus === 'failed');
  snapshot.forEach(message => {
    merged = upsertMessage(merged, message);
  });
  return merged;
};

const hasTerminalTurnToolResultGap = (messages: Message[], turns: RoomAgentTurn[]) => {
  const terminalTurnIds = new Set(turns
    .filter(turn => turn.status !== 'running')
    .map(turn => turn.id));
  if (terminalTurnIds.size === 0) return false;

  const resultCallIds = new Set(messages.flatMap(message => (
    message.messageType === 'tool_result' && message.toolCallId
      ? [message.toolCallId]
      : []
  )));
  return messages.some(message => (
    message.messageType === 'tool_call'
    && Boolean(message.toolCallId)
    && Boolean(message.turnId)
    && terminalTurnIds.has(message.turnId!)
    && !resultCallIds.has(message.toolCallId!)
  ));
};

type RoomEventApplyContext = {
  source: 'fast-path' | 'replay';
  headSeq: number;
  deliveryId?: string;
  requestId?: string;
};

const findRoomEventProjectionMismatch = (
  events: RoomEvent[],
  messages: Message[],
  turns: RoomAgentTurn[],
): Record<string, unknown> | null => {
  const messageById = new Map(messages.map(message => [message.id, message]));
  const turnById = new Map(turns.map(turn => [turn.id, turn]));

  for (const event of events) {
    if (event.type === 'messages.upserted') {
      const afterImageById = new Map((event.payload.messages || []).map(message => [message.id, message]));
      const missingAfterImageId = (event.payload.messageIds || []).find(messageId => !afterImageById.has(messageId));
      if (missingAfterImageId) {
        return {
          seq: event.seq,
          eventType: event.type,
          reason: 'message-after-image-missing',
          messageId: missingAfterImageId,
        };
      }
      for (const expected of event.payload.messages || []) {
        const actual = messageById.get(expected.id);
        if (!actual) {
          return { seq: event.seq, eventType: event.type, reason: 'message-missing', messageId: expected.id };
        }
        if (
          actual.roomId !== expected.roomId
          || actual.messageType !== expected.messageType
          || actual.toolCallId !== expected.toolCallId
          || actual.turnId !== expected.turnId
        ) {
          return {
            seq: event.seq,
            eventType: event.type,
            reason: 'message-identity-mismatch',
            messageId: expected.id,
            expectedMessageType: expected.messageType,
            actualMessageType: actual.messageType,
            expectedToolCallId: expected.toolCallId || null,
            actualToolCallId: actual.toolCallId || null,
          };
        }
      }
    } else if (event.type === 'messages.deleted') {
      const remainingId = (event.payload.messageIds || []).find(messageId => messageById.has(messageId));
      if (remainingId) {
        return { seq: event.seq, eventType: event.type, reason: 'deleted-message-remains', messageId: remainingId };
      }
    } else if (event.type === 'agent_turns.upserted') {
      const afterImageById = new Map((event.payload.turns || []).map(turn => [turn.id, turn]));
      const missingAfterImageId = (event.payload.turnIds || []).find(turnId => !afterImageById.has(turnId));
      if (missingAfterImageId) {
        return {
          seq: event.seq,
          eventType: event.type,
          reason: 'turn-after-image-missing',
          turnId: missingAfterImageId,
        };
      }
      for (const expected of event.payload.turns || []) {
        const actual = turnById.get(expected.id);
        if (!actual || actual.roomId !== expected.roomId || actual.status !== expected.status) {
          return { seq: event.seq, eventType: event.type, reason: 'turn-mismatch', turnId: expected.id };
        }
      }
    } else if (event.type === 'agent_turns.deleted') {
      const remainingId = (event.payload.turnIds || []).find(turnId => turnById.has(turnId));
      if (remainingId) {
        return { seq: event.seq, eventType: event.type, reason: 'deleted-turn-remains', turnId: remainingId };
      }
    } else if (event.type === 'room.deleted' && (messages.length > 0 || turns.length > 0)) {
      return { seq: event.seq, eventType: event.type, reason: 'deleted-room-projection-not-empty' };
    }
  }
  return null;
};

const reduceRoomEvents = (
  events: RoomEvent[],
  messages: Message[],
  turns: RoomAgentTurn[],
) => {
  let nextMessages = messages;
  let nextTurns = turns;
  const deletedMediaAssetIds: string[] = [];
  let roomDeleted = false;
  let updatedRoom: Room | undefined;
  let roomMediaCacheInvalidated = false;
  let membersChanged = false;

  events.forEach(event => {
    switch (event.type) {
      case 'messages.upserted':
        (event.payload.messages || []).forEach(message => {
          nextMessages = upsertMessage(nextMessages, message);
        });
        break;
      case 'messages.deleted': {
        roomMediaCacheInvalidated = true;
        const deletedIds = new Set(event.payload.messageIds || []);
        nextMessages.forEach(message => {
          if (deletedIds.has(message.id) && message.mediaAsset?.id) {
            deletedMediaAssetIds.push(message.mediaAsset.id);
          }
        });
        nextMessages = nextMessages.filter(message => !deletedIds.has(message.id));
        break;
      }
      case 'agent_turns.upserted': {
        const byId = new Map(nextTurns.map(turn => [turn.id, turn]));
        (event.payload.turns || []).forEach(turn => byId.set(turn.id, { ...byId.get(turn.id), ...turn }));
        nextTurns = Array.from(byId.values()).sort((left, right) => (
          Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.id.localeCompare(right.id)
        ));
        break;
      }
      case 'agent_turns.deleted': {
        const deletedIds = new Set(event.payload.turnIds || []);
        nextTurns = nextTurns.filter(turn => !deletedIds.has(turn.id));
        break;
      }
      case 'room.deleted':
        roomDeleted = true;
        nextMessages = [];
        nextTurns = [];
        break;
      case 'room.updated':
        if (event.payload.room) updatedRoom = event.payload.room;
        break;
      case 'members.changed':
        // The public room stream deliberately contains no member IDs or roles.
        // Privileged member projections are loaded through their separately
        // authorized API instead of being reconstructed here.
        membersChanged = true;
        break;
    }
  });

  return {
    messages: nextMessages,
    turns: nextTurns,
    deletedMediaAssetIds,
    roomDeleted,
    updatedRoom,
    roomMediaCacheInvalidated,
    membersChanged,
  };
};

export const useRoomMessageEvents = ({
  roomId,
  isRoomSessionReady = true,
  messageSyncRequestId = 0,
  containerRef,
  getCurrentMessages,
  getCurrentAgentTurns = getEmptyAgentTurns,
  updateMessages,
  setAgentTurns,
  setIsLoading,
  setIsLoadingMore,
  setHasMoreMessages,
  setLastAppliedSeq,
  setOldestMessageId,
  setSessionCostUsd,
  setShowScrollButton,
  scrollToBottom,
  closeDeleteModal,
  closeEditModal,
  messageToDeleteId,
  messageToEditId,
  onAIStreamSettled,
  onRoomUpdated,
  onMembersChanged,
  onRoomDeleted,
  onRoomAccessDenied,
  requestHistoryRef,
}: UseRoomMessageEventsArgs) => {
  const messageToDeleteIdRef = useRef(messageToDeleteId);
  const messageToEditIdRef = useRef(messageToEditId);
  const sessionReadyRef = useRef(isRoomSessionReady);
  const syncRequestIdRef = useRef(messageSyncRequestId);
  sessionReadyRef.current = isRoomSessionReady;
  syncRequestIdRef.current = messageSyncRequestId;

  useEffect(() => {
    messageToDeleteIdRef.current = messageToDeleteId;
  }, [messageToDeleteId]);

  useEffect(() => {
    messageToEditIdRef.current = messageToEditId;
  }, [messageToEditId]);

  useEffect(() => {
    let cancelled = false;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let replayRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let replayRetryAttempt = 0;
    let requestSequence = 0;
    let hasBaseline = false;
    let hasMoreMessages = false;
    let oldestMessageId: string | undefined;
    let canonicalMessages: Message[] = [];
    let canonicalTurns: RoomAgentTurn[] = [];
    const pendingAIEvents = new PendingAIEventBuffer();
    const transientStreamGate = new AITransientStreamGate();
    const unpersistedAIErrorByMessageId = new Map<string, string>();
    const terminalToolGapRecoveryTurns = new Set<string>();
    const syncState = new RoomMessageSyncStateMachine();

    setSessionCostUsd(null);
    setAgentTurns([]);
    setShowScrollButton(false);
    closeDeleteModal();
    closeEditModal();

    void requestRoomAICost(roomId)
      .then(cost => {
        if (!cancelled && cost.roomId === roomId) setSessionCostUsd(cost.totalUsd);
      })
      .catch(error => {
        if (cancelled) return;
        logRoomMessageDiagnostic('room-cost-request-failed', {
          roomId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    const filterMessages = (messages: Message[]) => messages.filter(message => message.roomId === roomId);
    const filterTurns = (turns: RoomAgentTurn[]) => turns.filter(turn => turn.roomId === roomId);
    const setCursor = (seq: number) => {
      syncState.applyCursor(seq);
      setLastAppliedSeq(seq);
    };
    const setHasMore = (value: boolean) => {
      hasMoreMessages = value;
      setHasMoreMessages(value);
    };
    const setOldest = (value?: string) => {
      oldestMessageId = value;
      setOldestMessageId(value);
    };
    const scheduleScroll = (behavior: ScrollBehavior, delayMs: number) => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        scrollToBottom(behavior);
      }, delayMs);
    };
    const clearReplayRetry = () => {
      replayRetryAttempt = 0;
      if (replayRetryTimer) clearTimeout(replayRetryTimer);
      replayRetryTimer = null;
    };
    const scheduleReplayRetry = (reason: string) => {
      if (cancelled || replayRetryTimer) return;
      const delayMs = Math.min(10_000, 250 * (2 ** Math.min(replayRetryAttempt, 6)));
      replayRetryAttempt += 1;
      logRoomMessageDiagnostic('event-replay-retry-scheduled', { roomId, reason, delayMs, replayRetryAttempt });
      replayRetryTimer = setTimeout(() => {
        replayRetryTimer = null;
        void syncFromCursor();
      }, delayMs);
    };
    const cacheWindow = (
      messages: Message[],
      turns = getCurrentAgentTurns(),
      seq = syncState.lastAppliedSeq,
      more = hasMoreMessages,
      oldest = oldestMessageId,
    ) => {
      void writeCachedRoomMessageWindow({
        roomId,
        messages: filterMessages(messages),
        turns: filterTurns(turns),
        lastAppliedSeq: seq,
        hasMore: more,
        oldestMessageId: oldest,
        cachedAt: Date.now(),
      });
    };

    const queuePendingAIEvent = (event: PendingAITransientEvent) => {
      if (pendingAIEvents.enqueue(event)) return;
      logRoomMessageDiagnostic('pending-ai-event-dropped', {
        roomId,
        messageId: event.data.messageId,
        eventType: event.type,
      });
    };

    const acceptTransientAIEvent = (event: PendingAITransientEvent) => {
      const decision = transientStreamGate.accept(event.data.messageId, event.data);
      if (!decision.accepted && decision.conflict) {
        logRoomMessageDiagnostic('ai-transient-run-conflict', {
          roomId,
          messageId: event.data.messageId,
          runId: event.data.runId,
          generation: event.data.generation,
        });
        void syncFromCursor();
      }
      return decision;
    };

    const applyUnpersistedAIErrorOverlays = (messages: Message[]) => {
      let nextMessages = messages;
      unpersistedAIErrorByMessageId.forEach((error, messageId) => {
        nextMessages = failAIMessage(nextMessages, messageId, error);
      });
      return nextMessages;
    };

    const clearResolvedUnpersistedAIErrors = (messages: Message[]) => {
      messages.forEach(message => {
        if (message.status === 'complete' || message.status === 'error') {
          unpersistedAIErrorByMessageId.delete(message.id);
          transientStreamGate.settle(message.id);
        }
      });
    };

    const drainPendingAIEvents = (messages: Message[]) => {
      let nextMessages = messages;
      let receivedChunk = false;
      let settledCount = 0;
      messages.forEach(message => {
        const pending = pendingAIEvents.take(message.id);
        // A replay page can contain both the placeholder and the final durable
        // after-image. In that case the final row is authoritative: applying
        // an older buffered chunk after it would duplicate content.
        if (message.status === 'complete' || message.status === 'error') {
          pending.forEach(event => {
            if (event.type === 'ai_stream_end') {
              if (event.data.sessionCost) setSessionCostUsd(event.data.sessionCost.totalUsd);
              settledCount++;
            } else if (event.type === 'ai_stream_error') {
              if (event.data.persisted) settledCount++;
            }
          });
          return;
        }
        pending.forEach(event => {
          const decision = acceptTransientAIEvent(event);
          if (!decision.accepted) return;
          if (decision.resetMessage) {
            nextMessages = resetStreamingAIMessage(nextMessages, event.data.messageId);
          }
          switch (event.type) {
            case 'ai_chunk':
              nextMessages = appendAIChunk(nextMessages, event.data.messageId, event.data.chunk);
              receivedChunk = true;
              break;
            case 'a2ui_update':
              nextMessages = appendA2UIPayload(nextMessages, event.data.messageId, event.data.uiPayload);
              break;
            case 'ai_stream_end':
              nextMessages = completeAIMessage(nextMessages, event.data.messageId, {
                content: event.data.content,
                uiPayload: event.data.uiPayload,
                aiModel: event.data.aiModel,
                usage: event.data.usage,
                cost: event.data.cost,
              });
              if (event.data.sessionCost) setSessionCostUsd(event.data.sessionCost.totalUsd);
              settledCount++;
              break;
            case 'ai_stream_error':
              if (event.data.persisted && event.data.message) {
                nextMessages = upsertMessage(nextMessages, event.data.message);
              } else if (!event.data.persisted) {
                unpersistedAIErrorByMessageId.set(event.data.messageId, event.data.error);
                nextMessages = failAIMessage(nextMessages, event.data.messageId, event.data.error);
              }
              if (event.data.persisted) settledCount++;
              break;
          }
        });
      });
      if (receivedChunk) {
        const container = containerRef.current;
        if (container && container.scrollHeight - container.scrollTop - container.clientHeight < 150) {
          scheduleScroll('smooth', 50);
        }
      }
      for (let index = 0; index < settledCount; index++) onAIStreamSettled?.();
      return nextMessages;
    };

    const applySnapshot = (snapshot: RoomSnapshotPayload) => {
      onRoomUpdated?.(snapshot.room);
      clearResolvedUnpersistedAIErrors(snapshot.messages);
      if (snapshot.mode === 'prepend') {
        const byId = new Map(canonicalTurns.map(turn => [turn.id, turn]));
        filterTurns(snapshot.turns || []).forEach(turn => byId.set(turn.id, turn));
        canonicalTurns = Array.from(byId.values());
        const existingIds = new Set(canonicalMessages.map(message => message.id));
        canonicalMessages = applyUnpersistedAIErrorOverlays(drainPendingAIEvents(sortMessages([
          ...filterMessages(snapshot.messages).filter(message => !existingIds.has(message.id)),
          ...canonicalMessages,
        ])));
        setAgentTurns(canonicalTurns);
        updateMessages(canonicalMessages);
        setHasMore(snapshot.hasMore);
        setOldest(snapshot.oldestMessageId);
        cacheWindow(canonicalMessages, canonicalTurns, syncState.lastAppliedSeq, snapshot.hasMore, snapshot.oldestMessageId);
        setIsLoadingMore(false);
        return;
      }

      const nextMessages = applyUnpersistedAIErrorOverlays(drainPendingAIEvents(mergeSnapshotWithOptimisticMessages(
        filterMessages(snapshot.messages),
        filterMessages(getCurrentMessages()),
      )));
      const nextTurns = filterTurns(snapshot.turns || []);
      canonicalMessages = nextMessages;
      canonicalTurns = nextTurns;
      hasBaseline = true;
      syncState.applyReplacementSnapshot(snapshot.snapshotSeq);
      setLastAppliedSeq(snapshot.snapshotSeq);
      setHasMore(snapshot.hasMore);
      setOldest(snapshot.oldestMessageId);
      updateMessages(nextMessages);
      setAgentTurns(nextTurns);
      cacheWindow(nextMessages, nextTurns, snapshot.snapshotSeq, snapshot.hasMore, snapshot.oldestMessageId);
      setIsLoading(false);
      setShowScrollButton(false);
      scheduleScroll('auto', 0);
    };

    const loadSnapshot = async (options: { beforeMessageId?: string; limit?: number; reason?: string } = {}) => {
      const mode = options.beforeMessageId ? 'prepend' : 'replace';
      const snapshotToken = syncState.beginSnapshot(mode);
      if (!snapshotToken) return false;
      if (mode === 'prepend') {
        setIsLoadingMore(true);
      } else {
        setIsLoadingMore(false);
        setIsLoading(true);
      }
      const requestId = `${Date.now()}-${++requestSequence}`;
      logRoomMessageDiagnostic('snapshot-request', {
        requestId,
        roomId,
        mode,
        reason: options.reason || 'room-sync',
        beforeMessageId: options.beforeMessageId ?? null,
        lastAppliedSeq: syncState.lastAppliedSeq,
        messageSyncRequestId: syncRequestIdRef.current,
      });
      try {
        const snapshot = await requestRoomSnapshot({
          requestId,
          roomId,
          beforeMessageId: options.beforeMessageId,
          limit: options.limit ?? ROOM_MESSAGE_PAGE_LIMIT,
        });
        if (cancelled || !syncState.isSnapshotCurrent(snapshotToken)) return false;
        clearReplayRetry();
        applySnapshot(snapshot);
        return true;
      } catch (error) {
        if (error instanceof SocketRequestError && error.code === 'PAGINATION_BOUNDARY_EXPIRED') {
          return loadSnapshot({ reason: 'pagination-boundary-expired' });
        }
        if (error instanceof SocketRequestError && error.code === 'ROOM_ACCESS_DENIED') {
          onRoomAccessDenied?.(roomId);
          return false;
        }
        if (
          error instanceof SocketRequestError
          && (error.code === 'ROOM_AUTH_UNAVAILABLE' || error.code === 'NOT_REGISTERED')
        ) {
          scheduleReplayRetry(error.code);
        }
        if (!cancelled) {
          setIsLoading(false);
          setIsLoadingMore(false);
          logRoomMessageDiagnostic('snapshot-request-failed', {
            requestId,
            roomId,
            mode,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return false;
      } finally {
        syncState.finishSnapshot(snapshotToken);
        if (mode === 'prepend') setIsLoadingMore(false);
      }
    };

    const applyEventPage = (events: RoomEvent[], context: RoomEventApplyContext) => {
      const cursorBefore = syncState.lastAppliedSeq;
      const accepted: RoomEvent[] = [];
      let expectedSeq = syncState.lastAppliedSeq + 1;
      for (const event of events) {
        if (event.roomId !== roomId || event.seq <= syncState.lastAppliedSeq) continue;
        if (event.seq !== expectedSeq) {
          // A retained room.deleted tombstone is terminal and can safely jump a
          // pruned prefix: the deleted room has no snapshot to load instead.
          if (accepted.length > 0 || event.type !== 'room.deleted') {
            logRoomMessageDiagnostic('event-sequence-gap', {
              roomId,
              ...context,
              cursorBefore,
              expectedSeq,
              receivedSeq: event.seq,
              pageSeqs: events.map(candidate => candidate.seq),
            });
            return false;
          }
          expectedSeq = event.seq;
        }
        accepted.push(event);
        expectedSeq = event.seq + 1;
      }
      if (accepted.length === 0) return true;

      accepted.forEach(event => {
        if (event.type === 'messages.upserted') {
          clearResolvedUnpersistedAIErrors(event.payload.messages || []);
        } else if (event.type === 'messages.deleted') {
          (event.payload.messageIds || []).forEach(messageId => {
            unpersistedAIErrorByMessageId.delete(messageId);
            transientStreamGate.settle(messageId);
          });
        }
      });

      let eventBase = canonicalMessages;
      filterMessages(getCurrentMessages())
        .filter(message => message.deliveryStatus === 'pending' || message.deliveryStatus === 'failed')
        .forEach(message => {
          eventBase = upsertMessage(eventBase, message);
        });
      const nextSeq = accepted[accepted.length - 1].seq;
      let projectionMessages = eventBase;
      let projectionTurns = canonicalTurns;
      const deletedMediaAssetIds: string[] = [];
      let roomDeleted = false;
      let updatedRoom: Room | undefined;
      let roomMediaCacheInvalidated = false;
      let membersChanged = false;
      for (const event of accepted) {
        const step = reduceRoomEvents([event], projectionMessages, projectionTurns);
        const projectionMismatch = findRoomEventProjectionMismatch([event], step.messages, step.turns);
        if (projectionMismatch) {
          logRoomMessageDiagnostic('event-projection-rejected', {
            roomId,
            ...context,
            cursorBefore,
            nextSeq,
            pageSeqs: accepted.map(candidate => candidate.seq),
            eventTypes: accepted.map(candidate => candidate.type),
            ...projectionMismatch,
          });
          return false;
        }
        projectionMessages = step.messages;
        projectionTurns = step.turns;
        deletedMediaAssetIds.push(...step.deletedMediaAssetIds);
        roomDeleted ||= step.roomDeleted;
        updatedRoom = step.updatedRoom || updatedRoom;
        roomMediaCacheInvalidated ||= step.roomMediaCacheInvalidated;
        membersChanged ||= step.membersChanged;
      }
      const reduced = {
        messages: projectionMessages,
        turns: projectionTurns,
        deletedMediaAssetIds,
        roomDeleted,
        updatedRoom,
        roomMediaCacheInvalidated,
        membersChanged,
      };
      canonicalMessages = applyUnpersistedAIErrorOverlays(drainPendingAIEvents(reduced.messages));
      canonicalTurns = reduced.turns;
      reduced.deletedMediaAssetIds.forEach(assetId => void clearCachedMediaAsset(assetId));
      if (reduced.roomMediaCacheInvalidated) void clearCachedMediaForRoom(roomId);
      if (reduced.roomDeleted) {
        pendingAIEvents.clear();
        transientStreamGate.clear();
        unpersistedAIErrorByMessageId.clear();
        void clearCachedRoomMessageWindow(roomId);
        void clearCachedMediaForRoom(roomId);
      }
      if (reduced.updatedRoom) onRoomUpdated?.(reduced.updatedRoom);
      if (reduced.membersChanged) onMembersChanged?.(roomId);
      updateMessages(canonicalMessages);
      setAgentTurns(reduced.turns);
      setCursor(nextSeq);
      const toolEvents = accepted.flatMap(event => (
        event.type === 'messages.upserted'
          ? (event.payload.messages || []).filter(message => (
              message.messageType === 'tool_call' || message.messageType === 'tool_result'
            ))
          : []
      ));
      logRoomMessageDiagnostic('event-page-applied', {
        roomId,
        ...context,
        cursorBefore,
        cursorAfter: nextSeq,
        pageSeqs: accepted.map(event => event.seq),
        eventTypes: accepted.map(event => event.type),
        messageCount: canonicalMessages.length,
        turnCount: canonicalTurns.length,
        toolMessages: toolEvents.map(message => ({
          id: message.id,
          messageType: message.messageType,
          toolCallId: message.toolCallId || null,
          toolName: message.toolName || null,
          turnId: message.turnId || null,
        })),
      });
      setOldest(canonicalMessages[0]?.id);
      const hasMessageDeletion = accepted.some(event => event.type === 'messages.deleted');
      if (canonicalMessages.length === 0) {
        if (hasMoreMessages && hasMessageDeletion && !reduced.roomDeleted) {
          syncState.markHistoryInvalidated();
        } else {
          setHasMore(false);
        }
      }
      if (syncState.needsHistorySnapshot) {
        void clearCachedRoomMessageWindow(roomId);
      } else {
        cacheWindow(canonicalMessages, reduced.turns, nextSeq);
      }

      const deletedIds = new Set(accepted
        .filter(event => event.type === 'messages.deleted')
        .flatMap(event => event.payload.messageIds || []));
      if (messageToDeleteIdRef.current && deletedIds.has(messageToDeleteIdRef.current)) closeDeleteModal();
      if (messageToEditIdRef.current && deletedIds.has(messageToEditIdRef.current)) closeEditModal();
      if (reduced.roomDeleted) onRoomDeleted?.(roomId);
      return true;
    };

    const syncFromCursor = async () => {
      if (cancelled || !sessionReadyRef.current || !syncState.requestReplay()) return;
      try {
        while (syncState.consumeReplayRequest() && !cancelled && sessionReadyRef.current) {
          if (!hasBaseline) {
            const loaded = await loadSnapshot({ reason: 'initial-snapshot' });
            if (!loaded) break;
          }
          if (syncState.needsHistorySnapshot) {
            const loaded = await loadSnapshot({ reason: 'message-history-invalidated' });
            if (!loaded) {
              syncState.markHistoryInvalidated();
              break;
            }
          }

          let keepReading = true;
          while (keepReading && !cancelled && sessionReadyRef.current) {
            const requestId = `${Date.now()}-${++requestSequence}`;
            try {
              const page = await requestRoomEvents({
                requestId,
                roomId,
                afterSeq: syncState.lastAppliedSeq,
                limit: ROOM_EVENT_PAGE_LIMIT,
                maxBytes: ROOM_EVENT_PAGE_MAX_BYTES,
              });
              clearReplayRetry();
              syncState.notifyHead(page.headSeq);
              const hasTerminalDeletion = page.events.some(event => (
                event.type === 'room.deleted' && event.seq === page.headSeq
              ));
              if (
                syncState.shouldReplaceLargeGap(page.headSeq, ROOM_EVENT_SNAPSHOT_GAP_THRESHOLD)
                && !hasTerminalDeletion
              ) {
                const gapSnapshotTarget = page.headSeq;
                const loaded = await loadSnapshot({ reason: 'event-gap-threshold' });
                if (!loaded) return;
                syncState.markGapSnapshot(gapSnapshotTarget);
                continue;
              }
              if (page.events.length === 0 && syncState.lastAppliedSeq < page.headSeq) {
                const loaded = await loadSnapshot({ reason: 'event-gap-empty-page' });
                if (!loaded) return;
                continue;
              }
              if (!applyEventPage(page.events, {
                source: 'replay',
                headSeq: page.headSeq,
                requestId,
              })) {
                const loaded = await loadSnapshot({ reason: 'event-sequence-gap' });
                if (!loaded) return;
                continue;
              }
              if (syncState.needsHistorySnapshot) {
                const loaded = await loadSnapshot({ reason: 'message-window-emptied' });
                if (!loaded) return;
                continue;
              }
              keepReading = page.hasMore || syncState.needsReplay;
            } catch (error) {
              if (error instanceof SocketRequestError && error.code === 'CURSOR_AHEAD') {
                // The database may have been restored to an older sequence. Drop
                // the stale target before requesting the replacement snapshot.
                // Notifications received while that request is in flight raise
                // desiredHeadSeq again and applySnapshot preserves that new head.
                syncState.resetForCursorAhead();
                const loaded = await loadSnapshot({ reason: 'cursor-ahead' });
                if (!loaded) return;
                keepReading = true;
                continue;
              }
              if (
                error instanceof SocketRequestError
                && (
                  error.code === 'CURSOR_EXPIRED'
                  || error.code === 'EVENT_PAYLOAD_INVALID'
                  || error.code === 'EVENT_TOO_LARGE'
                )
              ) {
                const loaded = await loadSnapshot({
                  reason: error.code === 'EVENT_PAYLOAD_INVALID'
                    ? 'event-payload-invalid'
                    : error.code === 'EVENT_TOO_LARGE'
                      ? 'event-too-large'
                      : 'cursor-reset',
                });
                if (!loaded) return;
                keepReading = true;
                continue;
              }
              if (error instanceof SocketRequestError && error.code === 'ROOM_ACCESS_DENIED') {
                onRoomAccessDenied?.(roomId);
                keepReading = false;
                break;
              }
              if (
                error instanceof SocketRequestError
                && (error.code === 'ROOM_AUTH_UNAVAILABLE' || error.code === 'NOT_REGISTERED')
              ) {
                scheduleReplayRetry(error.code);
              }
              logRoomMessageDiagnostic('event-request-failed', {
                requestId,
                roomId,
                afterSeq: syncState.lastAppliedSeq,
                error: error instanceof Error ? error.message : String(error),
              });
              keepReading = false;
            }
          }
        }
      } finally {
        const replayRequested = syncState.finishReplay();
        setIsLoading(false);
        setIsLoadingMore(false);
        if (replayRequested && !cancelled) void syncFromCursor();
      }
    };

    const memoryWindow = readMemoryRoomMessageWindow(roomId);
    let cacheHydrationPromise: Promise<void>;
    if (memoryWindow) {
      const messages = sortMessages(filterMessages(memoryWindow.messages));
      const turns = filterTurns(memoryWindow.turns || []);
      const cacheHasTerminalToolGap = hasTerminalTurnToolResultGap(messages, turns);
      canonicalMessages = messages;
      canonicalTurns = turns;
      hasBaseline = !cacheHasTerminalToolGap;
      syncState.applyCursor(memoryWindow.lastAppliedSeq);
      hasMoreMessages = memoryWindow.hasMore;
      oldestMessageId = memoryWindow.oldestMessageId;
      updateMessages(messages);
      setAgentTurns(turns);
      setLastAppliedSeq(syncState.lastAppliedSeq);
      setHasMoreMessages(hasMoreMessages);
      setOldestMessageId(oldestMessageId);
      setIsLoading(false);
      scheduleScroll('auto', 0);
      if (cacheHasTerminalToolGap) {
        logRoomMessageDiagnostic('cached-terminal-tool-result-gap', { roomId, source: 'memory' });
        void clearCachedRoomMessageWindow(roomId);
      }
      cacheHydrationPromise = Promise.resolve();
    } else {
      canonicalMessages = filterMessages(getCurrentMessages()).filter(
        message => message.deliveryStatus === 'pending' || message.deliveryStatus === 'failed',
      );
      canonicalTurns = [];
      updateMessages(canonicalMessages);
      setIsLoading(true);
      cacheHydrationPromise = readCachedRoomMessageWindow(roomId)
        .then(cachedWindow => {
          if (cancelled || !cachedWindow || hasBaseline) return;
          const messages = sortMessages(filterMessages(cachedWindow.messages));
          const turns = filterTurns(cachedWindow.turns || []);
          const cacheHasTerminalToolGap = hasTerminalTurnToolResultGap(messages, turns);
          canonicalMessages = drainPendingAIEvents(messages);
          canonicalTurns = turns;
          hasBaseline = !cacheHasTerminalToolGap;
          syncState.applyCursor(cachedWindow.lastAppliedSeq);
          hasMoreMessages = cachedWindow.hasMore;
          oldestMessageId = cachedWindow.oldestMessageId;
          updateMessages(canonicalMessages);
          setAgentTurns(turns);
          setLastAppliedSeq(syncState.lastAppliedSeq);
          setHasMoreMessages(hasMoreMessages);
          setOldestMessageId(oldestMessageId);
          setIsLoading(false);
          scheduleScroll('auto', 0);
          if (cacheHasTerminalToolGap) {
            logRoomMessageDiagnostic('cached-terminal-tool-result-gap', { roomId, source: 'persistent' });
            void clearCachedRoomMessageWindow(roomId);
          }
        })
        .catch(error => {
          logRoomMessageDiagnostic('persistent-cache-read-failed', {
            roomId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    const issueHistoryRequest: RoomMessageHistoryRequest = async (options = {}) => {
      await cacheHydrationPromise;
      if (cancelled) return;
      if (options.beforeMessageId) {
        await loadSnapshot(options);
        return;
      }
      await syncFromCursor();
    };
    requestHistoryRef.current = issueHistoryRequest;

    const handleRoomEventAvailable = (event: RoomEventAvailable) => {
      if (event.roomId !== roomId || !Number.isSafeInteger(event.headSeq)) return;
      logRoomMessageDiagnostic('event-notification-received', {
        roomId,
        deliveryId: event.deliveryId || null,
        headSeq: event.headSeq,
        cursorBefore: syncState.lastAppliedSeq,
        eventSeqs: Array.isArray(event.events) ? event.events.map(candidate => candidate.seq) : [],
        eventTypes: Array.isArray(event.events) ? event.events.map(candidate => candidate.type) : [],
      });
      syncState.notifyHead(event.headSeq);
      const fastPathEvents = Array.isArray(event.events) ? event.events : [];
      const fastPathEndsAtHead = fastPathEvents.length > 0
        && fastPathEvents[fastPathEvents.length - 1].seq === event.headSeq;
      if (hasBaseline && fastPathEndsAtHead) syncState.beginRealtimeMutation();
      if (hasBaseline && fastPathEndsAtHead && !applyEventPage(fastPathEvents, {
        source: 'fast-path',
        headSeq: event.headSeq,
        deliveryId: event.deliveryId,
      })) {
        logRoomMessageDiagnostic('event-fast-path-gap', {
          roomId,
          lastAppliedSeq: syncState.lastAppliedSeq,
          headSeq: event.headSeq,
          eventSeqs: fastPathEvents.map(candidate => candidate.seq),
        });
      }
      if (!hasBaseline || syncState.needsReplay) void syncFromCursor();
    };
    const handleReconnect = () => void syncFromCursor();
    const handleRoomSyncRequired = () => void syncFromCursor();
    const handleMessageHistoryInvalidated = (event: { roomId?: string }) => {
      if (event.roomId !== roomId) return;
      syncState.markHistoryInvalidated();
      void syncFromCursor();
    };
    const handlePageResume = () => {
      if (document.visibilityState === 'visible') void syncFromCursor();
    };
    const handleAgentTurnUpdated = (turn: RoomAgentTurn) => {
      if (turn.roomId !== roomId) return;
      const byId = new Map(canonicalTurns.map(current => [current.id, current]));
      byId.set(turn.id, { ...byId.get(turn.id), ...turn });
      canonicalTurns = Array.from(byId.values()).sort((left, right) => (
        Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.id.localeCompare(right.id)
      ));
      setAgentTurns(canonicalTurns);
      if (
        turn.status !== 'running'
        && !terminalToolGapRecoveryTurns.has(turn.id)
        && hasTerminalTurnToolResultGap(canonicalMessages, canonicalTurns)
      ) {
        terminalToolGapRecoveryTurns.add(turn.id);
        syncState.markHistoryInvalidated();
        void clearCachedRoomMessageWindow(roomId);
        void syncFromCursor();
        return;
      }
      cacheWindow(canonicalMessages, canonicalTurns);
    };

    const handleAIChunk = (data: AIChunkEvent) => {
      if (data.roomId !== roomId) return;
      const target = canonicalMessages.find(message => message.id === data.messageId);
      if (!target) {
        queuePendingAIEvent({ type: 'ai_chunk', data });
        return;
      }
      if (target.status === 'complete' || target.status === 'error') return;
      const decision = acceptTransientAIEvent({ type: 'ai_chunk', data });
      if (!decision.accepted) return;
      const prepare = (messages: Message[]) => decision.resetMessage
        ? resetStreamingAIMessage(messages, data.messageId)
        : messages;
      canonicalMessages = appendAIChunk(prepare(canonicalMessages), data.messageId, data.chunk);
      updateMessages(previous => appendAIChunk(prepare(previous), data.messageId, data.chunk));
      const container = containerRef.current;
      if (container && container.scrollHeight - container.scrollTop - container.clientHeight < 150) {
        scheduleScroll('smooth', 50);
      }
    };
    const handleA2UIUpdate = (data: A2UIUpdateEvent) => {
      if (data.roomId !== roomId) return;
      const target = canonicalMessages.find(message => message.id === data.messageId);
      if (!target) {
        queuePendingAIEvent({ type: 'a2ui_update', data });
        return;
      }
      if (target.status === 'complete' || target.status === 'error') return;
      const decision = acceptTransientAIEvent({ type: 'a2ui_update', data });
      if (!decision.accepted) return;
      const prepare = (messages: Message[]) => decision.resetMessage
        ? resetStreamingAIMessage(messages, data.messageId)
        : messages;
      canonicalMessages = appendA2UIPayload(prepare(canonicalMessages), data.messageId, data.uiPayload);
      updateMessages(previous => appendA2UIPayload(prepare(previous), data.messageId, data.uiPayload));
    };
    const handleAIStreamEnd = (data: AIStreamEndEvent) => {
      if (data.roomId !== roomId) return;
      unpersistedAIErrorByMessageId.delete(data.messageId);
      const target = canonicalMessages.find(message => message.id === data.messageId);
      if (!target) {
        queuePendingAIEvent({ type: 'ai_stream_end', data });
        return;
      }
      if (target.status === 'complete' || target.status === 'error') {
        if (data.sessionCost) setSessionCostUsd(data.sessionCost.totalUsd);
        return;
      }
      const decision = acceptTransientAIEvent({ type: 'ai_stream_end', data });
      if (!decision.accepted) return;
      const prepare = (messages: Message[]) => decision.resetMessage
        ? resetStreamingAIMessage(messages, data.messageId)
        : messages;
      canonicalMessages = completeAIMessage(prepare(canonicalMessages), data.messageId, {
        content: data.content,
        uiPayload: data.uiPayload,
        aiModel: data.aiModel,
        usage: data.usage,
        cost: data.cost,
      });
      updateMessages(previous => completeAIMessage(prepare(previous), data.messageId, {
        content: data.content,
        uiPayload: data.uiPayload,
        aiModel: data.aiModel,
        usage: data.usage,
        cost: data.cost,
      }));
      cacheWindow(canonicalMessages);
      if (data.sessionCost) setSessionCostUsd(data.sessionCost.totalUsd);
      onAIStreamSettled?.();
    };
    const handleAIUsageUpdate = (data: AIUsageUpdateEvent) => {
      if (data.roomId !== roomId) return;
      updateMessages(previous => {
        canonicalMessages = previous.map(message => (
          message.id === data.messageId ? { ...message, usage: data.usage } : message
        ));
        return canonicalMessages;
      });
    };
    const handleAICostTotal = (data: AICostTotalEvent) => {
      if (data.roomId === roomId) setSessionCostUsd(data.totalUsd);
    };
    const handleAIStreamError = (data: AIStreamErrorEvent) => {
      if (data.roomId !== roomId) return;
      const errorMessage = data.message;
      const target = canonicalMessages.find(message => message.id === data.messageId);
      if (!target) {
        queuePendingAIEvent({ type: 'ai_stream_error', data });
        return;
      }
      if (target.status === 'complete' || target.status === 'error') return;
      const decision = acceptTransientAIEvent({ type: 'ai_stream_error', data });
      if (!decision.accepted) return;
      const prepare = (messages: Message[]) => decision.resetMessage
        ? resetStreamingAIMessage(messages, data.messageId)
        : messages;
      if (
        data.persisted
        && errorMessage
        && errorMessage.status === 'error'
        && errorMessage.id === data.messageId
        && errorMessage.roomId === roomId
      ) {
        unpersistedAIErrorByMessageId.delete(data.messageId);
        canonicalMessages = upsertMessage(prepare(canonicalMessages), errorMessage);
        updateMessages(previous => upsertMessage(prepare(previous), errorMessage));
        cacheWindow(canonicalMessages);
      } else {
        if (data.persisted) {
          logRoomMessageDiagnostic('persisted-ai-error-payload-invalid', {
            roomId,
            messageId: data.messageId,
          });
        }
        unpersistedAIErrorByMessageId.set(data.messageId, data.error);
        canonicalMessages = failAIMessage(prepare(canonicalMessages), data.messageId, data.error);
        updateMessages(previous => failAIMessage(prepare(previous), data.messageId, data.error));
        cacheWindow(canonicalMessages);
        void syncFromCursor();
      }
      onAIStreamSettled?.();
    };

    socket.on('room_event_available', handleRoomEventAvailable);
    socket.on('room_sync_required', handleRoomSyncRequired);
    socket.on('message_history_invalidated', handleMessageHistoryInvalidated);
    socket.on('connect', handleReconnect);
    socket.on('ai_chunk', handleAIChunk);
    socket.on('a2ui_update', handleA2UIUpdate);
    socket.on('ai_stream_end', handleAIStreamEnd);
    socket.on('ai_usage_update', handleAIUsageUpdate);
    socket.on('ai_cost_total', handleAICostTotal);
    socket.on('ai_stream_error', handleAIStreamError);
    socket.on('agent_turn_updated', handleAgentTurnUpdated);
    window.addEventListener('focus', handlePageResume);
    window.addEventListener('pageshow', handlePageResume);
    document.addEventListener('visibilitychange', handlePageResume);

    const loadingTimeout = setTimeout(() => setIsLoading(false), 5_000);
    return () => {
      cancelled = true;
      clearTimeout(loadingTimeout);
      if (scrollTimer) clearTimeout(scrollTimer);
      if (replayRetryTimer) clearTimeout(replayRetryTimer);
      pendingAIEvents.clear();
      transientStreamGate.clear();
      if (requestHistoryRef.current === issueHistoryRequest) requestHistoryRef.current = null;
      socket.off('room_event_available', handleRoomEventAvailable);
      socket.off('room_sync_required', handleRoomSyncRequired);
      socket.off('message_history_invalidated', handleMessageHistoryInvalidated);
      socket.off('connect', handleReconnect);
      socket.off('ai_chunk', handleAIChunk);
      socket.off('a2ui_update', handleA2UIUpdate);
      socket.off('ai_stream_end', handleAIStreamEnd);
      socket.off('ai_usage_update', handleAIUsageUpdate);
      socket.off('ai_cost_total', handleAICostTotal);
      socket.off('ai_stream_error', handleAIStreamError);
      socket.off('agent_turn_updated', handleAgentTurnUpdated);
      window.removeEventListener('focus', handlePageResume);
      window.removeEventListener('pageshow', handlePageResume);
      document.removeEventListener('visibilitychange', handlePageResume);
    };
  }, [
    roomId,
    containerRef,
    getCurrentMessages,
    getCurrentAgentTurns,
    updateMessages,
    setAgentTurns,
    setIsLoading,
    setIsLoadingMore,
    setHasMoreMessages,
    setLastAppliedSeq,
    setOldestMessageId,
    setSessionCostUsd,
    setShowScrollButton,
    scrollToBottom,
    closeDeleteModal,
    closeEditModal,
    onAIStreamSettled,
    onRoomUpdated,
    onMembersChanged,
    onRoomDeleted,
    onRoomAccessDenied,
    requestHistoryRef,
  ]);

  useEffect(() => {
    if (!isRoomSessionReady) return;
    void requestHistoryRef.current?.({
      limit: ROOM_MESSAGE_PAGE_LIMIT,
      reason: 'session-sync',
    });
  }, [isRoomSessionReady, messageSyncRequestId, requestHistoryRef, roomId]);
};
