// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomCreateModal } from './RoomCreateModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const renderModal = (isCodeAgentEnabled: boolean) => {
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
});
