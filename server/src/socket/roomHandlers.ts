import { v4 as uuidv4 } from 'uuid';
import { createRoomMemberEvent, createRoomRecord } from '../services/messageDomain';
import { Room } from '../types';
import { SocketConnectionContext } from './types';

const MAX_ROOM_NAME_LENGTH = 20;

type RenameRoomAck = {
  success: boolean;
  room?: Room;
  error?: string;
};

const validateRoomName = (name: unknown): { ok: true; name: string } | { ok: false; error: string } => {
  if (typeof name !== 'string') {
    return { ok: false, error: 'Room name is required' };
  }

  const trimmedName = name.trim();
  if (!trimmedName) {
    return { ok: false, error: 'Room name is required' };
  }

  if (trimmedName.length > MAX_ROOM_NAME_LENGTH) {
    return { ok: false, error: `Room name cannot exceed ${MAX_ROOM_NAME_LENGTH} characters` };
  }

  return { ok: true, name: trimmedName };
};

export function registerRoomHandlers({ io, socket, store, socketLogger }: SocketConnectionContext) {
  socket.on('register', async (clientId: string) => {
    const userId = clientId || uuidv4();
    await store.storeClientSession(socket.id, userId);
    socketLogger.info('Client registered', { socketId: socket.id, clientId: userId });

    socket.join(userId);
    const myRooms = await store.readRoomsByUser(userId);
    socket.emit('room_list', myRooms);
  });

  socket.on('get_rooms', async () => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to get rooms', { socketId: socket.id });
      socket.emit('error', { message: 'You are not registered' });
      return;
    }

    socketLogger.debug('Client requested room list', { socketId: socket.id, clientId });
    const myRooms = await store.readRoomsByUser(clientId);
    socket.emit('room_list', myRooms);
  });

  socket.on('create_room', async (roomData: { name: string; description?: string }, callback?: (roomId: string) => void) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId || !roomData?.name) {
      socketLogger.warn('Invalid room creation attempt', {
        socketId: socket.id,
        clientRegistered: !!clientId,
        roomDataValid: !!roomData?.name,
      });
      socket.emit('error', { message: 'You are not registered or room name is required' });
      return;
    }

    const roomId = await store.generateUniqueRoomId();
    const room = createRoomRecord({
      roomId,
      name: roomData.name,
      description: roomData.description,
      creatorId: clientId,
    });

    socketLogger.info('Room creation requested', {
      socketId: socket.id,
      clientId,
      roomId,
      roomName: roomData.name,
    });

    const savedRoom = await store.saveRoom(room);
    if (savedRoom) {
      io.to(clientId).emit('new_room', savedRoom);
      socketLogger.info('Room created successfully', { roomId, clientId });
      callback?.(room.id);
    }
  });

  socket.on('join_room', async (roomId: string) => {
    const userId = await store.getClientId(socket.id);
    if (!userId) {
      socketLogger.warn('Unregistered client tried to join room', { socketId: socket.id, roomId });
      socket.emit('error', { message: 'You are not registered' });
      return;
    }

    const prevRooms = await store.getUserRooms(socket.id);
    for (const r of prevRooms) {
      const memberCount = await store.updateRoomMemberCount(r, userId, socket.id, false);
      const leaveEvent = createRoomMemberEvent({
        roomId: r,
        userId,
        count: memberCount,
        action: 'leave',
      });

      socketLogger.debug('User left previous room before joining new one', {
        socketId: socket.id,
        userId,
        roomId: r,
        memberCount,
      });

      socket.to(r).emit('room_member_change', leaveEvent);
      socket.leave(r);
    }

    const room = await store.getRoomById(roomId);
    if (!room) {
      socketLogger.warn('Client tried to join non-existent room', { socketId: socket.id, userId, roomId });
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    const persistentMember = await store.addRoomMember(roomId, userId, room.creatorId === userId ? 'owner' : 'member');
    if (!persistentMember) {
      socketLogger.error('Failed to persist room membership while joining room', { socketId: socket.id, userId, roomId });
      socket.emit('error', { message: 'Failed to join room' });
      return;
    }

    socket.join(roomId);
    await store.storeUserRooms(socket.id, [roomId]);

    const memberCount = await store.updateRoomMemberCount(roomId, userId, socket.id, true);
    const joinEvent = createRoomMemberEvent({
      roomId,
      userId,
      count: memberCount,
      action: 'join',
    });

    io.to(roomId).emit('room_member_change', joinEvent);
    io.to(userId).emit('room_list', await store.readRoomsByUser(userId));

    socketLogger.info('User joined room', {
      socketId: socket.id,
      userId,
      roomId,
      roomName: room.name,
      memberCount,
    });

  });

  socket.on('leave_room', async (roomId: string) => {
    const userId = await store.getClientId(socket.id);
    if (!userId) return;

    socket.leave(roomId);

    const memberCount = await store.updateRoomMemberCount(roomId, userId, socket.id, false);
    const leaveEvent = createRoomMemberEvent({
      roomId,
      userId,
      count: memberCount,
      action: 'leave',
    });

    io.to(roomId).emit('room_member_change', leaveEvent);

    socketLogger.info('User left room', { socketId: socket.id, userId, roomId, memberCount });

    const userRooms = await store.getUserRooms(socket.id);
    const updatedRooms = userRooms.filter(id => id !== roomId);
    await store.storeUserRooms(socket.id, updatedRooms);
  });

  socket.on('delete_room', async (roomId: string, callback?: (result: { success: boolean; message?: string }) => void) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to delete room', { socketId: socket.id, roomId });
      callback?.({ success: false, message: 'You are not registered' });
      return;
    }

    if (!roomId) {
      socketLogger.warn('Client tried to delete room without room ID', { socketId: socket.id, clientId });
      callback?.({ success: false, message: 'Room ID is required' });
      return;
    }

    try {
      const room = await store.getRoomById(roomId);
      if (!room) {
        socketLogger.warn('Attempted to delete non-existent room', { socketId: socket.id, clientId, roomId });
        callback?.({ success: false, message: 'Room not found' });
        return;
      }

      if (room.creatorId !== clientId) {
        socketLogger.warn('Unauthorized attempt to delete room', { socketId: socket.id, clientId, roomId, creatorId: room.creatorId });
        callback?.({ success: false, message: 'You are not authorized to delete this room' });
        return;
      }

      socketLogger.info('Attempting to delete room', { socketId: socket.id, clientId, roomId, roomName: room.name });

      await store.deleteRoom(roomId, clientId);

      socketLogger.info('Room deleted successfully', { socketId: socket.id, clientId, roomId });

      const userSockets = await io.in(clientId).allSockets();
      const updatedRooms = await store.readRoomsByUser(clientId);
      userSockets.forEach(sid => {
        io.to(sid).emit('room_list', updatedRooms);
      });

      callback?.({ success: true });
    } catch (error) {
      socketLogger.error('Error deleting room', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        socketId: socket.id,
        clientId,
        roomId,
      });
      callback?.({ success: false, message: 'Failed to delete room due to server error' });
    }
  });

  socket.on('rename_room', async (
    data: { roomId?: string; name?: string },
    callback?: (result: RenameRoomAck) => void
  ) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to rename room', { socketId: socket.id, roomId: data?.roomId });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    const roomId = data?.roomId;
    if (!roomId) {
      socketLogger.warn('Client tried to rename room without room ID', { socketId: socket.id, clientId });
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }

    const validation = validateRoomName(data?.name);
    if (!validation.ok) {
      socketLogger.warn('Client tried to rename room with invalid name', { socketId: socket.id, clientId, roomId });
      callback?.({ success: false, error: validation.error });
      return;
    }

    try {
      const room = await store.getRoomById(roomId);
      if (!room) {
        socketLogger.warn('Attempted to rename non-existent room', { socketId: socket.id, clientId, roomId });
        callback?.({ success: false, error: 'Room not found' });
        return;
      }

      if (room.creatorId !== clientId) {
        socketLogger.warn('Unauthorized attempt to rename room', { socketId: socket.id, clientId, roomId, creatorId: room.creatorId });
        callback?.({ success: false, error: 'You are not authorized to rename this room' });
        return;
      }

      const updatedRoom = await store.updateRoomName(roomId, clientId, validation.name);
      if (!updatedRoom) {
        socketLogger.error('Room rename failed after authorization', { socketId: socket.id, clientId, roomId });
        callback?.({ success: false, error: 'Failed to rename room' });
        return;
      }

      io.to(clientId).emit('room_updated', updatedRoom);
      io.to(roomId).emit('room_updated', updatedRoom);
      socketLogger.info('Room renamed successfully', { socketId: socket.id, clientId, roomId });
      callback?.({ success: true, room: updatedRoom });
    } catch (error) {
      socketLogger.error('Error renaming room', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        socketId: socket.id,
        clientId,
        roomId,
      });
      callback?.({ success: false, error: 'Failed to rename room due to server error' });
    }
  });

  socket.on('disconnect', async (reason: string) => {
    const userId = await store.getClientId(socket.id);
    if (userId) {
      socketLogger.info('Client disconnected', { socketId: socket.id, userId, reason });
      const rooms = await store.getUserRooms(socket.id);
      for (const roomId of rooms) {
        const memberCount = await store.updateRoomMemberCount(roomId, userId, socket.id, false);
        const leaveEvent = createRoomMemberEvent({
          roomId,
          userId,
          count: memberCount,
          action: 'leave',
        });
        io.to(roomId).emit('room_member_change', leaveEvent);
        socketLogger.debug('Client left room due to disconnect', { socketId: socket.id, userId, roomId, memberCount });
      }
      await store.removeClientSession(socket.id);
      await store.storeUserRooms(socket.id, []);
    } else {
      socketLogger.info(`Unidentified socket disconnected: ${socket.id}`, { reason });
    }
  });

  socket.on('get_room_by_id', async (roomId: string, callback: (room: Room | null) => void) => {
    const room = await store.getRoomById(roomId);
    const userId = await store.getClientId(socket.id);

    if (room) {
      socketLogger.debug('Room info requested', { socketId: socket.id, userId, roomId, roomName: room.name });
      callback(room);
    } else {
      socketLogger.warn('Room info requested for non-existent room', { socketId: socket.id, userId, roomId });
      callback(null);
    }
  });
}
