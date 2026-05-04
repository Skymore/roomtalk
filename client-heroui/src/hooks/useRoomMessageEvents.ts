import { Dispatch, RefObject, SetStateAction, useEffect, useRef } from 'react';
import { clientId, socket } from '../utils/socket';
import { AICostTotalEvent, AIChunkEvent, AIStreamEndEvent, AIStreamErrorEvent, Message } from '../utils/types';
import { appendAIChunk, completeAIMessage, sortMessages, upsertMessage } from '../utils/messageState';

interface UseRoomMessageEventsArgs {
  roomId: string;
  containerRef: RefObject<HTMLDivElement>;
  updateMessages: (updater: SetStateAction<Message[]>) => void;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
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

  useEffect(() => {
    messageToDeleteIdRef.current = messageToDeleteId;
  }, [messageToDeleteId]);

  useEffect(() => {
    messageToEditIdRef.current = messageToEditId;
  }, [messageToEditId]);

  useEffect(() => {
    updateMessages([]);
    setIsLoading(true);
    setSessionCostUsd(0);
    closeDeleteModal();
    closeEditModal();
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleScroll = (behavior: ScrollBehavior, delayMs: number) => {
      if (scrollTimer) {
        clearTimeout(scrollTimer);
      }

      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        scrollToBottom(behavior);
      }, delayMs);
    };

    const handleMessageHistory = (messageHistory: Message[]) => {
      const roomMessages = sortMessages(messageHistory.filter(message => message.roomId === roomId));
      updateMessages(roomMessages);
      setIsLoading(false);
      scheduleScroll('auto', 100);
    };

    const handleNewMessage = (message: Message) => {
      if (message.roomId !== roomId) return;

      updateMessages(prev => upsertMessage(prev, message));

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
      updateMessages(prev => completeAIMessage(prev, data.messageId, {
        aiModel: data.aiModel,
        usage: data.usage,
        cost: data.cost,
      }));
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
      updateMessages(prev =>
        prev.map(msg =>
          msg.id === data.messageId
            ? { ...msg, content: (msg.content || '') + `\n\n${warningPrefix}: ` + data.error, status: 'error' }
            : msg
        )
      );
    };

    const handleMessagesCleared = (clearedRoomId: string) => {
      if (clearedRoomId === roomId) {
        updateMessages([]);
        setShowScrollButton(false);
        closeEditModal();
        closeDeleteModal();
      }
    };

    const handleMessageEdited = (updatedMessage: Message) => {
      if (updatedMessage.roomId === roomId) {
        updateMessages(prev =>
          prev.map(msg => (msg.id === updatedMessage.id ? updatedMessage : msg))
        );
        if (messageToEditIdRef.current === updatedMessage.id) {
          closeEditModal();
        }
      }
    };

    const handleMessageDeleted = (deletedMessageId: string, deletedRoomId: string) => {
      if (deletedRoomId === roomId) {
        updateMessages(prev => prev.filter(msg => msg.id !== deletedMessageId));
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

    socket.emit('get_room_messages', roomId);

    const loadingTimeout = setTimeout(() => {
      setIsLoading(false);
    }, 5000);

    return () => {
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
    setSessionCostUsd,
    setShowScrollButton,
    scrollToBottom,
    closeDeleteModal,
    closeEditModal,
    warningPrefix,
  ]);

  useEffect(() => {
    const handleConnect = () => {
      socket.emit('get_room_messages', roomId);
    };
    socket.on('connect', handleConnect);
    return () => {
      socket.off('connect', handleConnect);
    };
  }, [roomId]);
};
