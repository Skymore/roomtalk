import { Dispatch, RefObject, SetStateAction, useEffect, useRef } from 'react';
import { clientId, socket } from '../utils/socket';
import { AICostTotalEvent, AIChunkEvent, AIStreamEndEvent, AIStreamErrorEvent, Message, RoomMessageHistoryPayload } from '../utils/types';
import { appendAIChunk, completeAIMessage, sortMessages, upsertMessage } from '../utils/messageState';
import { deleteCachedRoomMessageWindow, readCachedRoomMessageWindow, readMemoryRoomMessageWindow, writeCachedRoomMessageWindow } from '../utils/messageHistoryCache';

const ROOM_MESSAGE_PAGE_LIMIT = 80;

interface UseRoomMessageEventsArgs {
  roomId: string;
  containerRef: RefObject<HTMLDivElement>;
  updateMessages: (updater: SetStateAction<Message[]>) => void;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setIsLoadingMore: Dispatch<SetStateAction<boolean>>;
  setHasMoreMessages: Dispatch<SetStateAction<boolean>>;
  setHistoryVersion: Dispatch<SetStateAction<number>>;
  setOldestMessageId: Dispatch<SetStateAction<string | undefined>>;
  setSessionCostUsd: Dispatch<SetStateAction<number>>;
  setShowScrollButton: Dispatch<SetStateAction<boolean>>;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  closeDeleteModal: () => void;
  closeEditModal: () => void;
  messageToDeleteId?: string;
  messageToEditId?: string;
  warningPrefix: string;
}

export const useRoomMessageEvents = ({
  roomId,
  containerRef,
  updateMessages,
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
    setSessionCostUsd(0);
    setShowScrollButton(false);
    closeDeleteModal();
    closeEditModal();
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let serverHistoryLoaded = false;

    const memoryWindow = readMemoryRoomMessageWindow(roomId);
    const memoryMessages = memoryWindow
      ? sortMessages(memoryWindow.messages.filter(message => message.roomId === roomId))
      : [];

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
        messages: sortMessages(messages.filter(message => message.roomId === roomId)),
        historyVersion,
        hasMore,
        oldestMessageId,
        cachedAt: Date.now(),
      });
    };

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

        updateMessages(sortMessages(cachedWindow.messages.filter(message => message.roomId === roomId)));
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
      const roomMessages = sortMessages(historyPayload.messages.filter(message => message.roomId === roomId));

      if (mode === 'prepend') {
        updateMessages(prev => {
          const existingIds = new Set(prev.map(message => message.id));
          return sortMessages([...roomMessages.filter(message => !existingIds.has(message.id)), ...prev]);
        });
      } else {
        updateMessages(roomMessages);
        setShowScrollButton(false);
        scheduleScroll('auto', 100);
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

    const handleAIStreamEnd = (data: AIStreamEndEvent) => {
      if (data.roomId !== roomId) return;
      const nextHistoryVersion = bumpLocalHistoryVersion();
      updateMessages(prev => {
        const next = completeAIMessage(prev, data.messageId, {
          content: data.content,
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
    };

    const handleMessagesCleared = (clearedRoomId: string) => {
      if (clearedRoomId === roomId) {
        updateMessages([]);
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
    socket.on('ai_chunk', handleAIChunk);
    socket.on('ai_stream_end', handleAIStreamEnd);
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
      socket.off('ai_chunk', handleAIChunk);
      socket.off('ai_stream_end', handleAIStreamEnd);
      socket.off('ai_cost_total', handleAICostTotal);
      socket.off('ai_stream_error', handleAIStreamError);
      socket.off('messages_cleared', handleMessagesCleared);
      socket.off('message_edited', handleMessageEdited);
      socket.off('message_deleted', handleMessageDeleted);
    };
  }, [
    roomId,
    containerRef,
    updateMessages,
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
