import React, { useEffect, useState, useRef, useCallback, useImperativeHandle } from 'react';
import { Icon } from '@iconify/react';
import { requestAIResponse, requestEditMessageAndAIResponse, socket } from '../utils/socket';
import { MessageItem } from './MessageItem';
import { Message } from '../utils/types';
import { useTranslation } from 'react-i18next';
import { getStoredAIModel } from '../utils/aiModels';
import { formatUsdCost } from '../utils/formatters';
import {
  deleteMessageById,
  editMessageAndTruncateAfter,
  editMessageContent,
  getMessageById,
  replaceMessage,
  truncateBeforeMessage,
} from '../utils/messageState';
import { useRoomMessageEvents } from '../hooks/useRoomMessageEvents';

// Import your new modals
import { DeleteConfirmationModal } from './DeleteConfirmationModal';
import { EditMessageModal } from './EditMessageModal';

// Reminder: Set the app element for react-modal for accessibility
// Ideally in your root component file (e.g., App.tsx or main.tsx)
// Modal.setAppElement('#root');

interface MessageListProps {
  roomId: string;
  onReply: (message: Message) => void;
  bottomPaddingPx?: number;
  bottomPadding?: string;
  onScrollButtonVisibilityChange?: (isVisible: boolean) => void;
}

export interface MessageListHandle {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(({
  roomId,
  onReply,
  bottomPaddingPx,
  bottomPadding,
  onScrollButtonVisibilityChange,
}, ref) => {
  const { t } = useTranslation();
  // generate a stable ID for the scroll container
  const scrollContainerId = `message-list-scroll-${roomId}`;
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const retryScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  // State for modals
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [messageToDelete, setMessageToDelete] = useState<Message | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [messageToEdit, setMessageToEdit] = useState<Message | null>(null);
  const [sessionCostUsd, setSessionCostUsd] = useState(0);

  const updateMessages = useCallback((updater: React.SetStateAction<Message[]>) => {
    setMessages(prev => {
      const next =
        typeof updater === 'function'
          ? (updater as (prevState: Message[]) => Message[])(prev)
          : updater;

      if (next === prev) {
        return prev;
      }

      return next;
    });
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  useImperativeHandle(ref, () => ({
    scrollToBottom,
  }), [scrollToBottom]);

  useEffect(() => {
    onScrollButtonVisibilityChange?.(showScrollButton);
  }, [showScrollButton, onScrollButtonVisibilityChange]);

  useEffect(() => {
    return () => {
      if (retryScrollTimerRef.current) {
        clearTimeout(retryScrollTimerRef.current);
      }
    };
  }, []);

  // --- Modal Handlers (Keep dependencies as they are or simplify if possible) ---
  const handleOpenDeleteModal = useCallback((messageId: string) => {
    const msg = getMessageById(messages, messageId);
    if (msg) {
      setMessageToDelete(msg);
      setIsDeleteModalOpen(true);
    }
   }, [messages]);
  const handleCloseDeleteModal = useCallback(() => {
      setIsDeleteModalOpen(false);
    setMessageToDelete(null);
   }, []);
  const handleOpenEditModal = useCallback((messageId: string) => {
      const msg = getMessageById(messages, messageId);
    if (msg) {
      setMessageToEdit(msg);
      setIsEditModalOpen(true);
    }
  }, [messages]);
  const handleCloseEditModal = useCallback(() => {
      setIsEditModalOpen(false);
    setMessageToEdit(null);
   }, []);

  // --- Edit/Delete Logic ---
  const handleSaveEdit = useCallback((messageId: string, newContent: string) => {
    console.log('Saving edit (from modal):', messageId, newContent);
    const originalMessages = messages;
    updateMessages(prev => editMessageContent(prev, messageId, newContent));
    // No need to close modal here, EditMessageModal handles it

    socket.emit('edit_message', { roomId, messageId, newContent }, (response: { success: boolean; updatedMessage?: Message; error?: string }) => {
      if (response.success && response.updatedMessage) {
        console.log('Edit successful on server.');
        updateMessages(prev => replaceMessage(prev, response.updatedMessage!));
      } else {
        console.error('Failed to save edit on server:', response.error);
        updateMessages(originalMessages);
        // Use translation key for alert
        alert(t('errorEditingMessage', { error: response.error || t('unknownError') }));
      }
    });
  }, [roomId, messages, updateMessages, t]);

  const handleSaveEditAndAskAI = useCallback((messageId: string, newContent: string) => {
    console.log('Saving edit and triggering AI (from modal):', messageId, newContent);
    const originalMessages = messages;
    const optimisticResult = editMessageAndTruncateAfter(messages, messageId, newContent);

    // 1. Optimistic Update & Truncation
    updateMessages(optimisticResult.messages);
    // No need to close modal here, EditMessageModal handles it

    // Check if index was found before proceeding
    if (!optimisticResult.found) {
        console.error("Edited message ID not found in state during optimistic update.");
        updateMessages(originalMessages); // Revert
        return;
    }

    requestEditMessageAndAIResponse({
      roomId,
      messageId,
      newContent,
      model: getStoredAIModel() || undefined,
    }).catch((error) => {
      console.error('Failed to save edit before asking AI:', error);
      updateMessages(originalMessages);
      alert(t('errorEditingMessage', { error: error instanceof Error ? error.message : t('unknownError') }));
    });
  }, [roomId, messages, updateMessages, t]);

  // Define handleConfirmDelete within useCallback, accessing messageToDelete state
  const handleConfirmDelete = useCallback(() => {
    if (!messageToDelete) return;

    const messageIdToDelete = messageToDelete.id;
    console.log('Confirmed deleting message:', messageIdToDelete);

    // 1. Close modal & Optimistically remove from UI
    handleCloseDeleteModal(); // Close modal first
    updateMessages(prev => deleteMessageById(prev, messageIdToDelete));

    // 2. Emit event to server
    socket.emit('delete_message', { roomId, messageId: messageIdToDelete }, (response: { success: boolean; error?: string }) => {
      if (!response.success) {
        console.error('Failed to delete message on server:', response.error);
        // Refetch history on error to ensure consistency
        socket.emit('get_room_messages', roomId);
         // Use translation key for alert
        alert(t('errorDeletingMessage', { error: response.error || t('unknownError') }));
      }
    });
  }, [roomId, messageToDelete, handleCloseDeleteModal, updateMessages, t]);

  // 添加刷新AI的处理函数
  const handleRefreshAI = useCallback((messageId: string) => {
    console.log('Retrying AI response for message ID:', messageId);

    // 找到消息的索引位置
    const retryResult = truncateBeforeMessage(messages, messageId);
    if (!retryResult.found) {
      console.error("Cannot retry AI response: Message ID not found in current list.");
      return;
    }

    // 截断本地消息列表到当前AI消息之前
    // This effectively removes the target AI message and all subsequent messages from the UI optimistically
    updateMessages(retryResult.messages);
    console.log('Truncated message list locally, count:', retryResult.messages.length);

    // 向服务器发送 ask_ai 事件，并带上 retryForMessageId 标识
    // 服务器将根据这个ID来截断 redis 中的历史记录
    requestAIResponse({
      roomId,
      // prompt: '', // Prompt is now determined by the server based on truncated history
      retryForMessageId: messageId, // 新增：告知服务器这是针对哪条消息的重试
      model: getStoredAIModel() || undefined
      // TODO: Consider sending current role/system prompt if needed
    }).catch((error) => {
      console.error('Failed to retry AI response:', error);
      socket.emit('get_room_messages', roomId);
    });
    console.log('Emitted ask_ai for retry with retryForMessageId:', messageId);

    // 自动滚动到底部
    if (retryScrollTimerRef.current) {
      clearTimeout(retryScrollTimerRef.current);
    }
    retryScrollTimerRef.current = setTimeout(() => {
      scrollToBottom('smooth');
      retryScrollTimerRef.current = null;
    }, 100);
  }, [roomId, messages, updateMessages, scrollToBottom]);

  useRoomMessageEvents({
    roomId,
    containerRef,
    updateMessages,
    setIsLoading,
    setSessionCostUsd,
    setShowScrollButton,
    scrollToBottom,
    closeDeleteModal: handleCloseDeleteModal,
    closeEditModal: handleCloseEditModal,
    messageToDeleteId: messageToDelete?.id,
    messageToEditId: messageToEdit?.id,
    warningPrefix: t('warningPrefix'),
  });

  // ... handleScroll ...
  const handleScroll = () => {
    const container = containerRef.current;
    if (container) {
      const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
      setShowScrollButton(!isAtBottom && messages.length > 0);
    }
  };

  // ... loading/empty states ...
  // ... return statement with JSX ...

  return (
    <>
      <div
        id={scrollContainerId}
        data-testid="message-list-scroll"
        ref={containerRef}
        className="relative flex h-full w-full flex-col overflow-y-auto bg-[#f5f4ed] p-3 dark:bg-[#141413]"
        style={{ paddingBottom: bottomPadding ?? (bottomPaddingPx ? `${bottomPaddingPx}px` : 'var(--rt-message-list-bottom-padding, 180px)') }}
        onScroll={handleScroll}
      >
        <div className="sticky top-0 z-20 mb-2 flex justify-end">
          <div className="flex items-center gap-1 rounded-full border border-[#dedbd0] bg-[#faf9f5]/95 px-2.5 py-1 text-tiny font-medium text-[#4d4c48] shadow-sm backdrop-blur dark:border-[#30302e] dark:bg-[#1d1d1b]/95 dark:text-[#e8e6dc]">
            <Icon icon="lucide:coins" className="h-3.5 w-3.5" />
            <span>{t('sessionCost')}: {formatUsdCost(sessionCostUsd)}</span>
          </div>
        </div>
        {/* ... Loading/Empty/List rendering ... */}
         {!isLoading && messages.length > 0 && (
            <div className="flex flex-col space-y-2 pb-4">
                {messages
                .map((message) => (
                    <MessageItem
                    key={message.id}
                    message={message}
                    onStartEdit={handleOpenEditModal}
                    onDeleteMessage={handleOpenDeleteModal}
                    onRefreshAI={handleRefreshAI}
                    onReply={onReply}
                    />
                ))}
            </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Render Modals */}
      <DeleteConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={handleCloseDeleteModal}
        onConfirm={handleConfirmDelete}
        messageContent={messageToDelete?.content ? messageToDelete.content.substring(0, 100) : ''}
      />
      <EditMessageModal
        isOpen={isEditModalOpen}
        onClose={handleCloseEditModal}
        message={messageToEdit}
        onSave={handleSaveEdit}
        onSaveAndAskAI={handleSaveEditAndAskAI}
      />
    </>
  );
});

MessageList.displayName = 'MessageList';
