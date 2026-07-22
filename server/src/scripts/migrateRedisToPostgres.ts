import dotenv from 'dotenv';
import { createClient, RedisClientType } from 'redis';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresPool, PostgresStore } from '../repositories/postgresStore';
import { decodeAssistantRunRequestPayload, decodeAssistantRunTerminalPayload } from '../repositories/assistantRunPayload';
import {
  AssistantRunRecord,
  AudioTranscriptionRecord,
  ClientAccount,
  ClientAuthTokenRecord,
  OutboxEventRecord,
  PendingMediaUpload,
  PushSubscriptionRecord,
} from '../repositories/store';
import { AIModelOption, MediaAsset, Message, Room, RoomAgentTurn, RoomAICostTotal, RoomMember } from '../types';
import { CodexConnectionRecord } from '../services/codexConnection';
import { PostgresCodexConnectionStore } from '../services/codexConnectionStore';
import { GitHubConnectionRecord } from '../services/githubConnection';
import { PostgresGitHubConnectionStore } from '../services/githubConnectionStore';

dotenv.config();

type MigrationLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface RedisToPostgresMigrationSource {
  readRooms(): Promise<Room[]>;
  readMessagesByRoom(roomId: string): Promise<Message[]>;
  readRoomAICost(roomId: string): Promise<RoomAICostTotal>;
  readRoomMembers(roomId: string): Promise<RoomMember[]>;
  readRoomAgentTurns(roomId: string): Promise<RoomAgentTurn[]>;
  readRoomMediaAssets(roomId: string): Promise<MediaAsset[]>;
  readRoomSaves(roomId: string): Promise<Array<{ clientId: string; savedAt: string }>>;
  readRoomPasswordHash(roomId: string): Promise<string | null>;
  readGlobalData(): Promise<RedisDurableGlobalData>;
}

export interface RedisToPostgresMigrationTarget {
  saveRoom(room: Room): Promise<Room | null>;
  saveMessageHistory(roomId: string, messages: Message[]): Promise<Room | null>;
  setRoomAICostTotal(roomId: string, totalUsd: number): Promise<RoomAICostTotal>;
  saveRoomMember(member: RoomMember): Promise<void>;
  saveRoomAgentTurn(turn: RoomAgentTurn): Promise<void>;
  saveMediaAsset(asset: MediaAsset): Promise<void>;
  saveRoomForUser(roomId: string, clientId: string, savedAt: string): Promise<void>;
  saveRoomPasswordHash(roomId: string, passwordHash: string): Promise<void>;
  saveGlobalData(data: RedisDurableGlobalData): Promise<Record<RedisDurableGlobalKind, number>>;
}

export const REDIS_DURABLE_GLOBAL_KINDS = [
  'pendingMediaUploads',
  'audioTranscriptions',
  'assistantRuns',
  'outboxEvents',
  'pushSubscriptions',
  'accounts',
  'clientPasswords',
  'clientAuthTokens',
  'clientNicknames',
  'codexConnections',
  'githubConnections',
] as const;

export type RedisDurableGlobalKind = typeof REDIS_DURABLE_GLOBAL_KINDS[number];

export type MigratedClientAuthToken = ClientAuthTokenRecord & { lastUsedAt?: string };

export interface RedisDurableGlobalData {
  pendingMediaUploads: PendingMediaUpload[];
  audioTranscriptions: AudioTranscriptionRecord[];
  assistantRuns: AssistantRunRecord[];
  outboxEvents: OutboxEventRecord[];
  pushSubscriptions: PushSubscriptionRecord[];
  accounts: Array<{ account: ClientAccount; linkedClientIds: string[] }>;
  clientPasswords: Array<{ clientId: string; passwordHash: string }>;
  clientAuthTokens: MigratedClientAuthToken[];
  clientNicknames: Array<{ clientId: string; nickname: string }>;
  codexConnections: CodexConnectionRecord[];
  githubConnections: GitHubConnectionRecord[];
}

export interface RedisToPostgresMigrationFailure {
  roomId?: string;
  stage: 'read_rooms' | 'read_room_data' | 'read_global_data' | 'save_room' | 'save_messages' | 'save_room_related' | 'set_cost' | 'save_global_data';
  error: string;
}

export interface RedisToPostgresMigrationStats {
  dryRun: boolean;
  roomsRead: number;
  roomsWritten: number;
  roomsFailed: number;
  messagesRead: number;
  messagesWritten: number;
  costsRead: number;
  costsWritten: number;
  membersRead: number;
  membersWritten: number;
  agentTurnsRead: number;
  agentTurnsWritten: number;
  mediaAssetsRead: number;
  mediaAssetsWritten: number;
  roomSavesRead: number;
  roomSavesWritten: number;
  roomPasswordsRead: number;
  roomPasswordsWritten: number;
  globalRecordsRead: Record<RedisDurableGlobalKind, number>;
  globalRecordsWritten: Record<RedisDurableGlobalKind, number>;
  failures: RedisToPostgresMigrationFailure[];
}

export interface RedisToPostgresMigrationOptions {
  source: RedisToPostgresMigrationSource;
  target?: RedisToPostgresMigrationTarget;
  dryRun?: boolean;
  logger?: MigrationLogger;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const createEmptyStats = (dryRun: boolean): RedisToPostgresMigrationStats => ({
  dryRun,
  roomsRead: 0,
  roomsWritten: 0,
  roomsFailed: 0,
  messagesRead: 0,
  messagesWritten: 0,
  costsRead: 0,
  costsWritten: 0,
  membersRead: 0,
  membersWritten: 0,
  agentTurnsRead: 0,
  agentTurnsWritten: 0,
  mediaAssetsRead: 0,
  mediaAssetsWritten: 0,
  roomSavesRead: 0,
  roomSavesWritten: 0,
  roomPasswordsRead: 0,
  roomPasswordsWritten: 0,
  globalRecordsRead: emptyGlobalCounts(),
  globalRecordsWritten: emptyGlobalCounts(),
  failures: [],
});

const emptyGlobalCounts = (): Record<RedisDurableGlobalKind, number> => Object.fromEntries(
  REDIS_DURABLE_GLOBAL_KINDS.map(kind => [kind, 0])
) as Record<RedisDurableGlobalKind, number>;

export async function migrateRedisToPostgres({
  source,
  target,
  dryRun = false,
  logger,
}: RedisToPostgresMigrationOptions): Promise<RedisToPostgresMigrationStats> {
  if (!dryRun && !target) {
    throw new Error('Redis to PostgreSQL migration requires a target unless dryRun is enabled');
  }

  const stats = createEmptyStats(dryRun);
  let rooms: Room[];

  try {
    rooms = await source.readRooms();
  } catch (error) {
    stats.failures.push({ stage: 'read_rooms', error: errorMessage(error) });
    logger?.error('Failed to read Redis rooms for migration', { error });
    return stats;
  }

  stats.roomsRead = rooms.length;
  logger?.info('Read Redis rooms for migration', { count: rooms.length, dryRun });

  for (const room of rooms) {
    let messages: Message[];
    let roomCost: RoomAICostTotal;
    let members: RoomMember[];
    let agentTurns: RoomAgentTurn[];
    let mediaAssets: MediaAsset[];
    let roomSaves: Array<{ clientId: string; savedAt: string }>;
    let passwordHash: string | null;

    try {
      [messages, roomCost, members, agentTurns, mediaAssets, roomSaves, passwordHash] = await Promise.all([
        source.readMessagesByRoom(room.id),
        source.readRoomAICost(room.id),
        source.readRoomMembers(room.id),
        source.readRoomAgentTurns(room.id),
        source.readRoomMediaAssets(room.id),
        source.readRoomSaves(room.id),
        source.readRoomPasswordHash(room.id),
      ]);
    } catch (error) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'read_room_data', error: errorMessage(error) });
      logger?.error('Failed to read Redis room data for migration', { error, roomId: room.id });
      continue;
    }

    stats.messagesRead += messages.length;
    stats.costsRead++;
    stats.membersRead += members.length;
    stats.agentTurnsRead += agentTurns.length;
    stats.mediaAssetsRead += mediaAssets.length;
    stats.roomSavesRead += roomSaves.length;
    stats.roomPasswordsRead += passwordHash ? 1 : 0;

    if (dryRun) {
      continue;
    }

    const migrationTarget = target!;
    let savedRoom: Room | null;
    try {
      savedRoom = await migrationTarget.saveRoom(room);
    } catch (error) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'save_room', error: errorMessage(error) });
      logger?.error('Failed to save PostgreSQL room during migration', { error, roomId: room.id });
      continue;
    }

    if (!savedRoom) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'save_room', error: 'Target rejected room save' });
      logger?.error('Failed to save PostgreSQL room during migration', { roomId: room.id });
      continue;
    }

    let savedMessages: Room | null;
    try {
      savedMessages = await migrationTarget.saveMessageHistory(room.id, messages);
    } catch (error) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'save_messages', error: errorMessage(error) });
      logger?.error('Failed to save PostgreSQL room messages during migration', { error, roomId: room.id, count: messages.length });
      continue;
    }

    if (!savedMessages) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'save_messages', error: 'Target rejected message history save' });
      logger?.error('Failed to save PostgreSQL room messages during migration', { roomId: room.id, count: messages.length });
      continue;
    }

    try {
      await migrationTarget.setRoomAICostTotal(room.id, roomCost.totalUsd);
    } catch (error) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'set_cost', error: errorMessage(error) });
      logger?.error('Failed to set PostgreSQL room AI cost during migration', { error, roomId: room.id, totalUsd: roomCost.totalUsd });
      continue;
    }

    try {
      for (const member of members) await migrationTarget.saveRoomMember(member);
      for (const turn of agentTurns) await migrationTarget.saveRoomAgentTurn(turn);
      for (const asset of mediaAssets) await migrationTarget.saveMediaAsset(asset);
      for (const saved of roomSaves) await migrationTarget.saveRoomForUser(room.id, saved.clientId, saved.savedAt);
      if (passwordHash) await migrationTarget.saveRoomPasswordHash(room.id, passwordHash);
    } catch (error) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'save_room_related', error: errorMessage(error) });
      logger?.error('Failed to save PostgreSQL related room data during migration', { error, roomId: room.id });
      continue;
    }

    stats.roomsWritten++;
    stats.messagesWritten += messages.length;
    stats.costsWritten++;
    stats.membersWritten += members.length;
    stats.agentTurnsWritten += agentTurns.length;
    stats.mediaAssetsWritten += mediaAssets.length;
    stats.roomSavesWritten += roomSaves.length;
    stats.roomPasswordsWritten += passwordHash ? 1 : 0;
  }

  let globalData: RedisDurableGlobalData;
  try {
    globalData = await source.readGlobalData();
    for (const kind of REDIS_DURABLE_GLOBAL_KINDS) {
      stats.globalRecordsRead[kind] = globalData[kind].length;
    }
  } catch (error) {
    stats.failures.push({ stage: 'read_global_data', error: errorMessage(error) });
    logger?.error('Failed to read Redis global durable data for migration', { error });
    return stats;
  }

  if (!dryRun) {
    try {
      stats.globalRecordsWritten = await target!.saveGlobalData(globalData);
    } catch (error) {
      stats.failures.push({ stage: 'save_global_data', error: errorMessage(error) });
      logger?.error('Failed to save PostgreSQL global durable data during migration', { error });
    }
  }

  return stats;
}

export class RedisMigrationSource implements RedisToPostgresMigrationSource {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly logger: MigrationLogger
  ) {}

  async readRooms(): Promise<Room[]> {
    const roomIds = await this.redisClient.hKeys('rooms');
    const rooms = await Promise.all(
      roomIds.map(async roomId => {
        const roomJson = await this.redisClient.hGet('rooms', roomId);
        if (!roomJson) {
          throw new Error(`Missing Redis room payload for ${roomId}`);
        }

        try {
          return JSON.parse(roomJson) as Room;
        } catch (error) {
          throw new Error(`Invalid JSON for Redis room ${roomId}: ${errorMessage(error)}`);
        }
      })
    );

    return rooms;
  }

  private parseMessages(roomId: string, payloads: string[]): Message[] {
    return payloads.map((payload, index) => {
      try {
        return JSON.parse(payload) as Message;
      } catch (error) {
        throw new Error(`Invalid JSON for Redis room message ${roomId}/${index}: ${errorMessage(error)}`);
      }
    });
  }

  private async readMessagesByIndex(roomId: string): Promise<string[]> {
    const messageKey = `room:${roomId}:messages`;
    const client = this.redisClient as any;

    if (typeof client.lLen !== 'function' || typeof client.lIndex !== 'function') {
      throw new Error('Redis client does not support index-by-index message fallback');
    }

    const length = Number(await client.lLen(messageKey));
    const payloads: string[] = [];

    for (let index = 0; index < length; index++) {
      const payload = await client.lIndex(messageKey, index);
      if (typeof payload === 'string') {
        payloads.push(payload);
      }
    }

    return payloads;
  }

  async readMessagesByRoom(roomId: string): Promise<Message[]> {
    const messageKey = `room:${roomId}:messages`;

    try {
      const payloads = await this.redisClient.lRange(messageKey, 0, -1);
      return this.parseMessages(roomId, payloads);
    } catch (error) {
      this.logger.warn('Full Redis message list read failed during migration; falling back to index-by-index read', { error, roomId });
      const payloads = await this.readMessagesByIndex(roomId);
      return this.parseMessages(roomId, payloads);
    }
  }

  async readRoomAICost(roomId: string): Promise<RoomAICostTotal> {
    const raw = await this.redisClient.get(`room:${roomId}:ai_cost_total_usd`);
    const totalUsd = Number.parseFloat(raw || '0');
    if (!Number.isFinite(totalUsd)) {
      throw new Error(`Invalid Redis AI cost total for room ${roomId}: ${raw}`);
    }
    return { roomId, currency: 'USD', totalUsd };
  }

  async readRoomMembers(roomId: string) {
    return this.readJsonHash<RoomMember>(`room:${roomId}:room_members`);
  }

  async readRoomAgentTurns(roomId: string) {
    return this.readJsonHash<RoomAgentTurn>(`room:${roomId}:agent_turns`);
  }

  async readRoomMediaAssets(roomId: string) {
    const assetIds = await this.redisClient.sMembers(`room:${roomId}:media_assets`);
    return Promise.all(assetIds.map(async assetId => {
      const raw = await this.redisClient.hGet('media_assets', assetId);
      if (!raw) throw new Error(`Missing Redis media asset ${assetId} referenced by room ${roomId}`);
      try {
        return JSON.parse(raw) as MediaAsset;
      } catch (error) {
        throw new Error(`Invalid JSON for Redis media asset ${assetId}: ${errorMessage(error)}`);
      }
    }));
  }

  async readRoomSaves(roomId: string) {
    const clientIds = await this.redisClient.sMembers(`room:${roomId}:saved_by`);
    return Promise.all(clientIds.map(async clientId => {
      const savedAt = await this.redisClient.hGet(`user:${clientId}:saved_rooms`, roomId);
      if (!savedAt) {
        throw new Error(`Missing savedAt for Redis room save ${roomId}/${clientId}`);
      }
      return { clientId, savedAt };
    }));
  }

  readRoomPasswordHash(roomId: string) {
    return this.redisClient.get(`room:${roomId}:password_hash`);
  }

  async readGlobalData(): Promise<RedisDurableGlobalData> {
    const [
      pendingMediaUploads,
      audioTranscriptions,
      assistantRuns,
      outboxEvents,
      pushSubscriptions,
      accounts,
      accountLinks,
      clientPasswords,
      clientAuthTokens,
      clientNicknames,
      codexConnections,
      githubConnections,
    ] = await Promise.all([
      this.readJsonHash<PendingMediaUpload>('pending_media_uploads'),
      this.readJsonHash<AudioTranscriptionRecord>('audio_transcriptions'),
      this.readJsonHash<AssistantRunRecord>('assistant_runs'),
      this.readJsonHash<OutboxEventRecord>('outbox_events'),
      this.readJsonHash<PushSubscriptionRecord>('push_subscriptions'),
      this.readJsonHash<ClientAccount>('client:accounts'),
      this.redisClient.hGetAll('client:account_links'),
      this.redisClient.hGetAll('client:passwords'),
      this.readJsonHash<MigratedClientAuthToken>('client:auth_tokens'),
      this.redisClient.hGetAll('client:nicknames'),
      this.readJsonHash<CodexConnectionRecord>('codex:connections'),
      this.readJsonHash<GitHubConnectionRecord>('github:connections'),
    ]);

    const linkedClientsByAccount = new Map<string, string[]>();
    for (const [clientId, accountId] of Object.entries(accountLinks)) {
      linkedClientsByAccount.set(accountId, [...(linkedClientsByAccount.get(accountId) || []), clientId]);
    }

    return {
      pendingMediaUploads,
      audioTranscriptions,
      assistantRuns,
      outboxEvents,
      pushSubscriptions,
      accounts: accounts.map(account => ({
        account,
        linkedClientIds: linkedClientsByAccount.get(account.accountId) || [account.primaryClientId],
      })),
      clientPasswords: Object.entries(clientPasswords).map(([clientId, passwordHash]) => ({ clientId, passwordHash })),
      clientAuthTokens: clientAuthTokens.map(token => ({
        clientId: token.clientId,
        tokenHash: token.tokenHash,
        createdAt: token.createdAt,
        ...(token.accountId ? { accountId: token.accountId } : {}),
        ...(token.authMethod ? { authMethod: token.authMethod } : {}),
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
        ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}),
      })),
      clientNicknames: Object.entries(clientNicknames).map(([clientId, nickname]) => ({ clientId, nickname })),
      codexConnections: codexConnections.map(record => ({
        ...record,
        authRefreshOwnerId: undefined,
        authRefreshLockedUntil: undefined,
      })),
      githubConnections,
    };
  }

  private async readJsonHash<T>(key: string): Promise<T[]> {
    const values = await this.redisClient.hGetAll(key);
    return Object.entries(values).map(([field, raw]) => {
      try {
        return JSON.parse(raw) as T;
      } catch (error) {
        throw new Error(`Invalid JSON in Redis hash ${key} field ${field}: ${errorMessage(error)}`);
      }
    });
  }
}

export class PostgresMigrationTarget implements RedisToPostgresMigrationTarget {
  private readonly codexConnections: PostgresCodexConnectionStore;
  private readonly githubConnections: PostgresGitHubConnectionStore;

  constructor(private readonly pool: PostgresPool, private readonly store: PostgresStore) {
    this.codexConnections = new PostgresCodexConnectionStore(pool);
    this.githubConnections = new PostgresGitHubConnectionStore(pool);
  }

  saveRoom(room: Room) { return this.store.saveRoom(room); }
  saveMessageHistory(roomId: string, messages: Message[]) { return this.store.saveMessageHistory(roomId, messages); }
  async setRoomAICostTotal(roomId: string, totalUsd: number): Promise<RoomAICostTotal> {
    if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
      await this.pool.query('DELETE FROM room_ai_cost_totals WHERE room_id = $1', [roomId]);
      return { roomId, currency: 'USD', totalUsd: 0 };
    }
    await this.pool.query(
      `INSERT INTO room_ai_cost_totals (room_id,total_usd,updated_at) VALUES ($1,$2,NOW())
      ON CONFLICT (room_id) DO UPDATE SET total_usd=EXCLUDED.total_usd,updated_at=EXCLUDED.updated_at`,
      [roomId, totalUsd]
    );
    return { roomId, currency: 'USD', totalUsd };
  }

  async saveRoomMember(member: RoomMember) {
    const saved = await this.store.updateRoomMemberRole(member.roomId, member.clientId, member.role, member.joinedAt);
    if (!saved) throw new Error(`PostgreSQL rejected room member ${member.roomId}/${member.clientId}`);
  }

  async saveRoomAgentTurn(turn: RoomAgentTurn) {
    if (!await this.store.upsertRoomAgentTurn(turn)) throw new Error(`PostgreSQL rejected room agent turn ${turn.id}`);
  }

  async saveMediaAsset(asset: MediaAsset) {
    if (!await this.store.saveMediaAsset(asset)) throw new Error(`PostgreSQL rejected media asset ${asset.id}`);
  }

  async saveRoomForUser(roomId: string, clientId: string, savedAt: string) {
    if (!await this.store.saveRoomForUser(roomId, clientId, savedAt)) throw new Error(`PostgreSQL rejected room save ${roomId}/${clientId}`);
  }

  async saveRoomPasswordHash(roomId: string, passwordHash: string) {
    if (!await this.store.updateRoomSettings(roomId, { passwordHash })) {
      throw new Error(`PostgreSQL rejected room password ${roomId}`);
    }
  }

  async saveGlobalData(data: RedisDurableGlobalData) {
    const counts = emptyGlobalCounts();
    for (const upload of data.pendingMediaUploads) {
      await this.store.savePendingMediaUpload(upload);
      counts.pendingMediaUploads++;
    }
    for (const record of data.audioTranscriptions) {
      await this.store.createAudioTranscription(record);
      await this.store.updateAudioTranscription(record.assetId, {
        status: record.status,
        transcript: record.transcript ?? null,
        languageCode: record.languageCode ?? null,
        providerTranscriptId: record.providerTranscriptId ?? null,
        error: record.error ?? null,
        updatedAt: record.updatedAt,
        completedAt: record.completedAt ?? null,
      });
      counts.audioTranscriptions++;
    }
    for (const run of data.assistantRuns) {
      await this.upsertAssistantRun(run, data.outboxEvents);
      counts.assistantRuns++;
    }
    for (const event of data.outboxEvents) {
      await this.upsertOutboxEvent(event);
      counts.outboxEvents++;
    }
    for (const subscription of data.pushSubscriptions) {
      await this.upsertPushSubscription(subscription);
      counts.pushSubscriptions++;
    }
    for (const account of data.accounts) {
      await this.upsertAccount(account.account, account.linkedClientIds);
      counts.accounts++;
    }
    for (const password of data.clientPasswords) {
      await this.upsertClientPassword(password.clientId, password.passwordHash);
      counts.clientPasswords++;
    }
    for (const token of data.clientAuthTokens) {
      await this.upsertClientAuthToken(token);
      counts.clientAuthTokens++;
    }
    for (const profile of data.clientNicknames) {
      await this.upsertClientNickname(profile.clientId, profile.nickname);
      counts.clientNicknames++;
    }
    for (const record of data.codexConnections) {
      await this.codexConnections.saveConnection(record);
      counts.codexConnections++;
    }
    for (const record of data.githubConnections) {
      await this.githubConnections.saveConnection(record);
      counts.githubConnections++;
    }
    return counts;
  }

  private async upsertAssistantRun(run: AssistantRunRecord, outboxEvents: OutboxEventRecord[]) {
    const expectedRequest = {
      roomId: run.roomId,
      modelId: run.modelId,
      apiModel: run.apiModel,
      provider: run.provider,
    };
    const existingRequest = decodeAssistantRunRequestPayload(run.requestPayload, expectedRequest);
    const legacyRequestEvent = outboxEvents
      .filter(event => (
        event.eventType === 'ai.run_requested'
        && event.aggregateType === 'assistant_run'
        && event.aggregateId === run.id
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const legacyModel: AIModelOption = {
      id: run.modelId,
      apiModel: run.apiModel,
      provider: run.provider,
      label: run.modelId,
      description: 'Model snapshot recovered from the legacy Redis assistant run',
    };
    const recoveredRequest = existingRequest || decodeAssistantRunRequestPayload({
      schemaVersion: 1,
      model: legacyModel,
      roleName: run.roleName || 'AI Assistant',
      systemPrompt: run.systemPrompt
        ?? 'You are a helpful, creative, friendly assistant. Respond concisely and clearly.',
      contextMessages: legacyRequestEvent?.payload.contextMessages,
    }, expectedRequest);

    const messageExists = await this.pool.query<{ id: string }>(
      `SELECT id FROM room_messages WHERE room_id = $1 AND id = $2`,
      [run.roomId, run.aiMessageId],
    );
    let runMessage: Message | undefined;
    if (messageExists.rows[0]) {
      runMessage = (await this.store.readMessagesByRoom(run.roomId))
        .find(message => message.id === run.aiMessageId);
      if (!runMessage) {
        throw new Error(`Unable to read imported assistant message ${run.roomId}/${run.aiMessageId}`);
      }
    }

    const existingTerminal = decodeAssistantRunTerminalPayload(run.terminalPayload, {
      roomId: run.roomId,
      messageId: run.aiMessageId,
    });
    const recoveredTerminal = existingTerminal || (
      (run.status === 'complete' || run.status === 'error') && runMessage?.messageType === 'ai'
        ? decodeAssistantRunTerminalPayload({
            schemaVersion: 1,
            outcome: run.status,
            ...(run.status === 'error'
              ? { error: run.error || 'Legacy assistant run failed' }
              : {}),
            ...(run.metadata && typeof run.metadata === 'object' && !Array.isArray(run.metadata)
              ? { metadata: run.metadata }
              : {}),
            message: {
              ...runMessage,
              status: run.status,
              isError: run.status === 'error',
            },
          }, {
            roomId: run.roomId,
            messageId: run.aiMessageId,
          })
        : null
    );

    const sourceWasActive = run.status === 'queued' || run.status === 'running' || run.status === 'finalizing';
    const hasStreamingPlaceholder = runMessage?.messageType === 'ai' && runMessage.status === 'streaming';
    let status: AssistantRunRecord['status'];
    let error = run.error;
    if (run.status === 'finalizing' && recoveredRequest && recoveredTerminal && hasStreamingPlaceholder) {
      status = 'finalizing';
    } else if ((run.status === 'queued' || run.status === 'running') && recoveredRequest && hasStreamingPlaceholder) {
      status = 'queued';
      error = undefined;
    } else if ((run.status === 'complete' || run.status === 'error') && recoveredTerminal) {
      status = run.status;
    } else if (run.status === 'cancelled') {
      status = 'cancelled';
    } else {
      status = 'cancelled';
      error = recoveredRequest
        ? 'Legacy assistant run has no matching streaming AI placeholder'
        : 'Legacy assistant run has no recoverable request snapshot';
    }

    const importedAt = new Date().toISOString();
    const normalized: AssistantRunRecord = {
      ...run,
      status,
      ...(error ? { error } : { error: undefined }),
      updatedAt: run.updatedAt || importedAt,
      ...(status === 'complete' || status === 'error' || status === 'cancelled'
        ? { completedAt: run.completedAt || importedAt }
        : { completedAt: undefined }),
      ...(recoveredRequest ? { requestPayload: recoveredRequest } : { requestPayload: undefined }),
      ...(recoveredTerminal ? { terminalPayload: recoveredTerminal } : { terminalPayload: undefined }),
      generation: Number.isSafeInteger(run.generation) && run.generation >= 0 ? run.generation : 0,
      attempt: Number.isSafeInteger(run.attempt) && run.attempt >= 0 ? run.attempt : 0,
      availableAt: run.availableAt || run.queuedAt || importedAt,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO assistant_runs (
          id, room_id, requested_by_client_id, user_message_id, ai_message_id, status,
          model_id, api_model, provider, role_name, system_prompt, max_context_messages,
          retry_for_message_id, edited_message_id, error, metadata, created_at, queued_at,
          started_at, completed_at, updated_at, request_payload, terminal_payload, generation,
          attempt, available_at, lease_owner, lease_expires_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,
          $22::jsonb,$23::jsonb,$24,$25,$26,$27,$28
        ) ON CONFLICT (id) DO NOTHING`,
        [
          normalized.id,
          normalized.roomId,
          normalized.requestedByClientId,
          normalized.userMessageId || null,
          normalized.aiMessageId,
          normalized.status,
          normalized.modelId,
          normalized.apiModel,
          normalized.provider,
          normalized.roleName || null,
          normalized.systemPrompt || null,
          normalized.maxContextMessages ?? null,
          normalized.retryForMessageId || null,
          normalized.editedMessageId || null,
          normalized.error || null,
          normalized.metadata ? JSON.stringify(normalized.metadata) : null,
          normalized.createdAt,
          normalized.queuedAt,
          normalized.startedAt || null,
          normalized.completedAt || null,
          normalized.updatedAt,
          normalized.requestPayload ? JSON.stringify(normalized.requestPayload) : null,
          normalized.terminalPayload ? JSON.stringify(normalized.terminalPayload) : null,
          normalized.generation,
          normalized.attempt,
          normalized.availableAt,
          null,
          null,
        ],
      );
      if (normalized.status === 'queued' || normalized.status === 'finalizing') {
        await client.query(
          `INSERT INTO task_dispatch_outbox (run_id, status, available_at)
          VALUES ($1, 'pending', $2::timestamptz)
          ON CONFLICT (run_id) DO NOTHING`,
          [normalized.id, normalized.availableAt],
        );
      }
      if (sourceWasActive && status === 'cancelled' && hasStreamingPlaceholder) {
        await client.query(
          `UPDATE room_messages
          SET status = 'error',
            content = $3,
            timestamp = clock_timestamp(),
            updated_at = clock_timestamp(),
            is_error = TRUE,
            ai_stream_owner_id = NULL
          WHERE room_id = $1
            AND id = $2
            AND status = 'streaming'`,
          [run.roomId, run.aiMessageId, error || 'Legacy assistant run could not be resumed'],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertOutboxEvent(event: OutboxEventRecord) {
    const retiredAssistantJob = event.eventType === 'ai.run_requested'
      && event.aggregateType === 'assistant_run';
    const importedAt = new Date().toISOString();
    const normalized = retiredAssistantJob
      ? {
          ...event,
          status: 'processed' as const,
          lockedAt: undefined,
          lockedBy: undefined,
          processedAt: event.processedAt || importedAt,
          lastError: 'Execution ownership migrated to assistant_runs during Redis import',
          updatedAt: importedAt,
        }
      : event;
    await this.pool.query(
      `INSERT INTO outbox_events (
        id,event_type,aggregate_type,aggregate_id,room_id,payload,status,attempts,available_at,
        locked_at,locked_by,processed_at,last_error,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET
        payload=EXCLUDED.payload,status=EXCLUDED.status,attempts=EXCLUDED.attempts,
        available_at=EXCLUDED.available_at,locked_at=EXCLUDED.locked_at,locked_by=EXCLUDED.locked_by,
        processed_at=EXCLUDED.processed_at,last_error=EXCLUDED.last_error,updated_at=EXCLUDED.updated_at`,
      [normalized.id, normalized.eventType, normalized.aggregateType, normalized.aggregateId,
        normalized.roomId || null, normalized.payload, normalized.status, normalized.attempts,
        normalized.availableAt, normalized.lockedAt || null, normalized.lockedBy || null,
        normalized.processedAt || null, normalized.lastError || null, normalized.createdAt, normalized.updatedAt]
    );
  }

  private async upsertPushSubscription(record: PushSubscriptionRecord) {
    await this.pool.query(
      `INSERT INTO push_subscriptions (endpoint,client_id,browser_instance_id,p256dh,auth,user_agent,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (endpoint) DO UPDATE SET client_id=EXCLUDED.client_id,browser_instance_id=EXCLUDED.browser_instance_id,
        p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,user_agent=EXCLUDED.user_agent,updated_at=EXCLUDED.updated_at`,
      [record.endpoint, record.clientId, record.browserInstanceId || null, record.p256dh, record.auth,
        record.userAgent || null, record.createdAt, record.updatedAt]
    );
  }

  private async upsertAccount(account: ClientAccount, linkedClientIds: string[]) {
    await this.pool.query(
      `INSERT INTO accounts (id,primary_client_id,display_name,avatar_url,created_at,updated_at,last_login_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,avatar_url=EXCLUDED.avatar_url,
        updated_at=EXCLUDED.updated_at,last_login_at=EXCLUDED.last_login_at`,
      [account.accountId, account.primaryClientId, account.displayName || null, account.avatarUrl || null,
        account.createdAt, account.updatedAt, account.lastLoginAt || null]
    );
    await this.pool.query(
      `INSERT INTO account_identities (account_id,provider,provider_subject,email,email_verified,created_at,updated_at)
      VALUES ($1,'google',$2,$3,$4,$5,$6)
      ON CONFLICT (provider,provider_subject) DO UPDATE SET email=EXCLUDED.email,
        email_verified=EXCLUDED.email_verified,updated_at=EXCLUDED.updated_at`,
      [account.accountId, account.providerSubject, account.email || null, Boolean(account.emailVerified),
        account.createdAt, account.updatedAt]
    );
    for (const clientId of linkedClientIds) {
      await this.pool.query(
        `INSERT INTO client_account_links (client_id,account_id,linked_at) VALUES ($1,$2,$3)
        ON CONFLICT (client_id) DO UPDATE SET account_id=EXCLUDED.account_id`,
        [clientId, account.accountId, account.createdAt]
      );
    }
  }

  private async upsertClientAuthToken(token: MigratedClientAuthToken) {
    await this.pool.query(
      `INSERT INTO client_auth_tokens (token_hash,client_id,account_id,auth_method,created_at,last_used_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (token_hash) DO UPDATE SET client_id=EXCLUDED.client_id,account_id=EXCLUDED.account_id,
        auth_method=EXCLUDED.auth_method,last_used_at=EXCLUDED.last_used_at,expires_at=EXCLUDED.expires_at`,
      [token.tokenHash, token.clientId, token.accountId || null, token.authMethod || null,
        token.createdAt, token.lastUsedAt || token.createdAt, token.expiresAt || null]
    );
  }

  private async upsertClientPassword(clientId: string, passwordHash: string) {
    await this.pool.query(
      `INSERT INTO client_passwords (client_id,password_hash,created_at,updated_at) VALUES ($1,$2,NOW(),NOW())
      ON CONFLICT (client_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,updated_at=EXCLUDED.updated_at`,
      [clientId, passwordHash]
    );
  }

  private async upsertClientNickname(clientId: string, nickname: string) {
    await this.pool.query(
      `INSERT INTO client_profiles (client_id,nickname,updated_at) VALUES ($1,$2,NOW())
      ON CONFLICT (client_id) DO UPDATE SET nickname=EXCLUDED.nickname,updated_at=EXCLUDED.updated_at`,
      [clientId, nickname]
    );
  }
}

const hasArg = (name: string) => process.argv.slice(2).includes(name);

async function main() {
  const logger = new Logger('RedisToPostgresMigration');
  const dryRun = hasArg('--dry-run');
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const databaseUrl = process.env.DATABASE_URL;

  if (!dryRun && !databaseUrl) {
    throw new Error('DATABASE_URL is required unless --dry-run is used');
  }

  const redisClient: RedisClientType = createClient({ url: redisUrl });
  let postgresPool: PostgresPool | undefined;
  let postgresStore: PostgresStore | undefined;

  await redisClient.connect();
  try {
    if (!dryRun) {
      postgresPool = createPostgresPool(databaseUrl!, logger);
      postgresStore = new PostgresStore(postgresPool, logger);
      await postgresStore.initializeSchema();
    }

    const stats = await migrateRedisToPostgres({
      source: new RedisMigrationSource(redisClient, logger),
      target: postgresStore && postgresPool ? new PostgresMigrationTarget(postgresPool, postgresStore) : undefined,
      dryRun,
      logger,
    });

    logger.info('Redis to PostgreSQL migration finished', stats);
    if (stats.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await redisClient.quit();
    await postgresPool?.end?.();
  }
}

if (require.main === module) {
  main().catch(error => {
    const logger = new Logger('RedisToPostgresMigration');
    logger.error('Redis to PostgreSQL migration failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
