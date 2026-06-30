import React from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { ChatHeader } from './ChatHeader';
import { CodeAgentFileBrowserPanel } from './CodeAgentFileBrowserPanel';
import { MessageInput } from './MessageInput';
import { MessageList, MessageListHandle } from './MessageList';
import { AppView } from '../utils/appPersistence';
import { CodeAgentBackend, CodeAgentMode, getCodeAgentStatus, isSupportedCodeAgentBackend } from '../utils/codeAgent';
import { getAvatarColor, getAvatarText } from '../utils/userProfile';
import { updateRoomSettings } from '../utils/socket';
import { Message, Room, RoomPermissions, RoomRenameHandler } from '../utils/types';

interface CodeAgentRoomViewProps {
  currentRoom: Room;
  memberCount: number | null;
  isRestoringRoom: boolean;
  username: string;
  clientId: string;
  backend: CodeAgentBackend;
  availableModes: CodeAgentMode[];
  defaultMode: CodeAgentMode;
  handleCopyToClipboard: (text: string) => void;
  handleShareRoom: () => void;
  handleToggleSave: () => void;
  handleLeaveRoom: () => void;
  isRoomSaved: (roomId: string) => boolean;
  setView: (view: AppView) => void;
  clearRoomUrlParam: () => void;
  handleClearChatMessages: (confirmation: string) => unknown;
  handleDeleteRoom: (roomId: string) => void;
  handleRenameRoom: RoomRenameHandler;
  roomPermissions: RoomPermissions | null;
  onRoomUpdated: (room: Room) => void;
}

export const CodeAgentRoomView: React.FC<CodeAgentRoomViewProps> = ({
  currentRoom,
  memberCount,
  isRestoringRoom,
  username,
  clientId,
  backend,
  availableModes,
  defaultMode,
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
  roomPermissions,
  onRoomUpdated,
}) => {
  const { t } = useTranslation();
  const [replyToMessage, setReplyToMessage] = React.useState<Message | null>(null);
  const composerRef = React.useRef<HTMLDivElement>(null);
  const messageListRef = React.useRef<MessageListHandle>(null);
  const [composerHeight, setComposerHeight] = React.useState(96);
  const [showScrollButton, setShowScrollButton] = React.useState(false);
  const [isMobileFileManagerOpen, setIsMobileFileManagerOpen] = React.useState(false);
  const normalizedAvailableModes = React.useMemo(
    () => (availableModes.length ? availableModes : ['plan' as CodeAgentMode]),
    [availableModes]
  );
  const maxMode: CodeAgentMode = normalizedAvailableModes.includes('acceptEdits') ? 'acceptEdits' : 'plan';
  const effectiveDefaultMode = normalizedAvailableModes.includes(defaultMode) ? defaultMode : 'plan';
  const selectedMode: CodeAgentMode = normalizedAvailableModes.includes(currentRoom.codeAgentMode as CodeAgentMode)
    ? (currentRoom.codeAgentMode as CodeAgentMode)
    : effectiveDefaultMode;

  React.useEffect(() => {
    setReplyToMessage(null);
    setShowScrollButton(false);
    setIsMobileFileManagerOpen(false);
  }, [currentRoom.id]);

  const handleCodeAgentModeChange = React.useCallback((nextMode: CodeAgentMode) => {
    const constrainedMode = normalizedAvailableModes.includes(nextMode) ? nextMode : effectiveDefaultMode;
    updateRoomSettings({ roomId: currentRoom.id, codeAgentMode: constrainedMode }).then(
      (room) => onRoomUpdated(room),
      (error) => console.error('Failed to update code agent mode', error),
    );
  }, [currentRoom.id, effectiveDefaultMode, normalizedAvailableModes, onRoomUpdated]);

  React.useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;

    const update = () => {
      setComposerHeight(Math.ceil(el.getBoundingClientRect().height));
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

  const header = (
    <ChatHeader
      currentRoom={currentRoom}
      memberCount={memberCount}
      isRestoringRoom={isRestoringRoom}
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
      roomPermissions={roomPermissions}
      onRoomUpdated={onRoomUpdated}
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

  const renderFileManagerPanel = (surface: 'desktop' | 'mobile') => (
    <CodeAgentFileBrowserPanel
      key={`${currentRoom.id}:${surface}`}
      roomId={currentRoom.id}
      projectName={currentRoom.name || 'Workspace'}
      sandboxStatus={currentRoom.sandboxStatus}
      sandboxUpdatedAt={currentRoom.sandboxUpdatedAt}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col bg-[#f5f4ed] dark:bg-[#141413]">
      {header}

      <div className="grid min-h-0 w-full flex-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_560px] xl:grid-cols-[minmax(0,1fr)_680px] 2xl:grid-cols-[minmax(0,1fr)_760px]">
        <div className="relative min-h-0 overflow-hidden">
          <MessageList
            key={currentRoom.id}
            ref={messageListRef}
            roomId={currentRoom.id}
            room={currentRoom}
            presentation="code-agent"
            currentRoom={currentRoom}
            codeAgentMode={selectedMode}
            onReply={setReplyToMessage}
            roomPermissions={roomPermissions}
            bottomInsetPx={composerHeight + 12}
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
              style={{ bottom: composerHeight + 16 }}
              aria-label={t('scrollToBottom')}
              onPress={() => messageListRef.current?.scrollToBottom('smooth')}
            >
              <Icon icon="lucide:arrow-down" className="h-4 w-4" />
            </Button>
          )}

          <Button
            isIconOnly
            variant="solid"
            size="sm"
            radius="full"
            className="absolute right-3 top-3 z-40 bg-[#30302e] text-[#faf9f5] shadow-[0_0_0_1px_rgba(194,192,182,0.7),0_10px_24px_rgba(20,20,19,0.16)] dark:bg-[#faf9f5] dark:text-[#141413] lg:hidden"
            aria-label={t('codeAgentWorkspaceFiles')}
            onPress={() => setIsMobileFileManagerOpen(true)}
          >
            <Icon icon="lucide:folder-tree" className="h-4 w-4" />
          </Button>

          <div
            ref={composerRef}
            data-testid="message-input-panel"
            className="absolute inset-x-0 bottom-0 z-30 flex min-h-11 items-center border-t border-[#dedbd0] bg-[#faf9f5]/92 px-1 py-1 backdrop-blur-md dark:border-[#30302e] dark:bg-[#1d1d1b]/92 md:block md:min-h-0 md:p-3"
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
              canPost={roomPermissions?.canPost ?? true}
              postingRestrictionReason={roomPermissions?.postingRestrictionReason}
              postingSchedule={currentRoom.postingSchedule}
              isRoomAIProcessing={getCodeAgentStatus(currentRoom) === 'running'}
              isCodeAgentRoom
              codeAgentMode={selectedMode}
              codeAgentMaxMode={maxMode}
              onCodeAgentModeChange={handleCodeAgentModeChange}
            />
          </div>
        </div>

        <aside className="hidden min-h-0 border-l border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b] lg:flex">
          {renderFileManagerPanel('desktop')}
        </aside>
      </div>
      {isMobileFileManagerOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#faf9f5] dark:bg-[#1d1d1b] lg:hidden">
          <div className="safe-top flex min-h-10 items-center gap-2 border-b border-[#dedbd0] px-3 py-1 dark:border-[#30302e]">
            <Button
              isIconOnly
              variant="light"
              size="sm"
              aria-label={t('close')}
              onPress={() => setIsMobileFileManagerOpen(false)}
              className="h-8 w-8 min-w-8 rounded-lg text-[#141413] dark:text-[#faf9f5]"
            >
              <Icon icon="lucide:x" className="h-4 w-4" />
            </Button>
            <div className="min-w-0 flex-1 truncate text-sm font-medium text-[#141413] dark:text-[#faf9f5]">
              {t('codeAgentWorkspaceFiles')}
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {renderFileManagerPanel('mobile')}
          </div>
        </div>
      )}
    </div>
  );
};
