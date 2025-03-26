import React from 'react';
import { Avatar, Card } from '@heroui/react';
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

  return (
    <div 
      className={`group flex ${isMine ? 'justify-end' : 'justify-start'} mb-2`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {!isMine && (
        <Avatar 
          icon={<Icon icon="lucide:user" />}
          classNames={{
            base: "mr-2",
          }}
        />
      )}
      
      <div className="max-w-[75%] sm:max-w-[60%] md:max-w-[50%]">
        <Card
          className={`${isMine ? 'bg-primary-500 text-white' : 'bg-content2'} rounded-lg shadow-sm`}
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
          icon={<Icon icon="lucide:user" />}
          classNames={{
            base: "ml-2",
          }}
          color="primary"
        />
      )}
    </div>
  );
};