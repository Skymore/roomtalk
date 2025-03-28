import React, { useEffect, useState, useRef } from 'react';
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const eventBound = useRef<boolean>(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // 注册消息事件监听
  const setupMessageEvents = () => {
    if (eventBound.current) return;
    
    console.log('Setting up message event listeners for room:', roomId);
    
    // 先清除可能存在的旧监听器
    socket.off('message_history');
    socket.off('new_message');
    
    // 监听消息历史
    socket.on('message_history', (messageHistory: Message[]) => {
      console.log('Received message history, count:', messageHistory.length);
      // 过滤当前房间的消息
      const roomMessages = messageHistory.filter(message => message.roomId === roomId);
      setMessages(roomMessages);
      setIsLoading(false);
      setTimeout(scrollToBottom, 100);
    });

    // 监听新消息
    socket.on('new_message', (message: Message) => {
      console.log('Received new message:', message.id);
      if (message.roomId === roomId) {
        setMessages(prev => {
          // 避免重复消息
          if (prev.some(m => m.id === message.id)) {
            return prev;
          }
          return [...prev, message];
        });
        
        const container = containerRef.current;
        if (container) {
          const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
          if (isAtBottom) {
            setTimeout(scrollToBottom, 100);
          }
        }
      }
    });
    
    eventBound.current = true;
  };

  // 处理房间变更
  useEffect(() => {
    // 重置状态
    setMessages([]);
    setIsLoading(true);
    eventBound.current = false;

    // 设置消息事件监听器
    setupMessageEvents();

    // 请求房间消息历史
    socket.emit('get_room_messages', roomId);

    const loadingTimeout = setTimeout(() => {
      if (messages.length === 0) {
        setIsLoading(false);
      }
    }, 3000);

    return () => {
      // 清理事件监听器
      socket.off('message_history');
      socket.off('new_message');
      clearTimeout(loadingTimeout);
      eventBound.current = false;
    };
  }, [roomId]);

  // 监听socket连接状态
  useEffect(() => {
    const handleConnect = () => {
      console.log('Socket connected, setting up message events again');
      setupMessageEvents();
      socket.emit('get_room_messages', roomId);
    };

    socket.on('connect', handleConnect);

    return () => {
      socket.off('connect', handleConnect);
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