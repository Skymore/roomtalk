import React, { useEffect, useState, useRef } from 'react';
import { Spinner, Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { socket } from '../utils/socket';
import { MessageItem } from './MessageItem';
import { Message, AIChunkEvent, AIStreamEndEvent, AIStreamErrorEvent } from '../utils/types';
import { useTranslation } from 'react-i18next';

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

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  // 注册消息事件监听
  const setupMessageEvents = () => {
    if (eventBound.current) return;
    
    console.log('Setting up message event listeners for room:', roomId);
    
    // 先清除可能存在的旧监听器
    socket.off('message_history');
    socket.off('new_message');
    socket.off('ai_chunk');
    socket.off('ai_stream_end');
    socket.off('ai_stream_error');
    
    // 监听消息历史
    socket.on('message_history', (messageHistory: Message[]) => {
      console.log('Received message history, count:', messageHistory.length);
      // 过滤当前房间的消息
      const roomMessages = messageHistory.filter(message => message.roomId === roomId);
      setMessages(roomMessages);
      setIsLoading(false);
      setTimeout(() => scrollToBottom('auto'), 100);
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
          const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
          if (isAtBottom || message.clientId === socket.id || message.clientId === 'ai_assistant') {
            setTimeout(() => scrollToBottom('smooth'), 100);
          } else {
            setShowScrollButton(true);
          }
        }
      }
    });

    // 监听 AI 数据块
    socket.on('ai_chunk', (data: AIChunkEvent) => {
      console.log('Received AI chunk for message:', data.messageId);
      setMessages(prev =>
        prev.map(msg =>
          msg.id === data.messageId
            ? { ...msg, content: msg.content + data.chunk, status: 'streaming' }
            : msg
        )
      );
      
      // 流式传输时保持滚动到底部 (如果用户已经在底部)
      const container = containerRef.current;
      if (container) {
        const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
        if (isAtBottom) {
          setTimeout(() => scrollToBottom('smooth'), 50);
        }
      }
    });

    // 监听 AI 流结束
    socket.on('ai_stream_end', (data: AIStreamEndEvent) => {
      console.log('AI stream ended for message:', data.messageId);
      setMessages(prev =>
        prev.map(msg =>
          msg.id === data.messageId ? { ...msg, status: 'complete' } : msg
        )
      );
    });
    
    // 监听 AI 流错误
    socket.on('ai_stream_error', (data: AIStreamErrorEvent) => {
      console.error('AI stream error for message:', data.messageId, data.error);
      setMessages(prev =>
        prev.map(msg =>
          msg.id === data.messageId
            ? { ...msg, content: msg.content || '' + '\n\n⚠️ ' + data.error, status: 'error' }
            : msg
        )
      );
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
    }, 5000);

    return () => {
      // 清理事件监听器
      socket.off('message_history');
      socket.off('new_message');
      socket.off('ai_chunk');
      socket.off('ai_stream_end');
      socket.off('ai_stream_error');
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
      const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
      setShowScrollButton(!isAtBottom && messages.length > 0);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="text-primary w-10 h-10" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-default-500">
        <Icon icon="lucide:message-circle" className="w-10 h-10 mb-3" />
        <p className="text-center text-sm">
          {t('noMessages')}<br />
          <span className="text-xs text-default-400">{t('beFirstToMessage')}</span>
        </p>
      </div>
    );
  }

  return (
    <div 
      id={scrollContainerId}
      ref={containerRef}
      className="flex flex-col p-3 w-full"
      onScroll={handleScroll}
    >
      <div className="flex flex-col space-y-1.5">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
      </div>
      <div ref={messagesEndRef} />
      
      {showScrollButton && (
        <Button
          isIconOnly
          color="primary"
          variant="solid"
          size="sm"
          radius="full"
          className="absolute left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2 shadow-lg z-10"
          aria-label={t('scrollToBottom')}
          onPress={() => scrollToBottom('smooth')}
        >
          <Icon icon="lucide:arrow-down" className="w-4 h-4" />
        </Button>
      )}
    </div>
  );
};