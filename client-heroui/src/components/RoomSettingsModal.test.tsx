// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, RoomPermissions } from '../utils/types';
import { RoomSettingsModal } from './RoomSettingsModal';

const socketMocks = vi.hoisted(() => ({
  getRoomRoleMembers: vi.fn(async () => []),
  on: vi.fn(),
  off: vi.fn(),
}));
const i18nMock = vi.hoisted(() => ({
  t: (key: string) => key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: i18nMock.t,
  }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('../utils/socket', () => ({
  getRoomRoleMembers: socketMocks.getRoomRoleMembers,
  lookupRoomClient: vi.fn(),
  removeRoomAdmin: vi.fn(),
  removeRoomMember: vi.fn(),
  setRoomAdmin: vi.fn(),
  transferRoomOwnership: vi.fn(),
  updateRoomSettings: vi.fn(),
  socket: {
    on: socketMocks.on,
    off: socketMocks.off,
  },
}));

vi.mock('./HoverTooltip', () => ({
  HoverTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./PostingScheduleEditor', () => ({
  PostingScheduleEditor: () => <div>postingScheduleEditor</div>,
}));

const room: Room = {
  id: 'room-1',
  name: 'Test room',
  creatorId: 'client-1',
  createdAt: '2026-07-10T00:00:00.000Z',
  type: 'chat',
};

const permissions: RoomPermissions = {
  roomId: room.id,
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
  canUseCodeAgent: false,
};

const renderModal = () => render(
  <RoomSettingsModal
    isOpen
    room={room}
    roomPermissions={permissions}
    clientId="client-1"
    onClose={vi.fn()}
    onRenameRoom={vi.fn(async () => undefined)}
    onClearHistory={vi.fn(async () => undefined)}
    onDeleteRoom={vi.fn()}
  />,
);

describe('RoomSettingsModal tabs', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('connects tabs to one active panel and uses roving tabindex', async () => {
    renderModal();

    const tabs = await screen.findAllByRole('tab');
    const panel = screen.getByRole('tabpanel');

    expect(tabs).toHaveLength(4);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('tabindex')).toBe('0');
    expect(tabs.slice(1).every(tab => tab.getAttribute('tabindex') === '-1')).toBe(true);
    expect(tabs[0].getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id);
    tabs.forEach((tab) => {
      const controlledPanel = document.getElementById(tab.getAttribute('aria-controls') || '');
      expect(controlledPanel).toBeTruthy();
      expect(controlledPanel?.getAttribute('aria-labelledby')).toBe(tab.id);
    });
  });

  it('moves selection and focus with arrow, Home, and End keys', async () => {
    renderModal();

    const tabs = await screen.findAllByRole('tab');
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });

    await waitFor(() => expect(tabs[1].getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(tabs[1]);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[1].id);

    fireEvent.keyDown(tabs[1], { key: 'End' });
    await waitFor(() => expect(tabs[3].getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(tabs[3]);

    fireEvent.keyDown(tabs[3], { key: 'Home' });
    await waitFor(() => expect(tabs[0].getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('blocks an overlong inline room rename before submit', async () => {
    renderModal();
    const input = await screen.findByLabelText('roomName');
    fireEvent.change(input, { target: { value: 'x'.repeat(21) } });

    expect(input.getAttribute('maxlength')).toBe('20');
    expect(await screen.findByText('errorRoomNameTooLong')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
