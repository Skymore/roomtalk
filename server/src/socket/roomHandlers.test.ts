import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { registerRoomHandlers } from './roomHandlers';
import { Message, Room, RoomAICostTotal } from '../types';

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
  const store = {
    clientId,
    rooms: [room()],
    messages: [message()],
    socketRooms: [] as string[],
    members: new Set(['room-1:client-1']),
    addedMembers: [] as Array<{ roomId: string; clientId: string; role: 'owner' | 'member' }>,
    savedRooms: [] as Room[],
    deletedRooms: [] as Array<{ roomId: string; creatorId: string }>,
    removedSessions: [] as string[],
    async storeClientSession(_socketId: string, userId: string) {
      this.clientId = userId;
    },
    async getClientId() {
      return this.clientId;
    },
    async readRoomsByUser(clientIdForRooms: string) {
      return this.rooms.filter(item => item.creatorId === clientIdForRooms || this.members.has(`${item.id}:${clientIdForRooms}`));
    },
    async generateUniqueRoomId() {
      return 'generated-room';
    },
    async saveRoom(newRoom: Room) {
      this.savedRooms.push(newRoom);
      this.rooms.push(newRoom);
      this.members.add(`${newRoom.id}:${newRoom.creatorId}`);
      return newRoom;
    },
    async addRoomMember(roomId: string, memberClientId: string, role: 'owner' | 'member') {
      this.members.add(`${roomId}:${memberClientId}`);
      this.addedMembers.push({ roomId, clientId: memberClientId, role });
      return { roomId, clientId: memberClientId, role, joinedAt: '2026-05-03T00:00:00.000Z' };
    },
    async getRoomMember(roomId: string, memberClientId: string) {
      return this.members.has(`${roomId}:${memberClientId}`)
        ? { roomId, clientId: memberClientId, role: 'member' as const, joinedAt: '2026-05-03T00:00:00.000Z' }
        : null;
    },
    async isRoomMember(roomId: string, memberClientId: string) {
      return this.members.has(`${roomId}:${memberClientId}`);
    },
    async readRoomMembers(roomId: string) {
      return [...this.members]
        .filter(key => key.startsWith(`${roomId}:`))
        .map(key => ({ roomId, clientId: key.split(':')[1], role: 'member' as const, joinedAt: '2026-05-03T00:00:00.000Z' }));
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

    await socket.invoke('register', 'client-1');

    assert.equal(store.clientId, 'client-1');
    assert.deepEqual(socket.joined, ['client-1']);
    assert.deepEqual(socket.emitted, [{ event: 'room_list', args: [[room()]] }]);
  });

  it('returns rooms only for registered clients', async () => {
    const unregistered = createHarness(null);
    await unregistered.socket.invoke('get_rooms');
    assert.deepEqual(unregistered.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);

    const registered = createHarness('client-1');
    await registered.socket.invoke('get_rooms');
    assert.deepEqual(registered.socket.emitted, [{ event: 'room_list', args: [[room()]] }]);
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
    await unregistered.socket.invoke('join_room', 'room-1');
    assert.deepEqual(unregistered.socket.emitted, [{ event: 'error', args: [{ message: 'You are not registered' }] }]);

    const missing = createHarness('client-1');
    await missing.socket.invoke('join_room', 'missing');
    assert.deepEqual(missing.socket.emitted, [{ event: 'error', args: [{ message: 'Room not found' }] }]);

    const valid = createHarness('client-1');
    valid.store.socketRooms = ['old-room'];
    valid.store.rooms.push(room({ id: 'old-room', name: 'Old Room' }));
    await valid.socket.invoke('join_room', 'room-1');

    assert.deepEqual(valid.socket.left, ['old-room']);
    assert.deepEqual(valid.socket.joined, ['room-1']);
    assert.deepEqual(valid.store.socketRooms, ['room-1']);
    assert.deepEqual(valid.store.addedMembers, [{ roomId: 'room-1', clientId: 'client-1', role: 'owner' }]);
    assert.equal(valid.socket.roomEmits[0].roomId, 'old-room');
    assert.equal(valid.socket.roomEmits[0].event, 'room_member_change');
    assert.equal(valid.io.roomEmits[0].roomId, 'room-1');
    assert.equal(valid.io.roomEmits[0].event, 'room_member_change');
    assert.equal(valid.io.roomEmits[1].roomId, 'client-1');
    assert.equal(valid.io.roomEmits[1].event, 'room_list');
    assert.deepEqual(valid.socket.emitted, []);
  });

  it('leaves rooms and updates stored socket memberships', async () => {
    const { io, socket, store } = createHarness('client-1');
    store.socketRooms = ['room-1', 'room-2'];

    await socket.invoke('leave_room', 'room-1');

    assert.deepEqual(socket.left, ['room-1']);
    assert.deepEqual(store.socketRooms, ['room-2']);
    assert.equal(io.roomEmits[0].roomId, 'room-1');
    assert.equal(io.roomEmits[0].event, 'room_member_change');
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
      { roomId: 'socket-2', event: 'room_list', args: [[]] },
    ]);
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
