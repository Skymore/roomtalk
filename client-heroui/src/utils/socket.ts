import { default as io } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { MediaKind, Message, Room, RoomMemberEvent, RoomOnlineMember } from './types';
import { Socket } from 'socket.io-client';

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

// Store room member counts
const roomMemberCounts = new Map<string, number>();

// Store callbacks for room member change events
const roomMemberChangeCallbacks: ((event: RoomMemberEvent) => void)[] = [];

// Store current active room to rejoin after reconnection
let activeRoomId: string | null = null;
// Store the latest username so it can be re-sent on every (re)connection
let currentUsername = '';
const SEND_MESSAGE_ACK_TIMEOUT_MS = 15000;
const SEND_MESSAGE_CONNECT_TIMEOUT_MS = 15000;
const ROOM_LOOKUP_TIMEOUT_MS = 30000;
const API_BASE_URL = (import.meta.env.VITE_SOCKET_URL || '').replace(/\/$/, '');

type SocketAckResponse = {
  success: boolean;
  error?: string;
  message?: unknown;
};

type SendMessageAckResponse = SocketAckResponse & {
  message?: Message;
};

type SendMessageAndAskAIAckResponse = SocketAckResponse & {
  userMessage?: Message;
  aiMessageId?: string;
};

type RoomAckResponse = SocketAckResponse & {
  room?: Room;
};

type RoomListAckResponse = SocketAckResponse & {
  rooms?: Room[];
};

// Get current member count for a room
export const getRoomMemberCount = (roomId: string): number | null => {
  return roomMemberCounts.get(roomId) ?? null;
};

// Update the username and notify the server. The value is cached so it can be
// re-sent automatically on reconnection (see the 'connect' handler).
export const setUsername = (username: string): void => {
  currentUsername = username;
  if (username && socket.connected) {
    socket.emit('set_username', username);
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
    // Register with the username so the server can show it in the online list.
    // Sending it together with register avoids a race with a separate set_username event.
    socket.emit('register', { clientId: getClientId(), username: currentUsername || undefined });

    // 重新加入之前的活动房间
    if (activeRoomId) {
      console.log('Rejoining active room after reconnection:', activeRoomId);
      socket.emit('join_room', activeRoomId);
    }
  });
  
  // Handle connection errors
  socket.on('connect_error', (error: Error) => {
    console.error('Socket connection error:', error);
  });
  
  // Handle disconnection
  socket.on('disconnect', (reason: string) => {
    console.log('Socket disconnected:', reason);
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

const waitForConnectedSocket = (timeoutMs = SEND_MESSAGE_CONNECT_TIMEOUT_MS) => new Promise<void>((resolve, reject) => {
  if (socket.connected) {
    resolve();
    return;
  }

  console.log('Socket disconnected, attempting to reconnect...');

  let timeoutId: number;
  let settled = false;

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
    fn();
  }

  function handleConnect() {
    settle(resolve);
  }

  function handleDisconnect() {
    settle(() => reject(new Error('Socket disconnected before sending message')));
  }

  timeoutId = window.setTimeout(() => {
    settle(() => reject(new Error('Timed out while reconnecting socket')));
  }, timeoutMs);

  socket.once('connect', handleConnect);
  socket.once('disconnect', handleDisconnect);
  socket.connect();
});

const emitWithAck = <TResponse extends SocketAckResponse>(
  event: string,
  payload: unknown,
  timeoutMessage: string,
  fallbackError: string,
): Promise<TResponse> => waitForConnectedSocket().then(() => new Promise<TResponse>((resolve, reject) => {
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

// Join a chat room
export const joinRoom = (roomId: string) => {
  activeRoomId = roomId; // 记录当前活动房间ID，用于重连后重新加入
  socket.emit('join_room', roomId);
};

// Leave a chat room
export const leaveRoom = (roomId: string) => {
  if (activeRoomId === roomId) {
    activeRoomId = null; // 清除活动房间ID
  }
  socket.emit('leave_room', roomId);
};

// Create a new room
export const createRoom = (roomName: string, description?: string) => {
  return new Promise((resolve) => {
    socket.emit('create_room', { name: roomName, description }, (roomId: string) => {
      resolve(roomId);
    });
  });
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

type CreateMediaUploadResponse = {
  assetId: string;
  uploadUrl: string;
  objectKey: string;
  expiresAt: string;
};

const apiPath = (path: string) => `${API_BASE_URL}${path}`;

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

const putMediaObject = async (uploadUrl: string, file: Blob, mimeType: string) => {
  const response = await fetch(uploadUrl, {
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
  width?: number;
  height?: number;
  durationMs?: number;
}): Promise<Message> => {
  const mimeType = (params.mimeType || params.file.type || `${params.kind}/octet-stream`).toLowerCase();
  const byteSize = params.file.size;
  const upload = await postJson<CreateMediaUploadResponse>('/api/media/uploads', {
    clientId,
    roomId: params.roomId,
    kind: params.kind,
    mimeType,
    byteSize,
  });

  await putMediaObject(upload.uploadUrl, params.file, mimeType);

  return postJson<Message>(`/api/media/uploads/${encodeURIComponent(upload.assetId)}/complete`, {
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
    width: params.width,
    height: params.height,
    durationMs: params.durationMs,
  });
};

export const requestAIResponse = (data: {
  roomId: string;
  systemPrompt?: string;
  roleName?: string;
  model?: string;
  editedMessageId?: string;
  retryForMessageId?: string;
}) => {
  return emitWithAck('ask_ai', data, 'Timed out while starting AI response', 'Failed to start AI response')
    .then(() => undefined);
};

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
}): Promise<{ userMessage: Message; aiMessageId: string }> => {
  return emitWithAck<SendMessageAndAskAIAckResponse>(
    'send_message_and_ask_ai',
    params,
    'Timed out while saving message and starting AI',
    'Failed to save message and start AI',
  ).then((response) => {
    if (!response.userMessage || !response.aiMessageId) {
      throw new Error('Server did not return userMessage or aiMessageId');
    }

    return {
      userMessage: response.userMessage,
      aiMessageId: response.aiMessageId,
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
}) => {
  return emitWithAck('edit_message_and_ask_ai', data, 'Timed out while starting AI response', 'Failed to start AI response')
    .then(() => undefined);
};

export const getMediaDownloadUrl = async (params: {
  roomId: string;
  assetId: string;
}): Promise<{ url: string; expiresAt?: string }> => {
  const query = new URLSearchParams({
    roomId: params.roomId,
    clientId,
  });
  const response = await fetch(apiPath(`/api/media/${encodeURIComponent(params.assetId)}/download-url?${query.toString()}`));
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to get media URL'));
  }
  const payload = await response.json();
  if (!payload?.url) {
    throw new Error('Server did not return media URL');
  }
  return {
    url: payload.url,
    expiresAt: payload.expiresAt,
  };
};

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
  return waitForConnectedSocket(ROOM_LOOKUP_TIMEOUT_MS).then(() => new Promise<Room | null>((resolve, reject) => {
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
