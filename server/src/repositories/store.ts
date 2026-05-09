import { AICost, Message, Room, RoomAICostTotal } from '../types';

export interface DurableRoomStore {
  generateUniqueRoomId(): Promise<string>;
  appendMessage(message: Message): Promise<Room | null>;
  upsertMessage(message: Message): Promise<Room | null>;
  saveMessageHistory(roomId: string, messages: Message[]): Promise<Room | null>;
  clearRoomMessages(roomId: string): Promise<number>;
  readMessagesByRoom(roomId: string): Promise<Message[]>;
  readRoomAICost(roomId: string): Promise<RoomAICostTotal>;
  incrementRoomAICost(roomId: string, cost: AICost | null): Promise<RoomAICostTotal>;
  saveRoom(room: Room): Promise<Room | null>;
  readRoomsByUser(clientId: string): Promise<Room[]>;
  getRoomById(roomId: string): Promise<Room | null>;
  deleteRoom(roomId: string, creatorId: string): Promise<void>;
  countRooms(): Promise<number>;
  resetAllDataForTests?(): Promise<void>;
  failInterruptedStreamingMessages?(content: string): Promise<number>;
}

export interface RealtimeRoomStore {
  updateRoomMemberCount(roomId: string, clientId: string, isJoining: boolean): Promise<number>;
  getRoomMemberCount(roomId: string): Promise<number>;
  storeClientSession(socketId: string, userId: string): Promise<void>;
  getClientId(socketId: string): Promise<string | null>;
  removeClientSession(socketId: string): Promise<void>;
  storeUserRooms(socketId: string, roomIds: string[]): Promise<void>;
  getUserRooms(socketId: string): Promise<string[]>;
  resetAllDataForTests?(): Promise<void>;
}

export type RoomStore = DurableRoomStore & RealtimeRoomStore;

export class CompositeRoomStore implements RoomStore {
  constructor(
    private readonly durableStore: DurableRoomStore,
    private readonly realtimeStore: RealtimeRoomStore
  ) {}

  generateUniqueRoomId() {
    return this.durableStore.generateUniqueRoomId();
  }

  appendMessage(message: Message) {
    return this.durableStore.appendMessage(message);
  }

  upsertMessage(message: Message) {
    return this.durableStore.upsertMessage(message);
  }

  saveMessageHistory(roomId: string, messages: Message[]) {
    return this.durableStore.saveMessageHistory(roomId, messages);
  }

  clearRoomMessages(roomId: string) {
    return this.durableStore.clearRoomMessages(roomId);
  }

  readMessagesByRoom(roomId: string) {
    return this.durableStore.readMessagesByRoom(roomId);
  }

  readRoomAICost(roomId: string) {
    return this.durableStore.readRoomAICost(roomId);
  }

  incrementRoomAICost(roomId: string, cost: AICost | null) {
    return this.durableStore.incrementRoomAICost(roomId, cost);
  }

  saveRoom(room: Room) {
    return this.durableStore.saveRoom(room);
  }

  readRoomsByUser(clientId: string) {
    return this.durableStore.readRoomsByUser(clientId);
  }

  getRoomById(roomId: string) {
    return this.durableStore.getRoomById(roomId);
  }

  deleteRoom(roomId: string, creatorId: string) {
    return this.durableStore.deleteRoom(roomId, creatorId);
  }

  countRooms() {
    return this.durableStore.countRooms();
  }

  async resetAllDataForTests() {
    let firstError: unknown;
    try {
      await this.durableStore.resetAllDataForTests?.();
    } catch (error) {
      firstError = error;
    }

    try {
      await this.realtimeStore.resetAllDataForTests?.();
    } catch (error) {
      firstError = firstError || error;
    }

    if (firstError) {
      throw firstError;
    }
  }

  failInterruptedStreamingMessages(content: string) {
    return this.durableStore.failInterruptedStreamingMessages?.(content) || Promise.resolve(0);
  }

  updateRoomMemberCount(roomId: string, clientId: string, isJoining: boolean) {
    return this.realtimeStore.updateRoomMemberCount(roomId, clientId, isJoining);
  }

  getRoomMemberCount(roomId: string) {
    return this.realtimeStore.getRoomMemberCount(roomId);
  }

  storeClientSession(socketId: string, userId: string) {
    return this.realtimeStore.storeClientSession(socketId, userId);
  }

  getClientId(socketId: string) {
    return this.realtimeStore.getClientId(socketId);
  }

  removeClientSession(socketId: string) {
    return this.realtimeStore.removeClientSession(socketId);
  }

  storeUserRooms(socketId: string, roomIds: string[]) {
    return this.realtimeStore.storeUserRooms(socketId, roomIds);
  }

  getUserRooms(socketId: string) {
    return this.realtimeStore.getUserRooms(socketId);
  }
}
