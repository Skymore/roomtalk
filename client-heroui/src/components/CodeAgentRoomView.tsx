import React from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { ChatHeader } from './ChatHeader';
import { CodeAgentDiffWorkerPoolProvider } from './CodeAgentDiffWorkerPoolProvider';
import { CodeAgentFileBrowserPanel } from './CodeAgentFileBrowserPanel';
import { MessageInput } from './MessageInput';
import { MessageList, MessageListHandle } from './MessageList';
import { AppView } from '../utils/appPersistence';
import { CodeAgentBackend, CodeAgentMode, getCodeAgentStatus, isSupportedCodeAgentBackend } from '../utils/codeAgent';
import { getAvatarColor, getAvatarText } from '../utils/userProfile';
import { updateRoomSettings } from '../utils/socket';
import { Message, Room, RoomPermissions, RoomRenameHandler } from '../utils/types';
import { beginHorizontalResize } from '../utils/horizontalResize';
import {
  CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH,
  CODE_AGENT_FILE_PANEL_WIDTH_CHANGE_EVENT,
  clampCodeAgentFilePanelWidth,
  CODE_AGENT_FILE_PANEL_COLLAPSED_WIDTH,
  type CodeAgentFilePanelWidthChangeDetail,
  CODE_AGENT_FILE_PANEL_PREFERRED_MIN_WIDTH,
  getCodeAgentPanelResizeBounds,
} from '../utils/codeAgentPanelLayout';
import { parseWorkspaceFileOpenTarget } from '../utils/workspaceFileOpenTarget';
import type { ReviewCommentContext } from '../utils/codeAgentReviewComments';

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

const FILE_MANAGER_WIDTH_STORAGE_KEY = 'roomtalk.codeWorkspace.fileManagerWidth';
const FILE_MANAGER_COLLAPSED_STORAGE_KEY = 'roomtalk.codeWorkspace.fileManagerCollapsed';
type WorkspaceFileOpenRequest = { path: string; line: number | null; requestId: number };

const defaultFileManagerWidth = () => {
  if (typeof window === 'undefined') {
    return 560;
  }
  if (typeof window.matchMedia !== 'function') {
    return 560;
  }
  if (window.matchMedia('(min-width: 1536px)').matches) {
    return 760;
  }
  if (window.matchMedia('(min-width: 1280px)').matches) {
    return 680;
  }
  return 560;
};

const readStoredFileManagerWidth = () => {
  if (typeof window === 'undefined') {
    return defaultFileManagerWidth();
  }
  const parsed = Number.parseInt(window.localStorage.getItem(FILE_MANAGER_WIDTH_STORAGE_KEY) || '', 10);
  return Number.isFinite(parsed)
    ? clampCodeAgentFilePanelWidth(parsed, window.innerWidth, CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH)
    : defaultFileManagerWidth();
};

const readStoredFileManagerCollapsed = () => {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.localStorage.getItem(FILE_MANAGER_COLLAPSED_STORAGE_KEY) === 'true';
};

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
  const workspaceLayoutRef = React.useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = React.useState(96);
  const [showScrollButton, setShowScrollButton] = React.useState(false);
  const [isMobileFileManagerOpen, setIsMobileFileManagerOpen] = React.useState(false);
  const [isFileManagerCollapsed, setIsFileManagerCollapsed] = React.useState(readStoredFileManagerCollapsed);
  const [fileManagerWidth, setFileManagerWidth] = React.useState(readStoredFileManagerWidth);
  const [workspaceFileOpenRequest, setWorkspaceFileOpenRequest] = React.useState<WorkspaceFileOpenRequest | null>(null);
  const [reviewComments, setReviewComments] = React.useState<ReviewCommentContext[]>([]);
  const [pendingWorkspaceFileSaves, setPendingWorkspaceFileSaves] = React.useState<ReadonlySet<string>>(() => new Set());
  const fileManagerWidthRef = React.useRef(fileManagerWidth);
  const workspaceFileOpenRequestIdRef = React.useRef(0);
  const fileManagerResizeCleanupRef = React.useRef<(() => void) | null>(null);
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
    setReviewComments([]);
    setPendingWorkspaceFileSaves(new Set());
  }, [currentRoom.id]);

  const handleWorkspaceFileSavePendingChange = React.useCallback((relativePath: string, pending: boolean) => {
    setPendingWorkspaceFileSaves((current) => {
      const normalizedPath = relativePath.trim();
      if (!normalizedPath || current.has(normalizedPath) === pending) {
        return current;
      }
      const next = new Set(current);
      if (pending) {
        next.add(normalizedPath);
      } else {
        next.delete(normalizedPath);
      }
      return next;
    });
  }, []);

  const handleAddReviewComment = React.useCallback((comment: ReviewCommentContext) => {
    setReviewComments((current) => {
      const withoutSameComment = current.filter((entry) => entry.id !== comment.id);
      return [...withoutSameComment, comment];
    });
  }, []);

  const handleRemoveReviewComment = React.useCallback((commentId: string) => {
    setReviewComments((current) => current.filter((entry) => entry.id !== commentId));
  }, []);

  const handleClearReviewComments = React.useCallback(() => {
    setReviewComments([]);
  }, []);

  React.useEffect(() => {
    fileManagerWidthRef.current = fileManagerWidth;
    workspaceLayoutRef.current?.style.setProperty('--code-agent-files-width', `${fileManagerWidth}px`);
  }, [fileManagerWidth]);

  React.useEffect(() => () => {
    fileManagerResizeCleanupRef.current?.();
    fileManagerResizeCleanupRef.current = null;
  }, []);

  const handleCodeAgentModeChange = React.useCallback((nextMode: CodeAgentMode) => {
    const constrainedMode = normalizedAvailableModes.includes(nextMode) ? nextMode : effectiveDefaultMode;
    updateRoomSettings({ roomId: currentRoom.id, codeAgentMode: constrainedMode }).then(
      (room) => onRoomUpdated(room),
      (error) => console.error('Failed to update code agent mode', error),
    );
  }, [currentRoom.id, effectiveDefaultMode, normalizedAvailableModes, onRoomUpdated]);

  const setFileManagerCollapsed = React.useCallback((collapsed: boolean) => {
    setIsFileManagerCollapsed(collapsed);
    try {
      window.localStorage.setItem(FILE_MANAGER_COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // Persistence is best-effort; the in-memory collapsed state is still updated.
    }
  }, []);

  const persistFileManagerWidth = React.useCallback((width: number) => {
    try {
      window.localStorage.setItem(FILE_MANAGER_WIDTH_STORAGE_KEY, String(width));
    } catch {
      // Persistence is best-effort; the live resize still applies.
    }
  }, []);

  const handleOpenWorkspaceFile = React.useCallback((path: string) => {
    const target = parseWorkspaceFileOpenTarget(path);
    if (!target) {
      return;
    }
    setFileManagerCollapsed(false);
    if (
      typeof window.matchMedia === 'function' &&
      !window.matchMedia('(min-width: 1024px)').matches
    ) {
      setIsMobileFileManagerOpen(true);
    }
    workspaceFileOpenRequestIdRef.current += 1;
    setWorkspaceFileOpenRequest({
      path: target.path,
      line: target.line,
      requestId: workspaceFileOpenRequestIdRef.current,
    });
  }, [setFileManagerCollapsed]);

  React.useLayoutEffect(() => {
    if (isFileManagerCollapsed) return undefined;
    const layout = workspaceLayoutRef.current;
    if (!layout) return undefined;

    const normalizeWidth = () => {
      if (
        typeof window.matchMedia === 'function' &&
        !window.matchMedia('(min-width: 1024px)').matches
      ) {
        return;
      }
      const availableWidth = layout.getBoundingClientRect().width;
      if (availableWidth <= 0) return;
      const nextWidth = clampCodeAgentFilePanelWidth(
        fileManagerWidthRef.current,
        availableWidth,
        CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH,
      );
      if (nextWidth === fileManagerWidthRef.current) return;
      fileManagerWidthRef.current = nextWidth;
      layout.style.setProperty('--code-agent-files-width', `${nextWidth}px`);
      setFileManagerWidth(nextWidth);
      persistFileManagerWidth(nextWidth);
    };

    normalizeWidth();
    window.addEventListener('resize', normalizeWidth);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(normalizeWidth);
    resizeObserver?.observe(layout);
    return () => {
      window.removeEventListener('resize', normalizeWidth);
      resizeObserver?.disconnect();
    };
  }, [isFileManagerCollapsed, persistFileManagerWidth]);

  React.useEffect(() => {
    const layout = workspaceLayoutRef.current;
    if (!layout) return undefined;

    const handleSyncedFilePanelWidth = (event: Event) => {
      const width = (event as CustomEvent<CodeAgentFilePanelWidthChangeDetail>).detail?.width;
      if (!Number.isFinite(width)) {
        return;
      }
      const availableWidth = layout.getBoundingClientRect().width || window.innerWidth;
      const nextWidth = clampCodeAgentFilePanelWidth(width, availableWidth, CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH);
      if (nextWidth === fileManagerWidthRef.current) {
        return;
      }
      fileManagerWidthRef.current = nextWidth;
      layout.style.setProperty('--code-agent-files-width', `${nextWidth}px`);
      setFileManagerWidth(nextWidth);
      persistFileManagerWidth(nextWidth);
    };

    layout.addEventListener(CODE_AGENT_FILE_PANEL_WIDTH_CHANGE_EVENT, handleSyncedFilePanelWidth);
    return () => {
      layout.removeEventListener(CODE_AGENT_FILE_PANEL_WIDTH_CHANGE_EVENT, handleSyncedFilePanelWidth);
    };
  }, [persistFileManagerWidth]);

  const handleFileManagerResizeStart = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }

    const layout = workspaceLayoutRef.current;
    if (!layout) {
      return;
    }

    event.preventDefault();
    const startWidth = isFileManagerCollapsed
      ? CODE_AGENT_FILE_PANEL_PREFERRED_MIN_WIDTH
      : fileManagerWidthRef.current;

    if (isFileManagerCollapsed) {
      setFileManagerCollapsed(false);
    }
    layout.style.transition = 'none';
    fileManagerResizeCleanupRef.current?.();
    fileManagerResizeCleanupRef.current = beginHorizontalResize({
      pointerId: event.pointerId,
      startX: event.clientX,
      initialWidth: startWidth,
      direction: -1,
      captureTarget: event.currentTarget,
      getBounds: () => getCodeAgentPanelResizeBounds(
        layout.getBoundingClientRect().width,
        CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH,
      ),
      onResize: (width) => {
        layout.style.setProperty('--code-agent-files-width', `${width}px`);
      },
      onFinish: (width) => {
        layout.style.transition = '';
        fileManagerWidthRef.current = width;
        setFileManagerWidth(width);
        persistFileManagerWidth(width);
        fileManagerResizeCleanupRef.current = null;
      },
    });
  }, [isFileManagerCollapsed, persistFileManagerWidth, setFileManagerCollapsed]);

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
      <div className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col bg-[#f5f4ed] dark:bg-[#141413]">
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
      openFileRequest={workspaceFileOpenRequest}
      revealLine={workspaceFileOpenRequest?.line ?? null}
      revealRequestId={workspaceFileOpenRequest?.requestId ?? 0}
      reviewComments={reviewComments}
      onAddReviewComment={handleAddReviewComment}
      onRemoveReviewComment={handleRemoveReviewComment}
      onFileSavePendingChange={handleWorkspaceFileSavePendingChange}
    />
  );

  const hasPendingWorkspaceFileSaves = pendingWorkspaceFileSaves.size > 0;
  const fileManagerToggleLabel = isFileManagerCollapsed
    ? t('codeAgentExpandWorkspaceFiles')
    : t('codeAgentCollapseWorkspaceFiles');
  const fileManagerToggleTitle = hasPendingWorkspaceFileSaves
    ? `${fileManagerToggleLabel} - ${t('codeAgentWorkspaceFilesSavePending')}`
    : fileManagerToggleLabel;

  return (
    <CodeAgentDiffWorkerPoolProvider>
    <div className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col bg-[#f5f4ed] dark:bg-[#141413]">
      {header}

      <div
        ref={workspaceLayoutRef}
        className="grid min-h-0 min-w-0 w-full flex-1 overflow-hidden lg:grid-cols-[minmax(var(--code-agent-chat-min-width),1fr)_minmax(0,var(--code-agent-files-width))]"
        data-code-agent-workspace-layout="true"
        data-code-agent-files-collapsed={String(isFileManagerCollapsed)}
        style={{
          ['--code-agent-chat-min-width' as string]: `${CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH}px`,
          ['--code-agent-files-width' as string]: isFileManagerCollapsed
            ? `${CODE_AGENT_FILE_PANEL_COLLAPSED_WIDTH}px`
            : `${fileManagerWidth}px`,
        }}
      >
        <div className="relative min-h-0 min-w-[var(--code-agent-chat-min-width)] overflow-hidden" data-code-agent-chat-pane="true">
          <MessageList
            key={currentRoom.id}
            ref={messageListRef}
            roomId={currentRoom.id}
            room={currentRoom}
            presentation="code-agent"
            currentRoom={currentRoom}
            codeAgentMode={selectedMode}
            onOpenWorkspaceFile={handleOpenWorkspaceFile}
            reviewComments={reviewComments}
            onAddReviewComment={handleAddReviewComment}
            onRemoveReviewComment={handleRemoveReviewComment}
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
              reviewComments={reviewComments}
              onRemoveReviewComment={handleRemoveReviewComment}
              onClearReviewComments={handleClearReviewComments}
            />
          </div>
        </div>

        <aside
          className="relative z-10 hidden min-h-0 min-w-0 overflow-visible border-l border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b] lg:flex"
          data-code-agent-files-panel="true"
        >
          <button
            type="button"
            aria-label={t('codeAgentResizeWorkspaceFiles')}
            className="group absolute inset-y-0 -left-4 z-40 w-8 cursor-col-resize touch-none focus-visible:outline-none"
            onPointerDown={handleFileManagerResizeStart}
          >
            <span
              aria-hidden="true"
              data-code-agent-resize-highlight="workspace-files"
              className="pointer-events-none absolute inset-y-0 left-1/2 z-50 -ml-px w-0.5 -translate-x-1/2 rounded-full bg-transparent transition-colors duration-150 group-hover:bg-[#c96442] group-active:bg-[#c96442] group-focus-visible:bg-[#c96442]"
            />
          </button>
          <div className={`${isFileManagerCollapsed ? 'w-full' : 'w-8'} relative flex shrink-0 justify-center border-r border-[#dedbd0] bg-[#f0eee6] dark:border-[#30302e] dark:bg-[#242422]`}>
            <Button
              isIconOnly
              variant="light"
              size="sm"
              aria-label={fileManagerToggleTitle}
              title={fileManagerToggleTitle}
              onPress={() => setFileManagerCollapsed(!isFileManagerCollapsed)}
              className="relative mt-2 h-7 w-7 min-w-7 rounded-md text-[#5e5d59] hover:bg-[#dedbd0] dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
            >
              <Icon icon={isFileManagerCollapsed ? 'lucide:panel-right-open' : 'lucide:panel-right-close'} className="h-3.5 w-3.5" />
              {hasPendingWorkspaceFileSaves ? (
                <span
                  aria-hidden="true"
                  data-testid="code-agent-file-save-pending-indicator"
                  className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[#c96442] shadow-[0_0_0_2px_#f0eee6] dark:bg-[#ffb197] dark:shadow-[0_0_0_2px_#242422]"
                />
              ) : null}
            </Button>
          </div>
          {isFileManagerCollapsed ? null : (
            <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
              {renderFileManagerPanel('desktop')}
            </div>
          )}
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
          <div className="flex min-h-0 flex-1">
            {renderFileManagerPanel('mobile')}
          </div>
        </div>
      )}
    </div>
    </CodeAgentDiffWorkerPoolProvider>
  );
};
