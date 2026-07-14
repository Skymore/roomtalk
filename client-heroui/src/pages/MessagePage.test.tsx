// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { MessagePage } from './MessagePage';
import { Room, RoomPermissions } from '../utils/types';
import { RoomSessionProtocolError } from '../utils/roomSessionController';

const roomSessionMock = vi.hoisted(() => {
  type Result = { room?: Room; permissions?: RoomPermissions; memberCount?: number };
  type Snapshot = {
    phase: 'idle' | 'connecting' | 'registering' | 'joining' | 'ready' | 'retrying' | 'unavailable';
    roomId: string | null;
    socketId: string | null;
    sessionEpoch: number;
    messageSyncRequestId: number;
    result: Result | null;
    source: string | null;
    attempt: number;
    error: Error | null;
  };
  const idleSnapshot = (): Snapshot => ({
    phase: 'idle',
    roomId: null,
    socketId: 'socket-1',
    sessionEpoch: 0,
    messageSyncRequestId: 0,
    result: null,
    source: null,
    attempt: 0,
    error: null,
  });
  let snapshot = idleSnapshot();
  let operationVersion = 0;
  let inFlight: { roomId: string; promise: Promise<Result> } | null = null;
  let performJoin: (roomId: string, password?: string) => Promise<Result> = async () => ({});
  const listeners = new Set<() => void>();
  const publish = (update: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...update };
    listeners.forEach(listener => listener());
  };
  const superseded = () => {
    const error = new Error('Room session request was superseded');
    error.name = 'RoomSessionSupersededError';
    return error;
  };

  const selectRoom = vi.fn((input: { roomId: string; password?: string; source?: string }) => {
    if (snapshot.phase === 'ready' && snapshot.roomId === input.roomId && snapshot.result) {
      return Promise.resolve(snapshot.result);
    }
    if (inFlight?.roomId === input.roomId) return inFlight.promise;

    const version = ++operationVersion;
    const roomChanged = snapshot.roomId !== input.roomId;
    publish({
      phase: 'joining',
      roomId: input.roomId,
      sessionEpoch: snapshot.sessionEpoch + (roomChanged ? 1 : 0),
      result: roomChanged ? null : snapshot.result,
      source: input.source || 'manual',
      error: null,
    });
    let promise: Promise<Result>;
    promise = Promise.resolve()
      .then(() => performJoin(input.roomId, input.password))
      .then(result => {
        if (version !== operationVersion || snapshot.roomId !== input.roomId) throw superseded();
        publish({
          phase: 'ready',
          result,
          messageSyncRequestId: snapshot.messageSyncRequestId + 1,
          error: null,
        });
        return result;
      })
      .catch(error => {
        if (version === operationVersion && snapshot.roomId === input.roomId && error?.name !== 'RoomSessionSupersededError') {
          publish({ phase: 'unavailable', error: error instanceof Error ? error : new Error(String(error)) });
        }
        throw error;
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { roomId: input.roomId, promise };
    return promise;
  });

  const controller = {
    selectRoom,
    ensureRoom: vi.fn((roomId: string, source = 'retry') => selectRoom({ roomId, source })),
    resume: vi.fn((source: string) => {
      if (!snapshot.roomId) return Promise.resolve(null);
      if (snapshot.phase === 'ready' && snapshot.result) {
        publish({ source, messageSyncRequestId: snapshot.messageSyncRequestId + 1 });
        return Promise.resolve(snapshot.result);
      }
      return selectRoom({ roomId: snapshot.roomId, source });
    }),
    leaveRoom: vi.fn((roomId: string) => {
      if (snapshot.roomId !== roomId) return;
      operationVersion += 1;
      inFlight = null;
      publish({
        phase: 'idle',
        roomId: null,
        result: null,
        source: 'manual',
        sessionEpoch: snapshot.sessionEpoch + 1,
        error: null,
      });
    }),
    isReady: vi.fn((roomId: string) => snapshot.roomId === roomId && snapshot.phase === 'ready'),
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    disconnect: () => {
      if (!snapshot.roomId) return;
      operationVersion += 1;
      inFlight = null;
      publish({ phase: 'retrying', socketId: null, source: 'socket-disconnect', error: null });
    },
    reconnect: () => {
      if (!snapshot.roomId) return;
      const roomId = snapshot.roomId;
      publish({
        phase: 'registering',
        socketId: 'socket-reconnected',
        sessionEpoch: snapshot.sessionEpoch + 1,
        source: 'socket-connect',
        error: null,
      });
      void selectRoom({ roomId, source: 'socket-connect' });
    },
    fail: (error: Error, source = 'socket-connect') => publish({ phase: 'unavailable', source, error }),
    reset: () => {
      operationVersion += 1;
      inFlight = null;
      snapshot = idleSnapshot();
      listeners.forEach(listener => listener());
    },
    setJoinImplementation: (implementation: typeof performJoin) => {
      performJoin = implementation;
    },
  };
  return controller;
});

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();

  const socket = {
    handlers,
    id: 'socket-1',
    connected: true,
    active: true,
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
      if (event === 'disconnect') {
        socket.connected = false;
        socket.active = true;
      }
      if (event === 'connect') {
        socket.connected = true;
        socket.active = true;
        socket.id = 'socket-reconnected';
      }
      handlers.get(event)?.forEach(handler => handler(...args));
      if (event === 'disconnect') roomSessionMock.disconnect();
      if (event === 'connect') roomSessionMock.reconnect();
    },
    reset: () => {
      handlers.clear();
      socket.id = 'socket-1';
      socket.connected = true;
      socket.active = true;
      socket.emit.mockImplementation(() => socket);
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
  onUsernameAdopted: vi.fn(),
  setUsername: vi.fn(),
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
  roomSessionController: roomSessionMock,
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
    RoomList: ({ rooms, onRoomSelect, onRoomSelectById, onModalTaskStart }: {
      rooms: Room[];
      onRoomSelect: (room: Room) => void;
      onRoomSelectById: (roomId: string) => void;
      onModalTaskStart?: () => void;
    }) => React.createElement(
      'div',
      { 'data-testid': 'room-list', 'data-room-ids': rooms.map(room => room.id).join(',') },
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
  return {
    SavedRoomList: ({ rooms }: { rooms: Room[] }) => React.createElement('div', {
      'data-testid': 'saved-room-list',
      'data-room-ids': rooms.map(room => room.id).join(','),
    }),
  };
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
    DesktopSidebar: ({ rooms, savedRooms, onRoomSelect }: {
      rooms: Room[];
      savedRooms: Room[];
      onRoomSelect?: (room: Room) => void;
    }) => React.createElement(
      'aside',
      {
        'data-testid': 'desktop-sidebar',
        'data-room-ids': rooms.map(room => room.id).join(','),
        'data-saved-room-ids': savedRooms.map(room => room.id).join(','),
      },
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
    ChatRoomView: ({ currentRoom, memberCount, isRestoringRoom, showRoomSessionSpinner, isRoomSessionReady, canUseRetainedRoomAccess, ensureRoomSessionReady, messageSyncRequestId, roomPermissions, handleShareRoom, handleToggleSave, handleDeleteRoom, onRetryRoomSession, setView, onRoomUpdated }: {
      currentRoom: Room;
      memberCount: number | null;
      isRestoringRoom: boolean;
      showRoomSessionSpinner?: boolean;
      isRoomSessionReady: boolean;
      canUseRetainedRoomAccess: boolean;
      ensureRoomSessionReady?: (roomId: string) => Promise<void>;
      messageSyncRequestId?: number;
      roomPermissions?: RoomPermissions | null;
      handleShareRoom?: () => void;
      handleToggleSave?: () => void;
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
        'data-restoring': String(showRoomSessionSpinner ?? isRestoringRoom),
        'data-session-restoring': String(isRestoringRoom),
        'data-session-ready': String(isRoomSessionReady),
        'data-retained-access': String(canUseRetainedRoomAccess),
        'data-message-sync-request-id': String(messageSyncRequestId ?? 0),
        'data-permission-room-id': roomPermissions?.roomId || 'none',
        'data-can-post': String(Boolean(roomPermissions?.canPost)),
        'data-posting-enabled': String(Boolean(currentRoom.postingSchedule?.enabled)),
      },
      currentRoom.name,
      React.createElement('button', {
        'data-testid': 'share-room',
        disabled: !canUseRetainedRoomAccess,
        onClick: handleShareRoom,
      }),
      React.createElement('button', {
        'data-testid': 'ensure-room-operation',
        disabled: !canUseRetainedRoomAccess,
        onClick: () => void ensureRoomSessionReady?.(currentRoom.id),
      }),
      React.createElement('button', {
        'data-testid': 'toggle-save-room',
        disabled: !canUseRetainedRoomAccess,
        onClick: handleToggleSave,
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
    CodeAgentRoomView: ({ currentRoom, isRoomSessionReady, canUseRetainedRoomAccess }: {
      currentRoom: Room;
      isRoomSessionReady: boolean;
      canUseRetainedRoomAccess: boolean;
    }) => React.createElement('div', {
      'data-testid': 'code-agent-room-view',
      'data-room-id': currentRoom.id,
      'data-session-ready': String(isRoomSessionReady),
      'data-retained-access': String(canUseRetainedRoomAccess),
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

const dispatchPageShow = (persisted = true) => {
  const event = new Event('pageshow') as Event & { persisted: boolean };
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
};

describe('MessagePage room session restore', () => {
  beforeEach(() => {
    localStorage.clear();
    socketMock.reset();
    roomSessionMock.reset();
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
    socketApiMock.joinRoom.mockImplementation(async () => ({
      room: room(),
      permissions: permissions(),
      memberCount: 5,
    }));
    roomSessionMock.setJoinImplementation((roomId, password) => socketApiMock.joinRoom(roomId, password));
    socketApiMock.leaveRoom.mockImplementation((roomId: string) => roomSessionMock.leaveRoom(roomId));
    socketApiMock.getRoomById.mockResolvedValue(room());
    socketApiMock.getRoomMemberCount.mockReturnValue(null);
    socketApiMock.onRoomMemberChange.mockReturnValue(vi.fn());
    socketApiMock.onUsernameAdopted.mockReturnValue(vi.fn());
    socketApiMock.getRoomsFromServer.mockResolvedValue([]);
    socketApiMock.getSavedRoomsFromServer.mockResolvedValue([]);
    socketApiMock.getRoomPermissions.mockResolvedValue(permissions());
  });

  afterEach(() => {
    cleanup();
  });

  it('replays room deltas that arrive while list snapshots are in flight', async () => {
    let resolveOwnedRooms: (rooms: Room[]) => void = () => {};
    let resolveSavedRooms: (rooms: Room[]) => void = () => {};
    socketApiMock.getRoomsFromServer.mockReturnValue(new Promise<Room[]>(resolve => {
      resolveOwnedRooms = resolve;
    }));
    socketApiMock.getSavedRoomsFromServer.mockReturnValue(new Promise<Room[]>(resolve => {
      resolveSavedRooms = resolve;
    }));
    renderPage();

    await waitFor(() => {
      expect(socketApiMock.getRoomsFromServer).toHaveBeenCalledTimes(1);
      expect(socketApiMock.getSavedRoomsFromServer).toHaveBeenCalledTimes(1);
    });
    act(() => {
      socketMock.trigger('new_room', room({ id: 'room-2', name: 'Room 2' }));
      socketMock.trigger('room_removed', 'room-1');
      socketMock.trigger('saved_room_added', room({ id: 'room-2', name: 'Room 2' }));
      socketMock.trigger('saved_room_removed', 'room-1');
    });
    await act(async () => {
      resolveOwnedRooms([room()]);
      resolveSavedRooms([room()]);
      await Promise.resolve();
    });

    await waitFor(() => {
      const sidebar = screen.getByTestId('desktop-sidebar');
      expect(sidebar.getAttribute('data-room-ids')).toBe('room-2');
      expect(sidebar.getAttribute('data-saved-room-ids')).toBe('room-2');
    });
  });

  it('refreshes list snapshots after the socket reconnects', async () => {
    renderPage();
    await waitFor(() => expect(socketApiMock.getRoomsFromServer).toHaveBeenCalledTimes(1));

    act(() => socketMock.trigger('connect'));

    await waitFor(() => {
      expect(socketApiMock.getRoomsFromServer).toHaveBeenCalledTimes(2);
      expect(socketApiMock.getSavedRoomsFromServer).toHaveBeenCalledTimes(2);
    });
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
    expect(messageCacheMock.reactivateCachedRoomMessageWindow).toHaveBeenCalledTimes(1);
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

  it('routes resume signals through the controller without duplicating an in-flight initial join', async () => {
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
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(roomSessionMock.resume).toHaveBeenCalledTimes(2);
    expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitialRestore({ room: room(), permissions: permissions(), memberCount: 5 });
      await initialRestore;
    });
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
    });
    expect(messageCacheMock.reactivateCachedRoomMessageWindow).toHaveBeenCalledTimes(1);
  });

  it('ignores the ordinary non-BFCache pageshow fired during initial load', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
    roomSessionMock.resume.mockClear();

    act(() => dispatchPageShow(false));
    await act(async () => {
      await Promise.resolve();
    });

    expect(roomSessionMock.resume).not.toHaveBeenCalled();
  });

  it('routes mobile, BFCache, and online resume signals without issuing another join', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));

    socketApiMock.joinRoom.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    document.dispatchEvent(new Event('visibilitychange'));
    dispatchPageShow();
    window.dispatchEvent(new Event('online'));

    await waitFor(() => expect(roomSessionMock.resume).toHaveBeenCalledTimes(3));
    expect(socketApiMock.joinRoom).not.toHaveBeenCalled();
    expect(messageCacheMock.reactivateCachedRoomMessageWindow).toHaveBeenCalledTimes(1);
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
    await waitFor(() => {
      expect(messageCacheMock.reactivateCachedRoomMessageWindow).toHaveBeenCalledTimes(2);
    });
  });

  it('advances the independent message sync request after a foreground resume', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-message-sync-request-id')).toBe('1');
    });

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-message-sync-request-id')).toBe('2');
    });
  });

  it('treats navigation back to an already verified room as navigation rather than another join', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('select-room-1'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
      expect(screen.getByTestId('chat-room-view').getAttribute('data-message-sync-request-id')).toBe('1');
    });
    expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('navigate-settings'));
    expect(await screen.findByTestId('settings-view')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sidebar-select-room-1'));

    expect(await screen.findByTestId('chat-room-view')).toBeTruthy();
    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-message-sync-request-id')).toBe('1');
    expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1);
  });

  it('keeps acknowledged access on disconnect while the new socket rejoins', async () => {
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

    act(() => {
      socketMock.trigger('disconnect', 'transport close');
    });
    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-retained-access')).toBe('true');

    act(() => {
      socketMock.trigger('connect');
    });
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined));
    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-retained-access')).toBe('true');

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
      expect(screen.getByTestId('chat-room-view').getAttribute('data-retained-access')).toBe('true');
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
    socketApiMock.joinRoom.mockRejectedValue(new RoomSessionProtocolError('ROOM_NOT_FOUND', 'Room not found'));

    renderPage();

    await waitFor(() => {
      expect(localStorage.getItem('roomtalk_current_room')).toBeNull();
    });
    expect(socketApiMock.leaveRoom).toHaveBeenCalledWith('room-1');
    expect(socketApiMock.leaveRoom).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined));

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

  it('retains acknowledged room access when reconnect retries are exhausted', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();

    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));
    act(() => {
      roomSessionMock.fail(new Error('reconnect failed'));
    });

    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-retained-access')).toBe('true');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-permission-room-id')).toBe('room-1');
    expect(await screen.findByText('errorRestoringRoom')).toBeTruthy();
  });

  it('invalidates retained access after an explicit server denial', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();

    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-retained-access')).toBe('true'));
    act(() => {
      roomSessionMock.fail(new RoomSessionProtocolError('WORKSPACE_UNAVAILABLE', 'Workspace unavailable'));
    });

    expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('false');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-retained-access')).toBe('false');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-permission-room-id')).toBe('none');
    expect((screen.getByTestId('share-room') as HTMLButtonElement).disabled).toBe(true);
  });

  it('waits for room recovery before updating the saved-room state', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));

    act(() => {
      roomSessionMock.fail(new Error('reconnect failed'));
    });
    let resolveRecovery!: (value: { room: Room; permissions: RoomPermissions; memberCount: number }) => void;
    socketApiMock.joinRoom.mockImplementationOnce(() => new Promise(resolve => {
      resolveRecovery = resolve;
    }));
    socketApiMock.saveRoomToServer.mockResolvedValueOnce(room());
    socketApiMock.joinRoom.mockClear();

    fireEvent.click(screen.getByTestId('toggle-save-room'));
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined));
    expect(socketApiMock.saveRoomToServer).not.toHaveBeenCalled();

    await act(async () => resolveRecovery({ room: room(), permissions: permissions(), memberCount: 1 }));
    await waitFor(() => expect(socketApiMock.saveRoomToServer).toHaveBeenCalledWith('room-1'));
  });

  it('atomically clears the active room when the controller confirms it is missing', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));

    act(() => {
      roomSessionMock.fail(new RoomSessionProtocolError('ROOM_NOT_FOUND', 'Room not found'));
    });

    await waitFor(() => expect(screen.queryByTestId('chat-room-view')).toBeNull());
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

    socketApiMock.joinRoom.mockRejectedValueOnce(new RoomSessionProtocolError(
      'ROOM_PASSWORD_REQUIRED_OR_INCORRECT',
      'Room password is required or incorrect',
    ));
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
    expect(screen.getByTestId('chat-room-view').getAttribute('data-retained-access')).toBe('false');
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
    expect(roomView.getAttribute('data-retained-access')).toBe('false');
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

  it('keeps member count stable and hides the header spinner during a foreground message synchronization', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();

    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('5');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');

    socketApiMock.joinRoom.mockClear();
    socketApiMock.getRoomMemberCount.mockReturnValue(null);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(roomSessionMock.resume).toHaveBeenCalledWith('visibility'));
    expect(socketApiMock.joinRoom).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('5');
    expect(screen.getByTestId('chat-room-view').getAttribute('data-restoring')).toBe('false');
  });

  it('keeps the current member count when a reconnect acknowledgement omits it', async () => {
    localStorage.setItem('roomtalk_current_room', JSON.stringify(room()));
    localStorage.setItem('roomtalk_current_view', 'chat');

    renderPage();

    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('chat-room-view').getAttribute('data-member-count')).toBe('5');

    socketApiMock.joinRoom.mockClear();
    socketApiMock.joinRoom.mockResolvedValue({ room: room(), permissions: permissions() });
    socketApiMock.getRoomMemberCount.mockReturnValue(null);

    act(() => {
      socketMock.trigger('disconnect', 'transport close');
      socketMock.trigger('connect');
    });
    await waitFor(() => expect(socketApiMock.joinRoom).toHaveBeenCalledWith('room-1', undefined));
    await waitFor(() => expect(screen.getByTestId('chat-room-view').getAttribute('data-session-ready')).toBe('true'));

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

    // Socket replacement's join ack carries a room snapshot read before the
    // newer broadcast; it must not roll metadata back.
    let resolveStaleReconnect: (value: unknown) => void = () => {};
    socketApiMock.joinRoom.mockImplementation(() => new Promise(resolve => {
      resolveStaleReconnect = resolve;
    }));
    act(() => {
      socketMock.trigger('disconnect', 'transport close');
      socketMock.trigger('connect');
    });
    await waitFor(() => expect(socketApiMock.joinRoom.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      resolveStaleReconnect({
        room: room({ postingSchedule: enabledSchedule(), updatedAt: '2026-06-08T10:02:00.000Z' }),
        permissions: permissions(),
        memberCount: 2,
      });
    });

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
      act(() => {
        socketMock.trigger('disconnect', 'transport close');
        socketMock.trigger('connect');
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
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
