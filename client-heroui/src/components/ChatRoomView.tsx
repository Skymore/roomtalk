import React from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ChatHeader } from './ChatHeader';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';
import { AppView } from '../utils/appPersistence';
import { getAvatarColor, getAvatarText } from '../utils/userProfile';
import { Room } from '../utils/types';

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
}) => {
  return (
    <PanelGroup direction="horizontal" className="flex h-full min-h-0 w-full flex-1">
      <PanelResizeHandle className="w-px cursor-col-resize bg-[#dedbd0] transition-colors hover:bg-[#c2c0b6] data-[resize-handle-active]:bg-[#c96442] dark:bg-[#30302e] dark:hover:bg-[#4d4c48] dark:data-[resize-handle-active]:bg-[#d97757]" />
      <Panel defaultSize={50} minSize={30}>
        <div className="flex h-full min-h-0 flex-1 flex-col bg-[#f5f4ed] dark:bg-[#141413]">
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
            clientId={clientId}
          />

          <div className="min-h-0 w-full flex-1 overflow-hidden">
            <MessageList roomId={currentRoom.id} />
          </div>

          <div className="flex-shrink-0 border-t border-[#dedbd0] bg-[#faf9f5]/92 p-2 backdrop-blur-md dark:border-[#30302e] dark:bg-[#1d1d1b]/92">
            <MessageInput
              roomId={currentRoom.id}
              username={username}
              avatarText={getAvatarText(username)}
              avatarColor={getAvatarColor(username)}
            />
          </div>
        </div>
      </Panel>
    </PanelGroup>
  );
};
