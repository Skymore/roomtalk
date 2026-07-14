import { Dispatch, MutableRefObject, RefObject, SetStateAction, useEffect, useRef, useState } from 'react';
import { clientId, requestRoomMessages, socket } from '../utils/socket';
import { A2UIUpdateEvent, AICostTotalEvent, AIChunkEvent, AIStreamEndEvent, AIStreamErrorEvent, AIUsageUpdateEvent, Message, RoomAgentTurn, RoomMessageHistoryInvalidatedEvent, RoomMessageHistoryPayload } from '../utils/types';
import { appendA2UIPayload, appendAIChunk, completeAIMessage, upsertMessage } from '../utils/messageState';
import { clearCachedRoomMessageWindow, readCachedRoomMessageWindow, readMemoryRoomMessageWindow, writeCachedRoomMessageWindow } from '../utils/messageHistoryCache';
import { clearCachedMediaAsset, clearCachedMediaForRoom } from '../utils/mediaCache';
import { logRoomMessageDiagnostic } from '../utils/roomDiagnostics';

const ROOM_MESSAGE_PAGE_LIMIT = 80;
const ROOM_HISTORY_RECONCILIATION_RETRY_LIMIT = 3;
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
  setMessageVersion: Dispatch<SetStateAction<number>>;
  setOldestMessageId: Dispatch<SetStateAction<string | undefined>>;
  setSessionCostUsd: Dispatch<SetStateAction<number | null>>;
  setShowScrollButton: Dispatch<SetStateAction<boolean>>;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  closeDeleteModal: () => void;
  closeEditModal: () => void;
  messageToDeleteId?: string;
  messageToEditId?: string;
  onAIStreamSettled?: () => void;
  warningPrefix: string;
  requestHistoryRef: MutableRefObject<RoomMessageHistoryRequest | null>;
}

export type RoomMessageHistoryRequest = (options?: {
  beforeMessageId?: string;
  limit?: number;
  reason?: string;
}) => Promise<void>;

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
  setMessageVersion,
  setOldestMessageId,
  setSessionCostUsd,
  setShowScrollButton,
  scrollToBottom,
  closeDeleteModal,
  closeEditModal,
  messageToDeleteId,
  messageToEditId,
  onAIStreamSettled,
  warningPrefix,
  requestHistoryRef,
}: UseRoomMessageEventsArgs) => {
  const messageToDeleteIdRef = useRef(messageToDeleteId);
  const messageToEditIdRef = useRef(messageToEditId);
  const messageVersionRef = useRef(0);
  const hasMoreMessagesRef = useRef(false);
  const oldestMessageIdRef = useRef<string | undefined>();
  const messageSyncRequestIdRef = useRef(messageSyncRequestId);
  messageSyncRequestIdRef.current = messageSyncRequestId;
  const historyRetryContextRef = useRef('');
  const historyRetryCountRef = useRef(0);
  const historyRetryScheduledRef = useRef(false);
  const mutationRevisionRef = useRef(0);
  const historyRequestSequenceRef = useRef(0);
  const latestReplaceRequestIdRef = useRef<string | null>(null);
  const [historyRefreshNonce, setHistoryRefreshNonce] = useState(0);

  useEffect(() => {
    messageToDeleteIdRef.current = messageToDeleteId;
  }, [messageToDeleteId]);

  useEffect(() => {
    messageToEditIdRef.current = messageToEditId;
  }, [messageToEditId]);

  useEffect(() => {
    setSessionCostUsd(null);
    setAgentTurns([]);
    setShowScrollButton(false);
    closeDeleteModal();
    closeEditModal();
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let serverHistoryLoaded = false;
    let cacheHydrationPromise = Promise.resolve();

    const memoryWindow = readMemoryRoomMessageWindow(roomId);
    const filterRoomMessages = (messages: Message[]) => messages.filter(message => message.roomId === roomId);
    const memoryMessages = memoryWindow ? filterRoomMessages(memoryWindow.messages) : [];
    const memoryTurns = memoryWindow?.turns?.filter(turn => turn.roomId === roomId) || [];

    messageVersionRef.current = memoryWindow?.messageVersion ?? 0;
    mutationRevisionRef.current = 0;
    latestReplaceRequestIdRef.current = null;
    hasMoreMessagesRef.current = memoryWindow?.hasMore ?? false;
    oldestMessageIdRef.current = memoryWindow?.oldestMessageId;

    const setMessageVersionState = (messageVersion: number) => {
      messageVersionRef.current = messageVersion;
      setMessageVersion(messageVersion);
    };

    const setHasMoreMessagesState = (hasMore: boolean) => {
      hasMoreMessagesRef.current = hasMore;
      setHasMoreMessages(hasMore);
    };

    const setOldestMessageIdState = (oldestMessageId?: string) => {
      oldestMessageIdRef.current = oldestMessageId;
      setOldestMessageId(oldestMessageId);
    };

    const markLocalMutation = () => {
      mutationRevisionRef.current += 1;
      return mutationRevisionRef.current;
    };

    const cacheCurrentWindow = (
      messages: Message[],
      messageVersion = messageVersionRef.current,
      hasMore = hasMoreMessagesRef.current,
      oldestMessageId = oldestMessageIdRef.current,
      turns = getCurrentAgentTurns(),
    ) => {
      writeCachedRoomMessageWindow({
        roomId,
        messages: filterRoomMessages(messages),
        turns: turns.filter(turn => turn.roomId === roomId),
        messageVersion,
        hasMore,
        oldestMessageId,
        cachedAt: Date.now(),
      });
    };

    const isSameMessageWindow = (left: Message[], right: Message[]) => (
      left.length === right.length &&
      left.every((message, index) => {
        const other = right[index];
        return other && message.id === other.id && message.updatedAt === other.updatedAt && message.status === other.status;
      })
    );

    const scheduleScroll = (behavior: ScrollBehavior, delayMs: number) => {
      if (scrollTimer) {
        clearTimeout(scrollTimer);
      }

      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        scrollToBottom(behavior);
      }, delayMs);
    };

    if (memoryWindow) {
      logRoomMessageDiagnostic('memory-cache-hit', {
        roomId,
        messageSyncRequestId: messageSyncRequestIdRef.current,
        messageVersion: memoryWindow.messageVersion,
        messageCount: memoryMessages.length,
        socketId: socket.id ?? null,
        socketConnected: socket.connected,
      });
      // Synchronous in-memory hit: render instantly, no blank/loading flash.
      updateMessages(memoryMessages);
      setAgentTurns(memoryTurns);
      setMessageVersionState(memoryWindow.messageVersion);
      setHasMoreMessagesState(memoryWindow.hasMore);
      setOldestMessageIdState(memoryWindow.oldestMessageId);
      setIsLoading(false);
      scheduleScroll('auto', 0);
    } else {
      logRoomMessageDiagnostic('persistent-cache-read-start', {
        roomId,
        messageSyncRequestId: messageSyncRequestIdRef.current,
        socketId: socket.id ?? null,
        socketConnected: socket.connected,
      });
      updateMessages([]);
      setIsLoading(true);
      // Fall back to the async IndexedDB cache (cold start / new tab).
      cacheHydrationPromise = readCachedRoomMessageWindow(roomId)
        .then(cachedWindow => {
          if (!cachedWindow) {
            logRoomMessageDiagnostic('persistent-cache-miss', {
              roomId,
              messageSyncRequestId: messageSyncRequestIdRef.current,
            });
            return;
          }
          if (cancelled || serverHistoryLoaded) {
            logRoomMessageDiagnostic('persistent-cache-skipped', {
              roomId,
              messageSyncRequestId: messageSyncRequestIdRef.current,
              cancelled,
              serverHistoryLoaded,
              messageVersion: cachedWindow.messageVersion,
              messageCount: cachedWindow.messages.length,
            });
            return;
          }

          const cachedMessages = filterRoomMessages(cachedWindow.messages);
          logRoomMessageDiagnostic('persistent-cache-hit', {
            roomId,
            messageSyncRequestId: messageSyncRequestIdRef.current,
            messageVersion: cachedWindow.messageVersion,
            messageCount: cachedMessages.length,
          });
          updateMessages(cachedMessages);
          setAgentTurns(cachedWindow.turns?.filter(turn => turn.roomId === roomId) || []);
          setMessageVersionState(cachedWindow.messageVersion);
          setHasMoreMessagesState(cachedWindow.hasMore);
          setOldestMessageIdState(cachedWindow.oldestMessageId);
          setIsLoading(false);
          scheduleScroll('auto', 0);
        })
        .catch(error => {
          logRoomMessageDiagnostic('persistent-cache-read-failed', {
            roomId,
            messageSyncRequestId: messageSyncRequestIdRef.current,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    const handleMessageHistory = (
      historyPayload: RoomMessageHistoryPayload,
      requestedMutationRevision: number,
    ) => {
      if (historyPayload.roomId !== roomId) return;

      const mode = historyPayload.mode || 'replace';
      const serverMessageVersion = historyPayload.messageVersion;
      const requestedMessageVersion = historyPayload.requestedMessageVersion;
      const newerReplaceRequestStarted = mode === 'replace'
        && latestReplaceRequestIdRef.current !== historyPayload.requestId;
      const canonicalWindowChanged = requestedMessageVersion !== messageVersionRef.current;
      const localWindowChanged = requestedMutationRevision !== mutationRevisionRef.current;
      const serverWindowIsOlder = serverMessageVersion < messageVersionRef.current;
      const ignored = newerReplaceRequestStarted
        || canonicalWindowChanged
        || localWindowChanged
        || serverWindowIsOlder;
      const ignoreReason = newerReplaceRequestStarted
        ? 'newer-replace-request-started'
        : serverWindowIsOlder
          ? 'server-window-older'
          : canonicalWindowChanged
            ? 'canonical-window-changed-after-request'
            : localWindowChanged
              ? 'local-window-changed-after-request'
              : null;
      logRoomMessageDiagnostic('history-response', {
        requestId: historyPayload.requestId,
        roomId,
        messageSyncRequestId: messageSyncRequestIdRef.current,
        requestedMessageVersion,
        currentMessageVersion: messageVersionRef.current,
        serverMessageVersion,
        messageCount: historyPayload.messages.length,
        requestedMutationRevision,
        currentMutationRevision: mutationRevisionRef.current,
        mode,
        decision: ignored ? 'ignored' : 'accepted',
        ignoreReason,
      });
      if (ignored) {
        setIsLoading(false);
        setIsLoadingMore(false);
        if (
          mode === 'replace'
          && !newerReplaceRequestStarted
          && !historyRetryScheduledRef.current
          && historyRetryCountRef.current < ROOM_HISTORY_RECONCILIATION_RETRY_LIMIT
        ) {
          historyRetryScheduledRef.current = true;
          historyRetryCountRef.current += 1;
          logRoomMessageDiagnostic('history-reconciliation-scheduled', {
            roomId,
            messageSyncRequestId: messageSyncRequestIdRef.current,
            retry: historyRetryCountRef.current,
            retryLimit: ROOM_HISTORY_RECONCILIATION_RETRY_LIMIT,
            nextBaseMessageVersion: messageVersionRef.current,
          });
          queueMicrotask(() => {
            historyRetryScheduledRef.current = false;
            if (!cancelled) {
              setHistoryRefreshNonce(current => current + 1);
            }
          });
        } else if (historyRetryCountRef.current >= ROOM_HISTORY_RECONCILIATION_RETRY_LIMIT) {
          logRoomMessageDiagnostic('history-reconciliation-exhausted', {
            roomId,
            messageSyncRequestId: messageSyncRequestIdRef.current,
            retryLimit: ROOM_HISTORY_RECONCILIATION_RETRY_LIMIT,
            currentMessageVersion: messageVersionRef.current,
            serverMessageVersion,
          });
        }
        return;
      }
      serverHistoryLoaded = true;
      historyRetryCountRef.current = 0;
      const roomMessages = filterRoomMessages(historyPayload.messages);

      if (mode === 'prepend') {
        setAgentTurns(previous => {
          const next = new Map(previous.map(turn => [turn.id, turn]));
          (historyPayload.turns || []).forEach(turn => next.set(turn.id, turn));
          return Array.from(next.values());
        });
        updateMessages(prev => {
          const existingIds = new Set(prev.map(message => message.id));
          return [...roomMessages.filter(message => !existingIds.has(message.id)), ...prev];
        });
      } else {
        setAgentTurns(historyPayload.turns || []);
        const currentMessages = filterRoomMessages(getCurrentMessages());
        const windowChanged = !isSameMessageWindow(currentMessages, roomMessages);

        if (windowChanged) {
          updateMessages(roomMessages);
          setShowScrollButton(false);
          scheduleScroll('auto', 0);
        }
        cacheCurrentWindow(
          roomMessages,
          serverMessageVersion,
          historyPayload.hasMore,
          historyPayload.oldestMessageId,
          historyPayload.turns || [],
        );
      }

      setHasMoreMessagesState(historyPayload.hasMore);
      if (mode === 'replace') {
        setMessageVersionState(serverMessageVersion);
      }
      setOldestMessageIdState(historyPayload.oldestMessageId);

      setIsLoading(false);
      setIsLoadingMore(false);
    };

    const handleNewMessage = (message: Message) => {
      if (message.roomId !== roomId) return;

      serverHistoryLoaded = true;
      const mutationRevision = markLocalMutation();
      logRoomMessageDiagnostic('new-message', {
        roomId,
        messageSyncRequestId: messageSyncRequestIdRef.current,
        messageId: message.id,
        messageType: message.messageType,
        mutationRevision,
        canonicalMessageVersion: messageVersionRef.current,
        socketId: socket.id ?? null,
        socketConnected: socket.connected,
      });
      updateMessages(prev => {
        const next = upsertMessage(prev, message);
        cacheCurrentWindow(next);
        return next;
      });

      const container = containerRef.current;
      if (container) {
        const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
        if (isAtBottom || message.clientId === clientId || message.clientId === 'ai_assistant') {
          scheduleScroll('smooth', 100);
        } else {
          setShowScrollButton(true);
        }
      }
    };

    const handleAgentTurnUpdated = (turn: RoomAgentTurn) => {
      if (turn.roomId !== roomId) return;
      markLocalMutation();
      setAgentTurns(previous => {
        const index = previous.findIndex(item => item.id === turn.id);
        const next = index === -1 ? [...previous, turn] : [...previous];
        if (index !== -1) next[index] = turn;
        cacheCurrentWindow(getCurrentMessages(), messageVersionRef.current, hasMoreMessagesRef.current, oldestMessageIdRef.current, next);
        return next;
      });
    };

    const handleAIChunk = (data: AIChunkEvent) => {
      if (data.roomId !== roomId) return;
      markLocalMutation();
      updateMessages(prev => appendAIChunk(prev, data.messageId, data.chunk));

      const container = containerRef.current;
      if (container) {
        const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
        if (isAtBottom) {
          scheduleScroll('smooth', 50);
        }
      }
    };

    const handleA2UIUpdate = (data: A2UIUpdateEvent) => {
      if (data.roomId !== roomId) return;
      markLocalMutation();
      updateMessages(prev => appendA2UIPayload(prev, data.messageId, data.uiPayload));

      const container = containerRef.current;
      if (container) {
        const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
        if (isAtBottom) {
          scheduleScroll('smooth', 50);
        }
      }
    };

    const handleAIStreamEnd = (data: AIStreamEndEvent) => {
      if (data.roomId !== roomId) return;
      serverHistoryLoaded = true;
      markLocalMutation();
      updateMessages(prev => {
        const next = completeAIMessage(prev, data.messageId, {
          content: data.content,
          uiPayload: data.uiPayload,
          aiModel: data.aiModel,
          usage: data.usage,
          cost: data.cost,
        });
        cacheCurrentWindow(next);
        return next;
      });
      if (data.sessionCost) {
        setSessionCostUsd(data.sessionCost.totalUsd);
      }
      onAIStreamSettled?.();
    };

    const handleAIUsageUpdate = (data: AIUsageUpdateEvent) => {
      if (data.roomId !== roomId) return;
      markLocalMutation();
      updateMessages(prev => prev.map(message => (
        message.id === data.messageId ? { ...message, usage: data.usage } : message
      )));
    };

    const handleAICostTotal = (data: AICostTotalEvent) => {
      if (data.roomId !== roomId) return;
      setSessionCostUsd(data.totalUsd);
    };

    const handleAIStreamError = (data: AIStreamErrorEvent) => {
      if (data.roomId !== roomId) return;
      serverHistoryLoaded = true;
      console.error('AI stream error for message:', data.messageId, data.error);
      markLocalMutation();
      updateMessages(prev => {
        const next = prev.map(msg =>
          msg.id === data.messageId
            ? { ...msg, content: (msg.content || '') + `\n\n${warningPrefix}: ` + data.error, status: 'error' as const }
            : msg
        );
        cacheCurrentWindow(next);
        return next;
      });
      onAIStreamSettled?.();
    };

    const handleMessagesCleared = (clearedRoomId: string) => {
      if (clearedRoomId === roomId) {
        serverHistoryLoaded = true;
        updateMessages([]);
        setAgentTurns([]);
        void clearCachedRoomMessageWindow(roomId);
        void clearCachedMediaForRoom(roomId);
        markLocalMutation();
        setHasMoreMessagesState(false);
        setOldestMessageIdState(undefined);
        setShowScrollButton(false);
        closeEditModal();
        closeDeleteModal();
      }
    };

    const handleMessageEdited = (updatedMessage: Message) => {
      if (updatedMessage.roomId === roomId) {
        serverHistoryLoaded = true;
        markLocalMutation();
        updateMessages(prev => {
          let changed = false;
          const next = prev.map(msg => {
            if (msg.id !== updatedMessage.id) {
              return msg;
            }
            changed = true;
            return updatedMessage;
          });
          if (changed) {
            cacheCurrentWindow(next);
          }
          return next;
        });
        if (messageToEditIdRef.current === updatedMessage.id) {
          closeEditModal();
        }
      }
    };

    const handleMessageDeleted = (deletedMessageId: string, deletedRoomId: string) => {
      if (deletedRoomId === roomId) {
        serverHistoryLoaded = true;
        markLocalMutation();
        updateMessages(prev => {
          const deletedMessage = prev.find(msg => msg.id === deletedMessageId);
          if (deletedMessage?.mediaAsset?.id) {
            void clearCachedMediaAsset(deletedMessage.mediaAsset.id);
          }
          const next = prev.filter(msg => msg.id !== deletedMessageId);
          if (next.length !== prev.length) {
            if (oldestMessageIdRef.current === deletedMessageId) {
              setOldestMessageIdState(next[0]?.id);
            }
            cacheCurrentWindow(next);
          }
          return next;
        });
        if (messageToDeleteIdRef.current === deletedMessageId) {
          closeDeleteModal();
        }
        if (messageToEditIdRef.current === deletedMessageId) {
          closeEditModal();
        }
      }
    };

    const issueHistoryRequest: RoomMessageHistoryRequest = async (options = {}) => {
      const mode = options.beforeMessageId ? 'prepend' : 'replace';
      if (mode === 'replace') {
        await cacheHydrationPromise;
      }
      if (cancelled) return;

      const requestId = `${Date.now()}-${++historyRequestSequenceRef.current}`;
      const requestedMutationRevision = mutationRevisionRef.current;
      const baseMessageVersion = messageVersionRef.current;
      if (mode === 'replace') {
        latestReplaceRequestIdRef.current = requestId;
      }
      logRoomMessageDiagnostic('history-request', {
        requestId,
        roomId,
        messageSyncRequestId: messageSyncRequestIdRef.current,
        reason: options.reason || (mode === 'prepend' ? 'pagination' : 'session-sync'),
        baseMessageVersion,
        requestedMutationRevision,
        beforeMessageId: options.beforeMessageId ?? null,
        limit: options.limit ?? ROOM_MESSAGE_PAGE_LIMIT,
        socketId: socket.id ?? null,
        socketConnected: socket.connected,
      });

      try {
        const history = await requestRoomMessages({
          requestId,
          roomId,
          beforeMessageId: options.beforeMessageId,
          limit: options.limit ?? ROOM_MESSAGE_PAGE_LIMIT,
          baseMessageVersion,
        });
        if (!cancelled) {
          handleMessageHistory(history, requestedMutationRevision);
        }
      } catch (error) {
        if (cancelled) return;
        setIsLoading(false);
        setIsLoadingMore(false);
        logRoomMessageDiagnostic('history-request-failed', {
          requestId,
          roomId,
          messageSyncRequestId: messageSyncRequestIdRef.current,
          mode,
          error: error instanceof Error ? error.message : String(error),
        });
        if (
          mode === 'replace'
          && !historyRetryScheduledRef.current
          && historyRetryCountRef.current < ROOM_HISTORY_RECONCILIATION_RETRY_LIMIT
        ) {
          historyRetryScheduledRef.current = true;
          historyRetryCountRef.current += 1;
          queueMicrotask(() => {
            historyRetryScheduledRef.current = false;
            if (!cancelled) setHistoryRefreshNonce(current => current + 1);
          });
        }
      }
    };
    requestHistoryRef.current = issueHistoryRequest;
    const handleMessageHistoryInvalidated = (event: RoomMessageHistoryInvalidatedEvent) => {
      if (event.roomId !== roomId) return;
      logRoomMessageDiagnostic('history-invalidated', {
        roomId,
        messageSyncRequestId: messageSyncRequestIdRef.current,
        reason: event.reason,
      });
      void issueHistoryRequest({ reason: `server-${event.reason}` });
    };

    socket.on('new_message', handleNewMessage);
    socket.on('message_history_invalidated', handleMessageHistoryInvalidated);
    socket.on('agent_turn_updated', handleAgentTurnUpdated);
    socket.on('ai_chunk', handleAIChunk);
    socket.on('a2ui_update', handleA2UIUpdate);
    socket.on('ai_stream_end', handleAIStreamEnd);
    socket.on('ai_usage_update', handleAIUsageUpdate);
    socket.on('ai_cost_total', handleAICostTotal);
    socket.on('ai_stream_error', handleAIStreamError);
    socket.on('messages_cleared', handleMessagesCleared);
    socket.on('message_edited', handleMessageEdited);
    socket.on('message_deleted', handleMessageDeleted);

    const loadingTimeout = setTimeout(() => {
      setIsLoading(false);
    }, 5000);

    return () => {
      cancelled = true;
      clearTimeout(loadingTimeout);
      if (scrollTimer) {
        clearTimeout(scrollTimer);
      }
      if (requestHistoryRef.current === issueHistoryRequest) {
        requestHistoryRef.current = null;
      }
      socket.off('new_message', handleNewMessage);
      socket.off('message_history_invalidated', handleMessageHistoryInvalidated);
      socket.off('agent_turn_updated', handleAgentTurnUpdated);
      socket.off('ai_chunk', handleAIChunk);
      socket.off('a2ui_update', handleA2UIUpdate);
      socket.off('ai_stream_end', handleAIStreamEnd);
      socket.off('ai_usage_update', handleAIUsageUpdate);
      socket.off('ai_cost_total', handleAICostTotal);
      socket.off('ai_stream_error', handleAIStreamError);
      socket.off('messages_cleared', handleMessagesCleared);
      socket.off('message_edited', handleMessageEdited);
      socket.off('message_deleted', handleMessageDeleted);
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
    setMessageVersion,
    setOldestMessageId,
    setSessionCostUsd,
    setShowScrollButton,
    scrollToBottom,
    closeDeleteModal,
    closeEditModal,
    onAIStreamSettled,
    warningPrefix,
    requestHistoryRef,
  ]);

  useEffect(() => {
    if (!isRoomSessionReady) return;

    const retryContext = `${roomId}:${messageSyncRequestId}`;
    if (historyRetryContextRef.current !== retryContext) {
      historyRetryContextRef.current = retryContext;
      historyRetryCountRef.current = 0;
      historyRetryScheduledRef.current = false;
    }
    void requestHistoryRef.current?.({
      limit: ROOM_MESSAGE_PAGE_LIMIT,
      reason: historyRetryCountRef.current > 0 ? 'version-reconciliation' : 'session-sync',
    });
  }, [historyRefreshNonce, isRoomSessionReady, messageSyncRequestId, requestHistoryRef, roomId]);
};
