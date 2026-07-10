// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BottomNav } from './BottomNav';
import type { Room } from '../utils/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('@heroui/react', () => ({
  Button: ({ children, onPress, isDisabled, ...props }: {
    children: React.ReactNode;
    onPress?: () => void;
    isDisabled?: boolean;
    [key: string]: unknown;
  }) => {
    const {
      isIconOnly: _isIconOnly,
      variant: _variant,
      color: _color,
      ...buttonProps
    } = props;
    return (
      <button type="button" disabled={isDisabled} onClick={onPress} {...buttonProps}>
        {children}
      </button>
    );
  },
}));

const currentRoom: Room = {
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-07-10T00:00:00.000Z',
  creatorId: 'client-1',
};

describe('BottomNav', () => {
  afterEach(cleanup);

  it('exposes a labeled navigation landmark without changing compact target dimensions', () => {
    render(<BottomNav view="chat" setView={vi.fn()} currentRoom={currentRoom} />);

    const nav = screen.getByRole('navigation', { name: 'menu' });
    expect(nav).toBeTruthy();
    const chatButton = screen.getByRole('button', { name: 'Room 1' });
    expect(chatButton.className).toContain('h-7');
    expect(chatButton.className).toContain('w-7');
    expect(chatButton.className).toContain('bg-secondary');
    expect(chatButton.className).toContain('text-secondary-foreground');
    expect(chatButton.getAttribute('aria-current')).toBe('page');
  });

  it('keeps chat unavailable until a room exists and navigates other destinations', () => {
    const setView = vi.fn();
    render(<BottomNav view="rooms" setView={setView} currentRoom={null} />);

    expect((screen.getByRole('button', { name: 'chatRooms' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'settings' }));
    expect(setView).toHaveBeenCalledWith('settings');
  });
});
