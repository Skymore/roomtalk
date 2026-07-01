// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, type RenderOptions } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../utils/types';
import { DesktopSidebar } from './DesktopSidebar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('@heroui/react', () => ({
  Avatar: ({ name }: { name?: string }) => <div data-testid="avatar">{name}</div>,
  Button: ({
    children,
    onPress,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { onPress?: () => void }) => (
    <button type="button" onClick={onPress} {...props}>
      {children}
    </button>
  ),
  Dropdown: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Input: ({
    onChange,
    value,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input value={value} onChange={onChange} {...props} />
  ),
  Modal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ModalBody: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ModalContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ModalFooter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ModalHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./HoverTooltip', () => ({
  HoverTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./RoomCreateModal', () => ({
  RoomCreateModal: () => null,
}));

vi.mock('./RoomRenameModal', () => ({
  RoomRenameModal: () => null,
}));

vi.mock('../utils/socket', () => ({
  createRoom: vi.fn(),
}));

const cocoRoom: Room = {
  id: 'coco-room',
  name: 'Coco Room',
  creatorId: 'client-1',
  createdAt: '2026-05-26T00:00:00.000Z',
  type: 'coco',
};

const renderSidebar = (currentRoom: Room | null, options?: RenderOptions) => render(
  <>
    <DesktopSidebar
      clientId="client-1"
      username="User"
      view="chat"
      setView={vi.fn()}
      rooms={[]}
      savedRooms={[]}
      currentRoom={currentRoom}
      i18n={{ language: 'en' }}
      changeLanguage={vi.fn()}
      toggleTheme={vi.fn()}
      isDark={false}
      handleCopyToClipboard={vi.fn()}
      onRoomSelect={vi.fn()}
      onRoomSelectById={vi.fn()}
      onDeleteRoom={vi.fn()}
      onUnsaveRoom={vi.fn()}
      onRenameRoom={vi.fn()}
      isCocoEnabled
    />
    <div
      data-code-agent-workspace-layout="true"
      data-code-agent-files-collapsed="false"
      style={{ ['--code-agent-files-width' as string]: '760px' }}
    >
      <aside data-code-agent-files-panel="true" />
    </div>
  </>,
  options,
);

const dispatchPointer = (
  target: EventTarget,
  type: string,
  values: { pointerId: number; clientX: number; buttons: number; button?: number },
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    clientX: { value: values.clientX },
    buttons: { value: values.buttons },
    button: { value: values.button ?? 0 },
  });
  target.dispatchEvent(event);
};

describe('DesktopSidebar', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reconstrains a persisted sidebar width when entering a Coco room', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1600,
    });
    localStorage.setItem('roomtalk.desktopSidebar.width', '1120');

    const host = document.createElement('div');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      width: 1600,
      height: 900,
      top: 0,
      right: 1600,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    document.body.appendChild(host);

    renderSidebar(cocoRoom, { container: host });

    const sidebar = screen.getByLabelText('resizeSidebar').closest('aside') as HTMLElement;
    const workspaceLayout = document.querySelector<HTMLElement>('[data-code-agent-workspace-layout="true"]');

    expect(sidebar.style.getPropertyValue('--desktop-sidebar-width')).toBe('360px');
    expect(sidebar.style.getPropertyValue('--desktop-sidebar-max-width')).toBe('360px');
    expect(localStorage.getItem('roomtalk.desktopSidebar.width')).toBe('360');
    expect(workspaceLayout?.style.getPropertyValue('--code-agent-files-width')).toBe('760px');
  });

  it('resizes the left sidebar by shrinking the file panel before consuming the code-agent chat pane', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1600,
    });

    const host = document.createElement('div');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      width: 1600,
      height: 900,
      top: 0,
      right: 1600,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    document.body.appendChild(host);

    renderSidebar(cocoRoom, { container: host });

    const resizeHandle = screen.getByLabelText('resizeSidebar');
    const sidebar = resizeHandle.closest('aside') as HTMLElement;
    const workspaceLayout = document.querySelector<HTMLElement>('[data-code-agent-workspace-layout="true"]');

    dispatchPointer(resizeHandle, 'pointerdown', { pointerId: 9, clientX: 320, buttons: 1 });
    dispatchPointer(window, 'pointermove', { pointerId: 9, clientX: 1600, buttons: 1 });
    dispatchPointer(window, 'pointerup', { pointerId: 9, clientX: 1600, buttons: 0 });

    expect(sidebar.style.getPropertyValue('--desktop-sidebar-width')).toBe('760px');
    expect(sidebar.style.maxWidth).toBe('var(--desktop-sidebar-max-width, calc(100% - 360px))');
    expect(sidebar.style.getPropertyValue('--desktop-sidebar-max-width')).toBe('760px');
    expect(localStorage.getItem('roomtalk.desktopSidebar.width')).toBe('760');
    expect(workspaceLayout?.style.getPropertyValue('--code-agent-files-width')).toBe('360px');
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('only shrinks the right file panel when the shell cannot fit the current three-column layout', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024,
    });
    localStorage.setItem('roomtalk.desktopSidebar.width', '760');

    const host = document.createElement('div');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      width: 1024,
      height: 900,
      top: 0,
      right: 1024,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    document.body.appendChild(host);

    renderSidebar(cocoRoom, { container: host });

    const sidebar = screen.getByLabelText('resizeSidebar').closest('aside') as HTMLElement;
    const workspaceLayout = document.querySelector<HTMLElement>('[data-code-agent-workspace-layout="true"]');

    expect(sidebar.style.getPropertyValue('--desktop-sidebar-width')).toBe('240px');
    expect(sidebar.style.getPropertyValue('--desktop-sidebar-max-width')).toBe('240px');
    expect(localStorage.getItem('roomtalk.desktopSidebar.width')).toBe('240');
    expect(workspaceLayout?.style.getPropertyValue('--code-agent-files-width')).toBe('304px');
  });
});
