// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRoomView } from './ChatRoomView';
import type { Room, RoomPermissions } from '../utils/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('./ChatHeader', () => ({
  ChatHeader: ({ isRoomSessionReady, canUseRetainedRoomAccess }: {
    isRoomSessionReady: boolean;
    canUseRetainedRoomAccess: boolean;
  }) => (
    <div
      data-testid="chat-header"
      data-session-ready={String(isRoomSessionReady)}
      data-retained-access={String(canUseRetainedRoomAccess)}
    />
  ),
}));

vi.mock('./MessageList', async () => {
  const ReactModule = await import('react');
  return {
    MessageList: ReactModule.forwardRef(({
      isRoomSessionReady,
      canUseRetainedRoomAccess,
    }: {
      isRoomSessionReady: boolean;
      canUseRetainedRoomAccess: boolean;
    }, ref: React.ForwardedRef<unknown>) => {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToBottom: vi.fn() }));
      return (
        <div
          data-testid="message-list"
          data-session-ready={String(isRoomSessionReady)}
          data-retained-access={String(canUseRetainedRoomAccess)}
        />
      );
    }),
  };
});

vi.mock('./MessageInput', () => ({
  MessageInput: ({ canPost, isRoomSessionReady, canUseRetainedRoomAccess, postingRestrictionReason }: {
    canPost: boolean;
    isRoomSessionReady?: boolean;
    canUseRetainedRoomAccess?: boolean;
    postingRestrictionReason?: string;
  }) => (
    <div
      data-testid="message-input"
      data-can-post={String(canPost)}
      data-session-ready={String(Boolean(isRoomSessionReady))}
      data-retained-access={String(Boolean(canUseRetainedRoomAccess))}
      data-restriction={postingRestrictionReason || ''}
    />
  ),
}));

vi.mock('@heroui/react', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const currentRoom: Room = {
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-07-10T00:00:00.000Z',
  creatorId: 'client-1',
};

const roomPermissions: RoomPermissions = {
  roomId: currentRoom.id,
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
};

const renderRoom = (
  isRoomSessionReady: boolean,
  canUseRetainedRoomAccess = isRoomSessionReady,
) => render(
  <ChatRoomView
    currentRoom={currentRoom}
    memberCount={1}
    isRestoringRoom={!isRoomSessionReady}
    isRoomSessionReady={isRoomSessionReady}
    canUseRetainedRoomAccess={canUseRetainedRoomAccess}
    ensureRoomSessionReady={vi.fn(async () => {})}
    onRetryRoomSession={vi.fn()}
    username="User"
    clientId="client-1"
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

describe('ChatRoomView room session guard', () => {
  afterEach(cleanup);

  it('renders cached messages read-only while the stored room is being verified', () => {
    renderRoom(false);

    expect(screen.getByTestId('chat-header').dataset.sessionReady).toBe('false');
    expect(screen.getByTestId('message-list').dataset.sessionReady).toBe('false');
    expect(screen.getByTestId('message-input').dataset.canPost).toBe('false');
    expect(screen.getByTestId('message-input').dataset.sessionReady).toBe('false');
    expect(screen.getByTestId('message-input').dataset.restriction).toBe('loading');
  });

  it('keeps acknowledged room actions available during a transient reconnect', () => {
    renderRoom(false, true);

    expect(screen.getByTestId('chat-header').dataset.retainedAccess).toBe('true');
    expect(screen.getByTestId('message-list').dataset.sessionReady).toBe('false');
    expect(screen.getByTestId('message-list').dataset.retainedAccess).toBe('true');
    expect(screen.getByTestId('message-input').dataset.canPost).toBe('true');
    expect(screen.getByTestId('message-input').dataset.sessionReady).toBe('false');
    expect(screen.getByTestId('message-input').dataset.retainedAccess).toBe('true');
    expect(screen.getByTestId('message-input').dataset.restriction).toBe('');
  });

  it('re-enables posting after the room session is verified', () => {
    renderRoom(true);
    expect(screen.getByTestId('message-input').dataset.canPost).toBe('true');
    expect(screen.getByTestId('message-input').dataset.sessionReady).toBe('true');
  });
});
