import { AICost, MediaAsset, Message, Room, RoomAICostTotal, RoomMember, RoomMemberRole, RoomMessagePage, RoomOnlineMember, RoomPostingSchedule } from '../types';
import { InterruptedStreamingMessageRecoveryOptions } from '../services/aiStreamRecovery';

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

export interface MediaMessageAppendResult {
  room: Room;
  message: Message;
  asset: MediaAsset;
}

export interface MediaHistoryPageCursor {
  createdAt: string;
  assetId: string;
}

export interface MediaHistoryPageOptions {
  limit?: number;
  before?: MediaHistoryPageCursor | null;
  since?: string;
  kinds?: Array<MediaAsset['kind']>;
}

export interface MediaHistoryPage {
  assets: MediaAsset[];
  hasMore: boolean;
}

export interface PendingMediaUpload {
  assetId: string;
  roomId: string;
  objectKey: string;
  kind: MediaAsset['kind'];
  mimeType: string;
  byteSize: number;
  uploadedByClientId: string;
  expiresAt: string;
  createdAt: string;
}

export interface PushSubscriptionRecord {
  clientId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavePushSubscriptionInput {
  clientId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

export interface ClientAuthTokenRecord {
  clientId: string;
  tokenHash: string;
  createdAt: string;
}

export interface RoomSettingsUpdate {
  passwordHash?: string | null;
  postingSchedule?: RoomPostingSchedule | null;
}

export interface DurableRoomStore {
  generateUniqueRoomId(): Promise<string>;
  appendMessage(message: Message): Promise<Room | null>;
  appendMediaMessageWithAsset(message: Message, asset: MediaAsset): Promise<MediaMessageAppendResult | null>;
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
  saveMediaAsset(asset: MediaAsset): Promise<MediaAsset | null>;
  replaceMessageMediaAsset(roomId: string, messageId: string, asset: MediaAsset): Promise<MessageUpdateResult | null>;
  getMediaAsset(assetId: string): Promise<MediaAsset | null>;
  getMediaAssetByMessageId(messageId: string): Promise<MediaAsset | null>;
  readMediaAssetsByRoom(roomId: string): Promise<MediaAsset[]>;
  readMediaHistoryPageByRoom(roomId: string, options?: MediaHistoryPageOptions): Promise<MediaHistoryPage>;
  deleteMediaAsset(assetId: string): Promise<void>;
  savePendingMediaUpload(upload: PendingMediaUpload): Promise<void>;
  getPendingMediaUpload(assetId: string): Promise<PendingMediaUpload | null>;
  deletePendingMediaUpload(assetId: string): Promise<void>;
  claimExpiredPendingMediaUploads(now: string, limit?: number): Promise<PendingMediaUpload[]>;
  readRoomAICost(roomId: string): Promise<RoomAICostTotal>;
  incrementRoomAICost(roomId: string, cost: AICost | null): Promise<RoomAICostTotal>;
  saveRoom(room: Room): Promise<Room | null>;
  addRoomMember(roomId: string, clientId: string, role: RoomMemberRole, joinedAt?: string): Promise<RoomMember | null>;
  removeRoomMember(roomId: string, clientId: string): Promise<boolean>;
  getRoomMember(roomId: string, clientId: string): Promise<RoomMember | null>;
  isRoomMember(roomId: string, clientId: string): Promise<boolean>;
  readRoomMembers(roomId: string): Promise<RoomMember[]>;
  savePushSubscription(subscription: SavePushSubscriptionInput): Promise<void>;
  deletePushSubscription(clientId: string, endpoint: string): Promise<boolean>;
  readPushSubscriptionsByRoom(roomId: string): Promise<PushSubscriptionRecord[]>;
  setClientPasswordHash(clientId: string, passwordHash: string): Promise<void>;
  getClientPasswordHash(clientId: string): Promise<string | null>;
  saveClientAuthToken(token: ClientAuthTokenRecord): Promise<void>;
  isClientAuthTokenValid(clientId: string, tokenHash: string): Promise<boolean>;
  deleteClientAuthToken(clientId: string, tokenHash: string): Promise<boolean>;
  deleteClientAuthTokens(clientId: string): Promise<void>;
  readRoomPasswordHash(roomId: string): Promise<string | null>;
  updateRoomSettings(roomId: string, updates: RoomSettingsUpdate): Promise<Room | null>;
  updateRoomMemberRole(roomId: string, clientId: string, role: RoomMemberRole, joinedAt?: string): Promise<RoomMember | null>;
  transferRoomOwnership(roomId: string, newOwnerClientId: string, previousOwnerRole?: Exclude<RoomMemberRole, 'owner'>): Promise<Room | null>;
  readRoomsByUser(clientId: string): Promise<Room[]>;
  saveRoomForUser(roomId: string, clientId: string, savedAt?: string): Promise<Room | null>;
  removeSavedRoomForUser(roomId: string, clientId: string): Promise<boolean>;
  readSavedRoomsByUser(clientId: string): Promise<Room[]>;
  getRoomById(roomId: string): Promise<Room | null>;
  updateRoomName(roomId: string, creatorId: string, name: string): Promise<Room | null>;
  deleteRoom(roomId: string, creatorId: string): Promise<void>;
  countRooms(): Promise<number>;
  // Durable client profile data. Nicknames live in the durable store so they
  // survive Redis flushes; presence (who is online) stays in the realtime store.
  setClientNickname(clientId: string, nickname: string): Promise<void>;
  getClientNicknames(clientIds: string[]): Promise<Record<string, string>>;
  resetAllDataForTests?(): Promise<void>;
  failInterruptedStreamingMessages?(content: string, options?: InterruptedStreamingMessageRecoveryOptions): Promise<number>;
}

export interface RealtimeRoomStore {
  updateRoomMemberCount(roomId: string, clientId: string, socketId: string, isJoining: boolean): Promise<number>;
  getRoomMemberCount(roomId: string): Promise<number>;
  getRoomOnlineMemberIds(roomId: string): Promise<string[]>;
  clearRealtimeRoomMembers?(): Promise<void>;
  storeClientSession(socketId: string, userId: string): Promise<void>;
  getClientId(socketId: string): Promise<string | null>;
  removeClientSession(socketId: string): Promise<void>;
  storeUserRooms(socketId: string, roomIds: string[]): Promise<void>;
  getUserRooms(socketId: string): Promise<string[]>;
  resetAllDataForTests?(): Promise<void>;
}

// Joins realtime presence (online member ids) with durable nicknames.
export interface RoomPresenceStore {
  getRoomOnlineMembers(roomId: string): Promise<RoomOnlineMember[]>;
}

export interface RoomMessageCacheStore {
  readCachedRoomMessages(roomId: string, messageVersion?: number): Promise<Message[] | null>;
  writeRoomMessagesCache(roomId: string, messages: Message[], messageVersion?: number): Promise<void>;
  invalidateRoomMessagesCache(roomId: string): Promise<void>;
  invalidateAllRoomMessagesCaches(): Promise<void>;
}

export type RoomStore = DurableRoomStore & RealtimeRoomStore & RoomPresenceStore;

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

  async appendMediaMessageWithAsset(message: Message, asset: MediaAsset) {
    const result = await this.durableStore.appendMediaMessageWithAsset(message, asset);
    if (result) {
      await this.invalidateRoomMessagesCache(message.roomId);
    }
    return result;
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
    let cacheMessageVersion: number | undefined;

    if (this.messageCacheStore) {
      try {
        const room = await this.durableStore.getRoomById(roomId);
        if (typeof room?.messageVersion === 'number' && Number.isFinite(room.messageVersion)) {
          cacheMessageVersion = room.messageVersion;
          const cachedMessages = await this.messageCacheStore.readCachedRoomMessages(roomId, cacheMessageVersion);
          if (cachedMessages) {
            return cachedMessages;
          }
        }
      } catch {
        // Cache failures must fall through to durable reads.
      }
    }

    const messages = await this.durableStore.readMessagesByRoom(roomId);
    if (this.messageCacheStore && cacheMessageVersion !== undefined) {
      await this.ignoreCacheFailure(async () => {
        const room = await this.durableStore.getRoomById(roomId);
        if (room?.messageVersion === cacheMessageVersion) {
          await this.messageCacheStore!.writeRoomMessagesCache(roomId, messages, cacheMessageVersion);
        }
      });
    }
    return messages;
  }

  readMessagePageByRoom(roomId: string, options?: RoomMessagePageOptions) {
    return this.durableStore.readMessagePageByRoom(roomId, options);
  }

  saveMediaAsset(asset: MediaAsset) {
    return this.durableStore.saveMediaAsset(asset);
  }

  async replaceMessageMediaAsset(roomId: string, messageId: string, asset: MediaAsset) {
    const result = await this.durableStore.replaceMessageMediaAsset(roomId, messageId, asset);
    if (result?.found) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  getMediaAsset(assetId: string) {
    return this.durableStore.getMediaAsset(assetId);
  }

  getMediaAssetByMessageId(messageId: string) {
    return this.durableStore.getMediaAssetByMessageId(messageId);
  }

  readMediaAssetsByRoom(roomId: string) {
    return this.durableStore.readMediaAssetsByRoom(roomId);
  }

  readMediaHistoryPageByRoom(roomId: string, options?: MediaHistoryPageOptions) {
    return this.durableStore.readMediaHistoryPageByRoom(roomId, options);
  }

  deleteMediaAsset(assetId: string) {
    return this.durableStore.deleteMediaAsset(assetId);
  }

  savePendingMediaUpload(upload: PendingMediaUpload) {
    return this.durableStore.savePendingMediaUpload(upload);
  }

  getPendingMediaUpload(assetId: string) {
    return this.durableStore.getPendingMediaUpload(assetId);
  }

  deletePendingMediaUpload(assetId: string) {
    return this.durableStore.deletePendingMediaUpload(assetId);
  }

  claimExpiredPendingMediaUploads(now: string, limit?: number) {
    return this.durableStore.claimExpiredPendingMediaUploads(now, limit);
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

  savePushSubscription(subscription: SavePushSubscriptionInput) {
    return this.durableStore.savePushSubscription(subscription);
  }

  deletePushSubscription(clientId: string, endpoint: string) {
    return this.durableStore.deletePushSubscription(clientId, endpoint);
  }

  readPushSubscriptionsByRoom(roomId: string) {
    return this.durableStore.readPushSubscriptionsByRoom(roomId);
  }

  setClientPasswordHash(clientId: string, passwordHash: string) {
    return this.durableStore.setClientPasswordHash(clientId, passwordHash);
  }

  getClientPasswordHash(clientId: string) {
    return this.durableStore.getClientPasswordHash(clientId);
  }

  saveClientAuthToken(token: ClientAuthTokenRecord) {
    return this.durableStore.saveClientAuthToken(token);
  }

  isClientAuthTokenValid(clientId: string, tokenHash: string) {
    return this.durableStore.isClientAuthTokenValid(clientId, tokenHash);
  }

  deleteClientAuthToken(clientId: string, tokenHash: string) {
    return this.durableStore.deleteClientAuthToken(clientId, tokenHash);
  }

  deleteClientAuthTokens(clientId: string) {
    return this.durableStore.deleteClientAuthTokens(clientId);
  }

  readRoomPasswordHash(roomId: string) {
    return this.durableStore.readRoomPasswordHash(roomId);
  }

  updateRoomSettings(roomId: string, updates: RoomSettingsUpdate) {
    return this.durableStore.updateRoomSettings(roomId, updates);
  }

  updateRoomMemberRole(roomId: string, clientId: string, role: RoomMemberRole, joinedAt?: string) {
    return this.durableStore.updateRoomMemberRole(roomId, clientId, role, joinedAt);
  }

  transferRoomOwnership(roomId: string, newOwnerClientId: string, previousOwnerRole?: Exclude<RoomMemberRole, 'owner'>) {
    return this.durableStore.transferRoomOwnership(roomId, newOwnerClientId, previousOwnerRole);
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

  async failInterruptedStreamingMessages(content: string, options?: InterruptedStreamingMessageRecoveryOptions) {
    const updatedCount = await (this.durableStore.failInterruptedStreamingMessages?.(content, options) || Promise.resolve(0));
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

  async getRoomOnlineMembers(roomId: string): Promise<RoomOnlineMember[]> {
    const clientIds = await this.realtimeStore.getRoomOnlineMemberIds(roomId);
    const nicknames = await this.durableStore.getClientNicknames(clientIds);
    return clientIds.map((clientId) => ({ clientId, nickname: nicknames[clientId] }));
  }

  getRoomOnlineMemberIds(roomId: string) {
    return this.realtimeStore.getRoomOnlineMemberIds(roomId);
  }

  setClientNickname(clientId: string, nickname: string) {
    return this.durableStore.setClientNickname(clientId, nickname);
  }

  getClientNicknames(clientIds: string[]) {
    return this.durableStore.getClientNicknames(clientIds);
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
