import { v4 as uuidv4 } from 'uuid';
import { hashRoomPassword, verifyRoomPassword } from '../services/roomSecurity';
import { createRoomMemberEvent, createRoomRecord } from '../services/messageDomain';
import { Room, RoomClientLookup, RoomOnlineMember, RoomPermissions, RoomPostingSchedule, RoomRoleMember } from '../types';
import { authorizeRoomAction, buildRoomPermissions, getRoomActor, normalizePostingSchedule } from './roomAuthorization';
import { SocketConnectionContext } from './types';

const MAX_ROOM_NAME_LENGTH = 20;
const MAX_CLIENT_ID_LENGTH = 128;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

type RenameRoomAck = {
  success: boolean;
  room?: Room;
  error?: string;
};

type RoomSaveAck = {
  success: boolean;
  room?: Room;
  error?: string;
};

type RoomListAck = {
  success: boolean;
  rooms?: Room[];
  error?: string;
};

type RoomPermissionsAck = {
  success: boolean;
  permissions?: RoomPermissions;
  error?: string;
};

type RoomRoleMembersAck = {
  success: boolean;
  members?: RoomRoleMember[];
  error?: string;
};

type RoomClientLookupAck = {
  success: boolean;
  client?: RoomClientLookup;
  error?: string;
};

type BasicRoomAck = {
  success: boolean;
  room?: Room;
  error?: string;
};

type RegisterAck = {
  success: boolean;
  clientId?: string;
  error?: string;
};

type JoinRoomAck = BasicRoomAck & {
  permissions?: RoomPermissions;
  memberCount?: number;
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

const getRoomIdFromPayload = (payload: unknown): string | null => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (payload && typeof payload === 'object' && typeof (payload as { roomId?: unknown }).roomId === 'string') {
    return (payload as { roomId: string }).roomId;
  }

  return null;
};

const parseTargetClientId = (value: unknown): { ok: true; clientId: string } | { ok: false; error: string } => {
  if (typeof value !== 'string') {
    return { ok: false, error: 'Target user ID is required' };
  }

  const clientId = value.trim();
  if (!clientId) {
    return { ok: false, error: 'Target user ID is required' };
  }

  if (clientId.length > MAX_CLIENT_ID_LENGTH || !CLIENT_ID_PATTERN.test(clientId)) {
    return { ok: false, error: 'Invalid user ID' };
  }

  return { ok: true, clientId };
};

const lookupKnownRoomClient = async (
  store: SocketConnectionContext['store'],
  roomId: string,
  targetClientId: string,
): Promise<RoomClientLookup> => {
  const [member, nicknames] = await Promise.all([
    store.getRoomMember(roomId, targetClientId),
    store.getClientNicknames([targetClientId]),
  ]);
  const nickname = nicknames[targetClientId];

  return {
    clientId: targetClientId,
    exists: Boolean(nickname),
    nickname,
    memberRole: member?.role ?? null,
  };
};

const readRoomRoleMembers = async (
  store: SocketConnectionContext['store'],
  roomId: string,
): Promise<RoomRoleMember[]> => {
  const members = await store.readRoomMembers(roomId);
  const nicknames = await store.getClientNicknames(members.map(member => member.clientId));
  const roleRank: Record<RoomRoleMember['role'], number> = { owner: 0, admin: 1, member: 2 };

  return members
    .map(member => ({
      ...member,
      nickname: nicknames[member.clientId],
    }))
    .sort((a, b) => roleRank[a.role] - roleRank[b.role] || a.joinedAt.localeCompare(b.joinedAt));
};

const parseJoinRoomPayload = (payload: unknown): { roomId: string | null; password?: string } => {
  if (typeof payload === 'string') {
    return { roomId: payload };
  }

  if (payload && typeof payload === 'object') {
    const data = payload as { roomId?: unknown; password?: unknown };
    return {
      roomId: typeof data.roomId === 'string' ? data.roomId : null,
      password: typeof data.password === 'string' ? data.password : undefined,
    };
  }

  return { roomId: null };
};

const MAX_NICKNAME_LENGTH = 40;

const normalizeNickname = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, MAX_NICKNAME_LENGTH);
};

const parseRegisterPayload = (payload: unknown): { clientId?: string; username: string | null } => {
  if (typeof payload === 'string') {
    return { clientId: payload, username: null };
  }
  if (payload && typeof payload === 'object') {
    const data = payload as { clientId?: unknown; username?: unknown };
    return {
      clientId: typeof data.clientId === 'string' ? data.clientId : undefined,
      username: normalizeNickname(data.username),
    };
  }
  return { clientId: undefined, username: null };
};

export function registerRoomHandlers({ io, socket, store, socketLogger }: SocketConnectionContext) {
  socket.on('register', async (payload: unknown, callback?: (result: RegisterAck) => void) => {
    const { clientId, username } = parseRegisterPayload(payload);
    const userId = clientId || uuidv4();
    try {
      await store.storeClientSession(socket.id, userId);
      if (username) {
        await store.setClientNickname(userId, username);
      }
      socketLogger.info('Client registered', { socketId: socket.id, clientId: userId });

      socket.join(userId);
      const myRooms = await store.readRoomsByUser(userId);
      const savedRooms = await store.readSavedRoomsByUser(userId);
      socket.emit('room_list', myRooms);
      socket.emit('saved_room_list', savedRooms);
      callback?.({ success: true, clientId: userId });
    } catch (error) {
      socketLogger.error('Failed to register client', { socketId: socket.id, clientId: userId, error });
      callback?.({ success: false, error: 'Failed to register client' });
    }
  });

  socket.on('set_username', async (rawUsername: unknown) => {
    const nickname = normalizeNickname(rawUsername);
    if (!nickname) {
      return;
    }
    const userId = await store.getClientId(socket.id);
    if (!userId) {
      socketLogger.warn('Unregistered client tried to set username', { socketId: socket.id });
      return;
    }
    await store.setClientNickname(userId, nickname);
    socketLogger.debug('Client nickname updated', { socketId: socket.id, clientId: userId });
  });

  socket.on('get_room_members', async (
    payload: unknown,
    callback?: (result: { success: boolean; members?: RoomOnlineMember[]; error?: string }) => void
  ) => {
    const roomId = getRoomIdFromPayload(payload);
    if (!roomId) {
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }

    const members = await store.getRoomOnlineMembers(roomId);
    callback?.({ success: true, members });
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

  socket.on('get_saved_rooms', async (
    payloadOrCallback?: unknown,
    maybeCallback?: (result: RoomListAck) => void
  ) => {
    const callback = typeof payloadOrCallback === 'function'
      ? payloadOrCallback as (result: RoomListAck) => void
      : maybeCallback;
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to get saved rooms', { socketId: socket.id });
      socket.emit('error', { message: 'You are not registered' });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    socketLogger.debug('Client requested saved room list', { socketId: socket.id, clientId });
    const savedRooms = await store.readSavedRoomsByUser(clientId);
    socket.emit('saved_room_list', savedRooms);
    callback?.({ success: true, rooms: savedRooms });
  });

  socket.on('create_room', async (roomData: { name: string; description?: string; password?: string; postingSchedule?: RoomPostingSchedule }, callback?: (roomId: string) => void) => {
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

    let savedRoom = await store.saveRoom(room);
    if (savedRoom && typeof roomData.password === 'string' && roomData.password.trim()) {
      const passwordHash = await hashRoomPassword(roomData.password.trim());
      savedRoom = await store.updateRoomSettings(savedRoom.id, { passwordHash }) || savedRoom;
    }
    if (savedRoom && roomData.postingSchedule) {
      try {
        const postingSchedule = normalizePostingSchedule(roomData.postingSchedule);
        savedRoom = await store.updateRoomSettings(savedRoom.id, { postingSchedule }) || savedRoom;
      } catch {
        // Invalid optional settings should not fail room creation; users can
        // correct them later from room settings.
      }
    }
    if (savedRoom) {
      io.to(clientId).emit('new_room', savedRoom);
      socketLogger.info('Room created successfully', { roomId, clientId });
      callback?.(room.id);
    }
  });

  socket.on('join_room', async (payload: unknown, callback?: (result: JoinRoomAck) => void) => {
    const { roomId, password } = parseJoinRoomPayload(payload);
    const userId = await store.getClientId(socket.id);
    if (!userId) {
      socketLogger.warn('Unregistered client tried to join room', { socketId: socket.id, roomId });
      socket.emit('error', { message: 'You are not registered' });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    if (!roomId) {
      socketLogger.warn('Client tried to join room without room ID', { socketId: socket.id, userId });
      socket.emit('error', { message: 'Room ID is required' });
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }

    const prevRooms = await store.getUserRooms(socket.id);
    for (const r of prevRooms.filter((previousRoomId) => previousRoomId !== roomId)) {
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
      callback?.({ success: false, error: 'Room not found' });
      return;
    }

    const existingMember = await store.getRoomMember(roomId, userId);
    const isCreator = room.creatorId === userId;
    if (room.hasPassword && !existingMember && !isCreator) {
      const passwordHash = await store.readRoomPasswordHash(roomId);
      const passwordOk = await verifyRoomPassword(password || '', passwordHash);
      if (!passwordOk) {
        socketLogger.warn('Client tried to join password-protected room with invalid password', { socketId: socket.id, userId, roomId });
        socket.emit('error', { message: 'Room password is required or incorrect' });
        callback?.({ success: false, error: 'Room password is required or incorrect' });
        return;
      }
    }

    const persistentMember = existingMember || await store.addRoomMember(roomId, userId, isCreator ? 'owner' : 'member');
    if (!persistentMember) {
      socketLogger.error('Failed to persist room membership while joining room', { socketId: socket.id, userId, roomId });
      socket.emit('error', { message: 'Failed to join room' });
      callback?.({ success: false, error: 'Failed to join room' });
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
    const actor = await getRoomActor(store, roomId, userId);
    const permissions = buildRoomPermissions(actor, roomId, userId, room);
    socket.emit('room_permissions', permissions);

    socketLogger.info('User joined room', {
      socketId: socket.id,
      userId,
      roomId,
      roomName: room.name,
      memberCount,
    });

    callback?.({ success: true, room, permissions, memberCount });

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

    // Leaving a room only changes realtime presence. Durable membership is the
    // access grant for password-protected rooms and administrator roles.
  });

  socket.on('save_room', async (payload: unknown, callback?: (result: RoomSaveAck) => void) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to save room', { socketId: socket.id });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    const roomId = getRoomIdFromPayload(payload);
    if (!roomId) {
      socketLogger.warn('Client tried to save room without room ID', { socketId: socket.id, clientId });
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }

    const savedRoom = await store.saveRoomForUser(roomId, clientId);
    if (!savedRoom) {
      socketLogger.warn('Client tried to save non-existent room', { socketId: socket.id, clientId, roomId });
      callback?.({ success: false, error: 'Room not found' });
      return;
    }

    const savedRooms = await store.readSavedRoomsByUser(clientId);
    io.to(clientId).emit('saved_room_list', savedRooms);
    callback?.({ success: true, room: savedRoom });
  });

  socket.on('unsave_room', async (payload: unknown, callback?: (result: RoomListAck) => void) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to unsave room', { socketId: socket.id });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    const roomId = getRoomIdFromPayload(payload);
    if (!roomId) {
      socketLogger.warn('Client tried to unsave room without room ID', { socketId: socket.id, clientId });
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }

    await store.removeSavedRoomForUser(roomId, clientId);
    const savedRooms = await store.readSavedRoomsByUser(clientId);
    io.to(clientId).emit('saved_room_list', savedRooms);
    callback?.({ success: true, rooms: savedRooms });
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
      const updatedSavedRooms = await store.readSavedRoomsByUser(clientId);
      userSockets.forEach(sid => {
        io.to(sid).emit('room_list', updatedRooms);
        io.to(sid).emit('saved_room_list', updatedSavedRooms);
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

  socket.on('get_room_permissions', async (
    payload: unknown,
    callback?: (result: RoomPermissionsAck) => void
  ) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    const roomId = getRoomIdFromPayload(payload);
    if (!roomId) {
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }

    const room = await store.getRoomById(roomId);
    const actor = await getRoomActor(store, roomId, clientId);
    if (!room || !actor) {
      callback?.({ success: false, error: 'You are not authorized to access this room' });
      return;
    }

    const permissions = buildRoomPermissions(actor, roomId, clientId, room);
    callback?.({ success: true, permissions });
  });

  socket.on('get_room_role_members', async (
    payload: unknown,
    callback?: (result: RoomRoleMembersAck) => void,
  ) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    const roomId = getRoomIdFromPayload(payload);
    if (!roomId) {
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }

    const auth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'room.manageAdmins' },
    });
    if (!auth.ok) {
      callback?.({ success: false, error: auth.message });
      return;
    }

    const members = await readRoomRoleMembers(store, roomId);
    callback?.({ success: true, members });
  });

  socket.on('lookup_room_client', async (
    data: { roomId?: string; targetClientId?: unknown },
    callback?: (result: RoomClientLookupAck) => void,
  ) => {
    const clientId = await store.getClientId(socket.id);
    const roomId = data?.roomId;
    const target = parseTargetClientId(data?.targetClientId);
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }
    if (!roomId) {
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }
    if (!target.ok) {
      callback?.({ success: false, error: target.error });
      return;
    }

    const auth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'room.manageAdmins' },
    });
    if (!auth.ok) {
      callback?.({ success: false, error: auth.message });
      return;
    }

    const lookup = await lookupKnownRoomClient(store, roomId, target.clientId);
    callback?.({ success: true, client: lookup });
  });

  socket.on('update_room_settings', async (
    data: { roomId?: string; password?: string; clearPassword?: boolean; postingSchedule?: unknown },
    callback?: (result: BasicRoomAck) => void,
  ) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    const roomId = data?.roomId;
    if (!roomId) {
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }

    const auth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'room.manageSettings' },
    });
    if (!auth.ok) {
      callback?.({ success: false, error: auth.message });
      return;
    }

    try {
      const updates: Parameters<typeof store.updateRoomSettings>[1] = {};
      if (typeof data.password === 'string' && data.password.trim()) {
        updates.passwordHash = await hashRoomPassword(data.password.trim());
      } else if (data.clearPassword) {
        updates.passwordHash = null;
      }

      if (Object.prototype.hasOwnProperty.call(data || {}, 'postingSchedule')) {
        updates.postingSchedule = normalizePostingSchedule(data.postingSchedule);
      }

      // 空更新不写库不广播:写库会无意义地 bump updated_at 并触发全房 room_updated
      if (Object.keys(updates).length === 0) {
        const room = await store.getRoomById(roomId);
        if (!room) {
          callback?.({ success: false, error: 'Room not found' });
          return;
        }
        callback?.({ success: true, room });
        return;
      }

      const updatedRoom = await store.updateRoomSettings(roomId, updates);
      if (!updatedRoom) {
        callback?.({ success: false, error: 'Failed to update room settings' });
        return;
      }

      io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
      io.to(roomId).emit('room_updated', updatedRoom);
      io.to(roomId).emit('room_permissions_invalidated', roomId);
      callback?.({ success: true, room: updatedRoom });
    } catch (error) {
      socketLogger.error('Error updating room settings', { error, socketId: socket.id, clientId, roomId });
      callback?.({ success: false, error: error instanceof Error ? error.message : 'Failed to update room settings' });
    }
  });

  socket.on('set_room_admin', async (
    data: { roomId?: string; targetClientId?: unknown },
    callback?: (result: { success: boolean; error?: string }) => void,
  ) => {
    const clientId = await store.getClientId(socket.id);
    const roomId = data?.roomId;
    const target = parseTargetClientId(data?.targetClientId);
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }
    if (!roomId) {
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }
    if (!target.ok) {
      callback?.({ success: false, error: target.error });
      return;
    }

    const auth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'room.manageAdmins' },
    });
    if (!auth.ok) {
      callback?.({ success: false, error: auth.message });
      return;
    }

    const lookup = await lookupKnownRoomClient(store, roomId, target.clientId);
    if (!lookup.exists) {
      callback?.({ success: false, error: 'Target user was not found' });
      return;
    }

    if (target.clientId === auth.actor.room.creatorId) {
      callback?.({ success: false, error: 'The room owner is already the owner' });
      return;
    }

    const member = await store.updateRoomMemberRole(roomId, target.clientId, 'admin');
    if (!member) {
      callback?.({ success: false, error: 'Failed to add administrator' });
      return;
    }

    io.to(roomId).emit('room_permissions_invalidated', roomId);
    io.to(roomId).emit('room_role_members_updated', roomId);
    callback?.({ success: true });
  });

  socket.on('remove_room_admin', async (
    data: { roomId?: string; targetClientId?: unknown },
    callback?: (result: { success: boolean; error?: string }) => void,
  ) => {
    const clientId = await store.getClientId(socket.id);
    const roomId = data?.roomId;
    const target = parseTargetClientId(data?.targetClientId);
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }
    if (!roomId) {
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }
    if (!target.ok) {
      callback?.({ success: false, error: target.error });
      return;
    }

    const auth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'room.manageAdmins' },
    });
    if (!auth.ok) {
      callback?.({ success: false, error: auth.message });
      return;
    }

    if (target.clientId === auth.actor.room.creatorId) {
      callback?.({ success: false, error: 'The room owner cannot be removed as administrator' });
      return;
    }

    const existingMember = await store.getRoomMember(roomId, target.clientId);
    if (existingMember?.role !== 'admin') {
      callback?.({ success: false, error: 'Target user is not an administrator' });
      return;
    }

    const member = await store.updateRoomMemberRole(roomId, target.clientId, 'member');
    if (!member) {
      callback?.({ success: false, error: 'Failed to remove administrator' });
      return;
    }

    io.to(roomId).emit('room_permissions_invalidated', roomId);
    io.to(roomId).emit('room_role_members_updated', roomId);
    callback?.({ success: true });
  });

  socket.on('transfer_room_ownership', async (
    data: { roomId?: string; targetClientId?: unknown },
    callback?: (result: BasicRoomAck) => void,
  ) => {
    const clientId = await store.getClientId(socket.id);
    const roomId = data?.roomId;
    const target = parseTargetClientId(data?.targetClientId);
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }
    if (!roomId) {
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }
    if (!target.ok) {
      callback?.({ success: false, error: target.error });
      return;
    }

    const auth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'room.transferOwnership', targetClientId: target.clientId },
    });
    if (!auth.ok) {
      callback?.({ success: false, error: auth.message });
      return;
    }

    if (target.clientId === clientId) {
      callback?.({ success: false, error: 'You already own this room' });
      return;
    }

    const lookup = await lookupKnownRoomClient(store, roomId, target.clientId);
    if (!lookup.exists) {
      callback?.({ success: false, error: 'Target user was not found' });
      return;
    }

    const updatedRoom = await store.transferRoomOwnership(roomId, target.clientId, 'admin');
    if (!updatedRoom) {
      callback?.({ success: false, error: 'Failed to transfer room ownership' });
      return;
    }

    const oldOwnerRooms = await store.readRoomsByUser(clientId);
    const newOwnerRooms = await store.readRoomsByUser(target.clientId);
    io.to(clientId).emit('room_list', oldOwnerRooms);
    io.to(target.clientId).emit('room_list', newOwnerRooms);
    io.to(roomId).emit('room_updated', updatedRoom);
    io.to(roomId).emit('room_permissions_invalidated', roomId);
    io.to(roomId).emit('room_role_members_updated', roomId);
    callback?.({ success: true, room: updatedRoom });
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
