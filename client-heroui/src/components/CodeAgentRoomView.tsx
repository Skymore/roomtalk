import React from 'react';
import { ChatHeader } from './ChatHeader';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';
import { AppView } from '../utils/appPersistence';
import { FeatureFlags } from '../utils/features';
import { getAvatarColor, getAvatarText } from '../utils/userProfile';
import { Room, RoomRenameHandler } from '../utils/types';

interface CodeAgentRoomViewProps {
  currentRoom: Room;
  memberCount: number;
  memberEvent: { type: 'join' | 'leave'; userId: string } | null;
  username: string;
  clientId: string;
  cocoMode: FeatureFlags['coco']['mode'];
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
  cocoMode,
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

      <div className="min-h-0 w-full flex-1 overflow-hidden">
        <MessageList
          roomId={currentRoom.id}
          presentation="code-agent"
          currentRoom={currentRoom}
          cocoMode={cocoMode}
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
          isRoomAIProcessing={currentRoom.cocoStatus === 'running'}
          isCodeAgentRoom
        />
      </div>
    </div>
  );
};
