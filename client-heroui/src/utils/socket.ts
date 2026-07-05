import { default as io } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { clearStoredUsername, saveUsername } from './appPersistence';
import { apiPath } from './apiBase';
import {
  A2UIActionEvent,
  AudioTranscription,
  CodeAgentMode,
  MediaKind,
  Message,
  Room,
  RoomClientLookup,
  RoomMediaHistoryKindFilter,
  RoomMediaHistoryPage,
  RoomMemberEvent,
  RoomOnlineMember,
  RoomPermissions,
  RoomPostingSchedule,
  RoomRoleMember,
  RoomType,
} from './types';
import { Socket } from 'socket.io-client';
import type { CodexPermissionMode, CodexReasoningEffort } from './codexSettings';

// Get client ID from local storage or create a new one
// This ID persists across browser sessions and uniquely identifies the user
const getClientId = (): string => {
  let clientId = localStorage.getItem('clientId');
  if (!clientId) {
    clientId = uuidv4();
    localStorage.setItem('clientId', clientId);
  }
  return clientId;
};

export const getCurrentClientId = (): string => getClientId();

const getBrowserInstanceId = (): string => {
  let id = localStorage.getItem('browserInstanceId');
  if (!id) {
    id = uuidv4();
    localStorage.setItem('browserInstanceId', id);
  }
  return id;
};

// Store room member counts
const roomMemberCounts = new Map<string, number>();

// Store callbacks for room member change events
const roomMemberChangeCallbacks: ((event: RoomMemberEvent) => void)[] = [];
const usernameAdoptedCallbacks: ((username: string) => void)[] = [];

// Store current active room to rejoin after reconnection
let activeRoomId: string | null = null;
let activeRoomPassword: string | null = null;
// Store the latest username so it can be re-sent on every (re)connection
let currentUsername = '';
let registeredSocketId: string | null = null;
let pendingRegistration: Promise<void> | null = null;
let suppressNextConnectAutoRegistration = false;
const SEND_MESSAGE_ACK_TIMEOUT_MS = 15000;
const SEND_MESSAGE_CONNECT_TIMEOUT_MS = 15000;
const ROOM_LOOKUP_TIMEOUT_MS = 30000;
const CLIENT_AUTH_TOKEN_KEY = 'clientAuthToken';

export type RoomJoinResult = {
  room?: Room;
  permissions?: RoomPermissions;
  memberCount?: number;
};

type SocketAckResponse = {
  success: boolean;
  error?: string;
  message?: unknown;
};

type CreateRoomAckResponse = SocketAckResponse & {
  roomId?: string;
};

export type CreateRoomOptions = {
  password?: string;
  postingSchedule?: RoomPostingSchedule | null;
  type?: RoomType;
};

type SendMessageAckResponse = SocketAckResponse & {
  message?: Message;
};

type SendMessageAndAskAIAckResponse = SocketAckResponse & {
  userMessage?: Message;
  aiMessageId?: string;
  aiStarted?: boolean;
  aiError?: string;
};

type CodeAgentWorkspaceSnapshotAckResponse = SocketAckResponse & {
  snapshot?: unknown;
};

type CodeWorkspaceEntriesAckResponse = SocketAckResponse & {
  entries?: unknown[];
  truncated?: boolean;
};

type CodeWorkspaceFileAckResponse = SocketAckResponse & {
  file?: unknown;
};

type CodeWorkspaceDiffAckResponse = SocketAckResponse & {
  diff?: unknown;
};

type CodeWorkspaceRefsAckResponse = SocketAckResponse & {
  refs?: unknown;
};

type CodeWorkspaceEntryAckResponse = SocketAckResponse & {
  entry?: unknown;
};

type CodeWorkspaceAssetUrlAckResponse = SocketAckResponse & {
  asset?: unknown;
};

type CodeWorkspacePreviewSessionAckResponse = SocketAckResponse & {
  session?: unknown;
  sessions?: unknown[];
};

type CodeWorkspacePreviewTargetAckResponse = SocketAckResponse & {
  target?: unknown;
};

type CodeWorkspacePreviewServersAckResponse = SocketAckResponse & {
  servers?: unknown[];
};

type CodexThreadListAckResponse = SocketAckResponse & {
  threads?: unknown[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
};

type CodexThreadReadAckResponse = SocketAckResponse & {
  thread?: unknown;
};

type RoomAckResponse = SocketAckResponse & {
  room?: Room;
};

type RoomListAckResponse = SocketAckResponse & {
  rooms?: Room[];
};

type JoinRoomAckResponse = RoomAckResponse & {
  permissions?: RoomPermissions;
  memberCount?: number;
};

type RegisterAckResponse = SocketAckResponse & {
  clientId?: string;
  nickname?: string;
};

export type ClientAuthStatus = {
  clientId: string;
  hasPassword: boolean;
  hasAccount?: boolean;
};

type ClientAuthResponse = ClientAuthStatus & {
  clientAuthToken: string;
  nickname?: string | null;
};

export type ClientAccountInfo = {
  accountId: string;
  primaryClientId: string;
  provider: 'google';
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  avatarUrl?: string;
  lastLoginAt?: string;
};

export type ClientAccountStatus = {
  clientId: string;
  hasPassword: boolean;
  googleConfigured: boolean;
  account: ClientAccountInfo | null;
};

type GoogleAuthResponse = ClientAuthResponse & {
  account: ClientAccountInfo;
};

type RoomPermissionsAckResponse = SocketAckResponse & {
  permissions?: RoomPermissions;
};

type RoomRoleMembersAckResponse = SocketAckResponse & {
  members?: RoomRoleMember[];
};

type RoomClientLookupAckResponse = SocketAckResponse & {
  client?: RoomClientLookup;
};

export const sendA2UIAction = (payload: {
  roomId: string;
  messageId: string;
  action: A2UIActionEvent;
  systemPrompt?: string;
  roleName?: string;
  model?: string;
  maxContextMessages?: number;
}): Promise<void> => (
  emitWithAck<SocketAckResponse>(
    'a2ui_action',
    payload,
    'Timed out while sending UI action',
    'Failed to send UI action',
  ).then(() => undefined)
);

// Get current member count for a room
export const getRoomMemberCount = (roomId: string): number | null => {
  return roomMemberCounts.get(roomId) ?? null;
};

// Update the username and notify the server. The value is cached so it can be
// re-sent automatically on reconnection (see the 'connect' handler).
export const setUsername = (username: string): void => {
  currentUsername = username;
  if (username && socket.connected) {
    ensureRegisteredSocket()
      .then(() => socket.emit('set_username', username))
      .catch((error) => {
        console.error('Failed to register socket before updating username:', error);
      });
  }
};

// Fetch the list of online members (with nicknames) for a room
export const getRoomMembers = (roomId: string): Promise<RoomOnlineMember[]> => {
  return emitWithAck<SocketAckResponse & { members?: RoomOnlineMember[] }>(
    'get_room_members',
    { roomId },
    'Timed out while getting room members',
    'Failed to get room members',
  ).then((response) => response.members || []);
};

export const getRoomRoleMembers = (roomId: string): Promise<RoomRoleMember[]> => {
  return emitWithAck<RoomRoleMembersAckResponse>(
    'get_room_role_members',
    { roomId },
    'Timed out while getting room administrators',
    'Failed to get room administrators',
  ).then((response) => response.members || []);
};

export const lookupRoomClient = (roomId: string, targetClientId: string): Promise<RoomClientLookup> => {
  return emitWithAck<RoomClientLookupAckResponse>(
    'lookup_room_client',
    { roomId, targetClientId },
    'Timed out while checking user',
    'Failed to check user',
  ).then((response) => {
    if (!response.client) {
      throw new Error('Server did not return user details');
    }
    return response.client;
  });
};

export const getClientAuthToken = (): string | null => {
  const token = localStorage.getItem(CLIENT_AUTH_TOKEN_KEY)?.trim();
  return token || null;
};

export const setClientAuthToken = (token: string): void => {
  localStorage.setItem(CLIENT_AUTH_TOKEN_KEY, token);
};

export const clearClientAuthToken = (): void => {
  localStorage.removeItem(CLIENT_AUTH_TOKEN_KEY);
};

export const withClientAuthBody = <TBody extends Record<string, unknown>>(body: TBody): TBody & { clientAuthToken?: string } => {
  const token = getClientAuthToken();
  return token ? { ...body, clientAuthToken: token } : body;
};

// clientId acts as a bearer secret, so send it (and the auth token) as request
// headers instead of query params — query strings leak into browser history,
// proxy/CDN access logs, and the Referer header. The server reads X-Client-Id
// (falling back to ?clientId= for older clients) and X-Client-Auth-Token.
const clientAuthHeaders = (id: string = getClientId()): Record<string, string> => {
  const headers: Record<string, string> = { 'X-Client-Id': id };
  const token = getClientAuthToken();
  if (token) {
    headers['X-Client-Auth-Token'] = token;
  }
  return headers;
};

// Create and configure Socket connection
const createSocketConnection = (): typeof Socket => {
  const socketUrl = import.meta.env.VITE_SOCKET_URL;
  // 强化的Socket.io配置，添加自动重连和超时设置
  const socket = io(socketUrl, {
    reconnection: true,          // 启用自动重连
    reconnectionAttempts: 10,    // 最大重连尝试次数
    reconnectionDelay: 1000,     // 初始重连延迟(ms)
    reconnectionDelayMax: 5000,  // 最大重连延迟(ms)
    timeout: 20000,              // 连接超时时间(ms)
    autoConnect: true,           // 创建实例时自动连接
    transports: ['websocket'],   // 强制使用WebSocket
    upgrade: false,              // 禁用自动升级
  });
  
  // Register client ID when socket connection is established
  // This associates the persistent clientId with the temporary socket.id
  socket.on('connect', () => {
    console.log('Connected to WebSocket server, socket ID:', socket.id);
    registeredSocketId = null;
    if (suppressNextConnectAutoRegistration) {
      suppressNextConnectAutoRegistration = false;
      return;
    }

    ensureRegisteredSocket()
      .catch((error) => {
        console.error('Failed to register socket session after connection:', error);
      });
  });
  
  // Handle connection errors
  socket.on('connect_error', (error: Error) => {
    console.error('Socket connection error:', error);
  });
  
  // Handle disconnection
  socket.on('disconnect', (reason: string) => {
    console.log('Socket disconnected:', reason);
    registeredSocketId = null;
  });

  // Handle reconnection events
  socket.on('reconnect', (attemptNumber: number) => {
    console.log('Socket reconnected after', attemptNumber, 'attempts');
  });

  socket.on('reconnect_attempt', (attemptNumber: number) => {
    console.log('Socket reconnection attempt:', attemptNumber);
  });

  socket.on('reconnect_error', (error: Error) => {
    console.error('Socket reconnection error:', error);
  });

  socket.on('reconnect_failed', () => {
    console.error('Socket reconnection failed');
  });

  // Handle room member changes (join/leave events)
  socket.on('room_member_change', (event: RoomMemberEvent) => {
    roomMemberCounts.set(event.roomId, event.count);
    
    roomMemberChangeCallbacks.forEach(callback => callback(event));
  });
  
  return socket;
};

export const ensureRegisteredSocket = (timeoutMs = SEND_MESSAGE_ACK_TIMEOUT_MS): Promise<void> => {
  if (pendingRegistration) {
    return pendingRegistration;
  }

  if (socket.connected) {
    const socketId = socket.id || '';

    if (socketId && registeredSocketId === socketId) {
      return Promise.resolve();
    }
  }

  let startRegistration: () => void = () => {};
  const registrationPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutId: number;
    let registerAttempt = 0;

    function cleanup() {
      window.clearTimeout(timeoutId);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    }

    function settle(fn: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      pendingRegistration = null;
      suppressNextConnectAutoRegistration = false;
      fn();
    }

    function waitForReconnect() {
      if (settled) {
        return;
      }
      if (socket.connected) {
        attemptRegister();
        return;
      }
      socket.off('connect', handleConnect);
      socket.on('connect', handleConnect);
      suppressNextConnectAutoRegistration = true;
      socket.connect();
    }

    function handleConnect() {
      socket.off('connect', handleConnect);
      attemptRegister();
    }

    function handleDisconnect() {
      registeredSocketId = null;
      registerAttempt += 1;
      socket.off('disconnect', handleDisconnect);
      waitForReconnect();
    }

    function attemptRegister() {
      if (settled) {
        return;
      }
      if (!socket.connected) {
        waitForReconnect();
        return;
      }

      const socketId = socket.id || '';
      if (socketId && registeredSocketId === socketId) {
        settle(resolve);
        return;
      }

      const attemptId = registerAttempt + 1;
      registerAttempt = attemptId;
      socket.off('disconnect', handleDisconnect);
      socket.on('disconnect', handleDisconnect);
      socket.emit('register', {
        clientId: getClientId(),
        browserInstanceId: getBrowserInstanceId(),
        username: currentUsername || undefined,
        clientAuthToken: getClientAuthToken() || undefined,
      }, (response: RegisterAckResponse) => {
        if (settled || attemptId !== registerAttempt) {
          return;
        }
        socket.off('disconnect', handleDisconnect);
        if (!socket.connected) {
          handleDisconnect();
          return;
        }
        settle(() => {
          if (response?.success) {
            registeredSocketId = socketId || socket.id || null;
            const adopted = typeof response.nickname === 'string' ? response.nickname.trim() : '';
            if (adopted && adopted !== currentUsername) {
              currentUsername = adopted;
              saveUsername(adopted);
              usernameAdoptedCallbacks.forEach(callback => callback(adopted));
            }
            resolve();
            return;
          }

          const message = typeof response?.message === 'string' ? response.message : undefined;
          reject(new Error(response?.error || message || 'Failed to register client'));
        });
      });
    }

    startRegistration = () => {
      timeoutId = window.setTimeout(() => {
        settle(() => reject(new Error('Timed out while registering client')));
      }, timeoutMs || SEND_MESSAGE_CONNECT_TIMEOUT_MS);

      attemptRegister();
    };
  });

  pendingRegistration = registrationPromise;
  startRegistration();
  return registrationPromise;
};

type EmitWithAckOptions = {
  retryOnSocketReconnect?: boolean;
};

const isRetryableSocketDisconnectError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message === 'Socket disconnected before sending message' ||
    error.message === 'Socket disconnected while waiting for server acknowledgement'
  );
};

const emitWithAck = <TResponse extends SocketAckResponse>(
  event: string,
  payload: unknown,
  timeoutMessage: string,
  fallbackError: string,
  options: EmitWithAckOptions = {},
): Promise<TResponse> => {
  const emitOnce = (): Promise<TResponse> => ensureRegisteredSocket().then(() => new Promise<TResponse>((resolve, reject) => {
    if (!socket.connected) {
      reject(new Error('Socket disconnected before sending message'));
      return;
    }

    let settled = false;
    let timeoutId: number;

    function cleanup() {
      window.clearTimeout(timeoutId);
      socket.off('disconnect', handleDisconnect);
    }

    function settle(fn: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    }

    function handleDisconnect() {
      settle(() => reject(new Error('Socket disconnected while waiting for server acknowledgement')));
    }

    timeoutId = window.setTimeout(() => {
      settle(() => reject(new Error(timeoutMessage)));
    }, SEND_MESSAGE_ACK_TIMEOUT_MS);

    socket.once('disconnect', handleDisconnect);
    socket.emit(event, payload, (response: TResponse) => {
      settle(() => {
        if (response?.success) {
          resolve(response);
          return;
        }
        const message = typeof response?.message === 'string' ? response.message : undefined;
        reject(new Error(response?.error || message || fallbackError));
      });
    });
  }));

  return emitOnce().catch((error) => {
    if (options.retryOnSocketReconnect && isRetryableSocketDisconnectError(error)) {
      return emitOnce();
    }
    throw error;
  });
};

// Join a chat room
export const joinRoom = (roomId: string, password?: string): Promise<RoomJoinResult> => {
  const previousRoomId = activeRoomId;
  const previousRoomPassword = activeRoomPassword;
  return emitWithAck<JoinRoomAckResponse>(
    'join_room',
    { roomId, password },
    'Timed out while joining room',
    'Failed to join room',
  ).then((response) => ({
    room: response.room,
    permissions: response.permissions,
    memberCount: response.memberCount,
  })).then((result) => {
    if (typeof result.memberCount === 'number') {
      roomMemberCounts.set(roomId, result.memberCount);
    }
    activeRoomId = roomId; // 记录当前活动房间ID，用于重连后重新加入
    activeRoomPassword = password || null;
    return result;
  }).catch((error) => {
    activeRoomId = previousRoomId;
    activeRoomPassword = previousRoomPassword;
    throw error;
  });
};

export const ensureRoomJoined = (roomId: string): Promise<RoomJoinResult> => {
  const password = activeRoomId === roomId ? activeRoomPassword || undefined : undefined;
  return joinRoom(roomId, password);
};

// Leave a chat room
export const leaveRoom = (roomId: string) => {
  if (activeRoomId === roomId) {
    activeRoomId = null; // 清除活动房间ID
    activeRoomPassword = null;
  }
  socket.emit('leave_room', roomId);
};

// Create a new room
export const createRoom = (
  roomName: string,
  description?: string,
  optionsOrPassword?: CreateRoomOptions | string,
  legacyPostingSchedule?: RoomPostingSchedule | null,
): Promise<string> => {
  const options: CreateRoomOptions = typeof optionsOrPassword === 'string'
    ? { password: optionsOrPassword, postingSchedule: legacyPostingSchedule }
    : (optionsOrPassword || {});

  return ensureRegisteredSocket().then(() => new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Timed out while creating room'));
    }, SEND_MESSAGE_ACK_TIMEOUT_MS);

    socket.emit('create_room', {
      name: roomName,
      description,
      password: options.password,
      postingSchedule: options.postingSchedule,
      type: options.type || 'chat',
    }, (response: string | CreateRoomAckResponse) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);

      if (typeof response === 'string' && response) {
        resolve(response);
        return;
      }

      if (typeof response === 'object' && response?.success && response.roomId) {
        resolve(response.roomId);
        return;
      }

      const error = typeof response === 'object' && response ? response.error : undefined;
      reject(new Error(error || 'Failed to create room'));
    });
  }));
};

export const renameRoom = (roomId: string, name: string): Promise<Room> => {
  return emitWithAck<RoomAckResponse>(
    'rename_room',
    { roomId, name },
    'Timed out while renaming room',
    'Failed to rename room',
  ).then((response) => {
    if (!response.room) {
      throw new Error('Failed to rename room');
    }
    return response.room;
  });
};

export const saveRoomToServer = (roomId: string): Promise<Room> => {
  return emitWithAck<RoomAckResponse>(
    'save_room',
    { roomId },
    'Timed out while saving room',
    'Failed to save room',
  ).then((response) => {
    if (!response.room) {
      throw new Error('Server did not return saved room');
    }
    return response.room;
  });
};

export const unsaveRoomFromServer = (roomId: string): Promise<Room[]> => {
  return emitWithAck<RoomListAckResponse>(
    'unsave_room',
    { roomId },
    'Timed out while removing saved room',
    'Failed to remove saved room',
  ).then((response) => response.rooms || []);
};

export const getSavedRoomsFromServer = (): Promise<Room[]> => {
  return emitWithAck<RoomListAckResponse>(
    'get_saved_rooms',
    {},
    'Timed out while getting saved rooms',
    'Failed to get saved rooms',
  ).then((response) => response.rooms || []);
};

export const getRoomPermissions = (roomId: string): Promise<RoomPermissions> => {
  return emitWithAck<RoomPermissionsAckResponse>(
    'get_room_permissions',
    { roomId },
    'Timed out while getting room permissions',
    'Failed to get room permissions',
  ).then((response) => {
    if (!response.permissions) {
      throw new Error('Server did not return room permissions');
    }
    return response.permissions;
  });
};

export const clearRoomMessages = (roomId: string, confirmation: string): Promise<void> => {
  return emitWithAck<SocketAckResponse>(
    'clear_room_messages',
    { roomId, confirmation },
    'Timed out while clearing room history',
    'Failed to clear room history',
  ).then(() => undefined);
};

export const updateRoomSettings = (params: {
  roomId: string;
  password?: string;
  clearPassword?: boolean;
  postingSchedule?: RoomPostingSchedule | null;
  codeAgentAccess?: Room['codeAgentAccess'] | null;
  codeAgentMode?: Room['codeAgentMode'] | null;
  codeAgentBackend?: Room['codeAgentBackend'] | null;
}): Promise<Room> => {
  return emitWithAck<RoomAckResponse>(
    'update_room_settings',
    params,
    'Timed out while updating room settings',
    'Failed to update room settings',
  ).then((response) => {
    if (!response.room) {
      throw new Error('Server did not return updated room');
    }
    return response.room;
  });
};

export const setRoomAdmin = (roomId: string, targetClientId: string): Promise<void> => {
  return emitWithAck<SocketAckResponse>(
    'set_room_admin',
    { roomId, targetClientId },
    'Timed out while adding administrator',
    'Failed to add administrator',
  ).then(() => undefined);
};

export const removeRoomAdmin = (roomId: string, targetClientId: string): Promise<void> => {
  return emitWithAck<SocketAckResponse>(
    'remove_room_admin',
    { roomId, targetClientId },
    'Timed out while removing administrator',
    'Failed to remove administrator',
  ).then(() => undefined);
};

export const removeRoomMember = (roomId: string, targetClientId: string): Promise<void> => {
  return emitWithAck<SocketAckResponse>(
    'remove_room_member',
    { roomId, targetClientId },
    'Timed out while removing room member',
    'Failed to remove room member',
  ).then(() => undefined);
};

export const transferRoomOwnership = (roomId: string, targetClientId: string): Promise<Room> => {
  return emitWithAck<RoomAckResponse>(
    'transfer_room_ownership',
    { roomId, targetClientId },
    'Timed out while transferring ownership',
    'Failed to transfer ownership',
  ).then((response) => {
    if (!response.room) {
      throw new Error('Server did not return updated room');
    }
    return response.room;
  });
};

// Send message to a specific room
export const sendMessage = (
  content: string,
  roomId: string,
  messageType: 'text' = 'text',
  username?: string,
  avatar?: { text: string; color: string },
  replyToMessageId?: string,
  clientMessageId?: string,
): Promise<Message> => {
  return emitWithAck<SendMessageAckResponse>(
    'send_message',
    { content, roomId, messageType, username, avatar, replyToMessageId, clientMessageId },
    'Timed out while saving message',
    'Failed to save message',
  ).then((response) => {
    if (!response.message) {
      throw new Error('Server did not return saved message');
    }

    return response.message;
  });
};

// Send a sticker as a message. Unlike media, this never uploads bytes: it sends a
// stable catalog reference (stickerId) over the same send_message channel.
export const sendSticker = (
  stickerId: string,
  roomId: string,
  username?: string,
  avatar?: { text: string; color: string },
  replyToMessageId?: string,
  clientMessageId?: string,
): Promise<Message> => {
  return emitWithAck<SendMessageAckResponse>(
    'send_message',
    { content: stickerId, roomId, messageType: 'sticker', username, avatar, replyToMessageId, clientMessageId },
    'Timed out while sending sticker',
    'Failed to send sticker',
  ).then((response) => {
    if (!response.message) {
      throw new Error('Server did not return saved sticker message');
    }
    return response.message;
  });
};

type CreateMediaUploadResponse = {
  assetId: string;
  uploadUrl: string;
  objectKey: string;
  expiresAt: string;
};

export { apiPath };

const parseApiError = async (response: Response, fallback: string) => {
  try {
    const payload = await response.json();
    if (typeof payload?.error === 'string') {
      return payload.error;
    }
  } catch {
    // Ignore non-JSON error bodies.
  }
  return fallback;
};

const postJson = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(apiPath(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Request failed'));
  }
  return response.json() as Promise<T>;
};

export const getClientAuthStatus = async (targetClientId = getClientId()): Promise<ClientAuthStatus> => {
  const response = await fetch(apiPath(`/api/client-auth/${encodeURIComponent(targetClientId)}/status`), {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to load User ID login status'));
  }
  return response.json() as Promise<ClientAuthStatus>;
};

export const getClientAccountStatus = async (targetClientId = getClientId()): Promise<ClientAccountStatus> => {
  const response = await fetch(apiPath('/api/auth/account'), {
    cache: 'no-store',
    headers: clientAuthHeaders(targetClientId),
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to load account status'));
  }
  return response.json() as Promise<ClientAccountStatus>;
};

const adoptAuthenticatedClient = (response: ClientAuthResponse) => {
  localStorage.setItem('clientId', response.clientId);
  const nickname = typeof response.nickname === 'string' ? response.nickname.trim() : '';
  if (nickname) {
    currentUsername = nickname;
    saveUsername(nickname);
    usernameAdoptedCallbacks.forEach(callback => callback(nickname));
  } else {
    currentUsername = '';
    clearStoredUsername();
  }
  setClientAuthToken(response.clientAuthToken);
  registeredSocketId = null;
  pendingRegistration = null;
  suppressNextConnectAutoRegistration = false;
  if (socket.connected) {
    void ensureRegisteredSocket().catch((error) => {
      console.error('Failed to register socket after switching User ID:', error);
    });
  }
};

export const setClientPassword = async (password: string, currentPassword?: string): Promise<ClientAuthStatus> => {
  const response = await postJson<ClientAuthResponse>('/api/client-auth/password', withClientAuthBody({
    clientId: getClientId(),
    password,
    currentPassword: currentPassword || undefined,
  }));
  setClientAuthToken(response.clientAuthToken);
  return { clientId: response.clientId, hasPassword: response.hasPassword };
};

export const loginWithClientPassword = async (targetClientId: string, password: string): Promise<ClientAuthStatus> => {
  const response = await postJson<ClientAuthResponse>('/api/client-auth/login', {
    clientId: targetClientId,
    password,
  });
  adoptAuthenticatedClient(response);
  return { clientId: response.clientId, hasPassword: response.hasPassword };
};

export const loginWithGoogleCredential = async (credential: string): Promise<GoogleAuthResponse> => {
  const response = await postJson<GoogleAuthResponse>('/api/auth/google', withClientAuthBody({
    clientId: getClientId(),
    credential,
  }));
  adoptAuthenticatedClient(response);
  return response;
};

export const logoutClientPasswordSession = async (): Promise<void> => {
  const token = getClientAuthToken();
  if (token) {
    await postJson('/api/client-auth/logout', {
      clientId: getClientId(),
      clientAuthToken: token,
    }).catch(() => undefined);
  }
  clearClientAuthToken();
};

const putMediaObject = async (uploadUrl: string, file: Blob, mimeType: string) => {
  const response = await fetch(apiPath(uploadUrl), {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: file,
  });
  if (!response.ok) {
    throw new Error('Failed to upload media object');
  }
};

export const uploadMediaMessage = async (params: {
  file: Blob;
  roomId: string;
  kind: MediaKind;
  mimeType?: string;
  username?: string;
  avatar?: { text: string; color: string };
  replyToMessageId?: string;
  clientMessageId?: string;
  caption?: string;
  filename?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}): Promise<Message> => {
  const mimeType = (params.mimeType || params.file.type || `${params.kind}/octet-stream`).toLowerCase();
  const byteSize = params.file.size;
  const upload = await postJson<CreateMediaUploadResponse>('/api/media/uploads', withClientAuthBody({
    clientId,
    roomId: params.roomId,
    kind: params.kind,
    mimeType,
    byteSize,
    filename: params.filename,
  }));

  await putMediaObject(upload.uploadUrl, params.file, mimeType);

  return postJson<Message>(`/api/media/uploads/${encodeURIComponent(upload.assetId)}/complete`, withClientAuthBody({
    clientId,
    roomId: params.roomId,
    kind: params.kind,
    mimeType,
    byteSize,
    objectKey: upload.objectKey,
    username: params.username,
    avatar: params.avatar,
    replyToMessageId: params.replyToMessageId,
    clientMessageId: params.clientMessageId,
    caption: params.caption,
    filename: params.filename,
    width: params.width,
    height: params.height,
    durationMs: params.durationMs,
  }));
};

export const requestAIResponse = (data: {
  roomId: string;
  systemPrompt?: string;
  roleName?: string;
  model?: string;
  codexModel?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexPermissionMode?: CodexPermissionMode;
  editedMessageId?: string;
  retryForMessageId?: string;
  maxContextMessages?: number;
  codeAgentMode?: CodeAgentMode;
}) => {
  return emitWithAck('ask_ai', data, 'Timed out while starting AI response', 'Failed to start AI response')
    .then(() => undefined);
};

export const requestCodeAgentWorkspaceSnapshot = (roomId: string): Promise<unknown> => (
  emitWithAck<CodeAgentWorkspaceSnapshotAckResponse>(
    'get_code_workspace_snapshot',
    { roomId },
    'Timed out while refreshing workspace',
    'Failed to refresh workspace',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.snapshot) {
      throw new Error('Server did not return workspace snapshot');
    }

    return response.snapshot;
  })
);

export const requestCodeWorkspaceEntries = (roomId: string): Promise<{ entries: unknown[]; truncated: boolean }> => (
  emitWithAck<CodeWorkspaceEntriesAckResponse>(
    'list_code_workspace_entries',
    { roomId },
    'Timed out while loading workspace files',
    'Failed to load workspace files',
    { retryOnSocketReconnect: true },
  ).then((response) => ({
    entries: response.entries || [],
    truncated: Boolean(response.truncated),
  }))
);

export const requestCodeWorkspaceEntrySearch = (
  roomId: string,
  query: string,
  limit = 200,
): Promise<{ entries: unknown[]; truncated: boolean }> => (
  emitWithAck<CodeWorkspaceEntriesAckResponse>(
    'search_code_workspace_entries',
    { roomId, query, limit },
    'Timed out while searching workspace files',
    'Failed to search workspace files',
    { retryOnSocketReconnect: true },
  ).then((response) => ({
    entries: response.entries || [],
    truncated: Boolean(response.truncated),
  }))
);

export const requestCodeWorkspaceRefs = (
  roomId: string,
  options: { query?: string; limit?: number } = {},
): Promise<unknown> => (
  emitWithAck<CodeWorkspaceRefsAckResponse>(
    'list_code_workspace_refs',
    {
      roomId,
      query: typeof options.query === 'string' ? options.query : '',
      limit: options.limit,
    },
    'Timed out while loading workspace refs',
    'Failed to load workspace refs',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.refs) {
      throw new Error('Server did not return workspace refs');
    }

    return response.refs;
  })
);

export const requestCodeWorkspaceFile = (roomId: string, path: string): Promise<unknown> => (
  emitWithAck<CodeWorkspaceFileAckResponse>(
    'read_code_workspace_file',
    { roomId, path },
    'Timed out while reading workspace file',
    'Failed to read workspace file',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.file) {
      throw new Error('Server did not return workspace file');
    }

    return response.file;
  })
);

export const requestCodeWorkspaceAssetUrl = (roomId: string, path: string): Promise<unknown> => (
  emitWithAck<CodeWorkspaceAssetUrlAckResponse>(
    'create_code_workspace_asset_url',
    { roomId, path },
    'Timed out while preparing workspace file preview',
    'Failed to prepare workspace file preview',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.asset) {
      throw new Error('Server did not return workspace asset URL');
    }

    return response.asset;
  })
);

export type CodeWorkspacePreviewEvent = {
  type: 'opened' | 'navigated' | 'resized' | 'status' | 'refreshed' | 'closed';
  roomId: string;
  tabId: string;
  createdAt: string;
  snapshot?: unknown;
};

export type CodeWorkspacePreviewNavigationTarget =
  | { kind: 'url'; url: string }
  | { kind: 'environment-port'; port: number; protocol?: 'http' | 'https'; path?: string };

export type CodeWorkspacePreviewResolvedTarget = {
  requestedUrl: string;
  resolvedUrl: string;
  resolutionKind: 'direct' | 'e2b-port-host';
};

export type CodeWorkspacePreviewServerSnapshot = {
  host: string;
  port: number;
  url: string;
  processName?: string | null;
  pid?: number | null;
};

export const requestResolveCodeWorkspacePreviewTarget = (
  payload: { roomId: string; target: CodeWorkspacePreviewNavigationTarget },
): Promise<unknown> => (
  emitWithAck<CodeWorkspacePreviewTargetAckResponse>(
    'resolve_code_workspace_preview_target',
    payload,
    'Timed out while resolving workspace preview target',
    'Failed to resolve workspace preview target',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.target) {
      throw new Error('Server did not return workspace preview target');
    }
    return response.target;
  })
);

export const requestCodeWorkspacePreviewServers = (roomId: string): Promise<unknown[]> => (
  emitWithAck<CodeWorkspacePreviewServersAckResponse>(
    'list_code_workspace_preview_servers',
    { roomId },
    'Timed out while loading workspace preview servers',
    'Failed to load workspace preview servers',
    { retryOnSocketReconnect: true },
  ).then((response) => response.servers || [])
);

export const requestOpenCodeWorkspacePreviewSession = (
  payload: {
    roomId: string;
    tabId?: string;
    url?: string | null;
    title?: string;
    viewport?: unknown;
  },
): Promise<unknown> => (
  emitWithAck<CodeWorkspacePreviewSessionAckResponse>(
    'open_code_workspace_preview_session',
    payload,
    'Timed out while opening workspace preview',
    'Failed to open workspace preview',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.session) {
      throw new Error('Server did not return workspace preview session');
    }
    return response.session;
  })
);

export const requestNavigateCodeWorkspacePreviewSession = (
  payload: { roomId: string; tabId: string; url: string; title?: string },
): Promise<unknown> => (
  emitWithAck<CodeWorkspacePreviewSessionAckResponse>(
    'navigate_code_workspace_preview_session',
    payload,
    'Timed out while navigating workspace preview',
    'Failed to navigate workspace preview',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.session) {
      throw new Error('Server did not return workspace preview session');
    }
    return response.session;
  })
);

export const requestResizeCodeWorkspacePreviewSession = (
  payload: { roomId: string; tabId: string; viewport: unknown },
): Promise<unknown> => (
  emitWithAck<CodeWorkspacePreviewSessionAckResponse>(
    'resize_code_workspace_preview_session',
    payload,
    'Timed out while resizing workspace preview',
    'Failed to resize workspace preview',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.session) {
      throw new Error('Server did not return workspace preview session');
    }
    return response.session;
  })
);

export const requestReportCodeWorkspacePreviewSession = (
  payload: {
    roomId: string;
    tabId: string;
    navStatus: unknown;
    renderedViewport?: { width: number; height: number };
  },
): Promise<unknown> => (
  emitWithAck<CodeWorkspacePreviewSessionAckResponse>(
    'report_code_workspace_preview_session',
    payload,
    'Timed out while reporting workspace preview status',
    'Failed to report workspace preview status',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.session) {
      throw new Error('Server did not return workspace preview session');
    }
    return response.session;
  })
);

export const requestRefreshCodeWorkspacePreviewSession = (
  payload: { roomId: string; tabId: string },
): Promise<unknown> => (
  emitWithAck<CodeWorkspacePreviewSessionAckResponse>(
    'refresh_code_workspace_preview_session',
    payload,
    'Timed out while refreshing workspace preview',
    'Failed to refresh workspace preview',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.session) {
      throw new Error('Server did not return workspace preview session');
    }
    return response.session;
  })
);

export const requestCodeWorkspacePreviewSessions = (roomId: string): Promise<unknown[]> => (
  emitWithAck<CodeWorkspacePreviewSessionAckResponse>(
    'list_code_workspace_preview_sessions',
    { roomId },
    'Timed out while loading workspace previews',
    'Failed to load workspace previews',
    { retryOnSocketReconnect: true },
  ).then((response) => response.sessions || [])
);

export const requestCloseCodeWorkspacePreviewSession = (
  payload: { roomId: string; tabId?: string },
): Promise<unknown[]> => (
  emitWithAck<CodeWorkspacePreviewSessionAckResponse>(
    'close_code_workspace_preview_session',
    payload,
    'Timed out while closing workspace preview',
    'Failed to close workspace preview',
    { retryOnSocketReconnect: true },
  ).then((response) => response.sessions || [])
);

export const requestCodeWorkspaceDiff = (
  roomId: string,
  options: { ignoreWhitespace?: boolean; scope?: 'branch' | 'unstaged'; baseRef?: string } = {},
): Promise<unknown> => (
  emitWithAck<CodeWorkspaceDiffAckResponse>(
    'read_code_workspace_diff',
    {
      roomId,
      ignoreWhitespace: options.ignoreWhitespace === true,
      scope: options.scope === 'unstaged' ? 'unstaged' : 'branch',
      baseRef: typeof options.baseRef === 'string' && options.baseRef.trim() ? options.baseRef.trim() : undefined,
    },
    'Timed out while reading workspace diff',
    'Failed to read workspace diff',
    { retryOnSocketReconnect: true },
  ).then((response) => {
    if (!response.diff) {
      throw new Error('Server did not return workspace diff');
    }

    return response.diff;
  })
);

export const requestWriteCodeWorkspaceFile = (params: {
  roomId: string;
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}): Promise<unknown> => (
  emitWithAck<CodeWorkspaceEntryAckResponse>(
    'write_code_workspace_file',
    params,
    'Timed out while writing workspace file',
    'Failed to write workspace file',
  ).then((response) => {
    if (!response.entry) {
      throw new Error('Server did not return workspace entry');
    }

    return response.entry;
  })
);

export const requestCreateCodeWorkspaceDirectory = (roomId: string, path: string): Promise<unknown> => (
  emitWithAck<CodeWorkspaceEntryAckResponse>(
    'create_code_workspace_directory',
    { roomId, path },
    'Timed out while creating workspace directory',
    'Failed to create workspace directory',
  ).then((response) => {
    if (!response.entry) {
      throw new Error('Server did not return workspace entry');
    }

    return response.entry;
  })
);

export const requestRenameCodeWorkspaceEntry = (roomId: string, fromPath: string, toPath: string): Promise<unknown> => (
  emitWithAck<CodeWorkspaceEntryAckResponse>(
    'rename_code_workspace_entry',
    { roomId, fromPath, toPath },
    'Timed out while renaming workspace entry',
    'Failed to rename workspace entry',
  ).then((response) => {
    if (!response.entry) {
      throw new Error('Server did not return workspace entry');
    }

    return response.entry;
  })
);

export const requestDeleteCodeWorkspaceEntry = (roomId: string, path: string): Promise<void> => (
  emitWithAck<SocketAckResponse>(
    'delete_code_workspace_entry',
    { roomId, path },
    'Timed out while deleting workspace entry',
    'Failed to delete workspace entry',
  ).then(() => undefined)
);

export const interruptCodeAgentTurn = (roomId: string, reason?: string): Promise<void> => (
  emitWithAck<SocketAckResponse>(
    'interrupt_code_agent_turn',
    { roomId, reason },
    'Timed out while interrupting code agent',
    'Failed to interrupt code agent',
  ).then(() => undefined)
);

export const steerCodeAgentTurn = (roomId: string, prompt: string): Promise<void> => (
  emitWithAck<SocketAckResponse>(
    'steer_code_agent_turn',
    { roomId, prompt },
    'Timed out while steering code agent',
    'Failed to steer code agent',
  ).then(() => undefined)
);

export const respondCodeAgentApproval = (
  roomId: string,
  approvalId: string,
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): Promise<void> => (
  emitWithAck<SocketAckResponse>(
    'respond_code_agent_approval',
    { roomId, approvalId, decision },
    'Timed out while responding to approval',
    'Failed to respond to approval',
  ).then(() => undefined)
);

export const requestCodexThreads = (
  roomId: string,
  options: { cursor?: string | null; limit?: number; searchTerm?: string } = {},
): Promise<{ threads: unknown[]; nextCursor?: string | null; backwardsCursor?: string | null }> => (
  emitWithAck<CodexThreadListAckResponse>(
    'list_codex_threads',
    { roomId, ...options },
    'Timed out while loading Codex threads',
    'Failed to load Codex threads',
  ).then((response) => ({
    threads: response.threads || [],
    nextCursor: response.nextCursor,
    backwardsCursor: response.backwardsCursor,
  }))
);

export const requestCodexThread = (
  roomId: string,
  threadId: string,
  options: { includeTurns?: boolean } = {},
): Promise<unknown> => (
  emitWithAck<CodexThreadReadAckResponse>(
    'read_codex_thread',
    { roomId, threadId, ...options },
    'Timed out while loading Codex thread',
    'Failed to load Codex thread',
  ).then((response) => response.thread)
);

export const sendMessageAndAskAI = (params: {
  roomId: string;
  content: string;
  username?: string;
  avatar?: { text: string; color: string };
  replyToMessageId?: string;
  clientMessageId?: string;
  systemPrompt?: string;
  roleName?: string;
  model?: string;
  codexModel?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexPermissionMode?: CodexPermissionMode;
  maxContextMessages?: number;
  codeAgentMode?: CodeAgentMode;
}): Promise<{ userMessage: Message; aiMessageId?: string; aiStarted: boolean; aiError?: string }> => {
  return emitWithAck<SendMessageAndAskAIAckResponse>(
    'send_message_and_ask_ai',
    params,
    'Timed out while saving message and starting AI',
    'Failed to save message and start AI',
  ).then((response) => {
    if (!response.userMessage) {
      throw new Error('Server did not return userMessage');
    }

    return {
      userMessage: response.userMessage,
      aiMessageId: response.aiMessageId,
      aiStarted: response.aiStarted !== false && !!response.aiMessageId,
      aiError: response.aiError,
    };
  });
};

export const requestEditMessageAndAIResponse = (data: {
  roomId: string;
  messageId: string;
  newContent: string;
  systemPrompt?: string;
  roleName?: string;
  model?: string;
  codexModel?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexPermissionMode?: CodexPermissionMode;
  maxContextMessages?: number;
  codeAgentMode?: CodeAgentMode;
}) => {
  return emitWithAck('edit_message_and_ask_ai', data, 'Timed out while starting AI response', 'Failed to start AI response')
    .then(() => undefined);
};

export const getMediaDownloadUrl = async (params: {
  roomId: string;
  assetId: string;
}): Promise<{ url: string; expiresAt?: string }> => {
  const query = new URLSearchParams({ roomId: params.roomId });
  const headers = clientAuthHeaders();
  const response = await fetch(apiPath(`/api/media/${encodeURIComponent(params.assetId)}/download-url?${query.toString()}`), {
    headers,
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to get media URL'));
  }
  const payload = await response.json();
  if (!payload?.url) {
    throw new Error('Server did not return media URL');
  }
  const url = typeof payload.url === 'string' ? apiPath(payload.url) : payload.url;
  return {
    url,
    expiresAt: payload.expiresAt,
  };
};

export const getRoomMessagesForExport = async (roomId: string): Promise<Message[]> => {
  const response = await fetch(apiPath(`/api/rooms/${encodeURIComponent(roomId)}/messages`), {
    cache: 'no-store',
    headers: {
      'cache-control': 'no-cache',
      ...clientAuthHeaders(),
    },
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to export room messages'));
  }
  return response.json() as Promise<Message[]>;
};

export const getRoomMediaHistory = async (params: {
  roomId: string;
  before?: string | null;
  limit?: number;
  kind?: RoomMediaHistoryKindFilter;
}): Promise<RoomMediaHistoryPage> => {
  const query = new URLSearchParams();
  if (params.before) {
    query.set('before', params.before);
  }
  if (params.limit) {
    query.set('limit', String(params.limit));
  }
  if (params.kind) {
    query.set('kind', params.kind);
  }

  const suffix = query.toString();
  const response = await fetch(
    apiPath(`/api/rooms/${encodeURIComponent(params.roomId)}/media-history${suffix ? `?${suffix}` : ''}`),
    { headers: clientAuthHeaders() },
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to get media history'));
  }

  const payload = await response.json() as RoomMediaHistoryPage;
  return {
    ...payload,
    items: (payload.items || []).map(item => ({
      ...item,
      url: apiPath(item.url),
    })),
  };
};

export const getAudioTranscription = async (params: {
  roomId: string;
  messageId: string;
}): Promise<AudioTranscription> => {
  const response = await fetch(apiPath(`/api/rooms/${encodeURIComponent(params.roomId)}/messages/${encodeURIComponent(params.messageId)}/audio-transcription`), {
    cache: 'no-store',
    headers: clientAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to load audio transcription'));
  }
  return response.json() as Promise<AudioTranscription>;
};

export const requestAudioTranscription = async (params: {
  roomId: string;
  messageId: string;
}): Promise<AudioTranscription> => (
  postJson<AudioTranscription>(
    `/api/rooms/${encodeURIComponent(params.roomId)}/messages/${encodeURIComponent(params.messageId)}/audio-transcription`,
    withClientAuthBody({ clientId })
  )
);

// Mint a short-lived AssemblyAI streaming token (server keeps the API key)
export const createTranscriptionToken = (): Promise<{ token: string }> => {
  return emitWithAck<SocketAckResponse & { token?: string }>(
    'create_transcription_token',
    {},
    'Timed out while getting transcription token',
    'Failed to get transcription token',
  ).then((response) => {
    if (!response.token) {
      throw new Error('Server did not return transcription token');
    }
    return { token: response.token };
  });
};

// Get a room by ID (for joining rooms by ID)
export const getRoomById = (roomId: string): Promise<Room | null> => {
  return ensureRegisteredSocket(ROOM_LOOKUP_TIMEOUT_MS).then(() => new Promise<Room | null>((resolve, reject) => {
    if (!socket.connected) {
      reject(new Error('Socket disconnected before getting room'));
      return;
    }

    let settled = false;
    let timeoutId: number;

    function cleanup() {
      window.clearTimeout(timeoutId);
      socket.off('disconnect', handleDisconnect);
    }

    function settle(fn: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    }

    function handleDisconnect() {
      settle(() => reject(new Error('Socket disconnected while getting room')));
    }

    timeoutId = window.setTimeout(() => {
      settle(() => reject(new Error('Timed out while getting room')));
    }, ROOM_LOOKUP_TIMEOUT_MS);

    socket.once('disconnect', handleDisconnect);
    socket.emit('get_room_by_id', roomId, (room: Room | null) => {
      settle(() => resolve(room));
    });
  }));
};

// Register a callback for room member changes
export const onRoomMemberChange = (callback: (event: RoomMemberEvent) => void) => {
  roomMemberChangeCallbacks.push(callback);
  return () => {
    const index = roomMemberChangeCallbacks.indexOf(callback);
    if (index !== -1) {
      roomMemberChangeCallbacks.splice(index, 1);
    }
  };
};

export const onUsernameAdopted = (callback: (username: string) => void) => {
  usernameAdoptedCallbacks.push(callback);
  return () => {
    const index = usernameAdoptedCallbacks.indexOf(callback);
    if (index !== -1) {
      usernameAdoptedCallbacks.splice(index, 1);
    }
  };
};

export const onCodeWorkspacePreviewEvent = (
  callback: (event: CodeWorkspacePreviewEvent) => void,
) => {
  socket.on('code_workspace_preview_event', callback);
  return () => {
    socket.off('code_workspace_preview_event', callback);
  };
};

export const onSocketConnected = (
  callback: () => void,
) => {
  socket.on('connect', callback);
  return () => {
    socket.off('connect', callback);
  };
};

// Force reconnect the socket - can be called when app comes to foreground
export const reconnectSocket = (): void => {
  if (!socket.connected) {
    console.log('Manually reconnecting socket...');
    socket.connect();
  }
};

// Export Socket instance and client ID
export const socket = createSocketConnection();
export const clientId = getClientId();
export const browserInstanceId = getBrowserInstanceId();
