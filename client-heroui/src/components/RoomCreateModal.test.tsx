// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomCreateModal } from './RoomCreateModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const renderModal = (
  isCodeAgentEnabled: boolean,
  overrides: Partial<ComponentProps<typeof RoomCreateModal>> = {},
) => {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    roomName: 'New room',
    roomDescription: '',
    roomType: 'chat' as const,
    nameError: null,
    createError: null,
    isCreating: false,
    isCodeAgentEnabled,
    onRoomNameChange: vi.fn(),
    onRoomDescriptionChange: vi.fn(),
    onRoomTypeChange: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  };

  render(<RoomCreateModal {...props} />);
  return props;
};

describe('RoomCreateModal', () => {
  afterEach(() => {
    cleanup();
  });

  it('hides code-agent room creation when the feature is disabled', () => {
    renderModal(false);

    expect(screen.getByRole('radio', { name: /chatRoomType/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /codeAgentRoomType/ })).toBeNull();
  });

  it('shows and selects code-agent room creation when the feature is enabled', () => {
    const props = renderModal(true);

    fireEvent.click(screen.getByRole('radio', { name: /codeAgentRoomType/ }));

    expect(props.onRoomTypeChange).toHaveBeenCalledWith('codeAgent');
  });

  it('uses a full-height mobile modal shell', () => {
    renderModal(true);

    const dialog = screen.getByRole('dialog');

    expect(dialog.className).toContain('h-[var(--app-height,100dvh)]');
    expect(dialog.className).toContain('max-h-[var(--app-height,100dvh)]');
    expect(dialog.className).toContain('rounded-none');
    expect(dialog.className).toContain('sm:max-w-lg');
  });

  it('gives each text field one visible-label accessible name', () => {
    renderModal(true);

    const roomNameInput = screen.getByRole('textbox', { name: 'roomName' });
    const descriptionInput = screen.getByRole('textbox', { name: 'description (optional)' });
    const passwordInput = document.querySelector<HTMLInputElement>('input[autocomplete="new-password"]');

    expect(roomNameInput).toBeTruthy();
    expect(descriptionInput).toBeTruthy();
    expect(passwordInput).toBeTruthy();
    passwordInput!.type = 'text';
    expect(screen.getByRole('textbox', { name: 'password (optional)' })).toBe(passwordInput);
  });

  it('prevents overlong room names before submit', () => {
    const props = renderModal(true, { roomName: 'x'.repeat(21) });

    const roomNameInput = screen.getByRole('textbox', { name: 'roomName' }) as HTMLInputElement;
    const createButton = screen.getByRole('button', { name: 'create' }) as HTMLButtonElement;

    expect(roomNameInput.maxLength).toBe(20);
    expect(roomNameInput.getAttribute('aria-invalid')).toBe('true');
    expect(createButton.disabled).toBe(true);
    fireEvent.click(createButton);
    expect(props.onCreate).not.toHaveBeenCalled();
  });
});
