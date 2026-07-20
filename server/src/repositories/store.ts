import { AICost, AIModelProvider, CodeAgentQueuedInput, CodeAgentQueueState, MediaAsset, Message, Room, RoomAgentTurn, RoomAICostTotal, RoomEventPage, RoomMember, RoomMemberRole, RoomMessagePage, RoomOnlineMember, RoomPostingSchedule, RoomSandboxStatus, RoomSnapshot } from '../types';
import { InterruptedStreamingMessageRecoveryOptions } from '../services/aiStreamRecovery';

export const DEFAULT_ROOM_MESSAGE_PAGE_LIMIT = 80;

export interface RoomMessagePageOptions {
  // A complete agent turn counts as one unit. Messages without turnId each
  // count as one unit, so a page never splits an agent turn at its boundary.
  limit?: number;
  beforeMessageId?: string;
}

export interface RoomEventPageOptions {
  afterSeq: number;
  limit?: number;
  maxBytes?: number;
}

export interface RoomEventRetentionOptions {
  olderThan: string;
  maxEventsPerRoom: number;
}

export class RoomEventCursorExpiredError extends Error {
  readonly code = 'CURSOR_EXPIRED';

  constructor(
    readonly roomId: string,
    readonly afterSeq: number,
    readonly minAvailableSeq: number,
  ) {
    super(`Room event cursor ${afterSeq} is older than retained sequence ${minAvailableSeq} for ${roomId}`);
    this.name = 'RoomEventCursorExpiredError';
  }
}

export class RoomEventCursorAheadError extends Error {
  readonly code = 'CURSOR_AHEAD';

  constructor(
    readonly roomId: string,
    readonly afterSeq: number,
    readonly headSeq: number,
  ) {
    super(`Room event cursor ${afterSeq} is ahead of sequence ${headSeq} for ${roomId}`);
    this.name = 'RoomEventCursorAheadError';
  }
}

export interface MessageUpdateResult {
  room: Room;
  found: boolean;
  updatedMessage?: Message;
}

export interface CodeAgentQueueClaimResult {
  room: Room;
  message: Message;
}

export interface CodeAgentRoomLease {
  roomId: string;
  turnId: string;
  ownerId: string;
  fence: number;
  expiresAt: string;
}

export interface CodeAgentQueueMessageUpdate {
  expectedState: CodeAgentQueueState;
  queuedInput: CodeAgentQueuedInput | null;
  content?: string;
  updatedAt?: string;
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

export interface RoomSandboxReplacement {
  sandboxId: string;
  sandboxStatus: RoomSandboxStatus;
  sandboxUpdatedAt: string;
  sandboxArtifactVersion?: string;
  sandboxCodeAgentSourceRef?: string;
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
  filename?: string;
  uploadedByClientId: string;
  expiresAt: string;
  createdAt: string;
}

export type AudioTranscriptionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface AudioTranscriptionRecord {
  assetId: string;
  roomId: string;
  messageId: string;
  requestedByClientId: string;
  status: AudioTranscriptionStatus;
  transcript?: string;
  languageCode?: string;
  provider: 'assemblyai';
  providerTranscriptId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AudioTranscriptionUpdate {
  status?: AudioTranscriptionStatus;
  transcript?: string | null;
  languageCode?: string | null;
  providerTranscriptId?: string | null;
  error?: string | null;
  updatedAt?: string;
  completedAt?: string | null;
}

export interface PushSubscriptionRecord {
  clientId: string;
  browserInstanceId?: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavePushSubscriptionInput {
  clientId: string;
  browserInstanceId?: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

export type AssistantRunStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';

export interface AssistantRunRecord {
  id: string;
  roomId: string;
  requestedByClientId: string;
  aiMessageId: string;
  status: AssistantRunStatus;
  modelId: string;
  apiModel: string;
  provider: AIModelProvider;
  roleName?: string;
  userMessageId?: string;
  systemPrompt?: string;
  maxContextMessages?: number;
  retryForMessageId?: string;
  editedMessageId?: string;
  error?: string;
  createdAt: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface AssistantRunUpdate {
  status?: AssistantRunStatus;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  metadata?: Record<string, unknown> | null;
}

export type OutboxEventStatus = 'pending' | 'processing' | 'processed' | 'failed';

export interface OutboxEventRecord {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  roomId?: string;
  payload: Record<string, unknown>;
  status: OutboxEventStatus;
  attempts: number;
  availableAt: string;
  lockedAt?: string;
  lockedBy?: string;
  processedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxClaimOptions {
  workerId: string;
  eventTypes?: string[];
  limit?: number;
  now?: string;
  lockMs?: number;
}

export interface OutboxFailOptions {
  retryDelayMs?: number;
  maxAttempts?: number;
  now?: string;
}

export type ClientAuthMethod = 'password' | 'google';

export interface ClientAuthTokenRecord {
  clientId: string;
  tokenHash: string;
  createdAt: string;
  accountId?: string;
  authMethod?: ClientAuthMethod;
  expiresAt?: string;
}

export interface GoogleAccountProfile {
  providerSubject: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  avatarUrl?: string;
}

export interface ClientAccount {
  accountId: string;
  primaryClientId: string;
  provider: 'google';
  providerSubject: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface CreateGoogleAccountInput extends GoogleAccountProfile {
  accountId: string;
  clientId: string;
  now?: string;
}

export interface RoomSettingsUpdate {
  passwordHash?: string | null;
  postingSchedule?: RoomPostingSchedule | null;
  codeAgentAccess?: Room['codeAgentAccess'] | null;
  codeAgentMode?: Room['codeAgentMode'] | null;
  codeAgentBackend?: Room['codeAgentBackend'] | null;
}

export interface IdempotentMessageAppendResult {
  room: Room;
  message: Message;
  inserted: boolean;
}

export interface DurableRoomStore {
  generateUniqueRoomId(): Promise<string>;
  appendMessage(message: Message): Promise<Room | null>;
  appendMessageIdempotent(message: Message): Promise<IdempotentMessageAppendResult | null>;
  appendMessageWithAtomicPosition(message: Message): Promise<Room | null>;
  appendMediaMessageWithAsset(message: Message, asset: MediaAsset): Promise<MediaMessageAppendResult | null>;
  upsertMessage(message: Message): Promise<Room | null>;
  updateMessageContent(roomId: string, messageId: string, updatedContent: string, updatedAt?: string): Promise<MessageUpdateResult | null>;
  updateCodeAgentQueuedMessage?(roomId: string, messageId: string, update: CodeAgentQueueMessageUpdate): Promise<MessageUpdateResult | null>;
  materializeCodeAgentQueuedMessage?(roomId: string, messageId: string, expectedState: CodeAgentQueueState, turnId?: string, insertedAt?: string): Promise<MessageUpdateResult | null>;
  claimNextCodeAgentQueuedMessage?(roomId: string, updatedAt?: string): Promise<CodeAgentQueueClaimResult | null>;
  deleteCodeAgentQueuedMessage?(roomId: string, messageId: string, expectedState?: CodeAgentQueueState): Promise<MessageDeleteResult | null>;
  findRoomsWithQueuedCodeAgentMessages?(): Promise<string[]>;
  deleteMessageById(roomId: string, messageId: string): Promise<MessageDeleteResult | null>;
  truncateBeforeMessage(roomId: string, messageId: string): Promise<MessageTruncateResult | null>;
  truncateAfterMessage(roomId: string, messageId: string): Promise<MessageTruncateResult | null>;
  updateMessageAndTruncateAfter(roomId: string, messageId: string, newContent: string, updatedAt?: string): Promise<MessageUpdateAndTruncateResult | null>;
  saveMessageHistory(roomId: string, messages: Message[]): Promise<Room | null>;
  clearRoomMessages(roomId: string): Promise<number>;
  readMessagesByRoom(roomId: string): Promise<Message[]>;
  readMessagePageByRoom(roomId: string, options?: RoomMessagePageOptions): Promise<RoomMessagePage>;
  readRoomSnapshot?(roomId: string, options?: RoomMessagePageOptions): Promise<RoomSnapshot>;
  readRoomEvents?(roomId: string, options: RoomEventPageOptions): Promise<RoomEventPage>;
  readRoomEventHead?(roomId: string): Promise<number>;
  canReadRoomEvents?(roomId: string, clientId: string): Promise<boolean>;
  pruneRoomEvents?(options: RoomEventRetentionOptions): Promise<number>;
  upsertRoomAgentTurn?(turn: RoomAgentTurn): Promise<RoomAgentTurn | null>;
  readRoomAgentTurns?(roomId: string, turnIds?: string[]): Promise<RoomAgentTurn[]>;
  failInterruptedRoomAgentTurns?(completedAt?: string): Promise<number>;
  acquireCodeAgentRoomLease?(roomId: string, turnId: string, ownerId: string, now: string, ttlMs: number): Promise<CodeAgentRoomLease | null>;
  renewCodeAgentRoomLease?(roomId: string, turnId: string, ownerId: string, now: string, ttlMs: number): Promise<CodeAgentRoomLease | null>;
  releaseCodeAgentRoomLease?(roomId: string, turnId: string, ownerId: string): Promise<boolean>;
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
  getAudioTranscription(assetId: string): Promise<AudioTranscriptionRecord | null>;
  createAudioTranscription(record: AudioTranscriptionRecord): Promise<AudioTranscriptionRecord>;
  updateAudioTranscription(assetId: string, updates: AudioTranscriptionUpdate): Promise<AudioTranscriptionRecord | null>;
  readRoomAICost(roomId: string): Promise<RoomAICostTotal>;
  incrementRoomAICost(roomId: string, cost: AICost | null): Promise<RoomAICostTotal>;
  createAssistantRun?(run: AssistantRunRecord): Promise<AssistantRunRecord | null>;
  getAssistantRun?(runId: string): Promise<AssistantRunRecord | null>;
  updateAssistantRun?(runId: string, updates: AssistantRunUpdate): Promise<AssistantRunRecord | null>;
  createOutboxEvent?(event: OutboxEventRecord): Promise<OutboxEventRecord | null>;
  createAssistantRunWithOutbox?(run: AssistantRunRecord, event: OutboxEventRecord): Promise<{ run: AssistantRunRecord; event: OutboxEventRecord } | null>;
  claimOutboxEvents?(options: OutboxClaimOptions): Promise<OutboxEventRecord[]>;
  markOutboxEventProcessed?(eventId: string, processedAt?: string): Promise<OutboxEventRecord | null>;
  markOutboxEventFailed?(eventId: string, error: string, options?: OutboxFailOptions): Promise<OutboxEventRecord | null>;
  saveRoom(room: Room): Promise<Room | null>;
  addRoomMember(roomId: string, clientId: string, role: RoomMemberRole, joinedAt?: string): Promise<RoomMember | null>;
  removeRoomMember(roomId: string, clientId: string): Promise<boolean>;
  getRoomMember(roomId: string, clientId: string): Promise<RoomMember | null>;
  isRoomMember(roomId: string, clientId: string): Promise<boolean>;
  readRoomMembers(roomId: string): Promise<RoomMember[]>;
  savePushSubscription(subscription: SavePushSubscriptionInput): Promise<void>;
  deletePushSubscription(clientId: string, endpoint: string): Promise<boolean>;
  readPushSubscriptionsByRoom(roomId: string): Promise<PushSubscriptionRecord[]>;
  getAccountByClientId(clientId: string): Promise<ClientAccount | null>;
  getAccountByGoogleSubject(providerSubject: string): Promise<ClientAccount | null>;
  createGoogleAccountForClient(input: CreateGoogleAccountInput): Promise<ClientAccount | null>;
  updateGoogleAccountLogin(accountId: string, profile: GoogleAccountProfile, now?: string): Promise<ClientAccount | null>;
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
  deleteRoom(roomId: string, creatorId: string): Promise<boolean>;
  countRooms(): Promise<number>;
  compareAndSetRoomSandboxStatus(roomId: string, expectedStatuses: RoomSandboxStatus[], nextStatus: RoomSandboxStatus, updatedAt?: string): Promise<Room | null>;
  replaceRoomSandbox(roomId: string, expectedSandboxId: string, next: RoomSandboxReplacement): Promise<Room | null>;
  findInterruptedCodeAgentRooms(): Promise<Room[]>;
  findDanglingToolCalls(): Promise<Message[]>;
  // Durable client profile data. Nicknames live in the durable store so they
  // survive Redis flushes; presence (who is online) stays in the realtime store.
  setClientNickname(clientId: string, nickname: string): Promise<void>;
  getClientNicknames(clientIds: string[]): Promise<Record<string, string>>;
  resetAllDataForTests?(): Promise<void>;
  failInterruptedStreamingMessages?(content: string, options?: InterruptedStreamingMessageRecoveryOptions): Promise<number>;
}

export interface RealtimeRoomStore {
  withRoomAccessMutationLock?<T>(roomId: string, operation: () => Promise<T>): Promise<T>;
  updateRoomMemberCount(roomId: string, clientId: string, socketId: string, isJoining: boolean): Promise<number>;
  updateRoomBrowserPresence(roomId: string, browserInstanceId: string, socketId: string, isJoining: boolean): Promise<void>;
  getRoomMemberCount(roomId: string): Promise<number>;
  getRoomOnlineMemberIds(roomId: string): Promise<string[]>;
  getRoomActiveBrowserInstanceIds(roomId: string): Promise<string[]>;
  clearRealtimeRoomMembers?(): Promise<void>;
  storeClientSession(socketId: string, userId: string, browserInstanceId?: string): Promise<void>;
  getClientId(socketId: string): Promise<string | null>;
  getBrowserInstanceId(socketId: string): Promise<string | null>;
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
  readCachedRoomMessages(roomId: string, eventSeq: number): Promise<Message[] | null>;
  writeRoomMessagesCache(roomId: string, messages: Message[], eventSeq: number): Promise<void>;
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

  withRoomAccessMutationLock<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    return this.realtimeStore.withRoomAccessMutationLock
      ? this.realtimeStore.withRoomAccessMutationLock(roomId, operation)
      : operation();
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

  async appendMessageIdempotent(message: Message) {
    const result = await this.durableStore.appendMessageIdempotent(message);
    if (result?.inserted) {
      await this.invalidateRoomMessagesCache(message.roomId);
    }
    return result;
  }

  async appendMessageWithAtomicPosition(message: Message) {
    const updatedRoom = await this.durableStore.appendMessageWithAtomicPosition(message);
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

  async updateCodeAgentQueuedMessage(roomId: string, messageId: string, update: CodeAgentQueueMessageUpdate) {
    if (!this.durableStore.updateCodeAgentQueuedMessage) {
      return null;
    }
    const result = await this.durableStore.updateCodeAgentQueuedMessage(roomId, messageId, update);
    if (result?.found) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  async materializeCodeAgentQueuedMessage(roomId: string, messageId: string, expectedState: CodeAgentQueueState, turnId?: string, insertedAt?: string) {
    if (!this.durableStore.materializeCodeAgentQueuedMessage) {
      return null;
    }
    const result = await this.durableStore.materializeCodeAgentQueuedMessage(roomId, messageId, expectedState, turnId, insertedAt);
    if (result?.found) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  async claimNextCodeAgentQueuedMessage(roomId: string, updatedAt?: string) {
    if (!this.durableStore.claimNextCodeAgentQueuedMessage) {
      return null;
    }
    const result = await this.durableStore.claimNextCodeAgentQueuedMessage(roomId, updatedAt);
    if (result) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  async deleteCodeAgentQueuedMessage(roomId: string, messageId: string, expectedState?: CodeAgentQueueState) {
    if (!this.durableStore.deleteCodeAgentQueuedMessage) {
      return null;
    }
    const result = await this.durableStore.deleteCodeAgentQueuedMessage(roomId, messageId, expectedState);
    if (result?.deleted) {
      await this.invalidateRoomMessagesCache(roomId);
    }
    return result;
  }

  findRoomsWithQueuedCodeAgentMessages() {
    return this.durableStore.findRoomsWithQueuedCodeAgentMessages?.() || Promise.resolve([]);
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
    let cacheEventSeq: number | undefined;

    if (this.messageCacheStore && this.durableStore.readRoomEventHead) {
      try {
        cacheEventSeq = await this.durableStore.readRoomEventHead(roomId);
        const cachedMessages = await this.messageCacheStore.readCachedRoomMessages(roomId, cacheEventSeq);
        if (cachedMessages) {
          return cachedMessages;
        }
      } catch {
        // Cache failures must fall through to durable reads.
      }
    }

    const messages = await this.durableStore.readMessagesByRoom(roomId);
    if (this.messageCacheStore && this.durableStore.readRoomEventHead && cacheEventSeq !== undefined) {
      await this.ignoreCacheFailure(async () => {
        const currentEventSeq = await this.durableStore.readRoomEventHead!(roomId);
        if (currentEventSeq === cacheEventSeq) {
          await this.messageCacheStore!.writeRoomMessagesCache(roomId, messages, cacheEventSeq);
        }
      });
    }
    return messages;
  }

  readMessagePageByRoom(roomId: string, options?: RoomMessagePageOptions) {
    return this.durableStore.readMessagePageByRoom(roomId, options);
  }

  readRoomSnapshot(roomId: string, options?: RoomMessagePageOptions) {
    if (!this.durableStore.readRoomSnapshot) {
      throw new Error('The durable store does not support room event snapshots');
    }
    return this.durableStore.readRoomSnapshot(roomId, options);
  }

  readRoomEvents(roomId: string, options: RoomEventPageOptions) {
    if (!this.durableStore.readRoomEvents) {
      throw new Error('The durable store does not support room event replay');
    }
    return this.durableStore.readRoomEvents(roomId, options);
  }

  readRoomEventHead(roomId: string) {
    return this.durableStore.readRoomEventHead?.(roomId) || Promise.resolve(0);
  }

  canReadRoomEvents(roomId: string, clientId: string) {
    if (this.durableStore.canReadRoomEvents) {
      return this.durableStore.canReadRoomEvents(roomId, clientId);
    }
    return this.durableStore.getRoomMember(roomId, clientId).then(member => Boolean(member));
  }

  pruneRoomEvents(options: RoomEventRetentionOptions) {
    return this.durableStore.pruneRoomEvents?.(options) || Promise.resolve(0);
  }

  upsertRoomAgentTurn(turn: RoomAgentTurn) {
    return this.durableStore.upsertRoomAgentTurn?.(turn) || Promise.resolve(null);
  }

  readRoomAgentTurns(roomId: string, turnIds?: string[]) {
    return this.durableStore.readRoomAgentTurns?.(roomId, turnIds) || Promise.resolve([]);
  }

  failInterruptedRoomAgentTurns(completedAt?: string) {
    return this.durableStore.failInterruptedRoomAgentTurns?.(completedAt) || Promise.resolve(0);
  }

  acquireCodeAgentRoomLease(roomId: string, turnId: string, ownerId: string, now: string, ttlMs: number) {
    return this.durableStore.acquireCodeAgentRoomLease?.(roomId, turnId, ownerId, now, ttlMs) || Promise.resolve(null);
  }

  renewCodeAgentRoomLease(roomId: string, turnId: string, ownerId: string, now: string, ttlMs: number) {
    return this.durableStore.renewCodeAgentRoomLease?.(roomId, turnId, ownerId, now, ttlMs) || Promise.resolve(null);
  }

  releaseCodeAgentRoomLease(roomId: string, turnId: string, ownerId: string) {
    return this.durableStore.releaseCodeAgentRoomLease?.(roomId, turnId, ownerId) || Promise.resolve(false);
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

  getAudioTranscription(assetId: string) {
    return this.durableStore.getAudioTranscription(assetId);
  }

  createAudioTranscription(record: AudioTranscriptionRecord) {
    return this.durableStore.createAudioTranscription(record);
  }

  updateAudioTranscription(assetId: string, updates: AudioTranscriptionUpdate) {
    return this.durableStore.updateAudioTranscription(assetId, updates);
  }

  readRoomAICost(roomId: string) {
    return this.durableStore.readRoomAICost(roomId);
  }

  incrementRoomAICost(roomId: string, cost: AICost | null) {
    return this.durableStore.incrementRoomAICost(roomId, cost);
  }

  createAssistantRun(run: AssistantRunRecord) {
    return this.durableStore.createAssistantRun?.(run) || Promise.resolve(null);
  }

  getAssistantRun(runId: string) {
    return this.durableStore.getAssistantRun?.(runId) || Promise.resolve(null);
  }

  updateAssistantRun(runId: string, updates: AssistantRunUpdate) {
    return this.durableStore.updateAssistantRun?.(runId, updates) || Promise.resolve(null);
  }

  createOutboxEvent(event: OutboxEventRecord) {
    return this.durableStore.createOutboxEvent?.(event) || Promise.resolve(null);
  }

  createAssistantRunWithOutbox(run: AssistantRunRecord, event: OutboxEventRecord) {
    return this.durableStore.createAssistantRunWithOutbox?.(run, event) || Promise.resolve(null);
  }

  claimOutboxEvents(options: OutboxClaimOptions) {
    return this.durableStore.claimOutboxEvents?.(options) || Promise.resolve([]);
  }

  markOutboxEventProcessed(eventId: string, processedAt?: string) {
    return this.durableStore.markOutboxEventProcessed?.(eventId, processedAt) || Promise.resolve(null);
  }

  markOutboxEventFailed(eventId: string, error: string, options?: OutboxFailOptions) {
    return this.durableStore.markOutboxEventFailed?.(eventId, error, options) || Promise.resolve(null);
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

  getAccountByClientId(clientId: string) {
    return this.durableStore.getAccountByClientId(clientId);
  }

  getAccountByGoogleSubject(providerSubject: string) {
    return this.durableStore.getAccountByGoogleSubject(providerSubject);
  }

  createGoogleAccountForClient(input: CreateGoogleAccountInput) {
    return this.durableStore.createGoogleAccountForClient(input);
  }

  updateGoogleAccountLogin(accountId: string, profile: GoogleAccountProfile, now?: string) {
    return this.durableStore.updateGoogleAccountLogin(accountId, profile, now);
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
    const deleted = await this.durableStore.deleteRoom(roomId, creatorId);
    await this.invalidateRoomMessagesCache(roomId);
    return deleted;
  }

  countRooms() {
    return this.durableStore.countRooms();
  }

  compareAndSetRoomSandboxStatus(roomId: string, expectedStatuses: RoomSandboxStatus[], nextStatus: RoomSandboxStatus, updatedAt?: string) {
    return this.durableStore.compareAndSetRoomSandboxStatus(roomId, expectedStatuses, nextStatus, updatedAt);
  }

  replaceRoomSandbox(roomId: string, expectedSandboxId: string, next: RoomSandboxReplacement) {
    return this.durableStore.replaceRoomSandbox(roomId, expectedSandboxId, next);
  }

  findInterruptedCodeAgentRooms() {
    return this.durableStore.findInterruptedCodeAgentRooms();
  }

  findDanglingToolCalls() {
    return this.durableStore.findDanglingToolCalls();
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

  updateRoomBrowserPresence(roomId: string, browserInstanceId: string, socketId: string, isJoining: boolean) {
    return this.realtimeStore.updateRoomBrowserPresence(roomId, browserInstanceId, socketId, isJoining);
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

  getRoomActiveBrowserInstanceIds(roomId: string) {
    return this.realtimeStore.getRoomActiveBrowserInstanceIds(roomId);
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

  storeClientSession(socketId: string, userId: string, browserInstanceId?: string) {
    return this.realtimeStore.storeClientSession(socketId, userId, browserInstanceId);
  }

  getClientId(socketId: string) {
    return this.realtimeStore.getClientId(socketId);
  }

  getBrowserInstanceId(socketId: string) {
    return this.realtimeStore.getBrowserInstanceId(socketId);
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
