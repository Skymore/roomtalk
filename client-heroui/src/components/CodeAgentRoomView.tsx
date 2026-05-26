import React from 'react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { ChatHeader } from './ChatHeader';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';
import { AppView } from '../utils/appPersistence';
import { CodeAgentBackend, CodeAgentMode, getCodeAgentStatus, isSupportedCodeAgentBackend } from '../utils/codeAgent';
import { getAvatarColor, getAvatarText } from '../utils/userProfile';
import { Room, RoomRenameHandler } from '../utils/types';

interface CodeAgentRoomViewProps {
  currentRoom: Room;
  memberCount: number;
  memberEvent: { type: 'join' | 'leave'; userId: string } | null;
  username: string;
  clientId: string;
  backend: CodeAgentBackend;
  mode: CodeAgentMode;
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

export const CodeAgentRoomView: React.FC<CodeAgentRoomViewProps> = ({
  currentRoom,
  memberCount,
  memberEvent,
  username,
  clientId,
  backend,
  mode,
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
  const header = (
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
  );

  if (!isSupportedCodeAgentBackend(backend)) {
    return (
      <div className="flex h-full min-h-0 w-full flex-1 flex-col bg-[#f5f4ed] dark:bg-[#141413]">
        {header}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Icon icon="lucide:circle-alert" className="h-8 w-8 text-[#c96442] dark:text-[#d97757]" />
          <h2 className="text-lg font-semibold text-[#141413] dark:text-[#faf9f5]">{t('codeAgentBackendUnavailable')}</h2>
          <p className="max-w-md text-sm text-[#5e5d59] dark:text-[#b0aea5]">{t('codeAgentBackendUnavailableDescription')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col bg-[#f5f4ed] dark:bg-[#141413]">
      {header}

      <div className="min-h-0 w-full flex-1 overflow-hidden">
        <MessageList
          roomId={currentRoom.id}
          presentation="code-agent"
          currentRoom={currentRoom}
          codeAgentMode={mode}
        />
      </div>

      <div
        data-testid="message-input-panel"
        className="flex-shrink-0 border-t border-[#dedbd0] bg-[#faf9f5]/92 p-2 backdrop-blur-md dark:border-[#30302e] dark:bg-[#1d1d1b]/92 md:p-3"
      >
        <MessageInput
          roomId={currentRoom.id}
          username={username}
          avatarText={getAvatarText(username)}
          avatarColor={getAvatarColor(username)}
          isRoomAIProcessing={getCodeAgentStatus(currentRoom) === 'running'}
          isCodeAgentRoom
        />
      </div>
    </div>
  );
};
