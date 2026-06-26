// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../utils/types';
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
    MessageList: React.forwardRef(({ codeAgentMode }: { codeAgentMode: string }, ref: React.ForwardedRef<unknown>) => {
    React.useImperativeHandle(ref, () => ({ scrollToBottom: vi.fn() }));
    return <div data-testid="message-list" data-code-agent-mode={codeAgentMode} />;
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
  cocoStatus: 'idle',
};

const renderCodeAgentRoom = (room: Room, mode: 'plan' | 'acceptEdits') => render(
  <CodeAgentRoomView
    currentRoom={room}
    memberCount={1}
    isRestoringRoom={false}
    username="User"
    clientId="client-1"
    backend={room.type === 'coco' ? 'coco' : 'codex'}
    mode={mode}
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
  });

  it('shows a controlled unavailable state for a backend that is not wired yet', () => {
    renderCodeAgentRoom(unsupportedRoom, 'plan');

    expect(screen.getByTestId('chat-header')).toBeTruthy();
    expect(screen.getByText('codeAgentBackendUnavailable')).toBeTruthy();
    expect(screen.getByText('codeAgentBackendUnavailableDescription')).toBeTruthy();
    expect(screen.queryByTestId('message-input-panel')).toBeNull();
  });

  it('passes the selected Coco run mode to the workspace and composer', () => {
    renderCodeAgentRoom(cocoRoom, 'acceptEdits');

    expect(screen.getByTestId('message-list').dataset.codeAgentMode).toBe('plan');
    expect(screen.getByTestId('message-input').dataset.codeAgentRoom).toBe('true');
    expect(screen.getByTestId('message-input').dataset.codeAgentMode).toBe('plan');
    expect(screen.getByTestId('message-input').dataset.codeAgentMaxMode).toBe('acceptEdits');
  });
});
