import { Dispatch, MutableRefObject, RefObject, SetStateAction, useEffect, useRef } from 'react';
import { requestRoomEvents, requestRoomSnapshot, SocketRequestError, socket } from '../utils/socket';
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
import { appendA2UIPayload, appendAIChunk, completeAIMessage, upsertMessage } from '../utils/messageState';
import {
  clearCachedRoomMessageWindow,
  readCachedRoomMessageWindow,
  readMemoryRoomMessageWindow,
  writeCachedRoomMessageWindow,
} from '../utils/messageHistoryCache';
import { clearCachedMediaAsset, clearCachedMediaForRoom } from '../utils/mediaCache';
import { logRoomMessageDiagnostic } from '../utils/roomDiagnostics';
import { PendingAIEventBuffer, type PendingAITransientEvent } from '../utils/pendingAIEventBuffer';

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

  events.forEach(event => {
    switch (event.type) {
      case 'messages.upserted':
        (event.payload.messages || []).forEach(message => {
          nextMessages = upsertMessage(nextMessages, message);
        });
        break;
      case 'messages.deleted': {
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
        (event.payload.turns || []).forEach(turn => byId.set(turn.id, turn));
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
        break;
    }
  });

  return { messages: nextMessages, turns: nextTurns, deletedMediaAssetIds, roomDeleted, updatedRoom };
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
    let requestSequence = 0;
    let snapshotSequence = 0;
    let hasBaseline = false;
    let syncRunning = false;
    let syncAgain = false;
    let desiredHeadSeq = 0;
    let lastAppliedSeq = 0;
    let lastGapSnapshotTarget = 0;
    let hasMoreMessages = false;
    let oldestMessageId: string | undefined;
    let canonicalMessages: Message[] = [];
    let canonicalTurns: RoomAgentTurn[] = [];
    const pendingAIEvents = new PendingAIEventBuffer();

    setSessionCostUsd(null);
    setAgentTurns([]);
    setShowScrollButton(false);
    closeDeleteModal();
    closeEditModal();

    const filterMessages = (messages: Message[]) => messages.filter(message => message.roomId === roomId);
    const filterTurns = (turns: RoomAgentTurn[]) => turns.filter(turn => turn.roomId === roomId);
    const setCursor = (seq: number) => {
      lastAppliedSeq = seq;
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
    const cacheWindow = (
      messages: Message[],
      turns = getCurrentAgentTurns(),
      seq = lastAppliedSeq,
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
              settledCount++;
            }
          });
          return;
        }
        pending.forEach(event => {
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
              if (event.data.message) {
                nextMessages = upsertMessage(nextMessages, event.data.message);
              }
              settledCount++;
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
      if (snapshot.mode === 'prepend') {
        const byId = new Map(canonicalTurns.map(turn => [turn.id, turn]));
        filterTurns(snapshot.turns || []).forEach(turn => byId.set(turn.id, turn));
        canonicalTurns = Array.from(byId.values());
        const existingIds = new Set(canonicalMessages.map(message => message.id));
        canonicalMessages = drainPendingAIEvents([
          ...filterMessages(snapshot.messages).filter(message => !existingIds.has(message.id)),
          ...canonicalMessages,
        ]);
        setAgentTurns(canonicalTurns);
        updateMessages(canonicalMessages);
        setHasMore(snapshot.hasMore);
        setOldest(snapshot.oldestMessageId);
        cacheWindow(canonicalMessages, canonicalTurns, lastAppliedSeq, snapshot.hasMore, snapshot.oldestMessageId);
        setIsLoadingMore(false);
        return;
      }

      const nextMessages = drainPendingAIEvents(mergeSnapshotWithOptimisticMessages(
        filterMessages(snapshot.messages),
        filterMessages(getCurrentMessages()),
      ));
      const nextTurns = filterTurns(snapshot.turns || []);
      canonicalMessages = nextMessages;
      canonicalTurns = nextTurns;
      hasBaseline = true;
      desiredHeadSeq = Math.max(desiredHeadSeq, snapshot.snapshotSeq);
      setCursor(snapshot.snapshotSeq);
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
      const localSnapshotSequence = ++snapshotSequence;
      if (mode === 'prepend') setIsLoadingMore(true);
      else setIsLoading(true);
      const requestId = `${Date.now()}-${++requestSequence}`;
      logRoomMessageDiagnostic('snapshot-request', {
        requestId,
        roomId,
        mode,
        reason: options.reason || 'room-sync',
        beforeMessageId: options.beforeMessageId ?? null,
        lastAppliedSeq,
        messageSyncRequestId: syncRequestIdRef.current,
      });
      try {
        const snapshot = await requestRoomSnapshot({
          requestId,
          roomId,
          beforeMessageId: options.beforeMessageId,
          limit: options.limit ?? ROOM_MESSAGE_PAGE_LIMIT,
        });
        if (cancelled || localSnapshotSequence !== snapshotSequence) return false;
        applySnapshot(snapshot);
        return true;
      } catch (error) {
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
      }
    };

    const applyEventPage = (events: RoomEvent[]) => {
      const accepted: RoomEvent[] = [];
      let expectedSeq = lastAppliedSeq + 1;
      for (const event of events) {
        if (event.roomId !== roomId || event.seq <= lastAppliedSeq) continue;
        if (event.seq !== expectedSeq) {
          // A retained room.deleted tombstone is terminal and can safely jump a
          // pruned prefix: the deleted room has no snapshot to load instead.
          if (accepted.length > 0 || event.type !== 'room.deleted') return false;
          expectedSeq = event.seq;
        }
        accepted.push(event);
        expectedSeq = event.seq + 1;
      }
      if (accepted.length === 0) return true;

      let eventBase = canonicalMessages;
      filterMessages(getCurrentMessages())
        .filter(message => message.deliveryStatus === 'pending' || message.deliveryStatus === 'failed')
        .forEach(message => {
          eventBase = upsertMessage(eventBase, message);
        });
      const reduced = reduceRoomEvents(accepted, eventBase, canonicalTurns);
      const nextSeq = accepted[accepted.length - 1].seq;
      canonicalMessages = drainPendingAIEvents(reduced.messages);
      canonicalTurns = reduced.turns;
      reduced.deletedMediaAssetIds.forEach(assetId => void clearCachedMediaAsset(assetId));
      if (reduced.roomDeleted) {
        pendingAIEvents.clear();
        void clearCachedRoomMessageWindow(roomId);
        void clearCachedMediaForRoom(roomId);
      }
      if (reduced.updatedRoom) onRoomUpdated?.(reduced.updatedRoom);
      updateMessages(canonicalMessages);
      setAgentTurns(reduced.turns);
      setCursor(nextSeq);
      setOldest(canonicalMessages[0]?.id);
      if (canonicalMessages.length === 0) setHasMore(false);
      cacheWindow(canonicalMessages, reduced.turns, nextSeq);

      const deletedIds = new Set(accepted.flatMap(event => event.payload.messageIds || []));
      if (messageToDeleteIdRef.current && deletedIds.has(messageToDeleteIdRef.current)) closeDeleteModal();
      if (messageToEditIdRef.current && deletedIds.has(messageToEditIdRef.current)) closeEditModal();
      return true;
    };

    const syncFromCursor = async () => {
      syncAgain = true;
      if (syncRunning || cancelled || !sessionReadyRef.current) return;
      syncRunning = true;
      try {
        while (syncAgain && !cancelled && sessionReadyRef.current) {
          syncAgain = false;
          if (!hasBaseline) {
            const loaded = await loadSnapshot({ reason: 'initial-snapshot' });
            if (!loaded) break;
          }

          let keepReading = true;
          while (keepReading && !cancelled && sessionReadyRef.current) {
            const requestId = `${Date.now()}-${++requestSequence}`;
            try {
              const page = await requestRoomEvents({
                requestId,
                roomId,
                afterSeq: lastAppliedSeq,
                limit: ROOM_EVENT_PAGE_LIMIT,
                maxBytes: ROOM_EVENT_PAGE_MAX_BYTES,
              });
              desiredHeadSeq = Math.max(desiredHeadSeq, page.headSeq);
              const hasTerminalDeletion = page.events.some(event => (
                event.type === 'room.deleted' && event.seq === page.headSeq
              ));
              if (
                page.headSeq - lastAppliedSeq > ROOM_EVENT_SNAPSHOT_GAP_THRESHOLD
                && page.headSeq > lastGapSnapshotTarget
                && !hasTerminalDeletion
              ) {
                const gapSnapshotTarget = page.headSeq;
                const loaded = await loadSnapshot({ reason: 'event-gap-threshold' });
                if (!loaded) return;
                lastGapSnapshotTarget = gapSnapshotTarget;
                continue;
              }
              if (page.events.length === 0 && lastAppliedSeq < page.headSeq) {
                const loaded = await loadSnapshot({ reason: 'event-gap-empty-page' });
                if (!loaded) return;
                continue;
              }
              if (!applyEventPage(page.events)) {
                const loaded = await loadSnapshot({ reason: 'event-sequence-gap' });
                if (!loaded) return;
                continue;
              }
              keepReading = page.hasMore || lastAppliedSeq < desiredHeadSeq;
            } catch (error) {
              if (error instanceof SocketRequestError && error.code === 'CURSOR_AHEAD') {
                // The database may have been restored to an older sequence. Drop
                // the stale target before requesting the replacement snapshot.
                // Notifications received while that request is in flight raise
                // desiredHeadSeq again and applySnapshot preserves that new head.
                desiredHeadSeq = 0;
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
                )
              ) {
                const loaded = await loadSnapshot({
                  reason: error.code === 'EVENT_PAYLOAD_INVALID' ? 'event-payload-invalid' : 'cursor-reset',
                });
                if (!loaded) return;
                keepReading = true;
                continue;
              }
              logRoomMessageDiagnostic('event-request-failed', {
                requestId,
                roomId,
                afterSeq: lastAppliedSeq,
                error: error instanceof Error ? error.message : String(error),
              });
              keepReading = false;
            }
          }
        }
      } finally {
        syncRunning = false;
        setIsLoading(false);
        setIsLoadingMore(false);
        if (syncAgain && !cancelled) void syncFromCursor();
      }
    };

    const memoryWindow = readMemoryRoomMessageWindow(roomId);
    let cacheHydrationPromise: Promise<void>;
    if (memoryWindow) {
      const messages = filterMessages(memoryWindow.messages);
      const turns = filterTurns(memoryWindow.turns || []);
      canonicalMessages = messages;
      canonicalTurns = turns;
      hasBaseline = true;
      lastAppliedSeq = memoryWindow.lastAppliedSeq;
      hasMoreMessages = memoryWindow.hasMore;
      oldestMessageId = memoryWindow.oldestMessageId;
      updateMessages(messages);
      setAgentTurns(turns);
      setLastAppliedSeq(lastAppliedSeq);
      setHasMoreMessages(hasMoreMessages);
      setOldestMessageId(oldestMessageId);
      setIsLoading(false);
      scheduleScroll('auto', 0);
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
          const messages = filterMessages(cachedWindow.messages);
          const turns = filterTurns(cachedWindow.turns || []);
          canonicalMessages = drainPendingAIEvents(messages);
          canonicalTurns = turns;
          hasBaseline = true;
          lastAppliedSeq = cachedWindow.lastAppliedSeq;
          hasMoreMessages = cachedWindow.hasMore;
          oldestMessageId = cachedWindow.oldestMessageId;
          updateMessages(canonicalMessages);
          setAgentTurns(turns);
          setLastAppliedSeq(lastAppliedSeq);
          setHasMoreMessages(hasMoreMessages);
          setOldestMessageId(oldestMessageId);
          setIsLoading(false);
          scheduleScroll('auto', 0);
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
      syncAgain = true;
      await syncFromCursor();
    };
    requestHistoryRef.current = issueHistoryRequest;

    const handleRoomEventAvailable = (event: RoomEventAvailable) => {
      if (event.roomId !== roomId || !Number.isSafeInteger(event.headSeq)) return;
      desiredHeadSeq = Math.max(desiredHeadSeq, event.headSeq);
      const fastPathEvents = Array.isArray(event.events) ? event.events : [];
      const fastPathEndsAtHead = fastPathEvents.length > 0
        && fastPathEvents[fastPathEvents.length - 1].seq === event.headSeq;
      if (hasBaseline && fastPathEndsAtHead && !applyEventPage(fastPathEvents)) {
        logRoomMessageDiagnostic('event-fast-path-gap', {
          roomId,
          lastAppliedSeq,
          headSeq: event.headSeq,
          eventSeqs: fastPathEvents.map(candidate => candidate.seq),
        });
      }
      if (!hasBaseline || lastAppliedSeq < desiredHeadSeq) void syncFromCursor();
    };
    const handleReconnect = () => void syncFromCursor();
    const handleRoomSyncRequired = () => void syncFromCursor();
    const handlePageResume = () => {
      if (document.visibilityState === 'visible') void syncFromCursor();
    };

    const handleAIChunk = (data: AIChunkEvent) => {
      if (data.roomId !== roomId) return;
      if (!canonicalMessages.some(message => message.id === data.messageId)) {
        queuePendingAIEvent({ type: 'ai_chunk', data });
        return;
      }
      canonicalMessages = appendAIChunk(canonicalMessages, data.messageId, data.chunk);
      updateMessages(previous => appendAIChunk(previous, data.messageId, data.chunk));
      const container = containerRef.current;
      if (container && container.scrollHeight - container.scrollTop - container.clientHeight < 150) {
        scheduleScroll('smooth', 50);
      }
    };
    const handleA2UIUpdate = (data: A2UIUpdateEvent) => {
      if (data.roomId !== roomId) return;
      if (!canonicalMessages.some(message => message.id === data.messageId)) {
        queuePendingAIEvent({ type: 'a2ui_update', data });
        return;
      }
      canonicalMessages = appendA2UIPayload(canonicalMessages, data.messageId, data.uiPayload);
      updateMessages(previous => appendA2UIPayload(previous, data.messageId, data.uiPayload));
    };
    const handleAIStreamEnd = (data: AIStreamEndEvent) => {
      if (data.roomId !== roomId) return;
      if (!canonicalMessages.some(message => message.id === data.messageId)) {
        queuePendingAIEvent({ type: 'ai_stream_end', data });
        return;
      }
      canonicalMessages = completeAIMessage(canonicalMessages, data.messageId, {
        content: data.content,
        uiPayload: data.uiPayload,
        aiModel: data.aiModel,
        usage: data.usage,
        cost: data.cost,
      });
      updateMessages(previous => completeAIMessage(previous, data.messageId, {
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
      if (
        errorMessage
        && errorMessage.id === data.messageId
        && errorMessage.roomId === roomId
      ) {
        if (!canonicalMessages.some(message => message.id === data.messageId)) {
          queuePendingAIEvent({ type: 'ai_stream_error', data });
          return;
        }
        canonicalMessages = upsertMessage(canonicalMessages, errorMessage);
        updateMessages(previous => upsertMessage(previous, errorMessage));
        cacheWindow(canonicalMessages);
      }
      onAIStreamSettled?.();
    };

    socket.on('room_event_available', handleRoomEventAvailable);
    socket.on('room_sync_required', handleRoomSyncRequired);
    socket.on('connect', handleReconnect);
    socket.on('ai_chunk', handleAIChunk);
    socket.on('a2ui_update', handleA2UIUpdate);
    socket.on('ai_stream_end', handleAIStreamEnd);
    socket.on('ai_usage_update', handleAIUsageUpdate);
    socket.on('ai_cost_total', handleAICostTotal);
    socket.on('ai_stream_error', handleAIStreamError);
    window.addEventListener('focus', handlePageResume);
    window.addEventListener('pageshow', handlePageResume);
    document.addEventListener('visibilitychange', handlePageResume);

    const loadingTimeout = setTimeout(() => setIsLoading(false), 5_000);
    return () => {
      cancelled = true;
      clearTimeout(loadingTimeout);
      if (scrollTimer) clearTimeout(scrollTimer);
      pendingAIEvents.clear();
      if (requestHistoryRef.current === issueHistoryRequest) requestHistoryRef.current = null;
      socket.off('room_event_available', handleRoomEventAvailable);
      socket.off('room_sync_required', handleRoomSyncRequired);
      socket.off('connect', handleReconnect);
      socket.off('ai_chunk', handleAIChunk);
      socket.off('a2ui_update', handleA2UIUpdate);
      socket.off('ai_stream_end', handleAIStreamEnd);
      socket.off('ai_usage_update', handleAIUsageUpdate);
      socket.off('ai_cost_total', handleAICostTotal);
      socket.off('ai_stream_error', handleAIStreamError);
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
