// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../utils/types';
import { ChatHeader } from './ChatHeader';

const notificationMocks = vi.hoisted(() => ({
  getRoomNotificationsMuted: vi.fn(async () => false),
  setRoomNotificationsMuted: vi.fn(async (_roomId: string, muted: boolean) => muted),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon, ...props }: React.HTMLAttributes<HTMLSpanElement> & { icon: string }) => (
    <span data-icon={icon} {...props} />
  ),
}));

vi.mock('../hooks/useIsTouchDevice', () => ({
  useIsTouchDevice: () => false,
}));

vi.mock('../utils/socket', () => ({
  getRoomMembers: vi.fn(async () => []),
}));

vi.mock('../utils/pushNotifications', () => ({
  getRoomNotificationsMuted: notificationMocks.getRoomNotificationsMuted,
  setRoomNotificationsMuted: notificationMocks.setRoomNotificationsMuted,
}));

vi.mock('./RoomSettingsModal', () => ({
  RoomSettingsModal: () => null,
}));

vi.mock('./PostingScheduleDetails', () => ({
  PostingScheduleDetails: () => null,
}));

const room: Room = {
  id: 'room-1',
  name: 'Test room',
  creatorId: 'client-1',
  createdAt: '2026-09-22T00:00:00.000Z',
  type: 'chat',
};

const renderHeader = () => render(
  <ChatHeader
    currentRoom={room}
    memberCount={1}
    isRestoringRoom={false}
    isRoomSessionReady
    canUseRetainedRoomAccess
    ensureRoomSessionReady={vi.fn(async () => undefined)}
    onRetryRoomSession={vi.fn()}
    handleCopyToClipboard={vi.fn()}
    handleShareRoom={vi.fn()}
    handleToggleSave={vi.fn()}
    handleLeaveRoom={vi.fn()}
    isRoomSaved={() => false}
    setView={vi.fn()}
    clearRoomUrlParam={vi.fn()}
    handleClearChatMessages={vi.fn()}
    handleDeleteRoom={vi.fn()}
    handleRenameRoom={vi.fn(async () => undefined)}
    roomPermissions={null}
    clientId="client-1"
    onRoomUpdated={vi.fn()}
  />,
);

describe('ChatHeader room notification indicator', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    notificationMocks.getRoomNotificationsMuted.mockResolvedValue(false);
  });

  it('shows a muted icon before the room name when room notifications are disabled', async () => {
    notificationMocks.getRoomNotificationsMuted.mockResolvedValueOnce(true);
    renderHeader();

    const title = screen.getByTestId('chat-room-title');
    const mutedIcon = await screen.findByTestId('room-notifications-muted-icon');

    expect(notificationMocks.getRoomNotificationsMuted).toHaveBeenCalledWith('room-1');
    expect(mutedIcon.getAttribute('data-icon')).toBe('lucide:bell-off');
    expect(title.firstElementChild).toBe(mutedIcon);
    expect(title.textContent).toContain('Test room');
  });

  it('does not show the icon when room notifications are enabled', async () => {
    renderHeader();

    await waitFor(() => expect(notificationMocks.getRoomNotificationsMuted).toHaveBeenCalledWith('room-1'));
    expect(screen.queryByTestId('room-notifications-muted-icon')).toBeNull();
  });
});
