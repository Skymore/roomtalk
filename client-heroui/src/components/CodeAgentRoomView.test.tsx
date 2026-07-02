// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../utils/types';
import { CODE_AGENT_FILE_PANEL_WIDTH_CHANGE_EVENT, type CodeAgentFilePanelWidthChangeDetail } from '../utils/codeAgentPanelLayout';
import type { ReviewCommentContext } from '../utils/codeAgentReviewComments';
import type { CodeAgentPreviewAnnotationContext } from '../utils/codeAgentPreviewAnnotations';
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
      onOpenWorkspaceFile,
    }: {
      codeAgentMode: string;
      onOpenWorkspaceFile?: (path: string) => void;
    }, ref: React.ForwardedRef<unknown>) => {
    React.useImperativeHandle(ref, () => ({ scrollToBottom: vi.fn() }));
    return (
      <>
      <button
        type="button"
        data-testid="message-list"
        data-code-agent-mode={codeAgentMode}
        onClick={() => onOpenWorkspaceFile?.('/workspace/src/App.tsx')}
      >
        open-file
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
    codeAgentMaxMode,
    isCodeAgentRoom,
    reviewComments = [],
    onRemoveReviewComment,
    onClearReviewComments,
    previewAnnotations = [],
    onRemovePreviewAnnotation,
    onClearPreviewAnnotations,
  }: {
    codeAgentMode: string;
    codeAgentMaxMode: string;
    isCodeAgentRoom?: boolean;
    reviewComments?: readonly ReviewCommentContext[];
    onRemoveReviewComment?: (commentId: string) => void;
    onClearReviewComments?: () => void;
    previewAnnotations?: readonly CodeAgentPreviewAnnotationContext[];
    onRemovePreviewAnnotation?: (annotationId: string) => void;
    onClearPreviewAnnotations?: () => void;
  }) => (
    <div
      data-testid="message-input"
      data-code-agent-room={String(Boolean(isCodeAgentRoom))}
      data-code-agent-mode={codeAgentMode}
      data-code-agent-max-mode={codeAgentMaxMode}
      data-review-comments={String(reviewComments.length)}
      data-preview-annotations={String(previewAnnotations.length)}
    >
      {reviewComments.map((comment) => (
        <span key={comment.id}>{comment.text}</span>
      ))}
      {previewAnnotations.map((annotation) => (
        <span key={annotation.id}>{annotation.pageTitle || annotation.pageUrl}</span>
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
      <button
        type="button"
        data-testid="message-input-remove-preview-annotation"
        onClick={() => {
          if (previewAnnotations[0]) {
            onRemovePreviewAnnotation?.(previewAnnotations[0].id);
          }
        }}
      />
      <button
        type="button"
        data-testid="message-input-clear-preview-annotations"
        onClick={() => onClearPreviewAnnotations?.()}
      />
    </div>
  ),
}));

vi.mock('./CodeAgentFileBrowserPanel', () => ({
  CodeAgentFileBrowserPanel: ({
    surface,
    sandboxStatus,
    sandboxUpdatedAt,
    openFileRequest,
    revealLine,
    revealRequestId,
    onAddReviewComment,
    onAddPreviewAnnotation,
    onFileSavePendingChange,
  }: {
    surface?: 'desktop' | 'mobile';
    sandboxStatus?: string;
    sandboxUpdatedAt?: string;
    openFileRequest?: { path: string; requestId: number } | null;
    revealLine?: number | null;
    revealRequestId?: number;
    onAddReviewComment?: (comment: ReviewCommentContext) => void;
    onAddPreviewAnnotation?: (annotation: CodeAgentPreviewAnnotationContext) => void;
    onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  }) => (
    <>
      <div
        data-testid="file-browser"
        data-surface={surface || ''}
        data-sandbox-status={sandboxStatus}
        data-sandbox-updated-at={sandboxUpdatedAt}
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
      <button
        type="button"
        data-testid="file-add-preview-annotation"
        onClick={() => onAddPreviewAnnotation?.({
          id: 'annotation-1',
          pageUrl: 'https://example.com/app',
          pageTitle: 'Preview app',
          comment: '',
          elements: [{
            id: 'element-1',
            element: {
              pageUrl: 'https://example.com/app',
              pageTitle: 'Preview app',
              tagName: 'button',
              selector: '#save',
              htmlPreview: '<button id="save">Save</button>',
              componentName: null,
              source: null,
              stack: [],
              styles: 'display: inline-flex;',
              pickedAt: '2026-07-02T00:00:00.000Z',
            },
            rect: { x: 10, y: 20, width: 120, height: 32 },
          }],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: null,
          createdAt: '2026-07-02T00:00:00.000Z',
        })}
      />
    </>
  ),
}));

vi.mock('../utils/socket', () => ({
  updateRoomSettings: vi.fn(async ({ roomId, codeAgentMode }: { roomId: string; codeAgentMode: 'plan' | 'acceptEdits' }) => ({
    id: roomId,
    name: 'Coco Room',
    creatorId: 'client-1',
    createdAt: '2026-05-26T00:00:00.000Z',
    type: 'coco',
    codeAgentMode,
  })),
}));

const unsupportedRoom: Room = {
  id: 'room-1',
  name: 'Codex Room',
  creatorId: 'client-1',
  createdAt: '2026-05-26T00:00:00.000Z',
  type: 'codex' as Room['type'],
};

const cocoRoom: Room = {
  id: 'coco-room',
  name: 'Coco Room',
  creatorId: 'client-1',
  createdAt: '2026-05-26T00:00:00.000Z',
  type: 'coco',
  sandboxStatus: 'ready',
  sandboxUpdatedAt: '2026-06-30T10:00:00.000Z',
  cocoStatus: 'idle',
};

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
  availableModes: Array<'plan' | 'acceptEdits'> = room.codeAgentMode === 'acceptEdits' ? ['plan', 'acceptEdits'] : ['plan'],
  defaultMode: 'plan' | 'acceptEdits' = 'plan'
) => render(
  <CodeAgentRoomView
    currentRoom={room}
    memberCount={1}
    isRestoringRoom={false}
    username="User"
    clientId="client-1"
    backend={room.type === 'coco' ? 'coco' : 'codex'}
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
    roomPermissions={null}
    onRoomUpdated={vi.fn()}
  />
);

describe('CodeAgentRoomView', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a controlled unavailable state for a backend that is not wired yet', () => {
    renderCodeAgentRoom(unsupportedRoom);

    expect(screen.getByTestId('chat-header')).toBeTruthy();
    expect(screen.getByText('codeAgentBackendUnavailable')).toBeTruthy();
    expect(screen.getByText('codeAgentBackendUnavailableDescription')).toBeTruthy();
    expect(screen.queryByTestId('message-input-panel')).toBeNull();
  });

  it('passes the selected Coco run mode to the workspace and composer', () => {
    renderCodeAgentRoom({ ...cocoRoom, codeAgentMode: 'acceptEdits' });

    expect(screen.getByTestId('message-list').dataset.codeAgentMode).toBe('acceptEdits');
    expect(screen.getByTestId('message-input').dataset.codeAgentRoom).toBe('true');
    expect(screen.getByTestId('message-input').dataset.codeAgentMode).toBe('acceptEdits');
    expect(screen.getByTestId('message-input').dataset.codeAgentMaxMode).toBe('acceptEdits');
    expect(screen.getByTestId('file-browser').dataset.sandboxStatus).toBe('ready');
    expect(screen.getByTestId('file-browser').dataset.sandboxUpdatedAt).toBe('2026-06-30T10:00:00.000Z');
    expect(screen.getByLabelText('codeAgentResizeWorkspaceFiles')).toBeTruthy();
    expect(screen.getByLabelText('codeAgentCollapseWorkspaceFiles')).toBeTruthy();
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

    renderCodeAgentRoom(cocoRoom);

    const desktopFileBrowser = screen.getByTestId('file-browser');
    expect(desktopFileBrowser.dataset.surface).toBe('desktop');
    const layout = desktopFileBrowser.closest('[data-code-agent-workspace-layout="true"]') as HTMLDivElement;
    expect(layout.style.getPropertyValue('--code-agent-chat-min-width')).toBe('480px');
    expect(layout.style.getPropertyValue('--code-agent-composer-height')).toMatch(/px$/);
    expect(layout.className).toContain('lg:grid-cols-[minmax(var(--code-agent-chat-min-width),1fr)_minmax(0,var(--code-agent-files-width))]');
    expect(desktopFileBrowser.parentElement?.classList.contains('flex')).toBe(true);
    expect(desktopFileBrowser.parentElement?.classList.contains('min-h-0')).toBe(true);
    expect(screen.getByTestId('message-list').parentElement?.dataset.codeAgentChatPane).toBe('true');
    expect(screen.getByTestId('message-list').parentElement?.classList.contains('min-w-0')).toBe(true);
    expect(screen.getByTestId('message-list').parentElement?.classList.contains('lg:min-w-[var(--code-agent-chat-min-width)]')).toBe(true);
    expect(screen.getByTestId('message-list').parentElement?.classList.contains('min-w-[var(--code-agent-chat-min-width)]')).toBe(false);

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

    renderCodeAgentRoom(cocoRoom);

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

    renderCodeAgentRoom(cocoRoom);

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
    renderCodeAgentRoom(cocoRoom);

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
    renderCodeAgentRoom(cocoRoom);

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
    renderCodeAgentRoom(cocoRoom);

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
    renderCodeAgentRoom(cocoRoom);

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
    renderCodeAgentRoom(cocoRoom);

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

    renderCodeAgentRoom(cocoRoom);

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
    renderCodeAgentRoom(cocoRoom);

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

    renderCodeAgentRoom(cocoRoom);

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

    renderCodeAgentRoom(cocoRoom);

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

    renderCodeAgentRoom(cocoRoom);

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

  it('persists T3-style review comment drafts by room', () => {
    const storageKey = 'roomtalk.codeAgent.reviewComments.coco-room';
    const firstRender = renderCodeAgentRoom(cocoRoom);

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('0');

    fireEvent.click(screen.getByTestId('file-add-review-comment'));

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('1');
    expect(screen.getByText('Persist this review comment.')).toBeTruthy();
    expect(localStorage.getItem(storageKey)).toContain('Persist this review comment.');

    firstRender.unmount();
    const otherRoomRender = renderCodeAgentRoom({ ...cocoRoom, id: 'other-coco-room' });

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('0');
    expect(localStorage.getItem('roomtalk.codeAgent.reviewComments.other-coco-room')).toBeNull();

    otherRoomRender.unmount();
    renderCodeAgentRoom(cocoRoom);

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

  it('keeps mobile workspace draft contexts visible and removable inside the sheet', () => {
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
    const reviewStorageKey = 'roomtalk.codeAgent.reviewComments.coco-room';
    const previewStorageKey = 'roomtalk.codeAgent.previewAnnotations.coco-room';

    renderCodeAgentRoom(cocoRoom);

    expect(screen.queryByTestId('code-agent-mobile-review-drafts')).toBeNull();
    expect(screen.queryByTestId('code-agent-mobile-preview-annotation-drafts')).toBeNull();

    fireEvent.click(screen.getByTestId('file-add-review-comment'));
    fireEvent.click(screen.getByTestId('file-add-preview-annotation'));
    fireEvent.click(screen.getByLabelText('codeAgentWorkspaceFiles'));

    const sheet = screen.getByTestId('code-agent-mobile-file-manager-sheet');
    const reviewDrafts = within(sheet).getByTestId('code-agent-mobile-review-drafts');
    const previewDrafts = within(sheet).getByTestId('code-agent-mobile-preview-annotation-drafts');
    expect(within(reviewDrafts).getByText('codeAgentPendingReviewComments')).toBeTruthy();
    expect(within(reviewDrafts).getByText('1')).toBeTruthy();
    expect(within(reviewDrafts).getByText('src/App.tsx L1 to L2')).toBeTruthy();
    expect(localStorage.getItem(reviewStorageKey)).toContain('Persist this review comment.');
    expect(within(previewDrafts).getByText('codeAgentPendingPreviewAnnotations')).toBeTruthy();
    expect(within(previewDrafts).getByText('1')).toBeTruthy();
    expect(within(previewDrafts).getByText('Preview app <button>')).toBeTruthy();
    expect(localStorage.getItem(previewStorageKey)).toContain('Preview app');

    fireEvent.click(within(reviewDrafts).getByLabelText('codeAgentRemoveReviewComment'));

    expect(screen.getByTestId('message-input').dataset.reviewComments).toBe('0');
    expect(within(sheet).queryByTestId('code-agent-mobile-review-drafts')).toBeNull();
    expect(within(sheet).getByTestId('code-agent-mobile-preview-annotation-drafts')).toBeTruthy();
    expect(localStorage.getItem(reviewStorageKey)).toBeNull();

    fireEvent.click(within(previewDrafts).getByLabelText('codeAgentRemovePreviewAnnotation'));

    expect(screen.getByTestId('message-input').dataset.previewAnnotations).toBe('0');
    expect(within(sheet).queryByTestId('code-agent-mobile-preview-annotation-drafts')).toBeNull();
    expect(localStorage.getItem(previewStorageKey)).toBeNull();
  });

  it('persists preview annotation drafts by room', () => {
    const storageKey = 'roomtalk.codeAgent.previewAnnotations.coco-room';
    const firstRender = renderCodeAgentRoom(cocoRoom);

    expect(screen.getByTestId('message-input').dataset.previewAnnotations).toBe('0');

    fireEvent.click(screen.getByTestId('file-add-preview-annotation'));

    expect(screen.getByTestId('message-input').dataset.previewAnnotations).toBe('1');
    expect(screen.getByText('Preview app')).toBeTruthy();
    expect(localStorage.getItem(storageKey)).toContain('Preview app');
    expect(localStorage.getItem(storageKey)).not.toContain('data:image/png');

    firstRender.unmount();
    const otherRoomRender = renderCodeAgentRoom({ ...cocoRoom, id: 'other-coco-room' });

    expect(screen.getByTestId('message-input').dataset.previewAnnotations).toBe('0');
    expect(localStorage.getItem('roomtalk.codeAgent.previewAnnotations.other-coco-room')).toBeNull();

    otherRoomRender.unmount();
    renderCodeAgentRoom(cocoRoom);

    expect(screen.getByTestId('message-input').dataset.previewAnnotations).toBe('1');
    expect(screen.getByText('Preview app')).toBeTruthy();

    fireEvent.click(screen.getByTestId('message-input-remove-preview-annotation'));

    expect(screen.getByTestId('message-input').dataset.previewAnnotations).toBe('0');
    expect(localStorage.getItem(storageKey)).toBeNull();

    fireEvent.click(screen.getByTestId('file-add-preview-annotation'));
    expect(localStorage.getItem(storageKey)).toContain('Preview app');

    fireEvent.click(screen.getByTestId('message-input-clear-preview-annotations'));

    expect(screen.getByTestId('message-input').dataset.previewAnnotations).toBe('0');
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('constrains room edit mode when the server only allows plan mode', () => {
    localStorage.setItem('roomtalk_code_agent_mode_coco-room', 'acceptEdits');

    renderCodeAgentRoom({ ...cocoRoom, codeAgentMode: 'acceptEdits' }, ['plan']);

    expect(screen.getByTestId('message-list').dataset.codeAgentMode).toBe('plan');
    expect(screen.getByTestId('message-input').dataset.codeAgentMaxMode).toBe('plan');
  });
});
