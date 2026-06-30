// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../utils/types';
import { CODE_AGENT_FILE_PANEL_WIDTH_CHANGE_EVENT, type CodeAgentFilePanelWidthChangeDetail } from '../utils/codeAgentPanelLayout';
import { CodeAgentRoomView } from './CodeAgentRoomView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
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
      <button
        type="button"
        data-testid="message-list"
        data-code-agent-mode={codeAgentMode}
        onClick={() => onOpenWorkspaceFile?.('/workspace/src/App.tsx')}
      />
    );
    }),
  };
});

vi.mock('./MessageInput', () => ({
  MessageInput: ({ codeAgentMode, codeAgentMaxMode, isCodeAgentRoom }: { codeAgentMode: string; codeAgentMaxMode: string; isCodeAgentRoom?: boolean }) => (
    <div
      data-testid="message-input"
      data-code-agent-room={String(Boolean(isCodeAgentRoom))}
      data-code-agent-mode={codeAgentMode}
      data-code-agent-max-mode={codeAgentMaxMode}
    />
  ),
}));

vi.mock('./CodeAgentFileBrowserPanel', () => ({
  CodeAgentFileBrowserPanel: ({
    sandboxStatus,
    sandboxUpdatedAt,
    openFileRequest,
  }: {
    sandboxStatus?: string;
    sandboxUpdatedAt?: string;
    openFileRequest?: { path: string; requestId: number } | null;
  }) => (
    <div
      data-testid="file-browser"
      data-sandbox-status={sandboxStatus}
      data-sandbox-updated-at={sandboxUpdatedAt}
      data-open-path={openFileRequest?.path || ''}
      data-open-request-id={openFileRequest?.requestId || ''}
    />
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
  values: { pointerId: number; clientX: number; buttons: number; button?: number },
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    clientX: { value: values.clientX },
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
    renderCodeAgentRoom(cocoRoom);

    const desktopFileBrowser = screen.getByTestId('file-browser');
    const layout = desktopFileBrowser.closest('[data-code-agent-workspace-layout="true"]') as HTMLDivElement;
    expect(layout.style.getPropertyValue('--code-agent-chat-min-width')).toBe('480px');
    expect(layout.className).toContain('lg:grid-cols-[minmax(var(--code-agent-chat-min-width),1fr)_var(--code-agent-files-width)]');
    expect(desktopFileBrowser.parentElement?.classList.contains('flex')).toBe(true);
    expect(desktopFileBrowser.parentElement?.classList.contains('min-h-0')).toBe(true);
    expect(screen.getByTestId('message-list').parentElement?.dataset.codeAgentChatPane).toBe('true');
    expect(screen.getByTestId('message-list').parentElement?.classList.contains('min-w-[30rem]')).toBe(true);

    fireEvent.click(screen.getByLabelText('codeAgentWorkspaceFiles'));
    const fileBrowsers = screen.getAllByTestId('file-browser');
    expect(fileBrowsers).toHaveLength(2);
    const mobileFileBrowser = fileBrowsers.find((element) => element !== desktopFileBrowser);
    expect(mobileFileBrowser?.parentElement?.classList.contains('flex')).toBe(true);
    expect(mobileFileBrowser?.parentElement?.classList.contains('min-h-0')).toBe(true);
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
    dispatchPointer(window, 'pointermove', { pointerId: 4, clientX: 0, buttons: 1 });
    dispatchPointer(window, 'pointerup', { pointerId: 4, clientX: 0, buttons: 0 });

    expect(layout.style.getPropertyValue('--code-agent-files-width')).toBe('1120px');
    expect(localStorage.getItem('roomtalk.codeWorkspace.fileManagerWidth')).toBe('1120');
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('lets the workspace panel grow up to the reserved chat width on wide layouts', () => {
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
    expect(screen.getByLabelText('codeAgentCollapseWorkspaceFiles')).toBeTruthy();
  });

  it('constrains room edit mode when the server only allows plan mode', () => {
    localStorage.setItem('roomtalk_code_agent_mode_coco-room', 'acceptEdits');

    renderCodeAgentRoom({ ...cocoRoom, codeAgentMode: 'acceptEdits' }, ['plan']);

    expect(screen.getByTestId('message-list').dataset.codeAgentMode).toBe('plan');
    expect(screen.getByTestId('message-input').dataset.codeAgentMaxMode).toBe('plan');
  });
});
