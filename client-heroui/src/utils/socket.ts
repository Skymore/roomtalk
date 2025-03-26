import { io, Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { Room } from './types';

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

// Create and configure Socket connection
const createSocketConnection = (): Socket => {
  const socketUrl = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3012';
  const socket = io(socketUrl);
  
  // Register client ID when socket connection is established
  // This associates the persistent clientId with the temporary socket.id
  socket.on('connect', () => {
    console.log('Connected to WebSocket server, socket ID:', socket.id);
    socket.emit('register', getClientId());
  });
  
  // Handle connection errors
  socket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
  });
  
  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', reason);
  });
  
  return socket;
};

// Join a chat room
export const joinRoom = (roomId: string) => {
  socket.emit('join_room', roomId);
};

// Leave a chat room
export const leaveRoom = (roomId: string) => {
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
export const sendMessage = (content: string, roomId: string) => {
  socket.emit('send_message', { content, roomId });
};

// Get a room by ID (for joining rooms by ID)
export const getRoomById = (roomId: string): Promise<Room | null> => {
  return new Promise((resolve) => {
    socket.emit('get_room_by_id', roomId, (room: Room | null) => {
      resolve(room);
    });
  });
};

// Export Socket instance and client ID
export const socket = createSocketConnection();
export const clientId = getClientId(); 