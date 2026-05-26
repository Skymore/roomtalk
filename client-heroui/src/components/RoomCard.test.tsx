// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

    expect(props.onSelect).toHaveBeenCalledWith('room-1');
  });

  it('does not select the room when action buttons are clicked', () => {
    const props = renderRoomCard();

    fireEvent.click(screen.getByLabelText('copyRoomId'));
    fireEvent.click(screen.getByLabelText('share'));
    fireEvent.click(screen.getByLabelText('editRoomName'));
    fireEvent.click(screen.getByLabelText('deleteRoom'));

    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onCopyRoomId).toHaveBeenCalledWith('room-1');
    expect(props.onCopyRoomLink).toHaveBeenCalledWith('room-1');
    expect(props.onRename).toHaveBeenCalledWith(room);
    expect(props.onDelete).toHaveBeenCalledWith(room);
  });

  it('shows Coco room status without changing card shape', () => {
    renderRoomCard({
      ...room,
      type: 'coco',
      sandboxStatus: 'ready',
      cocoStatus: 'running',
    });

    expect(screen.getByText('codeAgentRoomType')).toBeTruthy();
    expect(screen.getByText('sandboxStatusReady')).toBeTruthy();
    expect(screen.getByText('cocoStatusRunning')).toBeTruthy();
    expect(screen.getByTestId('room-card').className).toContain('rounded-lg');
  });
});
