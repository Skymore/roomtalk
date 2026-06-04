import { AICost, ImageAsset, Message, Room, RoomAICostTotal, RoomMember, RoomMemberRole, RoomMessagePage } from '../types';

export const DEFAULT_ROOM_MESSAGE_PAGE_LIMIT = 80;

export interface RoomMessagePageOptions {
  limit?: number;
  beforeMessageId?: string;
}

export interface MessageUpdateResult {
  room: Room;
  found: boolean;
  updatedMessage?: Message;
}

export interface MessageDeleteResult {
  room: Room;
  deleted: boolean;
}

export interface MessageTruncateResult {
  room: Room;
  messages: Message[];
  targetFound: boolean;
}

export interface MessageUpdateAndTruncateResult {
  room: Room;
  messages: Message[];
  targetFound: boolean;
  updatedMessage?: Message;
}

export interface DurableRoomStore {
  generateUniqueRoomId(): Promise<string>;
  appendMessage(message: Message): Promise<Room | null>;
  upsertMessage(message: Message): Promise<Room | null>;
  updateMessageContent(roomId: string, messageId: string, updatedContent: string, updatedAt?: string): Promise<MessageUpdateResult | null>;
  deleteMessageById(roomId: string, messageId: string): Promise<MessageDeleteResult | null>;
  truncateBeforeMessage(roomId: string, messageId: string): Promise<MessageTruncateResult | null>;
  truncateAfterMessage(roomId: string, messageId: string): Promise<MessageTruncateResult | null>;
  updateMessageAndTruncateAfter(roomId: string, messageId: string, newContent: string, updatedAt?: string): Promise<MessageUpdateAndTruncateResult | null>;
  saveMessageHistory(roomId: string, messages: Message[]): Promise<Room | null>;
  clearRoomMessages(roomId: string): Promise<number>;
  readMessagesByRoom(roomId: string): Promise<Message[]>;
  readMessagePageByRoom(roomId: string, options?: RoomMessagePageOptions): Promise<RoomMessagePage>;
  saveImageAsset(asset: ImageAsset): Promise<ImageAsset | null>;
  replaceMessageImageAsset(roomId: string, messageId: string, asset: ImageAsset): Promise<MessageUpdateResult | null>;
  getImageAsset(assetId: string): Promise<ImageAsset | null>;
  getImageAssetByMessageId(messageId: string): Promise<ImageAsset | null>;
  readImageAssetsByRoom(roomId: string): Promise<ImageAsset[]>;
  deleteImageAsset(assetId: string): Promise<void>;
  readRoomAICost(roomId: string): Promise<RoomAICostTotal>;
  incrementRoomAICost(roomId: string, cost: AICost | null): Promise<RoomAICostTotal>;
  saveRoom(room: Room): Promise<Room | null>;
  addRoomMember(roomId: string, clientId: string, role: RoomMemberRole, joinedAt?: string): Promise<RoomMember | null>;
  removeRoomMember(roomId: string, clientId: string): Promise<boolean>;
  getRoomMember(roomId: string, clientId: string): Promise<RoomMember | null>;
  isRoomMember(roomId: string, clientId: string): Promise<boolean>;
  readRoomMembers(roomId: string): Promise<RoomMember[]>;
  readRoomsByUser(clientId: string): Promise<Room[]>;
  saveRoomForUser(roomId: string, clientId: string, savedAt?: string): Promise<Room | null>;
  removeSavedRoomForUser(roomId: string, clientId: string): Promise<boolean>;
  readSavedRoomsByUser(clientId: string): Promise<Room[]>;
  getRoomById(roomId: string): Promise<Room | null>;
  updateRoomName(roomId: string, creatorId: string, name: string): Promise<Room | null>;
  deleteRoom(roomId: string, creatorId: string): Promise<void>;
  countRooms(): Promise<number>;
  resetAllDataForTests?(): Promise<void>;
  failInterruptedStreamingMessages?(content: string): Promise<number>;
}

export interface RealtimeRoomStore {
  updateRoomMemberCount(roomId: string, clientId: string, socketId: string, isJoining: boolean): Promise<number>;
  getRoomMemberCount(roomId: string): Promise<number>;
  clearRealtimeRoomMembers?(): Promise<void>;
  storeClientSession(socketId: string, userId: string): Promise<void>;
  getClientId(socketId: string): Promise<string | null>;
  removeClientSession(socketId: string): Promise<void>;
  storeUserRooms(socketId: string, roomIds: string[]): Promise<void>;
  getUserRooms(socketId: string): Promise<string[]>;
  resetAllDataForTests?(): Promise<void>;
}

export interface RoomMessageCacheStore {
  readCachedRoomMessages(roomId: string): Promise<Message[] | null>;
  writeRoomMessagesCache(roomId: string, messages: Message[]): Promise<void>;
  invalidateRoomMessagesCache(roomId: string): Promise<void>;
  invalidateAllRoomMessagesCaches(): Promise<void>;
}

export type RoomStore = DurableRoomStore & RealtimeRoomStore;

export class CompositeRoomStore implements RoomStore {
  constructor(
    private readonly durableStore: DurableRoomStore,
    private readonly realtimeStore: RealtimeRoomStore,
    private readonly messageCacheStore?: RoomMessageCacheStore
  ) {}

  private async ignoreCacheFailure(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch {
      // Cache failures must not affect durable writes.
    }
  }

  private async invalidateRoomMessagesCache(roomId: string): Promise<void> {
    if (!this.messageCacheStore) {
      return;
    }

    await this.ignoreCacheFailure(() => this.messageCacheStore!.invalidateRoomMessagesCache(roomId));
  }

  generateUniqueRoomId() {
    return this.durableStore.generateUniqueRoomId();
  }

  async appendMessage(message: Message) {
    const updatedRoom = await this.durableStore.appendMessage(message);
    if (updatedRoom) {
      await this.invalidateRoomMessagesCache(message.roomId);
    }
    return updatedRoom;
  }

  async upsertMessage(message: Message) {
    const updatedRoom = await this.durableStore.upsertMessage(message);
    if (updatedRoom) {
      await this.invalidateRoomMessagesCache(message.roomId);
    }
    return updatedRoom;
  }

  async saveMessageHistory(roomId: string, messages: Message[]) {
    const updatedRoom = await this.durableStore.saveMessageHistory(roomId, messages);
    if (updatedRoom) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return updatedRoom;
  }

  async updateMessageContent(roomId: string, messageId: string, updatedContent: string, updatedAt?: string) {
    const result = await this.durableStore.updateMessageContent(roomId, messageId, updatedContent, updatedAt);
    if (result?.found) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  async deleteMessageById(roomId: string, messageId: string) {
    const result = await this.durableStore.deleteMessageById(roomId, messageId);
    if (result?.deleted) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  async truncateBeforeMessage(roomId: string, messageId: string) {
    const result = await this.durableStore.truncateBeforeMessage(roomId, messageId);
    if (result?.targetFound) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  async truncateAfterMessage(roomId: string, messageId: string) {
    const result = await this.durableStore.truncateAfterMessage(roomId, messageId);
    if (result?.targetFound) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  async updateMessageAndTruncateAfter(roomId: string, messageId: string, newContent: string, updatedAt?: string) {
    const result = await this.durableStore.updateMessageAndTruncateAfter(roomId, messageId, newContent, updatedAt);
    if (result?.targetFound) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  async clearRoomMessages(roomId: string) {
    const count = await this.durableStore.clearRoomMessages(roomId);
    await this.invalidateRoomMessagesCache(roomId);
    return count;
  }

  async readMessagesByRoom(roomId: string) {
    if (this.messageCacheStore) {
      try {
        const cachedMessages = await this.messageCacheStore.readCachedRoomMessages(roomId);
        if (cachedMessages) {
          return cachedMessages;
        }
      } catch {
        // Cache failures must fall through to durable reads.
      }
    }

    const messages = await this.durableStore.readMessagesByRoom(roomId);
    if (this.messageCacheStore) {
      await this.ignoreCacheFailure(() => this.messageCacheStore!.writeRoomMessagesCache(roomId, messages));
    }
    return messages;
  }

  readMessagePageByRoom(roomId: string, options?: RoomMessagePageOptions) {
    return this.durableStore.readMessagePageByRoom(roomId, options);
  }

  saveImageAsset(asset: ImageAsset) {
    return this.durableStore.saveImageAsset(asset);
  }

  async replaceMessageImageAsset(roomId: string, messageId: string, asset: ImageAsset) {
    const result = await this.durableStore.replaceMessageImageAsset(roomId, messageId, asset);
    if (result?.found) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  getImageAsset(assetId: string) {
    return this.durableStore.getImageAsset(assetId);
  }

  getImageAssetByMessageId(messageId: string) {
    return this.durableStore.getImageAssetByMessageId(messageId);
  }

  readImageAssetsByRoom(roomId: string) {
    return this.durableStore.readImageAssetsByRoom(roomId);
  }

  deleteImageAsset(assetId: string) {
    return this.durableStore.deleteImageAsset(assetId);
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

  addRoomMember(roomId: string, clientId: string, role: RoomMemberRole, joinedAt?: string) {
    return this.durableStore.addRoomMember(roomId, clientId, role, joinedAt);
  }

  removeRoomMember(roomId: string, clientId: string) {
    return this.durableStore.removeRoomMember(roomId, clientId);
  }

  getRoomMember(roomId: string, clientId: string) {
    return this.durableStore.getRoomMember(roomId, clientId);
  }

  isRoomMember(roomId: string, clientId: string) {
    return this.durableStore.isRoomMember(roomId, clientId);
  }

  readRoomMembers(roomId: string) {
    return this.durableStore.readRoomMembers(roomId);
  }

  readRoomsByUser(clientId: string) {
    return this.durableStore.readRoomsByUser(clientId);
  }

  saveRoomForUser(roomId: string, clientId: string, savedAt?: string) {
    return this.durableStore.saveRoomForUser(roomId, clientId, savedAt);
  }

  removeSavedRoomForUser(roomId: string, clientId: string) {
    return this.durableStore.removeSavedRoomForUser(roomId, clientId);
  }

  readSavedRoomsByUser(clientId: string) {
    return this.durableStore.readSavedRoomsByUser(clientId);
  }

  getRoomById(roomId: string) {
    return this.durableStore.getRoomById(roomId);
  }

  updateRoomName(roomId: string, creatorId: string, name: string) {
    return this.durableStore.updateRoomName(roomId, creatorId, name);
  }

  async deleteRoom(roomId: string, creatorId: string) {
    await this.durableStore.deleteRoom(roomId, creatorId);
    await this.invalidateRoomMessagesCache(roomId);
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

  async failInterruptedStreamingMessages(content: string) {
    const updatedCount = await (this.durableStore.failInterruptedStreamingMessages?.(content) || Promise.resolve(0));
    if (updatedCount > 0 && this.messageCacheStore) {
      await this.ignoreCacheFailure(() => this.messageCacheStore!.invalidateAllRoomMessagesCaches());
    }
    return updatedCount;
  }

  updateRoomMemberCount(roomId: string, clientId: string, socketId: string, isJoining: boolean) {
    return this.realtimeStore.updateRoomMemberCount(roomId, clientId, socketId, isJoining);
  }

  getRoomMemberCount(roomId: string) {
    return this.realtimeStore.getRoomMemberCount(roomId);
  }

  clearRealtimeRoomMembers() {
    return this.realtimeStore.clearRealtimeRoomMembers?.() || Promise.resolve();
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
