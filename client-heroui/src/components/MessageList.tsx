import React from 'react';
import { Spinner, Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { socket } from '../utils/socket';
import { MessageItem } from './MessageItem';
import { Message } from '../utils/types';
import { useTranslation } from 'react-i18next';

interface MessageListProps {
  roomId: string;
}

export const MessageList: React.FC<MessageListProps> = ({ roomId }) => {
  const { t } = useTranslation();
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = React.useState(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  React.useEffect(() => {
    // Reset state when room changes
    setMessages([]);
    setIsLoading(true);

    // Listen for message history for this room
    socket.on('message_history', (messageHistory: Message[]) => {
      // Filter messages for this room
      const roomMessages = messageHistory.filter(message => message.roomId === roomId);
      setMessages(roomMessages);
      setIsLoading(false);
      setTimeout(scrollToBottom, 100);
    });

    // Listen for new messages for this room
    socket.on('new_message', (message: Message) => {
      if (message.roomId === roomId) {
        setMessages(prev => [...prev, message]);
        const container = containerRef.current;
        if (container) {
          const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
          if (isAtBottom) {
            setTimeout(scrollToBottom, 100);
          }
        }
      }
    });

    // Request message history for this room
    socket.emit('get_room_messages', roomId);

    const loadingTimeout = setTimeout(() => {
      if (messages.length === 0) {
        setIsLoading(false);
      }
    }, 3000);

    return () => {
      socket.off('message_history');
      socket.off('new_message');
      clearTimeout(loadingTimeout);
    };
  }, [roomId]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (container) {
      const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
      setShowScrollButton(!isAtBottom && messages.length > 0);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="text-primary w-8 h-8" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-default-500">
        <Icon icon="lucide:message-circle" className="w-12 h-12 mb-4" />
        <p className="text-center">
          {t('noMessages')}<br />
          <span className="text-sm text-default-400">{t('beFirstToMessage')}</span>
        </p>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className="flex flex-col p-4 h-full overflow-y-auto"
      onScroll={handleScroll}
    >
      <div className="flex flex-col space-y-4">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
      </div>
      <div ref={messagesEndRef} />
      
      {showScrollButton && (
        <Button
          color="primary"
          variant="solid"
          size="sm"
          radius="full"
          className="fixed bottom-24 left-1/2 transform -translate-x-1/2 shadow-lg"
          startContent={<Icon icon="lucide:arrow-down" />}
          onPress={scrollToBottom}
        >
          {t('newMessages')}
        </Button>
      )}
    </div>
  );
};