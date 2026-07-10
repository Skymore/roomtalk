// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomRenameModal } from './RoomRenameModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const room = {
  id: 'room-1',
  name: 'Room 1',
  description: '',
  creatorId: 'client-1',
  createdAt: '2026-07-10T00:00:00.000Z',
};

describe('RoomRenameModal validation', () => {
  afterEach(cleanup);

  it('shows immediate length validation and disables Save', async () => {
    const onRename = vi.fn(async () => undefined);
    render(
      <RoomRenameModal
        isOpen
        room={room}
        onClose={vi.fn()}
        onRename={onRename}
      />,
    );

    const input = screen.getByLabelText('roomName');
    fireEvent.change(input, { target: { value: 'x'.repeat(21) } });

    expect(input.getAttribute('maxlength')).toBe('20');
    expect(await screen.findByText('errorRoomNameTooLong')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onRename).not.toHaveBeenCalled();
  });
});
