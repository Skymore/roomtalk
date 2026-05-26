// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomCreateModal } from './RoomCreateModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const renderModal = (isCocoEnabled: boolean) => {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    roomName: 'New room',
    roomDescription: '',
    roomType: 'chat' as const,
    nameError: null,
    createError: null,
    isCreating: false,
    isCocoEnabled,
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

  it('hides Coco room creation when the feature is disabled', () => {
    renderModal(false);

    expect(screen.getByRole('radio', { name: /chatRoomType/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /cocoRoomType/ })).toBeNull();
  });

  it('shows and selects Coco room creation when the feature is enabled', () => {
    const props = renderModal(true);

    fireEvent.click(screen.getByRole('radio', { name: /cocoRoomType/ }));

    expect(props.onRoomTypeChange).toHaveBeenCalledWith('coco');
  });
});
