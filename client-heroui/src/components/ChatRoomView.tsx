import React from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { ChatHeader } from './ChatHeader';
import { MessageInput } from './MessageInput';
import { MessageList, MessageListHandle } from './MessageList';
import { AppView } from '../utils/appPersistence';
import { getAvatarColor, getAvatarText } from '../utils/userProfile';
import { Message, Room, RoomRenameHandler } from '../utils/types';

interface ChatRoomViewProps {
  currentRoom: Room;
  memberCount: number;
  memberEvent: { type: 'join' | 'leave'; userId: string } | null;
  username: string;
  clientId: string;
  handleCopyToClipboard: (text: string) => void;
  handleShareRoom: () => void;
  handleToggleSave: () => void;
  handleLeaveRoom: () => void;
  isRoomSaved: (roomId: string) => boolean;
  setView: (view: AppView) => void;
  clearRoomUrlParam: () => void;
  handleClearChatMessages: () => void;
  handleDeleteRoom: (roomId: string) => void;
  handleRenameRoom: RoomRenameHandler;
}

export const ChatRoomView: React.FC<ChatRoomViewProps> = ({
  currentRoom,
  memberCount,
  memberEvent,
  username,
  clientId,
  handleCopyToClipboard,
  handleShareRoom,
  handleToggleSave,
  handleLeaveRoom,
  isRoomSaved,
  setView,
  clearRoomUrlParam,
  handleClearChatMessages,
  handleDeleteRoom,
  handleRenameRoom,
}) => {
  const { t } = useTranslation();
  const [replyToMessage, setReplyToMessage] = React.useState<Message | null>(null);
  const chatBodyRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLDivElement>(null);
  const messageListRef = React.useRef<MessageListHandle>(null);
  const [showScrollButton, setShowScrollButton] = React.useState(false);

  React.useEffect(() => {
    setReplyToMessage(null);
    setShowScrollButton(false);
  }, [currentRoom.id]);

  React.useLayoutEffect(() => {
    const el = composerRef.current;
    const body = chatBodyRef.current;
    if (!el) return;

    const update = () => {
      body?.style.setProperty('--rt-composer-height', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    };

    update();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col bg-[#f5f4ed] dark:bg-[#141413]">
      <ChatHeader
        currentRoom={currentRoom}
        memberCount={memberCount}
        memberEvent={memberEvent}
        handleCopyToClipboard={handleCopyToClipboard}
        handleShareRoom={handleShareRoom}
        handleToggleSave={handleToggleSave}
        handleLeaveRoom={handleLeaveRoom}
        isRoomSaved={isRoomSaved}
        setView={setView}
        clearRoomUrlParam={clearRoomUrlParam}
        handleClearChatMessages={handleClearChatMessages}
        handleDeleteRoom={handleDeleteRoom}
        handleRenameRoom={handleRenameRoom}
        clientId={clientId}
      />

      <div ref={chatBodyRef} className="relative min-h-0 w-full flex-1 overflow-hidden [--rt-composer-height:132px]">
        <MessageList
          ref={messageListRef}
          roomId={currentRoom.id}
          onReply={setReplyToMessage}
          onScrollButtonVisibilityChange={setShowScrollButton}
        />

        {showScrollButton && (
          <Button
            isIconOnly
            color="primary"
            variant="solid"
            size="sm"
            radius="full"
            className="absolute left-1/2 z-40 -translate-x-1/2 bg-[#30302e] text-[#faf9f5] shadow-[0_0_0_1px_rgba(194,192,182,0.7),0_10px_24px_rgba(20,20,19,0.16)] dark:bg-[#faf9f5] dark:text-[#141413]"
            style={{ bottom: 'calc(max(0px, calc(var(--app-keyboard-inset, 0px) - var(--rt-bottom-nav-height, 0px))) + var(--rt-composer-height, 132px) + 16px)' }}
            aria-label={t('scrollToBottom')}
            onPress={() => messageListRef.current?.scrollToBottom('smooth')}
          >
            <Icon icon="lucide:arrow-down" className="h-4 w-4" />
          </Button>
        )}

        <div
          ref={composerRef}
          data-testid="message-input-panel"
          className="absolute inset-x-0 z-30 border-t border-[#dedbd0] bg-[#faf9f5]/92 p-2 backdrop-blur-md dark:border-[#30302e] dark:bg-[#1d1d1b]/92 md:p-3"
          style={{ bottom: 'max(0px, calc(var(--app-keyboard-inset, 0px) - var(--rt-bottom-nav-height, 0px)))' }}
        >
          <MessageInput
            roomId={currentRoom.id}
            clientId={clientId}
            username={username}
            avatarText={getAvatarText(username)}
            avatarColor={getAvatarColor(username)}
            replyToMessage={replyToMessage}
            onCancelReply={() => setReplyToMessage(null)}
            onOptimisticMessage={(message) => messageListRef.current?.addOptimisticMessage(message)}
            onOptimisticMessageSaved={(clientMessageId, message) =>
              messageListRef.current?.replaceOptimisticMessage(clientMessageId, message)
            }
            onOptimisticMessageFailed={(clientMessageId, error) =>
              messageListRef.current?.markOptimisticMessageFailed(clientMessageId, error)
            }
          />
        </div>
      </div>
    </div>
  );
};
