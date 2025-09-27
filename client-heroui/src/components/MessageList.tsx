import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { socket } from '../utils/socket';
import { MessageItem } from './MessageItem';
import { Message, AIChunkEvent, AIStreamEndEvent, AIStreamErrorEvent } from '../utils/types';
import { useTranslation } from 'react-i18next';

// Import your new modals
import { DeleteConfirmationModal } from './DeleteConfirmationModal';
import { EditMessageModal } from './EditMessageModal';

// Reminder: Set the app element for react-modal for accessibility
// Ideally in your root component file (e.g., App.tsx or main.tsx)
// Modal.setAppElement('#root'); 

interface MessageListProps {
  roomId: string;
}

export const MessageList: React.FC<MessageListProps> = ({ roomId }) => {
  const { t } = useTranslation();
  // generate a stable ID for the scroll container
  const scrollContainerId = `message-list-scroll-${roomId}`;
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const eventBound = useRef<boolean>(false);
  // State for modals
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [messageToDelete, setMessageToDelete] = useState<Message | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [messageToEdit, setMessageToEdit] = useState<Message | null>(null);

  const sortMessages = useCallback((msgs: Message[]) => {
    return [...msgs].sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();

      const safeTimeA = Number.isFinite(timeA) ? timeA : 0;
      const safeTimeB = Number.isFinite(timeB) ? timeB : 0;

      if (safeTimeA !== safeTimeB) {
        return safeTimeA - safeTimeB;
      }

      const aIsStreamingAi = a.clientId === 'ai_assistant' && a.status === 'streaming';
      const bIsStreamingAi = b.clientId === 'ai_assistant' && b.status === 'streaming';

      if (aIsStreamingAi !== bIsStreamingAi) {
        return aIsStreamingAi ? 1 : -1;
      }

      return a.id.localeCompare(b.id);
    });
  }, []);

  const updateMessages = useCallback((updater: React.SetStateAction<Message[]>) => {
    setMessages(prev => {
      const next =
        typeof updater === 'function'
          ? (updater as (prevState: Message[]) => Message[])(prev)
          : updater;

      if (next === prev) {
        return prev;
      }

      return sortMessages(next);
    });
  }, [sortMessages]);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  // --- Modal Handlers (Keep dependencies as they are or simplify if possible) ---
  const handleOpenDeleteModal = useCallback((messageId: string) => { 
    const msg = messages.find(m => m.id === messageId);
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
      const msg = messages.find(m => m.id === messageId);
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
    updateMessages(prev =>
      prev.map(msg =>
        msg.id === messageId ? { ...msg, content: newContent } : msg
      )
    );
    // No need to close modal here, EditMessageModal handles it

    socket.emit('edit_message', { roomId, messageId, newContent }, (response: { success: boolean; updatedMessage?: Message; error?: string }) => {
      if (response.success && response.updatedMessage) {
        console.log('Edit successful on server.');
        updateMessages(prev =>
          prev.map(msg =>
            msg.id === messageId ? response.updatedMessage! : msg
          )
        );
      } else {
        console.error('Failed to save edit on server:', response.error);
        updateMessages(originalMessages);
        // Use translation key for alert
        alert(t('errorEditingMessage', { error: response.error || 'Unknown error' })); 
      }
    });
  }, [roomId, messages, t]);

  const handleSaveEditAndAskAI = useCallback((messageId: string, newContent: string) => {
    console.log('Saving edit and triggering AI (from modal):', messageId, newContent);
    const originalMessages = messages; 
    let editIndex = -1;

    // 1. Optimistic Update & Truncation
    updateMessages(prev => {
        editIndex = prev.findIndex(msg => msg.id === messageId);
        if (editIndex === -1) return prev; // Should not happen
        
        // Create updated message
        const updatedMsg = { ...prev[editIndex], content: newContent };

        // Return truncated history including the updated message
        return [...prev.slice(0, editIndex), updatedMsg]; 
    });
    // No need to close modal here, EditMessageModal handles it

    // Check if index was found before proceeding
    if (editIndex === -1) {
        console.error("Edited message ID not found in state during optimistic update.");
        updateMessages(originalMessages); // Revert
        return;
    }

    // 2. Emit edit_message to server
    socket.emit('edit_message', { roomId, messageId, newContent }, (response: { success: boolean; updatedMessage?: Message; error?: string }) => {
      if (response.success && response.updatedMessage) {
        console.log('Edit successful on server, triggering AI');
         
         // Optionally update the timestamp of the edited message in the already truncated state
        updateMessages(prev =>
          prev.map(msg => (msg.id === messageId ? response.updatedMessage! : msg))
        );

         // 3. NOW trigger AI, but without the prompt
        socket.emit('ask_ai', { 
          roomId, 
          editedMessageId: messageId // Server uses this to determine context
        });
       
      } else {
        console.error('Failed to save edit before asking AI:', response.error);
        // Revert optimistic update (both content and truncation)
        updateMessages(originalMessages);
         // Use translation key for alert
        alert(t('errorEditingMessage', { error: response.error || 'Unknown error' }));
      }
    });
  }, [roomId, messages, t]);

  // Define handleConfirmDelete within useCallback, accessing messageToDelete state
  const handleConfirmDelete = useCallback(() => {
    if (!messageToDelete) return;

    const messageIdToDelete = messageToDelete.id;
    console.log('Confirmed deleting message:', messageIdToDelete);
    
    // 1. Close modal & Optimistically remove from UI
    handleCloseDeleteModal(); // Close modal first
    updateMessages(prev => prev.filter(msg => msg.id !== messageIdToDelete));

    // 2. Emit event to server
    socket.emit('delete_message', { roomId, messageId: messageIdToDelete }, (response: { success: boolean; error?: string }) => {
      if (!response.success) {
        console.error('Failed to delete message on server:', response.error);
        // Refetch history on error to ensure consistency
        socket.emit('get_room_messages', roomId); 
         // Use translation key for alert
        alert(t('errorDeletingMessage', { error: response.error || 'Unknown error' })); 
      }
    });
  }, [roomId, messageToDelete, handleCloseDeleteModal, t]);

  // 添加刷新AI的处理函数
  const handleRefreshAI = useCallback((messageId: string) => {
    console.log('Retrying AI response for message ID:', messageId);

    // 找到消息的索引位置
    const msgIndex = messages.findIndex(msg => msg.id === messageId);
    if (msgIndex === -1) {
      console.error("Cannot retry AI response: Message ID not found in current list.");
      return;
    }

    // 截断本地消息列表到当前AI消息之前
    // This effectively removes the target AI message and all subsequent messages from the UI optimistically
    const truncatedMessages = messages.slice(0, msgIndex);
    updateMessages(truncatedMessages);
    console.log('Truncated message list locally, count:', truncatedMessages.length);

    // 向服务器发送 ask_ai 事件，并带上 retryForMessageId 标识
    // 服务器将根据这个ID来截断 redis 中的历史记录
    socket.emit('ask_ai', {
      roomId,
      // prompt: '', // Prompt is now determined by the server based on truncated history
      retryForMessageId: messageId // 新增：告知服务器这是针对哪条消息的重试
      // TODO: Consider sending current role/system prompt if needed
    });
    console.log('Emitted ask_ai for retry with retryForMessageId:', messageId);

    // 自动滚动到底部
    setTimeout(() => scrollToBottom('smooth'), 100);
  }, [roomId, messages, scrollToBottom]);

  // --- Event Listeners Setup ---
  // OPTIMIZE: Remove dependencies related to modal content/state from here.
  // The listeners themselves can access the latest state via closure or refs if needed,
  // but the setup itself only depends on the roomId changing.
  const setupMessageEvents = useCallback(() => {
    if (eventBound.current) return;
    console.log('Setting up message event listeners for room:', roomId);

    // Clear potential old listeners
    socket.off('message_history');
    socket.off('new_message');
    socket.off('ai_chunk');
    socket.off('ai_stream_end');
    socket.off('ai_stream_error');
    socket.off('messages_cleared');
    socket.off('message_edited'); 
    socket.off('message_deleted'); 

    // Listen for message history
    socket.on('message_history', (messageHistory: Message[]) => {
      console.log('Received message history, count:', messageHistory.length);
      // Filter immediately based on the CURRENT roomId from props/closure
      const roomMessages = messageHistory.filter(message => message.roomId === roomId);
      updateMessages(roomMessages);
      setIsLoading(false);
      setTimeout(() => scrollToBottom('auto'), 100);
    });

    // Listen for new messages
    socket.on('new_message', (message: Message) => {
      console.log('Received new message:', message.id);
       // Filter immediately based on the CURRENT roomId from props/closure
      if (message.roomId === roomId) {
        // No need to close modals here, happens via other listeners if needed
        updateMessages(prev => {
          if (prev.some(m => m.id === message.id)) return prev;
          return [...prev, message];
        });
        
        // Scroll logic based on current scroll position
        const container = containerRef.current;
        if (container) {
          const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
          if (isAtBottom || message.clientId === socket.id || message.clientId === 'ai_assistant') {
            setTimeout(() => scrollToBottom('smooth'), 100);
          } else {
            setShowScrollButton(true);
          }
        }
      }
    });

    // Listen for AI chunks
    socket.on('ai_chunk', (data: AIChunkEvent) => {
      if (data.roomId !== roomId) return; 
      console.log('Received AI chunk for message:', data.messageId);
      updateMessages(prev =>
        prev.map(msg =>
          msg.id === data.messageId
            ? { ...msg, content: (msg.content || '') + data.chunk, status: 'streaming' } // Ensure content is string
            : msg
        )
       ); 
      // Scroll logic based on current scroll position
      const container = containerRef.current;
      if (container) {
          const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
          if (isAtBottom) {
            setTimeout(() => scrollToBottom('smooth'), 50);
          }
      }
    });

    // Listen for AI stream end
    socket.on('ai_stream_end', (data: AIStreamEndEvent) => {
      if (data.roomId !== roomId) return;
      console.log('AI stream ended for message:', data.messageId);
      updateMessages(prev =>
        prev.map(msg => (msg.id === data.messageId ? { ...msg, status: 'complete' } : msg))
      );
    });
    
    // Listen for AI stream error
    socket.on('ai_stream_error', (data: AIStreamErrorEvent) => {
       if (data.roomId !== roomId) return;
      console.error('AI stream error for message:', data.messageId, data.error);
      updateMessages(prev =>
        prev.map(msg =>
          msg.id === data.messageId
            ? { ...msg, content: (msg.content || '') + '\n\n⚠️ ' + data.error, status: 'error' }
            : msg
        )
      );
    });

    // Handle server broadcast message clear event
    socket.on('messages_cleared', (clearedRoomId: string) => {
      console.log('[Server Broadcast] messages_cleared for room:', clearedRoomId);
      if (clearedRoomId === roomId) {
        console.log('[Local] Clearing messages for room:', roomId);
        updateMessages([]);
        setShowScrollButton(false);
        // Close modals if open when history clears
        handleCloseEditModal();
        handleCloseDeleteModal();
      }
    });
    
    // Handle message edited event
    socket.on('message_edited', (updatedMessage: Message) => {
      if (updatedMessage.roomId === roomId) {
        console.log('Received message_edited event:', updatedMessage.id);
        updateMessages(prev =>
          prev.map(msg => (msg.id === updatedMessage.id ? updatedMessage : msg))
        );
        // Check if the message currently in the edit modal was the one updated
        // Access state directly here, or potentially use a ref if needed
        if (messageToEdit?.id === updatedMessage.id) { 
            handleCloseEditModal(); // Close stale edit modal
        }
      }
    });

    // Handle message deleted event
    socket.on('message_deleted', (deletedMessageId: string, deletedRoomId: string) => {
       if (deletedRoomId === roomId) {
        console.log('Received message_deleted event:', deletedMessageId);
        updateMessages(prev => prev.filter(msg => msg.id !== deletedMessageId));
        // Check and close modals if the relevant message was deleted
        if (messageToDelete?.id === deletedMessageId) {
             handleCloseDeleteModal();
        }
         if (messageToEdit?.id === deletedMessageId) {
             handleCloseEditModal();
        }
       }
    });

    eventBound.current = true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, handleCloseDeleteModal, handleCloseEditModal]); // Keep modal closers, roomId is essential

  // OPTIMIZE: useEffect dependencies only need roomId and the setup function
  useEffect(() => {
    updateMessages([]);
    updateMessages([]);
    setIsLoading(true);
    handleCloseDeleteModal();
    handleCloseEditModal();
    eventBound.current = false;

    setupMessageEvents(); // Call the memoized setup function

    socket.emit('get_room_messages', roomId);

    const loadingTimeout = setTimeout(() => {
      if (messages.length === 0 && isLoading) { 
        setIsLoading(false);
      }
    }, 5000);

    return () => {
      // Listeners are cleaned up inside setupMessageEvents via socket.off
      clearTimeout(loadingTimeout);
      eventBound.current = false; // Reset bound flag
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, setupMessageEvents]); // Only depend on roomId and setupMessageEvents

   useEffect(() => {
    const handleConnect = () => {
      console.log('Socket connected, setting up message events again');
      // Reset bound flag to allow setup to run
      eventBound.current = false; 
      setupMessageEvents(); 
      socket.emit('get_room_messages', roomId);
    };
    socket.on('connect', handleConnect);
    return () => {
      socket.off('connect', handleConnect);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, setupMessageEvents]); // Only depend on roomId and setupMessageEvents

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
        ref={containerRef}
        className="flex flex-col p-3 w-full relative h-full overflow-y-auto" 
        onScroll={handleScroll}
      >
        {/* ... Loading/Empty/List rendering ... */}
         {!isLoading && messages.length > 0 && (
            <div className="flex flex-col space-y-1.5 pb-10"> 
                {messages
                .map((message) => (
                    <MessageItem 
                    key={message.id} 
                    message={message} 
                    onStartEdit={handleOpenEditModal} 
                    onDeleteMessage={handleOpenDeleteModal} 
                    onRefreshAI={handleRefreshAI}
                    />
                ))}
            </div>
        )}
        <div ref={messagesEndRef} />
        {/* Scroll Button */}
        {showScrollButton && ( 
             <Button
                isIconOnly
                color="primary"
                variant="solid"
                size="sm"
                radius="full"
                className="absolute bottom-4 left-1/2 transform -translate-x-1/2 shadow-lg z-10"
                aria-label={t('scrollToBottom')}
                onPress={() => scrollToBottom('smooth')}
                >
                <Icon icon="lucide:arrow-down" className="w-4 h-4" />
            </Button>
         )}
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
};