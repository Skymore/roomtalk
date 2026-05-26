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

const unsupportedRoom: Room = {
  id: 'room-1',
  name: 'Codex Room',
  creatorId: 'client-1',
  createdAt: '2026-05-26T00:00:00.000Z',
  type: 'codex' as Room['type'],
};

describe('CodeAgentRoomView', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows a controlled unavailable state for a backend that is not wired yet', () => {
    render(
      <CodeAgentRoomView
        currentRoom={unsupportedRoom}
        memberCount={1}
        memberEvent={null}
        username="User"
        clientId="client-1"
        backend="codex"
        mode="plan"
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
      />
    );

    expect(screen.getByTestId('chat-header')).toBeTruthy();
    expect(screen.getByText('codeAgentBackendUnavailable')).toBeTruthy();
    expect(screen.getByText('codeAgentBackendUnavailableDescription')).toBeTruthy();
    expect(screen.queryByTestId('message-input-panel')).toBeNull();
  });
});
