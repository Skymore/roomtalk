import React from 'react';
import { Avatar, Card, Image } from '@heroui/react';
import { Icon } from '@iconify/react';
import { clientId } from '../utils/socket';
import { formatTime } from '../utils/formatters';
import { Message } from '../utils/types';

interface MessageItemProps {
  message: Message;
}

export const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
  const isMine = message.clientId === clientId;
  const [isHovered, setIsHovered] = React.useState(false);
  const [imageError, setImageError] = React.useState(false);
  const isImage = message.messageType === 'image';

  // Handle image loading errors
  const handleImageError = () => {
    setImageError(true);
  };
  
  // 转换颜色为有效的Avatar颜色类型
  const getValidColor = (color: string | undefined): "primary" | "secondary" | "success" | "warning" | "danger" | "default" | undefined => {
    if (!color) return "default";
    if (["primary", "secondary", "success", "warning", "danger", "default"].includes(color)) {
      return color as "primary" | "secondary" | "success" | "warning" | "danger" | "default";
    }
    return "default";
  };

  return (
    <div 
      className={`group flex ${isMine ? 'justify-end' : 'justify-start'} mb-2`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {!isMine && (
        <Avatar 
          name={message.avatar?.text || undefined}
          icon={!message.avatar?.text ? <Icon icon="lucide:user" /> : undefined}
          color={getValidColor(message.avatar?.color)}
          classNames={{
            base: "mr-2",
          }}
        />
      )}
      
      <div className={`max-w-[75%] sm:max-w-[60%] md:max-w-[50%] ${isMine ? '' : ''}`}>
        {!isMine && message.username && (
          <div className="text-tiny text-default-500 mb-1 ml-1">
            {message.username}
          </div>
        )}
        
        {isImage ? (
          // 图片消息使用单独样式
          <div className="w-fit">
            {imageError ? (
              <div className="text-sm text-danger p-2 bg-default-100 rounded-md w-fit">
                <Icon icon="lucide:alert-triangle" className="inline mr-1" />
                Failed to load image
              </div>
            ) : (
              <div className="border border-default-200 rounded-md p-0.5 max-w-full overflow-hidden">
                <Image
                  src={message.content}
                  alt="Shared image"
                  className="max-h-[300px] max-w-full object-contain rounded"
                  onError={handleImageError}
                  isBlurred
                />
              </div>
            )}
          </div>
        ) : (
          // 文本消息使用气泡样式
          <Card
            className={`${isMine ? 'bg-primary-500 text-white' : 'bg-content2'} rounded-lg shadow-sm w-fit`}
          >
            <div className="p-3">
              <p className="text-sm whitespace-pre-wrap">
                {message.content.split(' ').map((word, i) => {
                  const urlPattern = /^(https?:\/\/[^\s]+)$/;
                  return urlPattern.test(word) ? (
                    <a 
                      key={i}
                      href={word}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`${isMine ? 'text-blue-100 underline' : 'text-primary'} hover:opacity-80`}
                    >
                      {word}
                    </a>
                  ) : (
                    <React.Fragment key={i}>
                      {i > 0 ? ' ' : ''}{word}
                    </React.Fragment>
                  );
                })}
              </p>
            </div>
          </Card>
        )}
        
        <div 
          className={`text-tiny mt-1 text-default-400 transition-opacity ${
            isHovered ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-70'
          }`}
        >
          {formatTime(message.timestamp)}
        </div>
      </div>

      {isMine && (
        <Avatar 
          name={message.avatar?.text || undefined}
          icon={!message.avatar?.text ? <Icon icon="lucide:user" /> : undefined}
          color={getValidColor(message.avatar?.color) || "primary"}
          classNames={{
            base: "ml-2",
          }}
        />
      )}
    </div>
  );
};