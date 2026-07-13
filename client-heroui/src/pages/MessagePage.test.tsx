// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
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
      socket.emit.mockImplementation(() => socket);
    },
  };

  return socket;
});

const socketApiMock = vi.hoisted(() => ({
  joinRoom: vi.fn(),
  ensureRoomJoined: vi.fn(),
  leaveRoom: vi.fn(),
  getRoomById: vi.fn(),
  getRoomMemberCount: vi.fn(),
  onRoomMemberChange: vi.fn(),
  onRoomMembershipRepairFailure: vi.fn(),
  onUsernameAdopted: vi.fn(),
  setUsername: vi.fn(),
  reconnectSocket: vi.fn(),
  renameRoom: vi.fn(),
  saveRoomToServer: vi.fn(),
  unsaveRoomFromServer: vi.fn(),
  getRoomsFromServer: vi.fn(),
  getSavedRoomsFromServer: vi.fn(),
  getRoomPermissions: vi.fn(),
  clearRoomMessages: vi.fn(),
  requestInputCodeWorkspaceTerminalSession: vi.fn().mockResolvedValue(undefined),
}));

const messageCacheMock = vi.hoisted(() => ({
  deleteCachedRoomMessageWindow: vi.fn().mockResolvedValue(undefined),
  invalidateCachedRoomMessageWindow: vi.fn().mockResolvedValue(undefined),
  reactivateCachedRoomMessageWindow: vi.fn(),
}));

vi.mock('../utils/socket', () => ({
  socket: socketMock,
  clientId: 'client-1',
  ...socketApiMock,
}));

vi.mock('../utils/messageHistoryCache', () => messageCacheMock);

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
    RoomList: ({ onRoomSelect, onRoomSelectById, onModalTaskStart }: {
      onRoomSelect: (room: Room) => void;
      onRoomSelectById: (roomId: string) => void;
      onModalTaskStart?: () => void;
    }) => React.createElement(
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
      React.createElement('button', {
        'data-testid': 'select-missing-room',
        onClick: () => onRoomSelectById('missing-room'),
      }),
      React.createElement('button', {
        'data-testid': 'lookup-room-a',
        onClick: () => onRoomSelectById('lookup-room-a'),
      }),
      React.createElement('button', {
        'data-testid': 'lookup-room-b',
        onClick: () => onRoomSelectById('lookup-room-b'),
      }),
      React.createElement('button', {
        'data-testid': 'open-room-task',
        onClick: onModalTaskStart,
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
  return {
    DesktopSidebar: ({ onRoomSelect }: { onRoomSelect?: (room: Room) => void }) => React.createElement(
      'aside',
      { 'data-testid': 'desktop-sidebar' },
      React.createElement('button', {
        'data-testid': 'sidebar-select-room-1',
        onClick: () => onRoomSelect?.({
          id: 'room-1',
          name: 'Room 1',
          description: '',
          createdAt: '2026-05-03T00:00:00.000Z',
          creatorId: 'client-1',
        }),
      }),
      React.createElement('button', {
        'data-testid': 'sidebar-select-room-2',
        onClick: () => onRoomSelect?.({
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

vi.mock('../components/WelcomeView', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return { WelcomeView: () => React.createElement('div', { 'data-testid': 'welcome-view' }) };
});

vi.mock('../components/ChatRoomView', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    ChatRoomView: ({ currentRoom, memberCount, isRestoringRoom, isRoomSessionReady, roomMembershipAckRevision, roomPermissions, handleShareRoom, handleDeleteRoom, onRetryRoomSession, setView, onRoomUpdated }: {
      currentRoom: Room;
      memberCount: number | null;
      isRestoringRoom: boolean;
      isRoomSessionReady: boolean;
      roomMembershipAckRevision?: number;
      roomPermissions?: RoomPermissions | null;
      handleShareRoom?: () => void;
      handleDeleteRoom?: (roomId: string) => void;
      onRetryRoomSession?: () => void;
      setView?: (view: 'settings') => void;
      onRoomUpdated?: (room: Room) => void;
    }) => React.createElement(
      'div',
      {
        'data-testid': 'chat-room-view',
        'data-room-id': currentRoom.id,
        'data-member-count': memberCount == null ? 'unknown' : String(memberCount),
        'data-restoring': String(isRestoringRoom),
        'data-session-ready': String(isRoomSessionReady),
        'data-membership-ack-revision': String(roomMembershipAckRevision ?? 0),
        'data-permission-room-id': roomPermissions?.roomId || 'none',
        'data-can-post': String(Boolean(roomPermissions?.canPost)),
        'data-posting-enabled': String(Boolean(currentRoom.postingSchedule?.enabled)),
      },
      currentRoom.name,
      React.createElement('button', {
        'data-testid': 'share-room',
        onClick: handleShareRoom,
      }),
      React.createElement('button', {
        'data-testid': 'delete-current-room',
        onClick: () => handleDeleteRoom?.(currentRoom.id),
      }),
      React.createElement('button', {
        'data-testid': 'retry-room-session',
        onClick: onRetryRoomSession,
      }),
      React.createElement('button', {
        'data-testid': 'navigate-settings',
        onClick: () => setView?.('settings'),
      }),
      React.createElement('button', {
        'data-testid': 'apply-settings-ack',
        onClick: () => onRoomUpdated?.({
          id: currentRoom.id,
          name: currentRoom.name,
          description: '',
          createdAt: '2026-05-03T00:00:00.000Z',
          creatorId: 'client-1',
        }),
      }),
    ),
  };
});

vi.mock('../components/CodeAgentRoomView', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    CodeAgentRoomView: ({ currentRoom, isRoomSessionReady }: {
      currentRoom: Room;
      isRoomSessionReady: boolean;
    }) => React.createElement('div', {
      'data-testid': 'code-agent-room-view',
      'data-room-id': currentRoom.id,
      'data-session-ready': String(isRoomSessionReady),
    }),
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
  canManageMembers: true,
  canTransferOwnership: true,
  canUseCodeAgent: true,
  ...overrides,
});

const TestNavigation = () => {
  const navigate = useNavigate();
  return <>
    <button data-testid="navigate-url-room-a" onClick={() => navigate('/?room=url-room-a')} />
    <button data-testid="navigate-url-room-b" onClick={() => navigate('/?room=url-room-b')} />
  </>;
};

const renderPage = (initialEntries = ['/']) => render(
  <MemoryRouter initialEntries={initialEntries}>
    <TestNavigation />
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
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    socketApiMock.joinRoom.mockResolvedValue({
      room: room(),
      permissions: permissions(),
      memberCount: 5,
    });
    socketApiMock.ensureRoomJoined.mockImplementation((roomId: string) => (
      socketApiMock.joinRoom(roomId, undefined)
    ));
    socketApiMock.getRoomById.mockResolvedValue(room());
    socketApiMock.getRoomMemberCount.mockReturnValue(null);
    socketApiMock.onRoomMemberChange.mockReturnValue(vi.fn());
    socketApiMock.onRoomMembershipRepairFailure.mockReturnValue(vi.fn());
    socketApiMock.onUsernameAdopted.mockReturnValue(vi.fn());
    socketApiMock.getRoomsFromServer.mockResolvedValue([]);
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
    expect(messageCacheMock.reactivateCachedRoomMessageWindow).toHaveBeenCalledWith('room-1');
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
    expect(socketApiMock.ensureRoomJoined).not.toHaveBeenCalledWith('shared-room');
    expect((await screen.findByTestId('chat-room-view')).getAttribute('data-room-id')).toBe('shared-room');
  });

  it('keeps the newest URL room lookup when an older response arrives last', async () => {
    let resolveRoomA: (value: Room | null) => void = () => {};
    let resolveRoomB: (value: Room | null) => void = () => {};
    const roomARequest = new Promise<Room | null>((resolve) => {
      resolveRoomA = resolve;
    });
    const roomBRequest = new Promise<Room | null>((resolve) => {
      resolveRoomB = resolve;
    });
    socketApiMock.getRoomById.mockImplementation((roomId: string) => (
      roomId === 'url-room-a' ? roomARequest : roomBRequest
    ));

    renderPage(['/?room=url-room-a']);
    await waitFor(() => expect(socketApiMock.getRoomById).toHaveBeenCalledWith('url-room-a'));
    fireEvent.click(screen.getByTestId('navigate-url-room-b'));
    await waitFor(() => expect(socketApiMock.getRoomById).toHaveBeenCalledWith('url-room-b'));

    await act(async () => {
      resolveRoomB(room({ id: 'url-room-b', name: 'URL Room B', hasPassword: true }));
      await roomBRequest;
    });
    expect((await screen.findByTestId('room-join-modal')).getAttribute('data-room-id')).toBe('url-room-b');

    await act(async () => {
      resolveRoomA(room({ id: 'url-room-a', name: 'URL Room A', hasPassword: true }));
      await roomARequest;
    });
    expect(screen.getByTestId('room-join-modal').getAttribute('data-room-id')).toBe('url-room-b');
  });

  it('opens a different URL room intent while another room is active', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    socketApiMock.getRoomById.mockResolvedValue(
      room({ id: 'url-room-b', name: 'URL Room B', hasPassword: true }),
    );

    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-1');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
    });

    fireEvent.click(screen.getByTestId('navigate-url-room-b'));

    await waitFor(() => expect(socketApiMock.getRoomById).toHaveBeenCalledWith('url-room-b'));
    expect((await screen.findByTestId('room-join-modal')).getAttribute('data-room-id')).toBe('url-room-b');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-1');
  });

  it('keeps the newest manual room lookup when an older response arrives last', async () => {
    localStorage.setItem('roomtalk_current_view', 'rooms');
    let resolveRoomA: (value: Room | null) => void = () => {};
    let resolveRoomB: (value: Room | null) => void = () => {};
    const roomARequest = new Promise<Room | null>((resolve) => {
      resolveRoomA = resolve;
    });
    const roomBRequest = new Promise<Room | null>((resolve) => {
      resolveRoomB = resolve;
    });
    socketApiMock.getRoomById.mockImplementation((roomId: string) => (
      roomId === 'lookup-room-a' ? roomARequest : roomBRequest
    ));

    renderPage();
    fireEvent.click(await screen.findByTestId('lookup-room-a'));
    fireEvent.click(screen.getByTestId('lookup-room-b'));

    await act(async () => {
      resolveRoomB(room({ id: 'lookup-room-b', name: 'Lookup Room B', hasPassword: true }));
      await roomBRequest;
    });
    expect((await screen.findByTestId('room-join-modal')).getAttribute('data-room-id')).toBe('lookup-room-b');

    await act(async () => {
      resolveRoomA(room({ id: 'lookup-room-a', name: 'Lookup Room A', hasPassword: true }));
      await roomARequest;
    });
    expect(screen.getByTestId('room-join-modal').getAttribute('data-room-id')).toBe('lookup-room-b');
  });

  it('does not clear a newly joined room when an older room delete ack arrives late', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    socketApiMock.joinRoom.mockImplementation(async (roomId: string) => ({
      room: room({ id: roomId, name: roomId === 'room-2' ? 'Room 2' : 'Room 1' }),
      permissions: permissions({ roomId }),
      memberCount: roomId === 'room-2' ? 3 : 2,
    }));
    let deleteAck: ((response: { success: boolean; message?: string }) => void) | null = null;
    socketMock.emit.mockImplementation((event: string, ...args: unknown[]) => {
      if (event === 'delete_room') {
        deleteAck = args[1] as (response: { success: boolean; message?: string }) => void;
      }
      return socketMock;
    });

    renderPage();
    expect((await screen.findByTestId('chat-room-view')).getAttribute('data-room-id')).toBe('room-1');
    fireEvent.click(screen.getByTestId('delete-current-room'));
    expect(deleteAck).not.toBeNull();

    fireEvent.click(screen.getByTestId('sidebar-select-room-2'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-2');
    });

    act(() => {
      deleteAck?.({ success: true });
    });
    expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-2');
    expect(messageCacheMock.invalidateCachedRoomMessageWindow).toHaveBeenCalledWith('room-1');
  });

  it('coalesces initial storage restore with pageshow and socket-connect recovery signals', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    let resolveInitialRestore: (value: unknown) => void = () => {};
    const initialRestore = new Promise((resolve) => {
      resolveInitialRestore = resolve;
    });
    socketApiMock.joinRoom.mockImplementation(() => initialRestore);

    renderPage();
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      dispatchPageShow();
      document.dispatchEvent(new Event('visibilitychange'));
      socketMock.trigger('connect');
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(socketApiMock.ensureRoomJoined).toHaveBeenCalledTimes(1);
    expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitialRestore({ room: room(), permissions: permissions(), memberCount: 5 });
      await initialRestore;
    });
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
    });
  });

  it('coalesces mobile restore, BFCache restore, and online events into one background rejoin', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));

    socketApiMock.joinRoom.mockClear();
    socketApiMock.ensureRoomJoined.mockClear();
    let resolveBackgroundRestore: (value: unknown) => void = () => {};
    const backgroundRestore = new Promise((resolve) => {
      resolveBackgroundRestore = resolve;
    });
    socketApiMock.joinRoom.mockImplementation(() => backgroundRestore);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    document.dispatchEvent(new Event('visibilitychange'));
    dispatchPageShow();
    window.dispatchEvent(new Event('online'));

    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);
    });
    expect(socketApiMock.ensureRoomJoined).toHaveBeenCalledTimes(1);
    expect(socketApiMock.ensureRoomJoined).toHaveBeenCalledWith('room-1');
    expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined);
    expect(socketApiMock.reconnectSocket).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveBackgroundRestore({
        room: room(),
        permissions: permissions(),
        memberCount: 6,
      });
      await backgroundRestore;
    });
  });

  it('suppresses successful background restore repeats until the suppression window expires', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
      localStorage.setItem('roomtalk_current_view', 'chat');

      renderPage();

      await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
      socketApiMock.joinRoom.mockClear();
      socketApiMock.ensureRoomJoined.mockClear();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

      dateNowSpy.mockReturnValue(2000);
      document.dispatchEvent(new Event('visibilitychange'));

      await waitFor(() => {
        expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        await Promise.resolve();
      });

      dateNowSpy.mockReturnValue(2100);
      window.dispatchEvent(new Event('online'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);

      dateNowSpy.mockReturnValue(2251);
      dispatchPageShow();

      await waitFor(() => {
        expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(2);
      });
      expect(socketApiMock.ensureRoomJoined).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('clears background suppression after a failed restore so the next signal can retry', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();

    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
    socketApiMock.joinRoom.mockClear();
    socketApiMock.ensureRoomJoined.mockClear();
    socketApiMock.joinRoom
      .mockRejectedValueOnce(new Error('Timed out while joining room'))
      .mockResolvedValueOnce({
        room: room(),
        permissions: permissions(),
        memberCount: 6,
      });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await Promise.resolve();
    });

    window.dispatchEvent(new Event('online'));

    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(2);
    });
    expect(socketApiMock.ensureRoomJoined).toHaveBeenCalledTimes(2);
  });

  it('allows socket reconnect to rejoin during a recent successful restore suppression window', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
      localStorage.setItem('roomtalk_current_view', 'chat');

      renderPage();

      await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
      socketApiMock.joinRoom.mockClear();
      socketApiMock.ensureRoomJoined.mockClear();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

      dateNowSpy.mockReturnValue(2000);
      document.dispatchEvent(new Event('visibilitychange'));

      await waitFor(() => {
        expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        await Promise.resolve();
      });

      dateNowSpy.mockReturnValue(2100);
      socketMock.trigger('disconnect', 'transport close');
      socketMock.trigger('connect');

      await waitFor(() => {
        expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(2);
      });
      expect(socketApiMock.ensureRoomJoined).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('rejoins the current room on socket connect after transport recovery', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));

    socketApiMock.joinRoom.mockClear();
    socketApiMock.ensureRoomJoined.mockClear();
    socketMock.trigger('connect');

    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined);
    });
    expect(socketApiMock.ensureRoomJoined).toHaveBeenCalledWith('room-1');
  });

  it('advances the verified room membership ack revision after a background rejoin', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-membership-ack-revision')).toBe('1');
    });

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-membership-ack-revision')).toBe('2');
    });
  });

  it('treats navigation back to an already verified room as navigation rather than another join', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('select-room-1'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-membership-ack-revision')).toBe('1');
    });
    expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('navigate-settings'));
    expect(await screen.findByTestId('settings-view')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sidebar-select-room-1'));

    expect(await screen.findByTestId('chat-room-view')).toBeTruthy();
    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-membership-ack-revision')).toBe('1');
    expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);
  });

  it('locks the room on disconnect and unlocks only after the new socket rejoins', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));

    let resolveReconnect: (value: unknown) => void = () => {};
    const reconnect = new Promise(resolve => {
      resolveReconnect = resolve;
    });
    socketApiMock.joinRoom.mockImplementation(() => reconnect);
    socketApiMock.joinRoom.mockClear();
    socketApiMock.ensureRoomJoined.mockClear();

    act(() => {
      socketMock.trigger('disconnect', 'transport close');
    });
    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');

    act(() => {
      socketMock.trigger('connect');
    });
    await waitFor(() => expect(socketApiMock.ensureRoomJoined).toHaveBeenCalledWith('room-1'));
    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');

    await act(async () => {
      resolveReconnect({ room: room(), permissions: permissions(), memberCount: 4 });
      await reconnect;
    });
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));
  });

  it('marks the room unavailable when the new socket cannot rejoin', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));

    socketApiMock.joinRoom.mockRejectedValueOnce(new Error('temporary rejoin failure'));
    act(() => {
      socketMock.trigger('disconnect', 'transport close');
      socketMock.trigger('connect');
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
    });
    expect(localStorage.getItem('roomtalk_current_room')).not.toBeNull();

    socketApiMock.joinRoom.mockResolvedValueOnce({
      room: room(),
      permissions: permissions(),
      memberCount: 3,
    });
    fireEvent.click(screen.getByTestId('retry-room-session'));
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));
  });

  it('does not let an acknowledgement from the disconnected transport unlock the room', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));

    let resolveOldRestore: (value: unknown) => void = () => {};
    const oldRestore = new Promise(resolve => {
      resolveOldRestore = resolve;
    });
    socketApiMock.joinRoom.mockImplementation(() => oldRestore);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(socketApiMock.ensureRoomJoined).toHaveBeenCalledWith('room-1'));

    act(() => {
      socketMock.trigger('disconnect', 'transport close');
    });
    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');

    await act(async () => {
      resolveOldRestore({ room: room(), permissions: permissions(), memberCount: 5 });
      await oldRestore;
    });
    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');
  });

  it('returns to the room list on native history back without leaving the room', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();

    await screen.findByTestId('chat-room-view');

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('room-list')).toBeTruthy();
    });
    expect(screen.queryByTestId('chat-room-view')).toBeNull();
    expect(socketApiMock.leaveRoom).not.toHaveBeenCalled();
    expect(localStorage.getItem('roomtalk_current_room')).not.toBeNull();
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
    expect(screen.getByTestId('room-list')).toBeTruthy();
    expect(await screen.findByText('errorRoomNoLongerExists')).toBeTruthy();
    expect(messageCacheMock.invalidateCachedRoomMessageWindow).toHaveBeenCalledWith('room-1');
  });

  it('clears the active room when the server removes this client from the room', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();
    await screen.findByTestId('chat-room-view');

    act(() => {
      socketMock.trigger('room_removed', 'room-1');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('chat-room-view')).toBeNull();
    });
    expect(localStorage.getItem('roomtalk_current_room')).toBeNull();
    expect(screen.getByTestId('room-list')).toBeTruthy();
    expect(await screen.findByText('roomAccessRemoved')).toBeTruthy();
    expect(messageCacheMock.invalidateCachedRoomMessageWindow).toHaveBeenCalledWith('room-1');
  });

  it('does not revive a removed pending room when its join acknowledgement arrives late', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    let resolveRoomTwoJoin: (value: {
      room: Room;
      permissions: RoomPermissions;
      memberCount: number;
    }) => void = () => {};
    const roomTwoJoin = new Promise<{
      room: Room;
      permissions: RoomPermissions;
      memberCount: number;
    }>((resolve) => {
      resolveRoomTwoJoin = resolve;
    });
    socketApiMock.joinRoom.mockImplementation((roomId: string) => {
      if (roomId === 'room-2') return roomTwoJoin;
      return Promise.resolve({
        room: room(),
        permissions: permissions(),
        memberCount: 5,
      });
    });

    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-1');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
    });

    fireEvent.click(screen.getByTestId('sidebar-select-room-2'));
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-2', undefined));

    act(() => {
      socketMock.trigger('room_removed', 'room-2');
    });
    await waitFor(() => expect(socketApiMock.ensureRoomJoined).toHaveBeenCalledWith('room-1'));

    await act(async () => {
      resolveRoomTwoJoin({
        room: room({ id: 'room-2', name: 'Room 2' }),
        permissions: permissions({ roomId: 'room-2' }),
        memberCount: 2,
      });
      await roomTwoJoin;
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-1');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
    });
    expect(socketApiMock.leaveRoom).toHaveBeenCalledWith('room-2');
    expect(messageCacheMock.invalidateCachedRoomMessageWindow).toHaveBeenCalledWith('room-2');
    expect(messageCacheMock.reactivateCachedRoomMessageWindow).not.toHaveBeenCalledWith('room-2');
    expect(JSON.parse(localStorage.getItem('roomtalk_current_room') || '{}').id).toBe('room-1');
    expect(await screen.findByText('roomAccessRemoved')).toBeTruthy();
  });

  it('clears an initial pending room when removal wins before its join acknowledgement', async () => {
    localStorage.setItem('roomtalk_current_view', 'rooms');
    let resolveJoin: (value: {
      room: Room;
      permissions: RoomPermissions;
      memberCount: number;
    }) => void = () => {};
    const pendingJoin = new Promise<{
      room: Room;
      permissions: RoomPermissions;
      memberCount: number;
    }>((resolve) => {
      resolveJoin = resolve;
    });
    socketApiMock.joinRoom.mockReturnValue(pendingJoin);

    renderPage();
    fireEvent.click(await screen.findByTestId('select-room-1'));
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined));

    act(() => {
      socketMock.trigger('room_removed', 'room-1');
    });
    await act(async () => {
      resolveJoin({
        room: room(),
        permissions: permissions(),
        memberCount: 2,
      });
      await pendingJoin;
    });

    await waitFor(() => expect(screen.getByTestId('room-list')).toBeTruthy());
    expect(screen.queryByTestId('chat-room-view')).toBeNull();
    expect(localStorage.getItem('roomtalk_current_room')).toBeNull();
    expect(socketApiMock.leaveRoom).toHaveBeenCalledWith('room-1');
    expect(messageCacheMock.reactivateCachedRoomMessageWindow).not.toHaveBeenCalledWith('room-1');
    expect(await screen.findByText('roomAccessRemoved')).toBeTruthy();
  });

  it('ignores a late permissions event from the previously active room', async () => {
    localStorage.setItem('roomtalk_current_view', 'rooms');
    renderPage();

    fireEvent.click(await screen.findByTestId('select-room-1'));
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));

    socketApiMock.joinRoom.mockResolvedValueOnce({
      room: room({ id: 'room-2', name: 'Room 2' }),
      memberCount: 2,
    });
    fireEvent.click(screen.getByTestId('sidebar-select-room-2'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-2');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-permission-room-id')).toBe('none');
    });

    act(() => {
      socketMock.trigger('room_permissions', permissions({ roomId: 'room-1', canPost: false }));
    });

    expect(screen.getByTestId('chat-room-view').getAttribute('data-permission-room-id')).toBe('none');
  });

  it('locks the room shell when socket membership repair cannot converge', async () => {
    let notifyRepairFailure: ((roomId: string, error: Error) => void) | null = null;
    socketApiMock.onRoomMembershipRepairFailure.mockImplementation((callback: (roomId: string, error: Error) => void) => {
      notifyRepairFailure = callback;
      return vi.fn();
    });
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();

    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));
    act(() => {
      notifyRepairFailure?.('room-1', new Error('repair failed'));
    });

    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
    expect(await screen.findByText('errorRestoringRoom')).toBeTruthy();
  });

  it('atomically clears the active room when a late repair result confirms it is missing', async () => {
    let notifyRepairFailure: ((roomId: string, error: Error) => void) | null = null;
    socketApiMock.onRoomMembershipRepairFailure.mockImplementation((callback: (roomId: string, error: Error) => void) => {
      notifyRepairFailure = callback;
      return vi.fn();
    });
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));

    act(() => {
      notifyRepairFailure?.('room-1', new Error('Room not found'));
    });

    expect(screen.queryByTestId('chat-room-view')).toBeNull();
    expect(screen.getByTestId('room-list')).toBeTruthy();
    expect(localStorage.getItem('roomtalk_current_room')).toBeNull();
    expect(messageCacheMock.invalidateCachedRoomMessageWindow).toHaveBeenCalledWith('room-1');
    expect(socketApiMock.leaveRoom).toHaveBeenCalledWith('room-1');
    expect(await screen.findByText('errorRoomNoLongerExists')).toBeTruthy();
  });

  it('rolls back to the verified room and reopens password entry after a rejected switch', async () => {
    localStorage.setItem('roomtalk_current_view', 'rooms');
    renderPage();
    fireEvent.click(await screen.findByTestId('select-room-1'));
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-1'));

    socketApiMock.joinRoom.mockRejectedValueOnce(new Error('Room password is required or incorrect'));
    fireEvent.click(screen.getByTestId('sidebar-select-room-2'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-1');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
    });
    expect((await screen.findByTestId('room-join-modal')).getAttribute('data-room-id')).toBe('room-2');
    expect(await screen.findByText('Room password is required or incorrect')).toBeTruthy();
  });

  it('does not let a stale permissions fetch overwrite a newer permissions push', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    socketApiMock.joinRoom.mockResolvedValueOnce({ room: room(), memberCount: 2 });
    let resolvePermissions: (value: RoomPermissions) => void = () => {};
    const pendingPermissions = new Promise<RoomPermissions>((resolve) => {
      resolvePermissions = resolve;
    });
    socketApiMock.getRoomPermissions.mockReturnValueOnce(pendingPermissions);

    renderPage();
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));
    act(() => {
      socketMock.trigger('room_permissions', permissions({ canPost: false }));
    });
    expect(screen.getByTestId('chat-room-view').getAttribute('data-can-post')).toBe('false');

    await act(async () => {
      resolvePermissions(permissions({ canPost: true }));
      await pendingPermissions;
    });
    expect(screen.getByTestId('chat-room-view').getAttribute('data-can-post')).toBe('false');
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
    expect(await screen.findByText('errorRestoringRoom')).toBeTruthy();
    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');
    expect(messageCacheMock.invalidateCachedRoomMessageWindow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('share-room'));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    socketApiMock.joinRoom.mockResolvedValue({
      room: room(),
      permissions: permissions(),
      memberCount: 5,
    });
    fireEvent.click(screen.getByTestId('retry-room-session'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
    });
  });

  it('renders a stored room immediately but keeps actions locked until rejoin succeeds', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    let resolveJoin: (value: unknown) => void = () => {};
    const pendingJoin = new Promise((resolve) => {
      resolveJoin = resolve;
    });
    socketApiMock.joinRoom.mockReturnValue(pendingJoin);

    renderPage();

    const roomView = await screen.findByTestId('chat-room-view');
    expect(roomView.getAttribute('data-session-ready')).toBe('false');
    expect(roomView.getAttribute('data-restoring')).toBe('true');
    fireEvent.click(screen.getByTestId('share-room'));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    await act(async () => {
      resolveJoin({ room: room(), permissions: permissions(), memberCount: 2 });
      await pendingJoin;
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
    });
    fireEvent.click(screen.getByTestId('share-room'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  });

  it('clears a stale page error when the user navigates to another primary view', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    socketApiMock.joinRoom.mockRejectedValue(new Error('Timed out while joining room'));

    renderPage();

    expect(await screen.findByText('errorRestoringRoom')).toBeTruthy();
    fireEvent.click(screen.getByTestId('navigate-settings'));

    expect(await screen.findByTestId('settings-view')).toBeTruthy();
    expect(screen.queryByText('errorRestoringRoom')).toBeNull();
  });

  it('automatically dismisses a non-blocking page error after eight seconds', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    socketApiMock.joinRoom.mockRejectedValue(new Error('Timed out while joining room'));
    vi.useFakeTimers();

    try {
      renderPage();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.queryByText('errorRestoringRoom')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(screen.queryByText('errorRestoringRoom')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a stale global error when a room modal task starts', async () => {
    localStorage.setItem('roomtalk_current_view', 'rooms');
    socketApiMock.getRoomById.mockResolvedValue(null);
    renderPage();

    fireEvent.click(await screen.findByTestId('select-missing-room'));
    expect(await screen.findByText('errorRoomNotFound')).toBeTruthy();

    fireEvent.click(screen.getByTestId('open-room-task'));
    expect(screen.queryByText('errorRoomNotFound')).toBeNull();
  });

  it('names the main landmark with the current primary-view heading', async () => {
    localStorage.setItem('roomtalk_current_view', 'rooms');
    renderPage();

    const main = screen.getByRole('main');
    const heading = screen.getByRole('heading', { level: 1, name: 'chatRooms' });
    expect(main.getAttribute('aria-labelledby')).toBe(heading.id);
  });

  it('shows success messages from page actions', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();

    await screen.findByTestId('chat-room-view');
    fireEvent.click(screen.getByTestId('share-room'));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    });
    expect(await screen.findByText('shareSuccess')).toBeTruthy();
  });

  it('keeps member count stable and hides the header spinner during background restores', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();

    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('5');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');

    let resolveBackgroundRestore: (value: unknown) => void = () => {};
    const backgroundRestore = new Promise((resolve) => {
      resolveBackgroundRestore = resolve;
    });
    socketApiMock.joinRoom.mockClear();
    socketApiMock.joinRoom.mockImplementation(() => backgroundRestore);
    socketApiMock.getRoomMemberCount.mockReturnValue(null);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined);
    });
    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('5');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');

    await act(async () => {
      resolveBackgroundRestore({
        room: room(),
        permissions: permissions(),
        memberCount: 6,
      });
      await backgroundRestore;
    });

    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('6');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
  });

  it('keeps the current member count when a background restore ack omits member count', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();

    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('5');

    let resolveBackgroundRestore: (value: unknown) => void = () => {};
    const backgroundRestore = new Promise((resolve) => {
      resolveBackgroundRestore = resolve;
    });
    socketApiMock.joinRoom.mockClear();
    socketApiMock.joinRoom.mockImplementation(() => backgroundRestore);
    socketApiMock.getRoomMemberCount.mockReturnValue(null);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined);
    });

    await act(async () => {
      resolveBackgroundRestore({
        room: room(),
        permissions: permissions(),
      });
      await backgroundRestore;
    });

    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('5');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
  });

  it('keeps the verified room shell locked until an uncached manual switch succeeds', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();

    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('5');

    let resolveManualSwitch: (value: unknown) => void = () => {};
    const manualSwitch = new Promise((resolve) => {
      resolveManualSwitch = resolve;
    });
    socketApiMock.joinRoom.mockClear();
    socketApiMock.joinRoom.mockImplementation(() => manualSwitch);
    socketApiMock.getRoomMemberCount.mockReturnValue(null);

    fireEvent.click(screen.getByTestId('sidebar-select-room-2'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('true');
    });
    expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-1');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('5');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');

    await act(async () => {
      resolveManualSwitch({
        room: room({ id: 'room-2', name: 'Room 2' }),
        permissions: permissions({ roomId: 'room-2' }),
        memberCount: 8,
      });
      await manualSwitch;
    });

    expect(screen.getByTestId('chat-room-view').getAttribute('data-room-id')).toBe('room-2');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('8');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
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

  const enabledSchedule = () => ({
    enabled: true,
    timezone: 'UTC',
    windows: [{ days: [1, 2, 3], start: '09:00', end: '17:00' }],
  });

  it('removes the posting schedule when room_updated arrives without one', async () => {
    socketApiMock.joinRoom.mockResolvedValue({
      room: room({ postingSchedule: enabledSchedule() }),
      permissions: permissions(),
      memberCount: 2,
    });

    renderPage();
    fireEvent.click(screen.getByTestId('select-room-1'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('true');
    });

    // 服务端关闭排期后,广播的房间对象不携带 postingSchedule 键
    act(() => {
      socketMock.trigger('room_updated', room());
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('false');
    });
  });

  it('drops a stale stored posting schedule when the rejoin ack omits it', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room({ postingSchedule: enabledSchedule() })));
    localStorage.setItem('roomtalk_current_view', 'chat');
    socketApiMock.joinRoom.mockResolvedValue({
      room: room(),
      permissions: permissions(),
      memberCount: 1,
    });

    renderPage();

    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('false');
    });
  });

  it('ignores a stale room_updated broadcast that arrives after a newer update', async () => {
    socketApiMock.joinRoom.mockResolvedValue({
      room: room({ postingSchedule: enabledSchedule(), updatedAt: '2026-06-08T10:00:00.000Z' }),
      permissions: permissions(),
      memberCount: 2,
    });

    renderPage();
    fireEvent.click(screen.getByTestId('select-room-1'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('true');
    });

    // 较新的更新:排期已被关闭
    act(() => {
      socketMock.trigger('room_updated', room({ updatedAt: '2026-06-08T10:05:00.000Z' }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('false');
    });

    // 乱序到达的旧广播不得回踩
    act(() => {
      socketMock.trigger('room_updated', room({ postingSchedule: enabledSchedule(), updatedAt: '2026-06-08T10:01:00.000Z' }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('false');
    });
  });

  it('keeps the newer room when a stale rejoin ack resolves after a broadcast', async () => {
    socketApiMock.joinRoom.mockResolvedValue({
      room: room({ postingSchedule: enabledSchedule(), updatedAt: '2026-06-08T10:00:00.000Z' }),
      permissions: permissions(),
      memberCount: 2,
    });

    renderPage();
    fireEvent.click(screen.getByTestId('select-room-1'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('true');
    });

    act(() => {
      socketMock.trigger('room_updated', room({ updatedAt: '2026-06-08T10:05:00.000Z' }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('false');
    });

    // 后台恢复的 join ack 携带的是更新前读出的旧房间
    socketApiMock.joinRoom.mockResolvedValue({
      room: room({ postingSchedule: enabledSchedule(), updatedAt: '2026-06-08T10:02:00.000Z' }),
      permissions: permissions(),
      memberCount: 2,
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(socketApiMock.joinRoom.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('false');
    });
  });

  it('keeps the header spinner hidden for fast background rejoins', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
    });

    vi.useFakeTimers();
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        // 健康场景:rejoin 在宽限期内完成
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a reconnecting spinner when a background rejoin stays pending past the grace period', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
    });

    let resolveSlowJoin: (value: unknown) => void = () => {};
    socketApiMock.joinRoom.mockImplementation(() => new Promise((resolve) => {
      resolveSlowJoin = resolve;
    }));

    vi.useFakeTimers();
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(399);
      });
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2);
      });
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('true');

      await act(async () => {
        resolveSlowJoin({ room: room(), permissions: permissions(), memberCount: 2 });
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the newer broadcast when a stale rejoin ack resolves before React commits', async () => {
    socketApiMock.joinRoom.mockResolvedValue({
      room: room({ postingSchedule: enabledSchedule(), roomVersion: 1 }),
      permissions: permissions(),
      memberCount: 2,
    });

    renderPage();
    fireEvent.click(screen.getByTestId('select-room-1'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('true');
    });

    // 启动一个后台恢复,ack 挂起
    let resolveStaleRejoin: (value: unknown) => void = () => {};
    socketApiMock.joinRoom.mockImplementation(() => new Promise((resolve) => {
      resolveStaleRejoin = resolve;
    }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // 同一批次(React commit 之前):先到 room_updated(v3, 排期已关),
    // 再 resolve 携带 v2 旧状态的 rejoin ack —— v3 不得被回踩
    await act(async () => {
      socketMock.trigger('room_updated', room({ roomVersion: 3 }));
      resolveStaleRejoin({
        room: room({ postingSchedule: enabledSchedule(), roomVersion: 2 }),
        permissions: permissions(),
        memberCount: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('false');
  });

  it('keeps the reconnect indicator owned by the latest restore across disconnects', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
    });

    const pendingJoins: Array<(value: unknown) => void> = [];
    socketApiMock.joinRoom.mockImplementation(() => new Promise((resolve) => {
      pendingJoins.push(resolve);
    }));

    vi.useFakeTimers();
    try {
      // 恢复 A(慢)
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(pendingJoins.length).toBe(1);

      // 断连(清 in-flight/抑制窗)→ 重连触发恢复 B
      await act(async () => {
        socketMock.trigger('disconnect', 'transport close');
        socketMock.trigger('connect');
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(pendingJoins.length).toBe(2);

      // 旧恢复 A 此刻才 resolve:它的 finally 不得清掉 B 的指示器
      await act(async () => {
        pendingJoins[0]({ room: room(), permissions: permissions(), memberCount: 1 });
        await vi.advanceTimersByTimeAsync(0);
      });

      // B 仍未完成,越过宽限期后必须显示"重连中"
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('true');

      // B 完成,指示器消失
      await act(async () => {
        pendingJoins[1]({ room: room(), permissions: permissions(), memberCount: 1 });
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the settings ack room without waiting for the broadcast', async () => {
    socketApiMock.joinRoom.mockResolvedValue({
      room: room({ postingSchedule: enabledSchedule() }),
      permissions: permissions(),
      memberCount: 2,
    });

    renderPage();
    fireEvent.click(screen.getByTestId('select-room-1'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('true');
    });

    // RoomSettingsModal 保存成功后用 ack 房间直接更新本地状态(read-your-write)
    fireEvent.click(screen.getByTestId('apply-settings-ack'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-posting-enabled')).toBe('false');
    });
  });
});
