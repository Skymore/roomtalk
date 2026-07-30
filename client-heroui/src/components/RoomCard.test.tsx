// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../utils/types';
import { RoomCard } from './RoomCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

const room: Room = {
  id: 'room-1',
  name: 'Test Room',
  description: '',
  createdAt: '2026-05-04T00:00:00.000Z',
  creatorId: 'client-1',
};

const renderRoomCard = (roomOverride: Room = room) => {
  const props = {
    room: roomOverride,
    clientId: 'client-1',
    copiedRoomId: null,
    copiedLinkId: null,
    onSelect: vi.fn(),
    onCopyRoomId: vi.fn(),
    onCopyRoomLink: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };

  render(<RoomCard {...props} />);
  return props;
};

describe('RoomCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('selects the room when the card is pressed', () => {
    const props = renderRoomCard();
    const card = screen.getByText('Test Room').closest('button');

    expect(card).not.toBeNull();
    expect(screen.getByTestId('room-card').className).toContain('rounded-lg');
    fireEvent.click(card!);

    expect(props.onSelect).toHaveBeenCalledWith(room);
  });

  it('keeps secondary room actions in one menu without selecting the room', async () => {
    const props = renderRoomCard();

    const openMenu = () => fireEvent.click(screen.getByLabelText('moreActions Test Room'));

    openMenu();
    fireEvent.click(await screen.findByText('copyRoomId'));
    await waitFor(() => expect(screen.queryByText('share')).toBeNull());
    openMenu();
    fireEvent.click(await screen.findByText('share'));
    await waitFor(() => expect(screen.queryByText('editRoomName')).toBeNull());
    openMenu();
    fireEvent.click(await screen.findByText('editRoomName'));
    await waitFor(() => expect(screen.queryByText('deleteRoom')).toBeNull());
    openMenu();
    fireEvent.click(await screen.findByText('deleteRoom'));

    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onCopyRoomId).toHaveBeenCalledWith('room-1');
    expect(props.onCopyRoomLink).toHaveBeenCalledWith('room-1');
    expect(props.onRename).toHaveBeenCalledWith(room);
    expect(props.onDelete).toHaveBeenCalledWith(room);
  });

  it('shows the complete room ID', () => {
    renderRoomCard({
      ...room,
      id: 'nZDcDhQE1234567890',
    });

    expect(screen.getByText('nZDcDhQE1234567890')).toBeTruthy();
  });

  it('distinguishes code-agent rooms by icon without status badges', () => {
    renderRoomCard({
      ...room,
      type: 'codeAgent',
      sandboxStatus: 'ready',
      codeAgentStatus: 'running',
    });

    expect(screen.getByTitle('codeAgentRoomType')).toBeTruthy();
    expect(screen.queryByText('codeAgentRoomType')).toBeNull();
    expect(screen.queryByText('sandboxStatusReady')).toBeNull();
    expect(screen.queryByText('codeAgentStatusRunning')).toBeNull();
    expect(screen.getByTestId('room-card').className).toContain('rounded-lg');
  });
});
