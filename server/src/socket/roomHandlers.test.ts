import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { registerRoomHandlers } from './roomHandlers';
import { Message, Room, RoomAICostTotal, RoomMemberRole } from '../types';

type SocketEmit = {
  event: string;
  args: unknown[];
};

type RoomEmit = {
  roomId: string;
  event: string;
  args: unknown[];
};

class FakeSocket {
  id = 'socket-1';
  handlers = new Map<string, (...args: any[]) => unknown>();
  emitted: SocketEmit[] = [];
  roomEmits: RoomEmit[] = [];
  joined: string[] = [];
  left: string[] = [];

  on(event: string, handler: (...args: any[]) => unknown) {
    this.handlers.set(event, handler);
  }

  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
  }

  join(roomId: string) {
    this.joined.push(roomId);
  }

  leave(roomId: string) {
    this.left.push(roomId);
  }

  to(roomId: string) {
    return {
      emit: (event: string, ...args: unknown[]) => {
        this.roomEmits.push({ roomId, event, args });
      },
    };
  }

  async invoke(event: string, ...args: unknown[]) {
    const handler = this.handlers.get(event);
    assert.ok(handler, `Expected handler for ${event}`);
    return handler(...args);
  }
}

class FakeIo {
  roomEmits: RoomEmit[] = [];
  socketsByRoom = new Map<string, Set<string>>();

  to(roomId: string) {
    return {
      emit: (event: string, ...args: unknown[]) => {
        this.roomEmits.push({ roomId, event, args });
      },
    };
  }

  in(roomId: string) {
    return {
      allSockets: async () => this.socketsByRoom.get(roomId) || new Set<string>(),
    };
  }
}

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'message-1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T00:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

const roomCost = (roomId = 'room-1'): RoomAICostTotal => ({
  roomId,
  currency: 'USD',
  totalUsd: 0.5,
});

const createHarness = (clientId: string | null = 'client-1') => {
  const socket = new FakeSocket();
  const io = new FakeIo();
  const memberKey = (roomId: string, memberClientId: string) => `${roomId}:${memberClientId}`;
  const store = {
    clientId,
    rooms: [room()],
    messages: [message()],
    socketRooms: [] as string[],
    members: new Set([memberKey('room-1', 'client-1')]),
    memberRoles: new Map<string, RoomMemberRole>([[memberKey('room-1', 'client-1'), 'owner']]),
    addedMembers: [] as Array<{ roomId: string; clientId: string; role: RoomMemberRole }>,
    savedRooms: [] as Room[],
    userSavedRooms: new Map<string, Set<string>>(),
    deletedRooms: [] as Array<{ roomId: string; creatorId: string }>,
    removedSessions: [] as string[],
    nicknames: new Map<string, string>(),
    async storeClientSession(_socketId: string, userId: string) {
      this.clientId = userId;
    },
    async setClientNickname(clientId: string, nickname: string) {
      this.nicknames.set(clientId, nickname);
    },
    async getClientNicknames(clientIds: string[]) {
      return Object.fromEntries(
        clientIds
          .map(clientId => [clientId, this.nicknames.get(clientId)])
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    },
    async getRoomOnlineMembers(roomId: string) {
      return [...this.members]
        .filter(key => key.startsWith(`${roomId}:`))
        .map(key => {
          const memberClientId = key.split(':')[1];
          return { clientId: memberClientId, nickname: this.nicknames.get(memberClientId) };
        });
    },
    async getClientId() {
      return this.clientId;
    },
    async readRoomsByUser(clientIdForRooms: string) {
      return this.rooms.filter(item => item.creatorId === clientIdForRooms);
    },
    async generateUniqueRoomId() {
      return 'generated-room';
    },
    async saveRoom(newRoom: Room) {
      this.savedRooms.push(newRoom);
      this.rooms.push(newRoom);
      this.members.add(memberKey(newRoom.id, newRoom.creatorId));
      this.memberRoles.set(memberKey(newRoom.id, newRoom.creatorId), 'owner');
      return newRoom;
    },
    async addRoomMember(roomId: string, memberClientId: string, role: RoomMemberRole) {
      this.members.add(memberKey(roomId, memberClientId));
      const key = memberKey(roomId, memberClientId);
      this.memberRoles.set(key, this.memberRoles.get(key) === 'owner' || role === 'owner' ? 'owner' : 'member');
      this.addedMembers.push({ roomId, clientId: memberClientId, role });
      return { roomId, clientId: memberClientId, role, joinedAt: '2026-05-03T00:00:00.000Z' };
    },
    async removeRoomMember(roomId: string, memberClientId: string) {
      const key = memberKey(roomId, memberClientId);
      if (this.memberRoles.get(key) === 'owner') {
        return false;
      }
      this.memberRoles.delete(key);
      return this.members.delete(key);
    },
    async getRoomMember(roomId: string, memberClientId: string) {
      const key = memberKey(roomId, memberClientId);
      return this.members.has(key)
        ? { roomId, clientId: memberClientId, role: this.memberRoles.get(key) || 'member' as const, joinedAt: '2026-05-03T00:00:00.000Z' }
        : null;
    },
    async isRoomMember(roomId: string, memberClientId: string) {
      return this.members.has(memberKey(roomId, memberClientId));
    },
    async readRoomMembers(roomId: string) {
      return [...this.members]
        .filter(key => key.startsWith(`${roomId}:`))
        .map(key => ({ roomId, clientId: key.split(':')[1], role: this.memberRoles.get(key) || 'member' as const, joinedAt: '2026-05-03T00:00:00.000Z' }));
    },
    async updateRoomMemberRole(roomId: string, memberClientId: string, role: RoomMemberRole) {
      const key = memberKey(roomId, memberClientId);
      this.members.add(key);
      this.memberRoles.set(key, role);
      return { roomId, clientId: memberClientId, role, joinedAt: '2026-05-03T00:00:00.000Z' };
    },
    async transferRoomOwnership(roomId: string, newOwnerClientId: string, previousOwnerRole: Exclude<RoomMemberRole, 'owner'> = 'admin') {
      const existingRoom = this.rooms.find(item => item.id === roomId);
      if (!existingRoom) {
        return null;
      }

      const oldOwnerId = existingRoom.creatorId;
      const oldOwnerKey = memberKey(roomId, oldOwnerId);
      if (this.memberRoles.get(oldOwnerKey) === 'owner') {
        this.memberRoles.set(oldOwnerKey, previousOwnerRole);
      }
      const newOwnerKey = memberKey(roomId, newOwnerClientId);
      this.members.add(newOwnerKey);
      this.memberRoles.set(newOwnerKey, 'owner');
      const updatedRoom = { ...existingRoom, creatorId: newOwnerClientId };
      this.rooms = this.rooms.map(item => item.id === roomId ? updatedRoom : item);
      return updatedRoom;
    },
    async saveRoomForUser(roomId: string, savedClientId: string) {
      const savedRoom = this.rooms.find(item => item.id === roomId) || null;
      if (!savedRoom) {
        return null;
      }

      const savedRoomIds = this.userSavedRooms.get(savedClientId) || new Set<string>();
      savedRoomIds.add(roomId);
      this.userSavedRooms.set(savedClientId, savedRoomIds);
      return savedRoom;
    },
    async removeSavedRoomForUser(roomId: string, savedClientId: string) {
      return this.userSavedRooms.get(savedClientId)?.delete(roomId) || false;
    },
    async readSavedRoomsByUser(savedClientId: string) {
      const savedRoomIds = this.userSavedRooms.get(savedClientId) || new Set<string>();
      return [...savedRoomIds]
        .map(roomId => this.rooms.find(item => item.id === roomId))
        .filter((item): item is Room => !!item);
    },
    async getUserRooms() {
      return this.socketRooms;
    },
    async storeUserRooms(_socketId: string, roomIds: string[]) {
      this.socketRooms = roomIds;
    },
    async updateRoomMemberCount(roomId: string, _userId: string, _socketId: string, isJoining: boolean) {
      return isJoining ? 2 : 1;
    },
    async updateRoomSettings(roomId: string, updates: { passwordHash?: string | null; postingSchedule?: Room['postingSchedule'] | null }) {
      const target = this.rooms.find(item => item.id === roomId);
      if (!target) {
        return null;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'postingSchedule')) {
        if (updates.postingSchedule) {
          target.postingSchedule = updates.postingSchedule;
        } else {
          delete target.postingSchedule;
        }
      }
      target.updatedAt = new Date().toISOString();
      return { ...target };
    },
    async getRoomById(roomId: string) {
      return this.rooms.find(item => item.id === roomId) || null;
    },
    async updateRoomName(roomId: string, creatorId: string, name: string) {
      const index = this.rooms.findIndex(item => item.id === roomId && item.creatorId === creatorId);
      if (index === -1) {
        return null;
      }
      this.rooms[index] = { ...this.rooms[index], name };
      return this.rooms[index];
    },
    async readMessagesByRoom(roomId: string) {
      return this.messages.filter(item => item.roomId === roomId);
    },
    async readRoomAICost(roomId: string) {
      return roomCost(roomId);
    },
    async deleteRoom(roomId: string, creatorId: string) {
      this.deletedRooms.push({ roomId, creatorId });
      this.rooms = this.rooms.filter(item => item.id !== roomId);
    },
    async removeClientSession(socketId: string) {
      this.removedSessions.push(socketId);
      this.clientId = null;
    },
  };

  registerRoomHandlers({
    io: io as any,
    socket: socket as any,
    store: store as any,
    socketLogger: logger as any,
  } as any);

  return { io, socket, store };
};

describe('room socket handlers', () => {
  it('registers clients, joins their private socket room, and returns owned rooms', async () => {
    const { socket, store } = createHarness(null);
    let response: unknown;

    await socket.invoke('register', 'client-1', (result: unknown) => {
      response = result;
    });

    assert.equal(store.clientId, 'client-1');
    assert.deepEqual(response, { success: true, clientId: 'client-1' });
    assert.deepEqual(socket.joined, ['client-1']);
    assert.deepEqual(socket.emitted, [
      { event: 'room_list', args: [[room()]] },
      { event: 'saved_room_list', args: [[]] },
    ]);
  });

  it('stores the nickname when registering with a username payload', async () => {
    const { socket, store } = createHarness(null);

    await socket.invoke('register', { clientId: 'client-9', username: '  Ada  ' });

    assert.equal(store.clientId, 'client-9');
    assert.equal(store.nicknames.get('client-9'), 'Ada');
  });

  it('stores the nickname for a registered client via set_username', async () => {
    const { socket, store } = createHarness('client-1');

    await socket.invoke('set_username', 'Grace');
    assert.equal(store.nicknames.get('client-1'), 'Grace');

    // Blank names are ignored
    await socket.invoke('set_username', '   ');
    assert.equal(store.nicknames.get('client-1'), 'Grace');
  });

  it('ignores set_username from unregistered clients', async () => {
    const { socket, store } = createHarness(null);

    await socket.invoke('set_username', 'Nobody');
    assert.equal(store.nicknames.size, 0);
  });

  it('returns online room members with their nicknames', async () => {
    const { socket, store } = createHarness('client-1');
    await store.setClientNickname('client-1', 'Ada');

    let response: { success: boolean; members?: Array<{ clientId: string; nickname?: string }> } | undefined;
    await socket.invoke('get_room_members', { roomId: 'room-1' }, (result: typeof response) => {
      response = result;
    });

    assert.deepEqual(response, { success: true, members: [{ clientId: 'client-1', nickname: 'Ada' }] });
  });

  it('rejects get_room_members without a room id', async () => {
    const { socket } = createHarness('client-1');

    let response: unknown;
    await socket.invoke('get_room_members', {}, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, { success: false, error: 'Room ID is required' });
  });

  it('returns room role members with nicknames for owners', async () => {
    const { socket, store } = createHarness('client-1');
    store.members.add('room-1:client-2');
    store.memberRoles.set('room-1:client-2', 'admin');
    await store.setClientNickname('client-1', 'Owner');
    await store.setClientNickname('client-2', 'Ada');

    let response: unknown;
    await socket.invoke('get_room_role_members', { roomId: 'room-1' }, (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, {
      success: true,
      members: [
        { roomId: 'room-1', clientId: 'client-1', role: 'owner', joinedAt: '2026-05-03T00:00:00.000Z', nickname: 'Owner' },
        { roomId: 'room-1', clientId: 'client-2', role: 'admin', joinedAt: '2026-05-03T00:00:00.000Z', nickname: 'Ada' },
      ],
    });
  });

  it('checks target users before adding administrators', async () => {
    const unknown = createHarness('client-1');
    let unknownResponse: unknown;
    await unknown.socket.invoke('set_room_admin', { roomId: 'room-1', targetClientId: 'client-2' }, (result: unknown) => {
      unknownResponse = result;
    });
    assert.deepEqual(unknownResponse, { success: false, error: 'Target user was not found' });
    assert.equal(await unknown.store.getRoomMember('room-1', 'client-2'), null);

    const known = createHarness('client-1');
    await known.store.setClientNickname('client-2', 'Ada');
    let knownResponse: unknown;
    await known.socket.invoke('set_room_admin', { roomId: 'room-1', targetClientId: 'client-2' }, (result: unknown) => {
      knownResponse = result;
    });

    assert.deepEqual(knownResponse, { success: true });
    assert.equal((await known.store.getRoomMember('room-1', 'client-2'))?.role, 'admin');
    assert.equal(known.io.roomEmits.at(-1)?.event, 'room_role_members_updated');
  });

  it('checks target users before transferring ownership', async () => {
    const unknown = createHarness('client-1');
    let unknownResponse: unknown;
    await unknown.socket.invoke('transfer_room_ownership', { roomId: 'room-1', targetClientId: 'client-2' }, (result: unknown) => {
      unknownResponse = result;
    });
    assert.deepEqual(unknownResponse, { success: false, error: 'Target user was not found' });
    assert.equal(unknown.store.rooms[0].creatorId, 'client-1');

    const known = createHarness('client-1');
    await known.store.setClientNickname('client-2', 'Ada');
    let knownResponse: { success: boolean; room?: Room } | undefined;
    await known.socket.invoke('transfer_room_ownership', { roomId: 'room-1', targetClientId: 'client-2' }, (result: typeof knownResponse) => {
      knownResponse = result;
    });

    assert.equal(knownResponse?.success, true);
    assert.equal(knownResponse?.room?.creatorId, 'client-2');
    assert.equal((await known.store.getRoomMember('room-1', 'client-2'))?.role, 'owner');
    assert.equal((await known.store.getRoomMember('room-1', 'client-1'))?.role, 'admin');
  });

  it('returns rooms only for registered clients', async () => {
    const unregistered = createHarness(null);
    await unregistered.socket.invoke('get_rooms');
    assert.deepEqual(unregistered.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);

    const registered = createHarness('client-1');
    await registered.socket.invoke('get_rooms');
    assert.deepEqual(registered.socket.emitted, [{ event: 'room_list', args: [[room()]] }]);
  });

  it('returns and updates saved rooms only for registered clients', async () => {
    const unregistered = createHarness(null);
    let unregisteredResponse: unknown;
    await unregistered.socket.invoke('get_saved_rooms', (response: unknown) => {
      unregisteredResponse = response;
    });
    assert.deepEqual(unregisteredResponse, { success: false, error: 'You are not registered' });
    assert.deepEqual(unregistered.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);

    const valid = createHarness('client-2');
    let saveResponse: unknown;
    await valid.socket.invoke('save_room', { roomId: 'room-1' }, (response: unknown) => {
      saveResponse = response;
    });
    assert.deepEqual(saveResponse, { success: true, room: room() });
    assert.deepEqual(valid.io.roomEmits, [
      { roomId: 'client-2', event: 'saved_room_list', args: [[room()]] },
    ]);
    assert.deepEqual(await valid.store.readRoomsByUser('client-2'), []);
    assert.deepEqual(await valid.store.readSavedRoomsByUser('client-2'), [room()]);

    let listResponse: unknown;
    await valid.socket.invoke('get_saved_rooms', (response: unknown) => {
      listResponse = response;
    });
    assert.deepEqual(listResponse, { success: true, rooms: [room()] });

    let unsaveResponse: unknown;
    await valid.socket.invoke('unsave_room', 'room-1', (response: unknown) => {
      unsaveResponse = response;
    });
    assert.deepEqual(unsaveResponse, { success: true, rooms: [] });
    assert.deepEqual(await valid.store.readSavedRoomsByUser('client-2'), []);
  });

  it('creates rooms and emits them to the creator room', async () => {
    const invalid = createHarness(null);
    await invalid.socket.invoke('create_room', { name: 'No session' });
    assert.deepEqual(invalid.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered or room name is required' }] }]);

    const valid = createHarness('client-1');
    let createdRoomId: string | undefined;
    await valid.socket.invoke('create_room', { name: 'Created', description: 'Room' }, (roomId: string) => {
      createdRoomId = roomId;
    });

    assert.equal(createdRoomId, 'generated-room');
    assert.equal(valid.store.savedRooms[0].name, 'Created');
    assert.deepEqual(valid.io.roomEmits, [{ roomId: 'client-1', event: 'new_room', args: [valid.store.savedRooms[0]] }]);
  });

  it('joins existing rooms and leaves previous rooms without sending message history', async () => {
    const unregistered = createHarness(null);
    let unregisteredJoinResponse: unknown;
    await unregistered.socket.invoke('join_room', 'room-1', (result: unknown) => {
      unregisteredJoinResponse = result;
    });
    assert.deepEqual(unregistered.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);
    assert.deepEqual(unregisteredJoinResponse, { success: false, error: 'You are not registered' });

    const missing = createHarness('client-1');
    let missingJoinResponse: unknown;
    await missing.socket.invoke('join_room', 'missing', (result: unknown) => {
      missingJoinResponse = result;
    });
    assert.deepEqual(missing.socket.emitted, [{ event: 'error', args: [{ message: 'Room not found' }] }]);
    assert.deepEqual(missingJoinResponse, { success: false, error: 'Room not found' });

    const valid = createHarness('client-1');
    valid.store.socketRooms = ['old-room'];
    valid.store.rooms.push(room({ id: 'old-room', name: 'Old Room' }));
    let joinResponse: unknown;
    await valid.socket.invoke('join_room', 'room-1', (result: unknown) => {
      joinResponse = result;
    });

    assert.deepEqual(valid.socket.left, ['old-room']);
    assert.deepEqual(valid.socket.joined, ['room-1']);
    assert.deepEqual(valid.store.socketRooms, ['room-1']);
    assert.deepEqual(valid.store.addedMembers, []);
    assert.equal(valid.socket.roomEmits[0].roomId, 'old-room');
    assert.equal(valid.socket.roomEmits[0].event, 'room_member_change');
    assert.equal(valid.io.roomEmits[0].roomId, 'room-1');
    assert.equal(valid.io.roomEmits[0].event, 'room_member_change');
    assert.equal(valid.io.roomEmits.length, 1);
    assert.equal(valid.socket.emitted[0].event, 'room_permissions');
    assert.deepEqual(joinResponse, {
      success: true,
      room: room(),
      permissions: {
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
        postingRestrictionReason: undefined,
      },
      memberCount: 2,
    });
  });

  it('rejoining the current room is idempotent and returns the member count', async () => {
    const valid = createHarness('client-1');
    valid.store.socketRooms = ['room-1'];
    let joinResponse: unknown;

    await valid.socket.invoke('join_room', { roomId: 'room-1' }, (result: unknown) => {
      joinResponse = result;
    });

    assert.deepEqual(valid.socket.left, []);
    assert.deepEqual(valid.socket.joined, ['room-1']);
    assert.deepEqual(valid.store.socketRooms, ['room-1']);
    assert.equal(valid.io.roomEmits[0].roomId, 'room-1');
    assert.equal(valid.io.roomEmits[0].event, 'room_member_change');
    assert.deepEqual((joinResponse as { memberCount?: number }).memberCount, 2);
  });

  it('leaves rooms and updates stored socket memberships', async () => {
    const { io, socket, store } = createHarness('client-2');
    store.socketRooms = ['room-1', 'room-2'];
    store.members.add('room-1:client-2');
    store.memberRoles.set('room-1:client-2', 'member');

    await socket.invoke('leave_room', 'room-1');

    assert.deepEqual(socket.left, ['room-1']);
    assert.deepEqual(store.socketRooms, ['room-2']);
    assert.equal(await store.isRoomMember('room-1', 'client-2'), true);
    assert.equal(io.roomEmits[0].roomId, 'room-1');
    assert.equal(io.roomEmits[0].event, 'room_member_change');
  });

  it('keeps owner membership when owners leave rooms', async () => {
    const { socket, store } = createHarness('client-1');
    store.socketRooms = ['room-1'];

    await socket.invoke('leave_room', 'room-1');

    assert.equal(await store.isRoomMember('room-1', 'client-1'), true);
  });

  it('deletes owned rooms and rejects invalid delete attempts', async () => {
    const unregistered = createHarness(null);
    let unregisteredResponse: unknown;
    await unregistered.socket.invoke('delete_room', 'room-1', (response: unknown) => {
      unregisteredResponse = response;
    });
    assert.deepEqual(unregisteredResponse, { success: false, message: 'You are not registered' });

    const unauthorized = createHarness('client-2');
    let unauthorizedResponse: unknown;
    await unauthorized.socket.invoke('delete_room', 'room-1', (response: unknown) => {
      unauthorizedResponse = response;
    });
    assert.deepEqual(unauthorizedResponse, { success: false, message: 'You are not authorized to delete this room' });

    const valid = createHarness('client-1');
    valid.io.socketsByRoom.set('client-1', new Set(['socket-1', 'socket-2']));
    let response: unknown;
    await valid.socket.invoke('delete_room', 'room-1', (result: unknown) => {
      response = result;
    });

    assert.deepEqual(response, { success: true });
    assert.deepEqual(valid.store.deletedRooms, [{ roomId: 'room-1', creatorId: 'client-1' }]);
    assert.deepEqual(valid.io.roomEmits, [
      { roomId: 'socket-1', event: 'room_list', args: [[]] },
      { roomId: 'socket-1', event: 'saved_room_list', args: [[]] },
      { roomId: 'socket-2', event: 'room_list', args: [[]] },
      { roomId: 'socket-2', event: 'saved_room_list', args: [[]] },
    ]);
  });

  it('updates posting schedules, stamps updatedAt, and broadcasts room_updated', async () => {
    const { io, socket } = createHarness('client-1');
    let response: unknown;

    await socket.invoke('update_room_settings', {
      roomId: 'room-1',
      postingSchedule: { enabled: true, timezone: 'UTC', windows: [{ days: [1], start: '09:00', end: '17:00' }] },
    }, (result: unknown) => {
      response = result;
    });

    const ack = response as { success: boolean; room?: Room };
    assert.equal(ack.success, true);
    assert.equal(typeof ack.room?.updatedAt, 'string');
    assert.equal(ack.room?.postingSchedule?.enabled, true);
    const updateEmits = io.roomEmits.filter(item => item.event === 'room_updated');
    assert.deepEqual(updateEmits.map(item => item.roomId), ['client-1', 'room-1']);
    assert.equal(io.roomEmits.some(item => item.event === 'room_permissions_invalidated'), true);
  });

  it('returns the room without writing or broadcasting for empty settings updates', async () => {
    const { io, socket } = createHarness('client-1');
    let response: unknown;

    await socket.invoke('update_room_settings', { roomId: 'room-1' }, (result: unknown) => {
      response = result;
    });

    const ack = response as { success: boolean; room?: Room };
    assert.equal(ack.success, true);
    assert.equal(ack.room?.id, 'room-1');
    // 空更新不得 bump updatedAt,也不得广播
    assert.equal(ack.room?.updatedAt, undefined);
    assert.deepEqual(io.roomEmits, []);
  });

  it('renames owned rooms and broadcasts updated room state', async () => {
    const unregistered = createHarness(null);
    let unregisteredResponse: unknown;
    await unregistered.socket.invoke('rename_room', { roomId: 'room-1', name: 'Renamed' }, (response: unknown) => {
      unregisteredResponse = response;
    });
    assert.deepEqual(unregisteredResponse, { success: false, error: 'You are not registered' });

    const invalid = createHarness('client-1');
    let invalidResponse: unknown;
    await invalid.socket.invoke('rename_room', { roomId: 'room-1', name: '   ' }, (response: unknown) => {
      invalidResponse = response;
    });
    assert.deepEqual(invalidResponse, { success: false, error: 'Room name is required' });

    const tooLong = createHarness('client-1');
    let tooLongResponse: unknown;
    await tooLong.socket.invoke('rename_room', { roomId: 'room-1', name: 'a'.repeat(21) }, (response: unknown) => {
      tooLongResponse = response;
    });
    assert.deepEqual(tooLongResponse, { success: false, error: 'Room name cannot exceed 20 characters' });

    const missing = createHarness('client-1');
    let missingResponse: unknown;
    await missing.socket.invoke('rename_room', { roomId: 'missing', name: 'Renamed' }, (response: unknown) => {
      missingResponse = response;
    });
    assert.deepEqual(missingResponse, { success: false, error: 'Room not found' });

    const unauthorized = createHarness('client-2');
    let unauthorizedResponse: unknown;
    await unauthorized.socket.invoke('rename_room', { roomId: 'room-1', name: 'Renamed' }, (response: unknown) => {
      unauthorizedResponse = response;
    });
    assert.deepEqual(unauthorizedResponse, { success: false, error: 'You are not authorized to rename this room' });

    const valid = createHarness('client-1');
    let response: { success: boolean; room?: Room } | undefined;
    await valid.socket.invoke('rename_room', { roomId: 'room-1', name: '  Renamed Room  ' }, (result: typeof response) => {
      response = result;
    });

    assert.equal(response?.success, true);
    assert.equal(response?.room?.name, 'Renamed Room');
    assert.equal(valid.store.rooms[0].name, 'Renamed Room');
    assert.deepEqual(valid.io.roomEmits, [
      { roomId: 'client-1', event: 'room_updated', args: [valid.store.rooms[0]] },
      { roomId: 'room-1', event: 'room_updated', args: [valid.store.rooms[0]] },
    ]);
  });

  it('cleans up memberships on disconnect and resolves room lookup callbacks', async () => {
    const { io, socket, store } = createHarness('client-1');
    store.socketRooms = ['room-1', 'room-2'];
    store.rooms.push(room({ id: 'room-2', name: 'Room 2' }));

    await socket.invoke('disconnect', 'transport close');

    assert.deepEqual(store.removedSessions, ['socket-1']);
    assert.deepEqual(store.socketRooms, []);
    assert.deepEqual(io.roomEmits.map(item => item.event), ['room_member_change', 'room_member_change']);

    const lookup = createHarness('client-1');
    let foundRoom: Room | null | undefined;
    await lookup.socket.invoke('get_room_by_id', 'room-1', (result: Room | null) => {
      foundRoom = result;
    });
    assert.deepEqual(foundRoom, room());

    let missingRoom: Room | null | undefined;
    await lookup.socket.invoke('get_room_by_id', 'missing', (result: Room | null) => {
      missingRoom = result;
    });
    assert.equal(missingRoom, null);
  });
});
