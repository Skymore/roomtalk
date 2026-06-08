// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { MessagePage } from './MessagePage';
import { Room, RoomPermissions } from '../utils/types';

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();

  const socket = {
    handlers,
    connected: true,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const eventHandlers = handlers.get(event) || new Set();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
      return socket;
    }),
    off: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.get(event)?.delete(handler);
      return socket;
    }),
    emit: vi.fn(),
    trigger: (event: string, ...args: any[]) => {
      handlers.get(event)?.forEach(handler => handler(...args));
    },
    reset: () => {
      handlers.clear();
      socket.connected = true;
    },
  };

  return socket;
});

const socketApiMock = vi.hoisted(() => ({
  joinRoom: vi.fn(),
  leaveRoom: vi.fn(),
  getRoomById: vi.fn(),
  getRoomMemberCount: vi.fn(),
  onRoomMemberChange: vi.fn(),
  setUsername: vi.fn(),
  reconnectSocket: vi.fn(),
  renameRoom: vi.fn(),
  saveRoomToServer: vi.fn(),
  unsaveRoomFromServer: vi.fn(),
  getSavedRoomsFromServer: vi.fn(),
  getRoomPermissions: vi.fn(),
  clearRoomMessages: vi.fn(),
}));

vi.mock('../utils/socket', () => ({
  socket: socketMock,
  clientId: 'client-1',
  ...socketApiMock,
}));

vi.mock('@heroui/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../components/RoomList', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    RoomList: ({ onRoomSelect }: { onRoomSelect: (room: Room) => void }) => React.createElement(
      'div',
      { 'data-testid': 'room-list' },
      React.createElement('button', {
        'data-testid': 'select-room-1',
        onClick: () => onRoomSelect({
          id: 'room-1',
          name: 'Room 1',
          description: '',
          createdAt: '2026-05-03T00:00:00.000Z',
          creatorId: 'client-1',
        }),
      }),
      React.createElement('button', {
        'data-testid': 'select-room-2',
        onClick: () => onRoomSelect({
          id: 'room-2',
          name: 'Room 2',
          description: '',
          createdAt: '2026-05-03T00:00:00.000Z',
          creatorId: 'client-1',
        }),
      }),
    ),
  };
});

vi.mock('../components/SavedRoomList', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return { SavedRoomList: () => React.createElement('div', { 'data-testid': 'saved-room-list' }) };
});

vi.mock('../components/SettingsView', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return { SettingsView: () => React.createElement('div', { 'data-testid': 'settings-view' }) };
});

vi.mock('../components/RoomJoinModal', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    RoomJoinModal: ({ roomToJoin, handleConfirmJoin }: {
      roomToJoin: Room;
      handleConfirmJoin: (confirmed: boolean, password?: string) => void;
    }) => React.createElement(
      'div',
      { 'data-testid': 'room-join-modal', 'data-room-id': roomToJoin.id },
      React.createElement('button', {
        'data-testid': 'confirm-join',
        onClick: () => handleConfirmJoin(true, 'secret'),
      }),
      React.createElement('button', {
        'data-testid': 'cancel-join',
        onClick: () => handleConfirmJoin(false),
      }),
    ),
  };
});

vi.mock('../components/BottomNav', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return { BottomNav: () => React.createElement('nav', { 'data-testid': 'bottom-nav' }) };
});

vi.mock('../components/DesktopSidebar', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return { DesktopSidebar: () => React.createElement('aside', { 'data-testid': 'desktop-sidebar' }) };
});

vi.mock('../components/WelcomeView', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return { WelcomeView: () => React.createElement('div', { 'data-testid': 'welcome-view' }) };
});

vi.mock('../components/ChatRoomView', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    ChatRoomView: ({ currentRoom, memberCount, isRestoringRoom }: {
      currentRoom: Room;
      memberCount: number | null;
      isRestoringRoom: boolean;
    }) => React.createElement(
      'div',
      {
        'data-testid': 'chat-room-view',
        'data-room-id': currentRoom.id,
        'data-member-count': memberCount == null ? 'unknown' : String(memberCount),
        'data-restoring': String(isRestoringRoom),
      },
      currentRoom.name,
    ),
  };
});

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  ...overrides,
});

const permissions = (overrides: Partial<RoomPermissions> = {}): RoomPermissions => ({
  roomId: 'room-1',
  clientId: 'client-1',
  role: 'owner',
  canPost: true,
  canEditAnyMessage: true,
  canDeleteAnyMessage: true,
  canClearHistory: true,
  canManageRoom: true,
  canManageAdmins: true,
  canTransferOwnership: true,
  ...overrides,
});

const renderPage = (initialEntries = ['/']) => render(
  <MemoryRouter initialEntries={initialEntries}>
    <MessagePage />
  </MemoryRouter>
);

const dispatchPageShow = () => {
  const event = new Event('pageshow') as Event & { persisted: boolean };
  Object.defineProperty(event, 'persisted', { value: true });
  window.dispatchEvent(event);
};

describe('MessagePage room session restore', () => {
  beforeEach(() => {
    localStorage.clear();
    socketMock.reset();
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    socketApiMock.joinRoom.mockResolvedValue({
      room: room(),
      permissions: permissions(),
      memberCount: 5,
    });
    socketApiMock.getRoomById.mockResolvedValue(room());
    socketApiMock.getRoomMemberCount.mockReturnValue(null);
    socketApiMock.onRoomMemberChange.mockReturnValue(vi.fn());
    socketApiMock.getSavedRoomsFromServer.mockResolvedValue([]);
    socketApiMock.getRoomPermissions.mockResolvedValue(permissions());
  });

  afterEach(() => {
    cleanup();
  });

  it('restores a stored room through the join acknowledgement', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();

    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined);
    });
    expect((await screen.findByTestId('chat-room-view')).getAttribute('data-member-count')).toBe('5');
  });

  it('prioritizes URL joins over stale stored rooms and passes the confirmed password', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room({ id: 'old-room', name: 'Old Room' })));
    localStorage.setItem('roomtalk_current_view', 'chat');
    socketApiMock.getRoomById.mockResolvedValue(room({ id: 'shared-room', name: 'Shared Room', hasPassword: true }));
    socketApiMock.joinRoom.mockResolvedValue({
      room: room({ id: 'shared-room', name: 'Shared Room', hasPassword: true }),
      permissions: permissions({ roomId: 'shared-room' }),
      memberCount: 2,
    });

    renderPage(['/?room=shared-room']);

    await waitFor(() => {
      expect(socketApiMock.getRoomById).toHaveBeenCalledWith('shared-room');
    });
    expect(socketApiMock.joinRoom).not.toHaveBeenCalledWith('old-room', undefined);

    fireEvent.click(await screen.findByTestId('confirm-join'));

    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledWith('shared-room', 'secret');
    });
    expect((await screen.findByTestId('chat-room-view')).getAttribute('data-room-id')).toBe('shared-room');
  });

  it('rejoins the current room on mobile restore, BFCache restore, and online events', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));

    socketApiMock.joinRoom.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    document.dispatchEvent(new Event('visibilitychange'));
    dispatchPageShow();
    window.dispatchEvent(new Event('online'));

    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(3);
    });
    expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined);
  });

  it('rejoins the current room on socket connect after transport recovery', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));

    socketApiMock.joinRoom.mockClear();
    socketMock.trigger('connect');

    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined);
    });
  });

  it('clears the stored room when restore reports the room no longer exists', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    socketApiMock.joinRoom.mockRejectedValue(new Error('Room not found'));

    renderPage();

    await waitFor(() => {
      expect(localStorage.getItem('roomtalk_current_room')).toBeNull();
    });
    expect(socketApiMock.leaveRoom).toHaveBeenCalledWith('room-1');
    expect(screen.queryByTestId('chat-room-view')).toBeNull();
    expect(screen.getByTestId('welcome-view')).toBeTruthy();
  });

  it('keeps the room shell when restore fails due to a transient network error', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    socketApiMock.joinRoom.mockRejectedValue(new Error('Timed out while joining room'));

    renderPage();

    expect((await screen.findByTestId('chat-room-view')).getAttribute('data-room-id')).toBe('room-1');
    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined);
    });
    expect(localStorage.getItem('roomtalk_current_room')).not.toBeNull();
  });

  it('ignores stale restore results after the user switches to another room', async () => {
    let resolveFirstJoin: (value: unknown) => void = () => {};
    const firstJoin = new Promise((resolve) => {
      resolveFirstJoin = resolve;
    });
    socketApiMock.joinRoom.mockImplementation((roomId: string) => {
      if (roomId === 'room-1') {
        return firstJoin;
      }
      return Promise.resolve({
        room: room({ id: 'room-2', name: 'Room 2' }),
        permissions: permissions({ roomId: 'room-2' }),
        memberCount: 8,
      });
    });

    renderPage();
    fireEvent.click(screen.getByTestId('select-room-1'));
    fireEvent.click(screen.getByTestId('select-room-2'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-2');
    });

    await act(async () => {
      resolveFirstJoin({
        room: room({ id: 'room-1', name: 'Room 1' }),
        permissions: permissions(),
        memberCount: 3,
      });
      await firstJoin;
    });

    expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-2');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('8');
  });
});
