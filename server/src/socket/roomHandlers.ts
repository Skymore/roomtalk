import { v4 as uuidv4 } from 'uuid';
import { createCocoAccessControl } from '../services/cocoAccessControl';
import { createRoomMemberEvent, createRoomRecord, validateRoomNameInput } from '../services/messageDomain';
import { Room, RoomType } from '../types';
import { SocketConnectionContext } from './types';

type RenameRoomAck = {
  success: boolean;
  room?: Room;
  error?: string;
};

type CreateRoomAck = {
  success: boolean;
  roomId?: string;
  error?: string;
};

type CreateRoomPayload = {
  name: string;
  description?: string;
  type?: unknown;
};

const normalizeRoomType = (type: unknown): RoomType | undefined => (
  type === 'coco' ? 'coco' : undefined
);

export function registerRoomHandlers({ io, socket, store, socketLogger, cocoAccess = createCocoAccessControl({ enabled: false }) }: SocketConnectionContext) {
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

  socket.on('create_room', async (roomData: CreateRoomPayload, callback?: (result: CreateRoomAck) => void) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Invalid room creation attempt', {
        socketId: socket.id,
        clientRegistered: false,
        roomDataValid: !!roomData?.name,
      });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    const roomName = validateRoomNameInput(roomData?.name);
    if (!roomName.ok) {
      socketLogger.warn('Invalid room creation attempt', {
        socketId: socket.id,
        clientRegistered: true,
        roomDataValid: false,
      });
      callback?.({ success: false, error: roomName.error });
      return;
    }

    if (roomData?.type !== undefined && roomData.type !== 'chat' && roomData.type !== 'coco') {
      socketLogger.warn('Unknown room type ignored during room creation', {
        socketId: socket.id,
        clientId,
        roomType: roomData.type,
      });
    }
    if (roomData?.type === 'coco') {
      const access = cocoAccess.canUse(clientId);
      if (!access.allowed) {
        socketLogger.warn('Coco room creation rejected by rollout controls', {
          socketId: socket.id,
          clientId,
          reason: access.reason,
        });
        callback?.({ success: false, error: access.message || 'Coco is unavailable' });
        return;
      }
    }

    const roomId = await store.generateUniqueRoomId();
    const room = createRoomRecord({
      roomId,
      name: roomName.name,
      description: roomData?.description,
      creatorId: clientId,
      type: normalizeRoomType(roomData.type),
    });

    socketLogger.info('Room creation requested', {
      socketId: socket.id,
      clientId,
      roomId,
      roomName: roomName.name,
      roomType: room.type || 'chat',
    });

    const savedRoom = await store.saveRoom(room);
    if (savedRoom) {
      io.to(clientId).emit('new_room', savedRoom);
      socketLogger.info('Room created successfully', { roomId, clientId });
      callback?.({ success: true, roomId: room.id });
      return;
    }

    callback?.({ success: false, error: 'Failed to create room' });
  });

  socket.on('join_room', async (roomId: string) => {
    const userId = await store.getClientId(socket.id);
    if (!userId) {
      socketLogger.warn('Unregistered client tried to join room', { socketId: socket.id, roomId });
      socket.emit('error', { message: 'You are not registered' });
      return;
    }

    const room = await store.getRoomById(roomId);
    if (!room) {
      socketLogger.warn('Client tried to join non-existent room', { socketId: socket.id, userId, roomId });
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    if (room.type === 'coco') {
      const access = cocoAccess.canUse(userId);
      if (!access.allowed) {
        socketLogger.warn('Coco room join rejected by rollout controls', {
          socketId: socket.id,
          userId,
          roomId,
          reason: access.reason,
        });
        socket.emit('error', { message: access.message || 'Coco is unavailable' });
        return;
      }
    }

    const prevRooms = await store.getUserRooms(socket.id);
    for (const r of prevRooms) {
      const memberCount = await store.updateRoomMemberCount(r, userId, false);
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

    socket.join(roomId);
    await store.storeUserRooms(socket.id, [roomId]);

    const memberCount = await store.updateRoomMemberCount(roomId, userId, true);
    const joinEvent = createRoomMemberEvent({
      roomId,
      userId,
      count: memberCount,
      action: 'join',
    });

    io.to(roomId).emit('room_member_change', joinEvent);

    socketLogger.info('User joined room', {
      socketId: socket.id,
      userId,
      roomId,
      roomName: room.name,
      memberCount,
    });

    const roomMessages = await store.readMessagesByRoom(roomId);
    socket.emit('message_history', roomMessages);
    socket.emit('ai_cost_total', await store.readRoomAICost(roomId));
  });

  socket.on('leave_room', async (roomId: string) => {
    const userId = await store.getClientId(socket.id);
    if (!userId) return;

    socket.leave(roomId);

    const memberCount = await store.updateRoomMemberCount(roomId, userId, false);
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

    const validation = validateRoomNameInput(data?.name);
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
        const memberCount = await store.updateRoomMemberCount(roomId, userId, false);
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
      if (room.type === 'coco') {
        const access = cocoAccess.canUse(userId);
        if (!access.allowed) {
          socketLogger.warn('Coco room info lookup rejected by rollout controls', {
            socketId: socket.id,
            userId,
            roomId,
            reason: access.reason,
          });
          callback(null);
          return;
        }
      }
      socketLogger.debug('Room info requested', { socketId: socket.id, userId, roomId, roomName: room.name });
      callback(room);
    } else {
      socketLogger.warn('Room info requested for non-existent room', { socketId: socket.id, userId, roomId });
      callback(null);
    }
  });
}
