import React, { useState } from 'react';
import { Button, Textarea } from '@heroui/react';
import { Icon } from '@iconify/react';
import { sendMessage } from '../utils/socket';
import { useTranslation } from 'react-i18next';

interface MessageInputProps {
  roomId: string;
}

export const MessageInput: React.FC<MessageInputProps> = ({ roomId }) => {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!message.trim()) return;
    
    setIsSending(true);
    try {
      sendMessage(message, roomId);
      setMessage('');
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-2">
      <div className="flex items-end gap-2">
        <Textarea
          placeholder={t('typeMessage')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1"
          minRows={1}
          maxRows={5}
          autoFocus
          disabled={isSending}
        />
        <Button
          type="submit"
          isIconOnly
          color="primary"
          aria-label={t('send')}
          isLoading={isSending}
          isDisabled={!message.trim() || isSending}
        >
          <Icon icon="lucide:send" />
        </Button>
      </div>
    </form>
  );
};