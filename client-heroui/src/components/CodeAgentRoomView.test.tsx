// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, RoomPermissions } from '../utils/types';
import { CODE_AGENT_FILE_PANEL_WIDTH_CHANGE_EVENT, type CodeAgentFilePanelWidthChangeDetail } from '../utils/codeAgentPanelLayout';
import type { ReviewCommentContext } from '../utils/codeAgentReviewComments';
import {
  addCodeAgentRightPanelPreviewSurface,
  readCodeAgentRightPanelState,
  resetCodeAgentRightPanelStoreForTests,
} from '../utils/codeAgentRightPanelStore';
import { CodeAgentRoomView } from './CodeAgentRoomView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('./ChatHeader', () => ({
  ChatHeader: () => <div data-testid="chat-header" />,
}));

vi.mock('./MessageList', async () => {
  const React = await import('react');
  return {
    MessageList: React.forwardRef(({
      codeAgentMode,
      codeAgentBackend,
      bottomInsetPx,
      onOpenWorkspaceFile,
      onOpenWorkspaceArtifact,
      onCodeAgentBackendChange,
    }: {
      codeAgentMode: string;
      codeAgentBackend?: string;
      bottomInsetPx?: number;
      onOpenWorkspaceFile?: (path: string) => void;
      onOpenWorkspaceArtifact?: (url: string) => boolean;
      onCodeAgentBackendChange?: (backend: 'code-agent' | 'codex' | 'codex-app-server') => void;
    }, ref: React.ForwardedRef<unknown>) => {
    React.useImperativeHandle(ref, () => ({ scrollToBottom: vi.fn() }));
    return (
      <>
      <button
        type="button"
        data-testid="message-list"
        data-code-agent-mode={codeAgentMode}
        data-code-agent-backend={codeAgentBackend || ''}
        data-bottom-inset-px={String(bottomInsetPx ?? '')}
        onClick={() => onOpenWorkspaceFile?.('/workspace/src/App.tsx')}
      >
        open-file
      </button>
      <button
        type="button"
        data-testid="message-list-open-artifact"
        onClick={() => onOpenWorkspaceArtifact?.('https://room.example/p/mobile-demo/')}
      >
        open-artifact
      </button>
      <button
        type="button"
        data-testid="message-list-switch-app"
        onClick={() => onCodeAgentBackendChange?.('codex-app-server')}
      >
        switch-app
      </button>
      <button
        type="button"
        data-testid="message-list-line-link"
        onClick={() => onOpenWorkspaceFile?.('/workspace/src/App.tsx:42')}
      >
        open-file-line
      </button>
      <button
        type="button"
        data-testid="message-list-hash-line-link"
        onClick={() => onOpenWorkspaceFile?.('src/App.tsx#L87C5')}
      >
        open-file-hash-line
      </button>
      </>
    );
    }),
  };
});

vi.mock('./MessageInput', () => ({
  MessageInput: ({
    codeAgentMode,
    codeAgentAvailableModes,
    canSwitchCodeAgentMode,
    isCodeAgentRoom,
    canPost,
    isRoomSessionReady,
    canUseRetainedRoomAccess,
    postingRestrictionReason,
    reviewComments = [],
    onRemoveReviewComment,
    onClearReviewComments,
  }: {
    codeAgentMode: string;
    codeAgentAvailableModes?: string[];
    canSwitchCodeAgentMode?: boolean;
    isCodeAgentRoom?: boolean;
    canPost?: boolean;
    isRoomSessionReady?: boolean;
    canUseRetainedRoomAccess?: boolean;
    postingRestrictionReason?: string;
    reviewComments?: readonly ReviewCommentContext[];
    onRemoveReviewComment?: (commentId: string) => void;
    onClearReviewComments?: () => void;
  }) => (
    <div
      data-testid="message-input"
      data-code-agent-room={String(Boolean(isCodeAgentRoom))}
      data-code-agent-mode={codeAgentMode}
      data-code-agent-available-modes={(codeAgentAvailableModes || []).join(',')}
      data-can-switch-code-agent-mode={String(Boolean(canSwitchCodeAgentMode))}
      data-can-post={String(Boolean(canPost))}
      data-session-ready={String(Boolean(isRoomSessionReady))}
      data-retained-access={String(Boolean(canUseRetainedRoomAccess))}
      data-posting-restriction-reason={postingRestrictionReason || ''}
      data-review-comments={String(reviewComments.length)}
    >
      {reviewComments.map((comment) => (
        <span key={comment.id}>{comment.text}</span>
      ))}
      <button
        type="button"
        data-testid="message-input-remove-review-comment"
        onClick={() => {
          if (reviewComments[0]) {
            onRemoveReviewComment?.(reviewComments[0].id);
          }
        }}
      />
      <button
        type="button"
        data-testid="message-input-clear-review-comments"
        onClick={() => onClearReviewComments?.()}
      />
    </div>
  ),
}));

vi.mock('./CodeAgentFileBrowserPanel', () => ({
  CodeAgentFileBrowserPanel: ({
    surface,
    sandboxStatus,
    sandboxUpdatedAt,
    workspaceEditable,
    openFileRequest,
    revealLine,
    revealRequestId,
    onAddReviewComment,
    onFileSavePendingChange,
  }: {
    surface?: 'desktop' | 'mobile';
    sandboxStatus?: string;
    sandboxUpdatedAt?: string;
    workspaceEditable?: boolean;
    openFileRequest?: { path: string; requestId: number } | null;
    revealLine?: number | null;
    revealRequestId?: number;
    onAddReviewComment?: (comment: ReviewCommentContext) => void;
    onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  }) => (
    <>
      <div
        data-testid="file-browser"
        data-surface={surface || ''}
        data-sandbox-status={sandboxStatus}
        data-sandbox-updated-at={sandboxUpdatedAt}
        data-workspace-editable={String(Boolean(workspaceEditable))}
        data-open-path={openFileRequest?.path || ''}
        data-open-request-id={openFileRequest?.requestId || ''}
        data-reveal-line={revealLine || ''}
        data-reveal-request-id={revealRequestId || ''}
      />
      <button
        type="button"
        data-testid="file-save-pending-on"
        onClick={() => onFileSavePendingChange?.('src/App.tsx', true)}
      />
      <button
        type="button"
        data-testid="file-save-pending-off"
        onClick={() => onFileSavePendingChange?.('src/App.tsx', false)}
      />
      <button
        type="button"
        data-testid="file-add-review-comment"
        onClick={() => onAddReviewComment?.({
          id: 'comment-1',
          sectionId: 'file:src/App.tsx',
          sectionTitle: 'File comment',
          filePath: 'src/App.tsx',
          startIndex: 0,
          endIndex: 1,
          rangeLabel: 'L1 to L2',
          text: 'Persist this review comment.',
          diff: 'line 1\nline 2',
          fenceLanguage: 'tsx',
        })}
      />
    </>
  ),
}));

vi.mock('../utils/socket', () => ({
  updateRoomSettings: vi.fn(async ({ roomId, codeAgentMode, codeAgentBackend }: { roomId: string; codeAgentMode?: 'plan' | 'edit' | 'approveForMe' | 'fullAccess' | 'acceptEdits'; codeAgentBackend?: 'code-agent' | 'codex' | 'codex-app-server' }) => ({
    id: roomId,
    name: 'Code Agent Room',
    creatorId: 'client-1',
    createdAt: '2026-05-26T00:00:00.000Z',
    type: 'codeAgent',
    ...(codeAgentMode ? { codeAgentMode } : {}),
    ...(codeAgentBackend ? { codeAgentBackend } : {}),
  })),
}));

const unsupportedRoom: Room = {
  id: 'room-1',
  name: 'Codex Room',
  creatorId: 'client-1',
  createdAt: '2026-05-26T00:00:00.000Z',
  type: 'codex' as Room['type'],
};

const codeAgentRoom: Room = {
  id: 'code-agent-room',
  name: 'Code Agent Room',
  creatorId: 'client-1',
  createdAt: '2026-05-26T00:00:00.000Z',
  type: 'codeAgent',
  sandboxStatus: 'ready',
  sandboxUpdatedAt: '2026-06-30T10:00:00.000Z',
  codeAgentStatus: 'idle',
};

const permissions = (overrides: Partial<RoomPermissions> = {}): RoomPermissions => ({
  roomId: 'code-agent-room',
  clientId: 'client-1',
  role: 'owner',
  canPost: true,
  canEditAnyMessage: true,
  canDeleteAnyMessage: true,
  canClearHistory: true,
  canManageRoom: true,
  canManageAdmins: true,
  canManageMembers: true,
  canTransferOwnership: true,
  canUseCodeAgent: true,
  ...overrides,
});

const dispatchPointer = (
  target: EventTarget,
  type: string,
  values: { pointerId: number; clientX: number; buttons: number; button?: number; clientY?: number },
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY ?? 100 },
    buttons: { value: values.buttons },
    button: { value: values.button ?? 0 },
  });
  target.dispatchEvent(event);
};

const renderCodeAgentRoom = (
  room: Room,
  availableModes: Array<'plan' | 'edit' | 'approveForMe' | 'fullAccess' | 'acceptEdits'> = room.codeAgentMode === 'edit' ? ['plan', 'edit'] : ['plan'],
  defaultMode: 'plan' | 'edit' | 'approveForMe' | 'fullAccess' | 'acceptEdits' = 'plan',
  roomPermissions: RoomPermissions | null = null,
  isRoomSessionReady = true,
  canUseRetainedRoomAccess = isRoomSessionReady,
) => render(
  <CodeAgentRoomView
    currentRoom={room}
    memberCount={1}
    isRestoringRoom={false}
    isRoomSessionReady={isRoomSessionReady}
    canUseRetainedRoomAccess={canUseRetainedRoomAccess}
    ensureRoomSessionReady={vi.fn(async () => {})}
    onRetryRoomSession={vi.fn()}
    username="User"
    clientId="client-1"
    backend={room.codeAgentBackend || (room.type === 'codeAgent' ? 'code-agent' : 'codex')}
    availableModes={availableModes}
    defaultMode={defaultMode}
    handleCopyToClipboard={vi.fn()}
    handleShareRoom={vi.fn()}
    handleToggleSave={vi.fn()}
    handleLeaveRoom={vi.fn()}
    isRoomSaved={() => false}
    setView={vi.fn()}
    clearRoomUrlParam={vi.fn()}
    handleClearChatMessages={vi.fn()}
    handleDeleteRoom={vi.fn()}
    handleRenameRoom={vi.fn()}
    roomPermissions={roomPermissions}
    onRoomUpdated={vi.fn()}
  />
);

describe('CodeAgentRoomView', () => {
  afterEach(() => {
    cleanup();
    resetCodeAgentRightPanelStoreForTests();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders Codex-backed rooms through the shared code-agent UI', () => {
    renderCodeAgentRoom(unsupportedRoom);

    expect(screen.getByTestId('chat-header')).toBeTruthy();
    expect(screen.getByTestId('message-list').dataset.codeAgentBackend).toBe('codex');
    expect(screen.getByTestId('message-input-panel')).toBeTruthy();
  });

  it('keeps cached code-agent rooms read-only until the room session is verified', async () => {
    const { updateRoomSettings } = await import('../utils/socket');
    vi.mocked(updateRoomSettings).mockClear();
    renderCodeAgentRoom(
      { ...codeAgentRoom, codeAgentMode: 'edit' },
      ['plan', 'edit'],
      'edit',
      permissions(),
      false,
    );

    expect(screen.getByTestId('message-input').dataset.canPost).toBe('false');
    expect(screen.getByTestId('message-input').dataset.sessionReady).toBe('false');
    expect(screen.getByTestId('message-input').dataset.postingRestrictionReason).toBe('errorRestoringRoom');
    expect(screen.queryByTestId('file-browser')).toBeNull();
    expect(screen.getByTestId('code-agent-file-browser-session-locked')).toBeTruthy();
    fireEvent.click(screen.getByTestId('message-list-switch-app'));
    expect(updateRoomSettings).not.toHaveBeenCalled();
  });

  it('preserves the cached workspace and composer during a transient reconnect', async () => {
    const { updateRoomSettings } = await import('../utils/socket');
    vi.mocked(updateRoomSettings).mockClear();
    renderCodeAgentRoom(
      { ...codeAgentRoom, codeAgentMode: 'edit' },
      ['plan', 'edit'],
      'edit',
      permissions(),
      false,
      true,
    );

    expect(screen.getByTestId('message-input').dataset.canPost).toBe('true');
    expect(screen.getByTestId('message-input').dataset.sessionReady).toBe('false');
    expect(screen.getByTestId('message-input').dataset.retainedAccess).toBe('true');
    expect(screen.getByTestId('message-input').dataset.postingRestrictionReason).toBe('');
    expect(screen.getByTestId('file-browser').dataset.workspaceEditable).toBe('false');
    expect(screen.queryByTestId('code-agent-file-browser-session-locked')).toBeNull();

    fireEvent.click(screen.getByTestId('message-list-switch-app'));
    expect(updateRoomSettings).not.toHaveBeenCalled();
  });

  it('passes the selected code-agent run mode to the workspace and composer', () => {
    renderCodeAgentRoom({ ...codeAgentRoom, codeAgentMode: 'edit' }, ['plan', 'edit'], 'plan', permissions());

    expect(screen.getByTestId('message-list').dataset.codeAgentMode).toBe('edit');
    expect(screen.getByTestId('message-input').dataset.codeAgentRoom).toBe('true');
    expect(screen.getByTestId('message-input').dataset.codeAgentMode).toBe('edit');
    expect(screen.getByTestId('message-input').dataset.codeAgentAvailableModes).toBe('plan,edit');
    expect(screen.getByTestId('message-input').dataset.sessionReady).toBe('true');
    expect(screen.getByTestId('message-input').dataset.canSwitchCodeAgentMode).toBe('true');
    expect(screen.getByTestId('file-browser').dataset.sandboxStatus).toBe('ready');
    expect(screen.getByTestId('file-browser').dataset.sandboxUpdatedAt).toBe('2026-06-30T10:00:00.000Z');
    expect(screen.getByTestId('file-browser').dataset.workspaceEditable).toBe('true');
    expect(screen.getByLabelText('codeAgentResizeWorkspaceFiles')).toBeTruthy();
    expect(screen.getByLabelText('codeAgentCollapseWorkspaceFiles')).toBeTruthy();
  });

  it('updates the room engine when the workspace header switches to Codex', async () => {
    const { updateRoomSettings } = await import('../utils/socket');
    renderCodeAgentRoom(codeAgentRoom, ['plan'], 'plan', permissions());

    fireEvent.click(screen.getByTestId('message-list-switch-app'));
    await act(async () => {});

    expect(updateRoomSettings).toHaveBeenCalledWith({ roomId: 'code-agent-room', codeAgentBackend: 'codex-app-server' });
  });

  it('keeps the message scrollbar above the floating composer', () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class MockResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();

      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    renderCodeAgentRoom(codeAgentRoom);

    const composer = screen.getByTestId('message-input-panel') as HTMLDivElement;
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 148,
      top: 752,
      right: 800,
      bottom: 900,
      left: 0,
      x: 0,
      y: 752,
      toJSON: () => ({}),
    });

    act(() => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    });

    expect(screen.getByTestId('message-list-layer').getAttribute('style')).toContain('bottom: 148px');
    expect(screen.getByTestId('message-list').dataset.bottomInsetPx).toBe('12');
  });

  it('keeps composer mode switching locked for non-managers while preserving edit capability', () => {
    renderCodeAgentRoom({ ...codeAgentRoom, codeAgentMode: 'edit' }, ['plan', 'edit'], 'plan', permissions({
      role: 'member',
      canManageRoom: false,
      canManageAdmins: false,
      canManageMembers: false,
      canTransferOwnership: false,
    }));

    expect(screen.getByTestId('message-input').dataset.codeAgentMode).toBe('edit');
    expect(screen.getByTestId('message-input').dataset.codeAgentAvailableModes).toBe('plan,edit');
    expect(screen.getByTestId('message-input').dataset.canSwitchCodeAgentMode).toBe('false');
  });

  it('disables the composer when room permissions cannot use code agent', () => {
    renderCodeAgentRoom(codeAgentRoom, ['plan'], 'plan', permissions({
      role: 'member',
      canUseCodeAgent: false,
    }));

    const input = screen.getByTestId('message-input');
    expect(input.dataset.canPost).toBe('false');
    expect(input.dataset.postingRestrictionReason).toBe('codeAgentAccessDenied');
  });

  it('gives desktop and mobile file managers a flex height context', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    renderCodeAgentRoom(codeAgentRoom);

    const desktopFileBrowser = screen.getByTestId('file-browser');
    expect(desktopFileBrowser.dataset.surface).toBe('desktop');
    const layout = desktopFileBrowser.closest('[data-code-agent-workspace-layout="true"]') as HTMLDivElement;
    expect(layout.style.getPropertyValue('--code-agent-chat-min-width')).toBe('480px');
    expect(layout.style.getPropertyValue('--code-agent-composer-height')).toMatch(/px$/);
    expect(layout.className).toContain('lg:grid-cols-[minmax(var(--code-agent-chat-min-width),1fr)_minmax(0,var(--code-agent-files-width))]');
    expect(desktopFileBrowser.parentElement?.classList.contains('flex')).toBe(true);
    expect(desktopFileBrowser.parentElement?.classList.contains('min-h-0')).toBe(true);
    const messageListLayer = screen.getByTestId('message-list-layer');
    const chatPane = screen.getByTestId('message-list').closest('[data-code-agent-chat-pane="true"]');
    expect(messageListLayer.classList.contains('absolute')).toBe(true);
    expect(messageListLayer.classList.contains('overflow-hidden')).toBe(true);
    expect(chatPane).toBeTruthy();
    expect(chatPane?.classList.contains('min-w-0')).toBe(true);
    expect(chatPane?.classList.contains('lg:min-w-[var(--code-agent-chat-min-width)]')).toBe(true);
    expect(chatPane?.classList.contains('min-w-[var(--code-agent-chat-min-width)]')).toBe(false);

    fireEvent.click(screen.getByLabelText('codeAgentWorkspaceFiles'));
    const fileBrowsers = screen.getAllByTestId('file-browser');
    expect(fileBrowsers).toHaveLength(2);
    const mobileFileBrowser = fileBrowsers.find((element) => element !== desktopFileBrowser);
    expect(mobileFileBrowser?.dataset.surface).toBe('mobile');
    expect(mobileFileBrowser?.parentElement?.classList.contains('flex')).toBe(true);
    expect(mobileFileBrowser?.parentElement?.classList.contains('min-h-0')).toBe(true);
  });

  it('keeps the mobile file manager mounted while the sheet is hidden', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    renderCodeAgentRoom(codeAgentRoom);

    const desktopFileBrowser = screen.getByTestId('file-browser');
    expect(desktopFileBrowser.dataset.surface).toBe('desktop');
    expect(screen.queryByTestId('code-agent-mobile-file-manager-sheet')).toBeNull();

    fireEvent.click(screen.getByLabelText('codeAgentWorkspaceFiles'));
    const openSheet = screen.getByTestId('code-agent-mobile-file-manager-sheet') as HTMLDivElement;
    expect(openSheet.hidden).toBe(false);
    expect(openSheet.dataset.open).toBe('true');
    const mobileFileBrowser = screen.getAllByTestId('file-browser').find((element) => (
      element.dataset.surface === 'mobile'
    ));
    expect(mobileFileBrowser).toBeTruthy();

    fireEvent.click(within(openSheet).getByLabelText('close'));
    const hiddenSheet = screen.getByTestId('code-agent-mobile-file-manager-sheet') as HTMLDivElement;
    expect(hiddenSheet.hidden).toBe(true);
    expect(hiddenSheet.dataset.open).toBe('false');
    expect(screen.getAllByTestId('file-browser').find((element) => (
      element.dataset.surface === 'mobile'
    ))).toBe(mobileFileBrowser);

    fireEvent.click(screen.getByLabelText('codeAgentWorkspaceFiles'));
    const reopenedSheet = screen.getByTestId('code-agent-mobile-file-manager-sheet') as HTMLDivElement;
    expect(reopenedSheet.hidden).toBe(false);
    expect(reopenedSheet.dataset.open).toBe('true');
    expect(screen.getAllByTestId('file-browser').find((element) => (
      element.dataset.surface === 'mobile'
    ))).toBe(mobileFileBrowser);
  });

  it('opens the mobile file manager when a workspace file link is selected', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    renderCodeAgentRoom(codeAgentRoom);

    expect(screen.queryByTestId('code-agent-mobile-file-manager-sheet')).toBeNull();

    fireEvent.click(screen.getByTestId('message-list-line-link'));

    const openSheet = screen.getByTestId('code-agent-mobile-file-manager-sheet') as HTMLDivElement;
    expect(openSheet.hidden).toBe(false);
    expect(openSheet.dataset.open).toBe('true');
    const mobileFileBrowser = screen.getAllByTestId('file-browser').find((element) => (
      element.dataset.surface === 'mobile'
    ));
    expect(mobileFileBrowser).toBeTruthy();
    expect(mobileFileBrowser?.dataset.openPath).toBe('src/App.tsx');
    expect(mobileFileBrowser?.dataset.openRequestId).toBe('1');
    expect(mobileFileBrowser?.dataset.revealLine).toBe('42');
    expect(mobileFileBrowser?.dataset.revealRequestId).toBe('1');
  });

  it('keeps the workspace files resize affordance from being clipped by the panel edge', () => {
    renderCodeAgentRoom(codeAgentRoom);

    const resizeHandle = screen.getByLabelText('codeAgentResizeWorkspaceFiles');
    const filesPanel = resizeHandle.closest('[data-code-agent-files-panel="true"]') as HTMLElement;
    expect(filesPanel.className).toContain('overflow-visible');
    expect(filesPanel.className).not.toContain('overflow-hidden');
    expect(resizeHandle.className).toContain('w-8');
    expect(resizeHandle.className).not.toContain('hover:bg');
    const highlight = resizeHandle.querySelector('[data-code-agent-resize-highlight="workspace-files"]');
    expect(highlight?.className).toContain('w-0.5');
    expect(highlight?.className).toContain('-ml-px');
    expect(highlight?.className).toContain('z-50');

    const fileBrowser = screen.getByTestId('file-browser');
    expect(fileBrowser.parentElement?.classList.contains('overflow-hidden')).toBe(true);
  });

  it('resizes the workspace panel against the available layout width and releases drag state', () => {
    renderCodeAgentRoom(codeAgentRoom);

    const resizeHandle = screen.getByLabelText('codeAgentResizeWorkspaceFiles');
    const layout = resizeHandle.closest('aside')?.parentElement as HTMLDivElement;
    expect(layout.dataset.codeAgentWorkspaceLayout).toBe('true');
    expect(resizeHandle.closest('aside')?.dataset.codeAgentFilesPanel).toBe('true');
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({
      width: 1600,
      height: 900,
      top: 0,
      right: 1600,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    dispatchPointer(resizeHandle, 'pointerdown', { pointerId: 4, clientX: 1200, buttons: 1 });
    dispatchPointer(resizeHandle, 'pointerleave', { pointerId: 4, clientX: 1190, buttons: 1 });
    dispatchPointer(window, 'pointermove', { pointerId: 4, clientX: 0, buttons: 1 });
    dispatchPointer(window, 'pointerup', { pointerId: 4, clientX: 0, buttons: 0 });
    dispatchPointer(window, 'pointermove', { pointerId: 4, clientX: 900, buttons: 1 });

    expect(layout.style.getPropertyValue('--code-agent-files-width')).toBe('1120px');
    expect(localStorage.getItem('roomtalk.codeWorkspace.fileManagerWidth')).toBe('1120');
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('lets the workspace panel grow to the chat-preserving cap', () => {
    renderCodeAgentRoom(codeAgentRoom);

    const resizeHandle = screen.getByLabelText('codeAgentResizeWorkspaceFiles');
    const layout = resizeHandle.closest('aside')?.parentElement as HTMLDivElement;
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({
      width: 1800,
      height: 900,
      top: 0,
      right: 1800,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    dispatchPointer(resizeHandle, 'pointerdown', { pointerId: 6, clientX: 1200, buttons: 1 });
    dispatchPointer(window, 'pointermove', { pointerId: 6, clientX: -2000, buttons: 1 });
    dispatchPointer(window, 'pointerup', { pointerId: 6, clientX: -2000, buttons: 0 });

    expect(layout.style.getPropertyValue('--code-agent-files-width')).toBe('1320px');
    expect(localStorage.getItem('roomtalk.codeWorkspace.fileManagerWidth')).toBe('1320');
  });

  it('finishes after a pressed viewport exit at the cap and ignores later movement', () => {
    renderCodeAgentRoom(codeAgentRoom);

    const resizeHandle = screen.getByLabelText('codeAgentResizeWorkspaceFiles');
    const layout = resizeHandle.closest('aside')?.parentElement as HTMLDivElement;
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({
      width: 1600,
      height: 900,
      top: 0,
      right: 1600,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    dispatchPointer(resizeHandle, 'pointerdown', { pointerId: 8, clientX: 1200, buttons: 1 });
    dispatchPointer(window, 'pointermove', { pointerId: 8, clientX: -800, buttons: 1 });
    const resizeGuard = document.querySelector('[data-horizontal-resize-guard="true"]') as HTMLElement;
    dispatchPointer(resizeGuard, 'pointerout', { pointerId: 8, clientX: -1, buttons: 1 });
    dispatchPointer(window, 'pointermove', { pointerId: 8, clientX: 900, buttons: 1 });
    dispatchPointer(window, 'pointerup', { pointerId: 8, clientX: 900, buttons: 0 });
    dispatchPointer(window, 'pointermove', { pointerId: 8, clientX: -800, buttons: 1 });

    expect(layout.style.getPropertyValue('--code-agent-files-width')).toBe('1120px');
    expect(localStorage.getItem('roomtalk.codeWorkspace.fileManagerWidth')).toBe('1120');
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('lets the workspace panel use wide layouts while preserving the chat pane', () => {
    renderCodeAgentRoom(codeAgentRoom);

    const resizeHandle = screen.getByLabelText('codeAgentResizeWorkspaceFiles');
    const layout = resizeHandle.closest('aside')?.parentElement as HTMLDivElement;
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({
      width: 2400,
      height: 900,
      top: 0,
      right: 2400,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    dispatchPointer(resizeHandle, 'pointerdown', { pointerId: 5, clientX: 1200, buttons: 1 });
    dispatchPointer(window, 'pointermove', { pointerId: 5, clientX: -2000, buttons: 1 });
    dispatchPointer(window, 'pointerup', { pointerId: 5, clientX: -2000, buttons: 0 });

    expect(layout.style.getPropertyValue('--code-agent-files-width')).toBe('1920px');
    expect(localStorage.getItem('roomtalk.codeWorkspace.fileManagerWidth')).toBe('1920');
  });

  it('shrinks the workspace files panel when the code-agent layout gets narrower', () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class MockResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();

      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    localStorage.setItem('roomtalk.codeWorkspace.fileManagerWidth', '760');

    renderCodeAgentRoom(codeAgentRoom);

    const resizeHandle = screen.getByLabelText('codeAgentResizeWorkspaceFiles');
    const layout = resizeHandle.closest('aside')?.parentElement as HTMLDivElement;
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({
      width: 700,
      height: 900,
      top: 0,
      right: 700,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    });

    expect(layout.style.getPropertyValue('--code-agent-files-width')).toBe('220px');
    expect(localStorage.getItem('roomtalk.codeWorkspace.fileManagerWidth')).toBe('220');
  });

  it('syncs the workspace files panel width after sidebar resizing compresses it', () => {
    localStorage.setItem('roomtalk.codeWorkspace.fileManagerWidth', '760');
    renderCodeAgentRoom(codeAgentRoom);

    const resizeHandle = screen.getByLabelText('codeAgentResizeWorkspaceFiles');
    const layout = resizeHandle.closest('aside')?.parentElement as HTMLDivElement;
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({
      width: 900,
      height: 900,
      top: 0,
      right: 900,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      layout.dispatchEvent(new CustomEvent<CodeAgentFilePanelWidthChangeDetail>(
        CODE_AGENT_FILE_PANEL_WIDTH_CHANGE_EVENT,
        { detail: { width: 760 } },
      ));
    });

    expect(layout.style.getPropertyValue('--code-agent-files-width')).toBe('420px');
    expect(localStorage.getItem('roomtalk.codeWorkspace.fileManagerWidth')).toBe('420');
  });

  it('opens the right file manager when a workspace diff file is selected', () => {
    localStorage.setItem('roomtalk.codeWorkspace.fileManagerCollapsed', 'true');

    renderCodeAgentRoom(codeAgentRoom);

    expect(screen.queryByTestId('file-browser')).toBeNull();

    fireEvent.click(screen.getByTestId('message-list'));

    const fileBrowser = screen.getByTestId('file-browser');
    expect(fileBrowser.dataset.openPath).toBe('src/App.tsx');
    expect(fileBrowser.dataset.openRequestId).toBe('1');
    expect(fileBrowser.dataset.revealLine).toBe('');
    expect(fileBrowser.dataset.revealRequestId).toBe('1');
    expect(screen.getByLabelText('codeAgentCollapseWorkspaceFiles')).toBeTruthy();
  });

  it('passes T3-style file reveal requests into the right file manager', () => {
    localStorage.setItem('roomtalk.codeWorkspace.fileManagerCollapsed', 'true');

    renderCodeAgentRoom(codeAgentRoom);

    fireEvent.click(screen.getByTestId('message-list-line-link'));

    let fileBrowser = screen.getByTestId('file-browser');
    expect(fileBrowser.dataset.openPath).toBe('src/App.tsx');
    expect(fileBrowser.dataset.openRequestId).toBe('1');
    expect(fileBrowser.dataset.revealLine).toBe('42');
    expect(fileBrowser.dataset.revealRequestId).toBe('1');

    fireEvent.click(screen.getByTestId('message-list-hash-line-link'));

    fileBrowser = screen.getByTestId('file-browser');
    expect(fileBrowser.dataset.openPath).toBe('src/App.tsx');
    expect(fileBrowser.dataset.openRequestId).toBe('2');
    expect(fileBrowser.dataset.revealLine).toBe('87');
    expect(fileBrowser.dataset.revealRequestId).toBe('2');
  });

  it('shows pending save markers on the desktop rail and mobile workspace sheet', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    renderCodeAgentRoom(codeAgentRoom);

    expect(screen.queryByTestId('code-agent-file-save-pending-indicator')).toBeNull();
    expect(screen.queryByTestId('code-agent-mobile-file-save-pending-indicator')).toBeNull();
    expect(screen.getByLabelText('codeAgentWorkspaceFiles').getAttribute('title')).toBe('codeAgentWorkspaceFiles');

    fireEvent.click(screen.getByTestId('file-save-pending-on'));

    expect(screen.getByTestId('code-agent-file-save-pending-indicator')).toBeTruthy();
    expect(screen.getByLabelText('codeAgentCollapseWorkspaceFiles - codeAgentWorkspaceFilesSavePending')).toBeTruthy();
    expect(screen.getByTestId('code-agent-mobile-file-save-pending-indicator')).toBeTruthy();
    const mobileWorkspaceButton = screen.getByLabelText('codeAgentWorkspaceFiles - codeAgentWorkspaceFilesSavePending');
    expect(mobileWorkspaceButton.getAttribute('title')).toBe('codeAgentWorkspaceFiles - codeAgentWorkspaceFilesSavePending');

    fireEvent.click(mobileWorkspaceButton);
    expect(screen.getByTestId('code-agent-mobile-sheet-file-save-pending-indicator')).toBeTruthy();

    fireEvent.click(screen.getAllByTestId('file-save-pending-off')[0]);

    expect(screen.queryByTestId('code-agent-file-save-pending-indicator')).toBeNull();
    expect(screen.queryByTestId('code-agent-mobile-file-save-pending-indicator')).toBeNull();
    expect(screen.queryByTestId('code-agent-mobile-sheet-file-save-pending-indicator')).toBeNull();
    expect(screen.getByLabelText('codeAgentCollapseWorkspaceFiles')).toBeTruthy();
    expect(screen.getByLabelText('codeAgentWorkspaceFiles').getAttribute('title')).toBe('codeAgentWorkspaceFiles');
  });

  it('opens the mobile workspace files entry on the files surface even after another surface was active', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    addCodeAgentRightPanelPreviewSurface('code-agent-room');
    expect(readCodeAgentRightPanelState('code-agent-room').activeSurfaceId).toBe('browser:new');

    renderCodeAgentRoom(codeAgentRoom);
    fireEvent.click(screen.getByLabelText('codeAgentWorkspaceFiles'));

    expect(screen.getByTestId('code-agent-mobile-file-manager-sheet').dataset.open).toBe('true');
    expect(readCodeAgentRightPanelState('code-agent-room').activeSurfaceId).toBe('files');
  });

  it('opens workspace artifacts in the mobile browser sheet', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    renderCodeAgentRoom(codeAgentRoom);
    fireEvent.click(screen.getByTestId('message-list-open-artifact'));

    expect(screen.getByTestId('code-agent-mobile-file-manager-sheet').dataset.open).toBe('true');
    expect(readCodeAgentRightPanelState('code-agent-room')).toMatchObject({
      isOpen: true,
      activeSurfaceId: 'browser:url:https%3A%2F%2Froom.example%2Fp%2Fmobile-demo%2F',
      surfaces: [{
        kind: 'preview',
        url: 'https://room.example/p/mobile-demo/',
      }],
    });
  });

  it('persists review comment drafts by room', () => {
    const storageKey = 'roomtalk.codeAgent.reviewComments.code-agent-room';
    const firstRender = renderCodeAgentRoom(codeAgentRoom);

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('0');

    fireEvent.click(screen.getByTestId('file-add-review-comment'));

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('1');
    expect(screen.getByText('Persist this review comment.')).toBeTruthy();
    expect(localStorage.getItem(storageKey)).toContain('Persist this review comment.');

    firstRender.unmount();
    const otherRoomRender = renderCodeAgentRoom({ ...codeAgentRoom, id: 'other-code-agent-room' });

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('0');
    expect(localStorage.getItem('roomtalk.codeAgent.reviewComments.other-code-agent-room')).toBeNull();

    otherRoomRender.unmount();
    renderCodeAgentRoom(codeAgentRoom);

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('1');
    expect(screen.getByText('Persist this review comment.')).toBeTruthy();

    fireEvent.click(screen.getByTestId('message-input-remove-review-comment'));

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('0');
    expect(localStorage.getItem(storageKey)).toBeNull();

    fireEvent.click(screen.getByTestId('file-add-review-comment'));
    expect(localStorage.getItem(storageKey)).toContain('Persist this review comment.');

    fireEvent.click(screen.getByTestId('message-input-clear-review-comments'));

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('0');
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('keeps mobile review draft contexts visible and removable inside the sheet', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const reviewStorageKey = 'roomtalk.codeAgent.reviewComments.code-agent-room';

    renderCodeAgentRoom(codeAgentRoom);

    expect(screen.queryByTestId('code-agent-mobile-review-drafts')).toBeNull();

    fireEvent.click(screen.getByTestId('file-add-review-comment'));
    fireEvent.click(screen.getByLabelText('codeAgentWorkspaceFiles'));

    const sheet = screen.getByTestId('code-agent-mobile-file-manager-sheet');
    const reviewDrafts = within(sheet).getByTestId('code-agent-mobile-review-drafts');
    expect(within(reviewDrafts).getByText('codeAgentPendingReviewComments')).toBeTruthy();
    expect(within(reviewDrafts).getByText('1')).toBeTruthy();
    expect(within(reviewDrafts).getByText('src/App.tsx L1 to L2')).toBeTruthy();
    expect(localStorage.getItem(reviewStorageKey)).toContain('Persist this review comment.');

    fireEvent.click(within(reviewDrafts).getByLabelText('codeAgentRemoveReviewComment'));

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('0');
    expect(within(sheet).queryByTestId('code-agent-mobile-review-drafts')).toBeNull();
    expect(localStorage.getItem(reviewStorageKey)).toBeNull();
  });

  it('constrains room edit mode when the server only allows plan mode', () => {
    localStorage.setItem('roomtalk_code_agent_mode_code-agent-room', 'acceptEdits');

    renderCodeAgentRoom({ ...codeAgentRoom, codeAgentMode: 'acceptEdits' }, ['plan']);

    expect(screen.getByTestId('message-list').dataset.codeAgentMode).toBe('plan');
    expect(screen.getByTestId('message-input').dataset.codeAgentAvailableModes).toBe('plan');
    expect(screen.getByTestId('file-browser').dataset.workspaceEditable).toBe('false');
  });
});
