import { default as io } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { Room, RoomMemberEvent, RoomMemberCount } from './types';
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

// Get current member count for a room
export const getRoomMemberCount = (roomId: string): number => {
  return roomMemberCounts.get(roomId) || 0;
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
    socket.emit('register', getClientId());
    
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

  // Handle room member count updates
  socket.on('room_member_count', (data: RoomMemberCount) => {
    roomMemberCounts.set(data.roomId, data.count);
  });

  // Handle room member changes (join/leave events)
  socket.on('room_member_change', (event: RoomMemberEvent) => {
    roomMemberCounts.set(event.roomId, event.count);
    
    roomMemberChangeCallbacks.forEach(callback => callback(event));
  });
  
  return socket;
};

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

// Send message to a specific room
export const sendMessage = (content: string, roomId: string, messageType: 'text' | 'image' = 'text', username?: string, avatar?: { text: string; color: string }) => {
  // 检查socket连接状态，如果断开则尝试重连
  if (!socket.connected) {
    console.log('Socket disconnected, attempting to reconnect...');
    socket.connect();
  }
  
  socket.emit('send_message', { content, roomId, messageType, username, avatar });
};

// Get a room by ID (for joining rooms by ID)
export const getRoomById = (roomId: string): Promise<Room | null> => {
  return new Promise((resolve) => {
    socket.emit('get_room_by_id', roomId, (room: Room | null) => {
      resolve(room);
    });
  });
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