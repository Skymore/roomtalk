import { Dispatch, RefObject, SetStateAction, useEffect, useRef } from 'react';
import { clientId, socket } from '../utils/socket';
import { A2UIUpdateEvent, AICostTotalEvent, AIChunkEvent, AIStreamEndEvent, AIStreamErrorEvent, AIUsageUpdateEvent, Message, RoomAgentTurn, RoomMessageHistoryPayload } from '../utils/types';
import { appendA2UIPayload, appendAIChunk, completeAIMessage, upsertMessage } from '../utils/messageState';
import { deleteCachedRoomMessageWindow, readCachedRoomMessageWindow, readMemoryRoomMessageWindow, writeCachedRoomMessageWindow } from '../utils/messageHistoryCache';

const ROOM_MESSAGE_PAGE_LIMIT = 80;

interface UseRoomMessageEventsArgs {
  roomId: string;
  containerRef: RefObject<HTMLDivElement>;
  getCurrentMessages: () => Message[];
  updateMessages: (updater: SetStateAction<Message[]>) => void;
  setAgentTurns: Dispatch<SetStateAction<RoomAgentTurn[]>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setIsLoadingMore: Dispatch<SetStateAction<boolean>>;
  setHasMoreMessages: Dispatch<SetStateAction<boolean>>;
  setHistoryVersion: Dispatch<SetStateAction<number>>;
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
}

export const useRoomMessageEvents = ({
  roomId,
  containerRef,
  getCurrentMessages,
  updateMessages,
  setAgentTurns,
  setIsLoading,
  setIsLoadingMore,
  setHasMoreMessages,
  setHistoryVersion,
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
}: UseRoomMessageEventsArgs) => {
  const messageToDeleteIdRef = useRef(messageToDeleteId);
  const messageToEditIdRef = useRef(messageToEditId);
  const historyVersionRef = useRef(0);
  const hasMoreMessagesRef = useRef(false);
  const oldestMessageIdRef = useRef<string | undefined>();

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

    const memoryWindow = readMemoryRoomMessageWindow(roomId);
    const filterRoomMessages = (messages: Message[]) => messages.filter(message => message.roomId === roomId);
    const memoryMessages = memoryWindow ? filterRoomMessages(memoryWindow.messages) : [];

    historyVersionRef.current = memoryWindow?.historyVersion ?? 0;
    hasMoreMessagesRef.current = memoryWindow?.hasMore ?? false;
    oldestMessageIdRef.current = memoryWindow?.oldestMessageId;

    const setHistoryVersionState = (historyVersion: number) => {
      historyVersionRef.current = historyVersion;
      setHistoryVersion(historyVersion);
    };

    const setHasMoreMessagesState = (hasMore: boolean) => {
      hasMoreMessagesRef.current = hasMore;
      setHasMoreMessages(hasMore);
    };

    const setOldestMessageIdState = (oldestMessageId?: string) => {
      oldestMessageIdRef.current = oldestMessageId;
      setOldestMessageId(oldestMessageId);
    };

    const bumpLocalHistoryVersion = () => {
      const nextHistoryVersion = historyVersionRef.current + 1;
      setHistoryVersionState(nextHistoryVersion);
      return nextHistoryVersion;
    };

    const cacheCurrentWindow = (
      messages: Message[],
      historyVersion = historyVersionRef.current,
      hasMore = hasMoreMessagesRef.current,
      oldestMessageId = oldestMessageIdRef.current,
    ) => {
      writeCachedRoomMessageWindow({
        roomId,
        messages: filterRoomMessages(messages),
        historyVersion,
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
      // Synchronous in-memory hit: render instantly, no blank/loading flash.
      updateMessages(memoryMessages);
      setHistoryVersionState(memoryWindow.historyVersion);
      setHasMoreMessagesState(memoryWindow.hasMore);
      setOldestMessageIdState(memoryWindow.oldestMessageId);
      setIsLoading(false);
      scheduleScroll('auto', 0);
    } else {
      updateMessages([]);
      setIsLoading(true);
      // Fall back to the async IndexedDB cache (cold start / new tab).
      readCachedRoomMessageWindow(roomId).then(cachedWindow => {
        if (!cachedWindow || cancelled || serverHistoryLoaded) {
          return;
        }

        updateMessages(filterRoomMessages(cachedWindow.messages));
        setHistoryVersionState(cachedWindow.historyVersion);
        setHasMoreMessagesState(cachedWindow.hasMore);
        setOldestMessageIdState(cachedWindow.oldestMessageId);
        setIsLoading(false);
        scheduleScroll('auto', 0);
      });
    }

    const handleMessageHistory = (historyPayload: RoomMessageHistoryPayload) => {
      serverHistoryLoaded = true;
      const mode = historyPayload.mode || 'replace';
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
        cacheCurrentWindow(roomMessages, historyPayload.historyVersion, historyPayload.hasMore, historyPayload.oldestMessageId);
      }

      setHasMoreMessagesState(historyPayload.hasMore);
      setHistoryVersionState(historyPayload.historyVersion);
      setOldestMessageIdState(historyPayload.oldestMessageId);

      setIsLoading(false);
      setIsLoadingMore(false);
    };

    const handleNewMessage = (message: Message) => {
      if (message.roomId !== roomId) return;

      const nextHistoryVersion = bumpLocalHistoryVersion();
      updateMessages(prev => {
        const next = upsertMessage(prev, message);
        cacheCurrentWindow(next, nextHistoryVersion);
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
      setAgentTurns(previous => {
        const index = previous.findIndex(item => item.id === turn.id);
        if (index === -1) return [...previous, turn];
        const next = [...previous];
        next[index] = turn;
        return next;
      });
    };

    const handleAIChunk = (data: AIChunkEvent) => {
      if (data.roomId !== roomId) return;
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
      const nextHistoryVersion = bumpLocalHistoryVersion();
      updateMessages(prev => {
        const next = completeAIMessage(prev, data.messageId, {
          content: data.content,
          uiPayload: data.uiPayload,
          aiModel: data.aiModel,
          usage: data.usage,
          cost: data.cost,
        });
        cacheCurrentWindow(next, nextHistoryVersion);
        return next;
      });
      if (data.sessionCost) {
        setSessionCostUsd(data.sessionCost.totalUsd);
      }
      onAIStreamSettled?.();
    };

    const handleAIUsageUpdate = (data: AIUsageUpdateEvent) => {
      if (data.roomId !== roomId) return;
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
      console.error('AI stream error for message:', data.messageId, data.error);
      const nextHistoryVersion = bumpLocalHistoryVersion();
      updateMessages(prev => {
        const next = prev.map(msg =>
          msg.id === data.messageId
            ? { ...msg, content: (msg.content || '') + `\n\n${warningPrefix}: ` + data.error, status: 'error' as const }
            : msg
        );
        cacheCurrentWindow(next, nextHistoryVersion);
        return next;
      });
      onAIStreamSettled?.();
    };

    const handleMessagesCleared = (clearedRoomId: string) => {
      if (clearedRoomId === roomId) {
        updateMessages([]);
        setAgentTurns([]);
        deleteCachedRoomMessageWindow(roomId);
        bumpLocalHistoryVersion();
        setHasMoreMessagesState(false);
        setOldestMessageIdState(undefined);
        setShowScrollButton(false);
        closeEditModal();
        closeDeleteModal();
      }
    };

    const handleMessageEdited = (updatedMessage: Message) => {
      if (updatedMessage.roomId === roomId) {
        const nextHistoryVersion = bumpLocalHistoryVersion();
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
            cacheCurrentWindow(next, nextHistoryVersion);
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
        const nextHistoryVersion = bumpLocalHistoryVersion();
        updateMessages(prev => {
          const next = prev.filter(msg => msg.id !== deletedMessageId);
          if (next.length !== prev.length) {
            if (oldestMessageIdRef.current === deletedMessageId) {
              setOldestMessageIdState(next[0]?.id);
            }
            cacheCurrentWindow(next, nextHistoryVersion);
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

    socket.on('message_history', handleMessageHistory);
    socket.on('new_message', handleNewMessage);
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

    socket.emit('get_room_messages', { roomId, limit: ROOM_MESSAGE_PAGE_LIMIT });

    const loadingTimeout = setTimeout(() => {
      setIsLoading(false);
    }, 5000);

    return () => {
      cancelled = true;
      clearTimeout(loadingTimeout);
      if (scrollTimer) {
        clearTimeout(scrollTimer);
      }
      socket.off('message_history', handleMessageHistory);
      socket.off('new_message', handleNewMessage);
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
    updateMessages,
    setAgentTurns,
    setIsLoading,
    setIsLoadingMore,
    setHasMoreMessages,
    setHistoryVersion,
    setOldestMessageId,
    setSessionCostUsd,
    setShowScrollButton,
    scrollToBottom,
    closeDeleteModal,
    closeEditModal,
    onAIStreamSettled,
    warningPrefix,
  ]);

  useEffect(() => {
    const handleConnect = () => {
      socket.emit('get_room_messages', { roomId, limit: ROOM_MESSAGE_PAGE_LIMIT });
    };
    socket.on('connect', handleConnect);
    return () => {
      socket.off('connect', handleConnect);
    };
  }, [roomId]);
};
