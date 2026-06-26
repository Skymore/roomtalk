import React, { useEffect, useState, useRef, useCallback, useImperativeHandle } from 'react';
import { Icon } from '@iconify/react';
import { clientId, getMediaDownloadUrl, getRoomMessagesForExport, requestAIResponse, requestEditMessageAndAIResponse, socket } from '../utils/socket';
import { MessageItem, preloadMarkdownContent } from './MessageItem';
import { Message, Room, RoomPermissions } from '../utils/types';
import { readMemoryRoomMessageWindow } from '../utils/messageHistoryCache';
import { useTranslation } from 'react-i18next';
import { getRoomAIRequestSettings } from '../utils/aiRequestSettings';
import { formatUsdCost } from '../utils/formatters';
import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react';
import { downloadTranscriptHtml, downloadTranscriptZip, type ExportMediaResolver } from '../utils/chatExport';
import {
  addOptimisticMessage,
  deleteMessageById,
  editMessageAndTruncateAfter,
  editMessageContent,
  getMessageById,
  markOptimisticMessageFailed,
  replaceMessage,
  replaceOptimisticMessage,
  sortMessages,
  truncateBeforeMessage,
} from '../utils/messageState';
import { useRoomMessageEvents } from '../hooks/useRoomMessageEvents';
import { CodeAgentMode } from '../utils/codeAgent';
import { CodeAgentWorkspaceSnapshot, fetchCodeAgentWorkspaceSnapshot } from '../utils/cocoWorkspace';

// Import your new modals
import { DeleteConfirmationModal } from './DeleteConfirmationModal';
import { EditMessageModal } from './EditMessageModal';
import { CodeAgentWorkspacePanel } from './CodeAgentWorkspacePanel';

const LOAD_MORE_MESSAGE_COUNT = 80;

// Reminder: Set the app element for react-modal for accessibility
// Ideally in your root component file (e.g., App.tsx or main.tsx)
// Modal.setAppElement('#root');

interface MessageListProps {
  roomId: string;
  room?: Room;
  onReply?: (message: Message) => void;
  roomPermissions?: RoomPermissions | null;
  bottomInsetPx?: number;
  onScrollButtonVisibilityChange?: (isVisible: boolean) => void;
  presentation?: 'chat' | 'code-agent';
  currentRoom?: Room;
  codeAgentMode?: CodeAgentMode;
}

export interface MessageListHandle {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  addOptimisticMessage: (message: Message) => void;
  replaceOptimisticMessage: (clientMessageId: string, savedMessage: Message) => void;
  markOptimisticMessageFailed: (clientMessageId: string, error?: string) => void;
}

export const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(({
  roomId,
  room,
  onReply = () => {},
  roomPermissions = null,
  bottomInsetPx = 16,
  onScrollButtonVisibilityChange,
  presentation = 'chat',
  currentRoom,
  codeAgentMode = 'plan',
}, ref) => {
  const { t } = useTranslation();
  // generate a stable ID for the scroll container
  const scrollContainerId = `message-list-scroll-${roomId}`;
  // Lazy initializers read the synchronous in-memory cache so the first paint
  // already shows the cached window (requires the `key={roomId}` remount in the
  // parent so these run per room).
  const [messages, setMessages] = useState<Message[]>(() => {
    const cached = readMemoryRoomMessageWindow(roomId);
    return cached ? sortMessages(cached.messages.filter(msg => msg.roomId === roomId)) : [];
  });
  const [isLoading, setIsLoading] = useState(() => !readMemoryRoomMessageWindow(roomId));
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(() => readMemoryRoomMessageWindow(roomId)?.hasMore ?? false);
  const [, setHistoryVersion] = useState(() => readMemoryRoomMessageWindow(roomId)?.historyVersion ?? 0);
  const [oldestMessageId, setOldestMessageId] = useState<string | undefined>(() => readMemoryRoomMessageWindow(roomId)?.oldestMessageId);
  // Always points at the latest messages so item handlers can stay reference-stable.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const retryScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNearBottomRef = useRef(true);
  const preserveScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const pendingScrollFrameRef = useRef<number | null>(null);
  const workspaceFetchAbortRef = useRef<AbortController | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  // State for modals
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [messageToDelete, setMessageToDelete] = useState<Message | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [messageToEdit, setMessageToEdit] = useState<Message | null>(null);
  const [sessionCostUsd, setSessionCostUsd] = useState<number | null>(null);
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<CodeAgentWorkspaceSnapshot | null>(null);
  const [isWorkspaceRefreshing, setIsWorkspaceRefreshing] = useState(false);
  const [workspaceRefreshError, setWorkspaceRefreshError] = useState<string | null>(null);
  const codeAgentRoom = currentRoom || (presentation === 'code-agent' ? room : undefined);
  const currentRoomId = codeAgentRoom?.id;

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

  const getCurrentMessages = useCallback(() => messagesRef.current, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = containerRef.current;
    if (container) {
      isNearBottomRef.current = true;
      setShowScrollButton(false);
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({
          top: container.scrollHeight,
          behavior,
        });
      } else {
        container.scrollTop = container.scrollHeight;
      }
      return;
    }

    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (typeof requestAnimationFrame !== 'function') {
      scrollToBottom(behavior);
      return;
    }

    if (pendingScrollFrameRef.current !== null) {
      cancelAnimationFrame(pendingScrollFrameRef.current);
    }

    pendingScrollFrameRef.current = requestAnimationFrame(() => {
      pendingScrollFrameRef.current = null;
      scrollToBottom(behavior);
    });
  }, [scrollToBottom]);

  useImperativeHandle(ref, () => ({
    scrollToBottom,
    addOptimisticMessage: (message: Message) => {
      updateMessages(prev => addOptimisticMessage(prev, message));
      scheduleScrollToBottom('auto');
    },
    replaceOptimisticMessage: (clientMessageId: string, savedMessage: Message) => {
      updateMessages(prev => replaceOptimisticMessage(prev, clientMessageId, savedMessage));
    },
    markOptimisticMessageFailed: (clientMessageId: string, error?: string) => {
      updateMessages(prev => markOptimisticMessageFailed(prev, clientMessageId, error));
    },
  }), [scheduleScrollToBottom, scrollToBottom, updateMessages]);

  const handleLoadMore = useCallback(() => {
    if (isLoadingMore || !hasMoreMessages || messages.length === 0) {
      return;
    }

    const container = containerRef.current;
    if (container) {
      preserveScrollRef.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }

    setIsLoadingMore(true);
    socket.emit('get_room_messages', {
      roomId,
      beforeMessageId: oldestMessageId || messages[0].id,
      limit: LOAD_MORE_MESSAGE_COUNT,
    });
  }, [hasMoreMessages, isLoadingMore, messages, oldestMessageId, roomId]);

  useEffect(() => {
    onScrollButtonVisibilityChange?.(showScrollButton);
  }, [showScrollButton, onScrollButtonVisibilityChange]);

  useEffect(() => {
    return () => {
      if (retryScrollTimerRef.current) {
        clearTimeout(retryScrollTimerRef.current);
      }
      if (pendingScrollFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(pendingScrollFrameRef.current);
      }
      workspaceFetchAbortRef.current?.abort();
    };
  }, []);

  const refreshWorkspaceSnapshot = useCallback(async () => {
    if (presentation !== 'code-agent' || !currentRoomId) {
      return;
    }

    workspaceFetchAbortRef.current?.abort();
    const controller = new AbortController();
    workspaceFetchAbortRef.current = controller;
    setIsWorkspaceRefreshing(true);
    setWorkspaceRefreshError(null);

    try {
      const snapshot = await fetchCodeAgentWorkspaceSnapshot(clientId, currentRoomId, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setWorkspaceSnapshot(snapshot);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('Failed to refresh code-agent workspace snapshot:', error);
        setWorkspaceRefreshError(error instanceof Error ? error.message : 'Failed to load workspace snapshot');
      }
    } finally {
      if (workspaceFetchAbortRef.current === controller) {
        workspaceFetchAbortRef.current = null;
        setIsWorkspaceRefreshing(false);
      }
    }
  }, [currentRoomId, presentation]);

  useEffect(() => {
    if (presentation !== 'code-agent' || !currentRoomId) {
      setWorkspaceSnapshot(null);
      setWorkspaceRefreshError(null);
      return;
    }

    void refreshWorkspaceSnapshot();

    return () => {
      workspaceFetchAbortRef.current?.abort();
    };
  }, [currentRoomId, presentation, refreshWorkspaceSnapshot]);

  // Warm the lazily-loaded markdown chunk on mount so the first message renders
  // as markdown immediately instead of flashing plain text. The component
  // remounts per room (key={roomId}), so per-room state already resets via the
  // lazy useState initializers above — no manual roomId reset needed here.
  useEffect(() => {
    preloadMarkdownContent();
  }, []);

  React.useLayoutEffect(() => {
    const preserveScroll = preserveScrollRef.current;
    const container = containerRef.current;
    if (!preserveScroll || !container) return;

    preserveScrollRef.current = null;
    container.scrollTop = preserveScroll.scrollTop + (container.scrollHeight - preserveScroll.scrollHeight);
  }, [messages.length]);

  React.useLayoutEffect(() => {
    if (isNearBottomRef.current) {
      scheduleScrollToBottom('auto');
    }
  }, [bottomInsetPx, scheduleScrollToBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const stickToBottomIfNeeded = () => {
      if (preserveScrollRef.current) {
        return;
      }
      if (isNearBottomRef.current) {
        scheduleScrollToBottom('auto');
      }
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(stickToBottomIfNeeded);
      observer.observe(contentRef.current || container);
    }

    container.addEventListener('load', stickToBottomIfNeeded, true);

    return () => {
      observer?.disconnect();
      container.removeEventListener('load', stickToBottomIfNeeded, true);
    };
  }, [scheduleScrollToBottom]);

  // --- Modal Handlers (Keep dependencies as they are or simplify if possible) ---
  const handleOpenDeleteModal = useCallback((messageId: string) => {
    const msg = getMessageById(messagesRef.current, messageId);
    if (msg) {
      setMessageToDelete(msg);
      setIsDeleteModalOpen(true);
    }
   }, []);
  const handleCloseDeleteModal = useCallback(() => {
      setIsDeleteModalOpen(false);
    setMessageToDelete(null);
   }, []);
  const handleOpenEditModal = useCallback((messageId: string) => {
      const msg = getMessageById(messagesRef.current, messageId);
    if (msg) {
      setMessageToEdit(msg);
      setIsEditModalOpen(true);
    }
  }, []);
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
      ...getRoomAIRequestSettings(roomId),
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
        socket.emit('get_room_messages', { roomId });
         // Use translation key for alert
        alert(t('errorDeletingMessage', { error: response.error || t('unknownError') }));
      }
    });
  }, [roomId, messageToDelete, handleCloseDeleteModal, updateMessages, t]);

  // 添加刷新AI的处理函数
  const handleRefreshAI = useCallback((messageId: string) => {
    console.log('Retrying AI response for message ID:', messageId);

    // 找到消息的索引位置
    const retryResult = truncateBeforeMessage(messagesRef.current, messageId);
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
      ...getRoomAIRequestSettings(roomId),
    }).catch((error) => {
      console.error('Failed to retry AI response:', error);
      socket.emit('get_room_messages', { roomId });
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
  }, [roomId, updateMessages, scrollToBottom]);

  useRoomMessageEvents({
    roomId,
    containerRef,
    getCurrentMessages,
    updateMessages,
    setIsLoading,
    setIsLoadingMore,
    setHasMoreMessages,
    setHistoryVersion,
    setOldestMessageId,
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
      isNearBottomRef.current = isAtBottom;
      setShowScrollButton(!isAtBottom && messages.length > 0);
    }
  };

  const [isExporting, setIsExporting] = useState(false);

  // Fall back to roomId when tests or older call sites do not provide room metadata.
  const loadMessagesForExport = useCallback(async () => {
    setIsExporting(true);
    try {
      return sortMessages(await getRoomMessagesForExport(roomId));
    } finally {
      setIsExporting(false);
    }
  }, [roomId]);

  const resolveExportMediaUrl = useCallback<ExportMediaResolver>(async (message) => {
    if (!message.mediaAsset?.id) {
      return null;
    }
    const { url } = await getMediaDownloadUrl({ roomId: message.roomId, assetId: message.mediaAsset.id });
    return url;
  }, []);

  const handleExportHtml = useCallback(async () => {
    try {
      await downloadTranscriptHtml(room || { id: roomId, name: roomId }, await loadMessagesForExport(), resolveExportMediaUrl);
    } catch (error) {
      console.error('Failed to export HTML transcript:', error);
      alert(t('exportFailed'));
    }
  }, [loadMessagesForExport, resolveExportMediaUrl, room, roomId, t]);

  const handleExportZip = useCallback(async () => {
    try {
      await downloadTranscriptZip(room || { id: roomId, name: roomId }, await loadMessagesForExport(), resolveExportMediaUrl);
    } catch (error) {
      console.error('Failed to export ZIP transcript:', error);
      alert(t('exportFailed'));
    }
  }, [loadMessagesForExport, resolveExportMediaUrl, room, roomId, t]);

  // ... loading/empty states ...
  // ... return statement with JSX ...

  return (
    <>
      {presentation !== 'code-agent' && (
      <div className="absolute right-3 top-3 z-20">
        <div className="flex items-center gap-1.5">
          <Dropdown placement="bottom-end">
            <DropdownTrigger>
              <Button
                size="sm"
                variant="flat"
                radius="full"
                isDisabled={isExporting}
                className="h-7 min-w-0 border border-[#dedbd0] bg-[#faf9f5]/95 px-2 text-tiny font-medium text-[#4d4c48] shadow-sm backdrop-blur dark:border-[#30302e] dark:bg-[#1d1d1b]/95 dark:text-[#e8e6dc]"
                startContent={<Icon icon={isExporting ? 'lucide:loader-circle' : 'lucide:download'} className={`h-3.5 w-3.5 ${isExporting ? 'animate-spin' : ''}`} />}
              >
                {t('exportChat')}
              </Button>
            </DropdownTrigger>
            <DropdownMenu aria-label={t('exportChat')}>
              <DropdownItem key="html" startContent={<Icon icon="lucide:file-code-2" />} onPress={handleExportHtml}>
                {t('exportHtml')}
              </DropdownItem>
              <DropdownItem key="zip" startContent={<Icon icon="lucide:archive" />} onPress={handleExportZip}>
                {t('exportZip')}
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
          <div className="flex items-center gap-1 rounded-full border border-[#dedbd0] bg-[#faf9f5]/95 px-2.5 py-1 text-tiny font-medium text-[#4d4c48] shadow-sm backdrop-blur dark:border-[#30302e] dark:bg-[#1d1d1b]/95 dark:text-[#e8e6dc]">
            <Icon icon="lucide:coins" className="h-3.5 w-3.5" />
            <span>{t('sessionCost')}: {sessionCostUsd === null ? '...' : formatUsdCost(sessionCostUsd)}</span>
          </div>
        </div>
      </div>
      )}
      <div
        id={scrollContainerId}
        data-testid="message-list-scroll"
        ref={containerRef}
        className="relative flex h-full w-full flex-col overflow-y-auto bg-[#f5f4ed] px-3 pt-3 dark:bg-[#141413]"
        onScroll={handleScroll}
      >
        <div ref={contentRef} data-testid="message-list-content" className="flex min-h-full flex-col">
          {presentation === 'code-agent' && codeAgentRoom && (
            <CodeAgentWorkspacePanel
              room={codeAgentRoom}
              messages={messages}
              mode={codeAgentMode}
              sessionCostUsd={sessionCostUsd ?? 0}
              workspaceSnapshot={workspaceSnapshot}
              isRefreshingWorkspace={isWorkspaceRefreshing}
              workspaceRefreshError={workspaceRefreshError}
              onRefreshWorkspace={refreshWorkspaceSnapshot}
            />
          )}
          {hasMoreMessages && (
            <div className="mb-3 flex justify-center">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="rounded-full border border-[#dedbd0] bg-[#faf9f5]/95 px-3 py-1.5 text-xs font-medium text-[#4d4c48] shadow-sm backdrop-blur transition hover:border-[#c2c0b6] hover:text-[#141413] dark:border-[#30302e] dark:bg-[#1d1d1b]/95 dark:text-[#e8e6dc] dark:hover:text-[#faf9f5]"
              >
                {isLoadingMore ? t('loadingMore') : t('loadMoreMessages', { count: LOAD_MORE_MESSAGE_COUNT })}
              </button>
            </div>
          )}
          {isLoading && messages.length === 0 && (
            <div className="flex min-h-[220px] flex-1 items-center justify-center">
              <Icon icon="lucide:loader-circle" className="h-6 w-6 animate-spin text-[#c96442] dark:text-[#d97757]" />
            </div>
          )}
          {!isLoading && messages.length === 0 && (
            <div className="flex min-h-[220px] flex-1 flex-col items-center justify-center text-center">
              <Icon icon="lucide:message-circle" className="mb-3 h-8 w-8 text-[#87867f] dark:text-[#8f8d86]" />
              <p className="font-serif text-lg font-medium text-[#141413] dark:text-[#faf9f5]">{t('noMessages')}</p>
              <p className="mt-1 text-sm text-[#5e5d59] dark:text-[#b0aea5]">{t('beFirstToMessage')}</p>
            </div>
          )}
          {!isLoading && messages.length > 0 && (
            <div className="flex flex-col space-y-2">
              {messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  roomPermissions={roomPermissions}
                  onStartEdit={handleOpenEditModal}
                  onDeleteMessage={handleOpenDeleteModal}
                  onRefreshAI={handleRefreshAI}
                  onReply={onReply}
                />
              ))}
            </div>
          )}
          <div
            aria-hidden="true"
            data-testid="message-list-scroll-end-inset"
            className="flex-shrink-0"
            style={{ height: bottomInsetPx }}
          />
          <div ref={messagesEndRef} />
        </div>
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
