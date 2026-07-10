import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { RoomStore } from '../repositories/store';
import { Message } from '../types';
import { CodeAgentRunnerMode } from './codeAgentRunnerProtocol';
import { normalizeCodeAgentMode } from './codeAgentModes';
import { canUseCodeAgentRoom } from './codeAgentRoomAccess';

export const CODE_AGENT_ROOM_CONTEXT_API_PREFIX = '/api/code-agent/room-context';
export const DEFAULT_ROOM_CONTEXT_TOKEN_TTL_SECONDS = 30 * 60;
export const DEFAULT_ROOM_CONTEXT_LIMIT = 20;
export const MAX_ROOM_CONTEXT_LIMIT = 100;
export const MAX_ROOM_CONTEXT_MESSAGE_CHARS = 20_000;
export const MAX_ROOM_CONTEXT_SEARCH_SCAN = 5_000;

export interface CodeAgentRoomContextTokenClaims {
  v: 1;
  jti: string;
  roomId: string;
  clientId: string;
  turnId: string;
  mode: CodeAgentRunnerMode;
  exp: number;
}

export interface CodeAgentRoomContextMessage {
  id: string;
  type: Message['messageType'];
  content: string;
  timestamp: string;
  updatedAt?: string;
  sender: {
    id: string;
    name?: string;
  };
  status?: Message['status'];
  replyTo?: Message['replyTo'];
  tool?: {
    callId?: string;
    name?: string;
    exitCode?: number;
    isError?: boolean;
  };
  media?: {
    kind: string;
    mimeType: string;
    filename?: string;
  };
}

export class CodeAgentRoomContextError extends Error {
  constructor(message: string, public readonly statusCode = 400, public readonly code = 'room_context_error') {
    super(message);
    this.name = 'CodeAgentRoomContextError';
  }
}

export interface CodeAgentRoomContextServiceOptions {
  tokenSecret: string;
  tokenTtlSeconds?: number;
  nowMs?: () => number;
  createId?: () => string;
}

const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const decode = (value: string) => Buffer.from(value, 'base64url').toString('utf8');
const stableJson = (value: Record<string, unknown>) => JSON.stringify(value, Object.keys(value).sort());
const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const normalizeLimit = (value?: number) => {
  if (!Number.isFinite(value)) return DEFAULT_ROOM_CONTEXT_LIMIT;
  return Math.max(1, Math.min(MAX_ROOM_CONTEXT_LIMIT, Math.floor(value!)));
};

const truncate = (value: string) => value.length > MAX_ROOM_CONTEXT_MESSAGE_CHARS
  ? `${value.slice(0, MAX_ROOM_CONTEXT_MESSAGE_CHARS)}\n...[truncated]`
  : value;

export const projectRoomContextMessage = (message: Message): CodeAgentRoomContextMessage | null => {
  if (message.status === 'streaming') return null;
  const projected: CodeAgentRoomContextMessage = {
    id: message.id,
    type: message.messageType,
    content: truncate(typeof message.content === 'string' ? message.content : ''),
    timestamp: message.timestamp,
    sender: {
      id: message.clientId,
      ...(message.username ? { name: message.username } : {}),
    },
    ...(message.updatedAt ? { updatedAt: message.updatedAt } : {}),
    ...(message.status ? { status: message.status } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
  if (message.messageType === 'tool_call' || message.messageType === 'tool_result') {
    projected.tool = {
      ...(message.toolCallId ? { callId: message.toolCallId } : {}),
      ...(message.toolName ? { name: message.toolName } : {}),
      ...(typeof message.exitCode === 'number' ? { exitCode: message.exitCode } : {}),
      ...(message.isError || message.status === 'error' ? { isError: true } : {}),
    };
  }
  if (message.mediaAsset) {
    projected.media = {
      kind: message.mediaAsset.kind,
      mimeType: message.mediaAsset.mimeType,
      ...(message.mediaAsset.filename ? { filename: message.mediaAsset.filename } : {}),
    };
  }
  return projected;
};

export class CodeAgentRoomContextService {
  private readonly nowMs: () => number;
  private readonly createId: () => string;
  private readonly tokenTtlSeconds: number;

  constructor(private readonly store: RoomStore, private readonly options: CodeAgentRoomContextServiceOptions) {
    this.nowMs = options.nowMs || (() => Date.now());
    this.createId = options.createId || (() => randomUUID());
    this.tokenTtlSeconds = options.tokenTtlSeconds || DEFAULT_ROOM_CONTEXT_TOKEN_TTL_SECONDS;
  }

  issueTurnToken(input: { roomId: string; clientId: string; turnId: string; mode: CodeAgentRunnerMode }) {
    const claims: CodeAgentRoomContextTokenClaims = {
      v: 1,
      jti: this.createId(),
      roomId: input.roomId,
      clientId: input.clientId,
      turnId: input.turnId,
      mode: input.mode,
      exp: Math.floor(this.nowMs() / 1000) + this.tokenTtlSeconds,
    };
    const payload = encode(stableJson(claims as unknown as Record<string, unknown>));
    return `${payload}.${sign(payload, this.options.tokenSecret)}`;
  }

  verifyTurnToken(token: string): CodeAgentRoomContextTokenClaims | null {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined || !safeEqual(signature, sign(payload, this.options.tokenSecret))) {
      return null;
    }
    try {
      const claims = JSON.parse(decode(payload));
      if (
        !claims || typeof claims !== 'object' || claims.v !== 1 ||
        typeof claims.jti !== 'string' || typeof claims.roomId !== 'string' ||
        typeof claims.clientId !== 'string' || typeof claims.turnId !== 'string' ||
        !normalizeCodeAgentMode(claims.mode) || typeof claims.exp !== 'number' ||
        claims.exp <= Math.floor(this.nowMs() / 1000)
      ) {
        return null;
      }
      return claims as CodeAgentRoomContextTokenClaims;
    } catch {
      return null;
    }
  }

  async history(claims: CodeAgentRoomContextTokenClaims, input: { limit?: number; beforeMessageId?: string }) {
    await this.assertRoomAccess(claims);
    const page = await this.store.readMessagePageByRoom(claims.roomId, {
      limit: normalizeLimit(input.limit),
      beforeMessageId: input.beforeMessageId,
    });
    const messages = page.messages.map(projectRoomContextMessage).filter((message): message is CodeAgentRoomContextMessage => Boolean(message));
    return {
      roomId: claims.roomId,
      messages,
      hasMore: page.hasMore,
      oldestMessageId: messages[0]?.id,
      historyVersion: page.historyVersion,
    };
  }

  async delta(claims: CodeAgentRoomContextTokenClaims, input: { sinceMessageId: string; limit?: number }) {
    await this.assertRoomAccess(claims);
    const all = await this.store.readMessagesByRoom(claims.roomId);
    const cursorIndex = all.findIndex(message => message.id === input.sinceMessageId);
    if (cursorIndex < 0) {
      throw new CodeAgentRoomContextError('The since message was not found in this room', 404, 'message_not_found');
    }
    const limit = normalizeLimit(input.limit);
    const projected = all.slice(cursorIndex + 1).map(projectRoomContextMessage).filter((message): message is CodeAgentRoomContextMessage => Boolean(message));
    const messages = projected.slice(0, limit);
    return {
      roomId: claims.roomId,
      sinceMessageId: input.sinceMessageId,
      messages,
      hasMore: projected.length > messages.length,
      nextMessageId: messages.at(-1)?.id || input.sinceMessageId,
    };
  }

  async search(claims: CodeAgentRoomContextTokenClaims, input: { query: string; limit?: number }) {
    await this.assertRoomAccess(claims);
    const query = input.query.trim().toLocaleLowerCase();
    if (!query) throw new CodeAgentRoomContextError('Search query is required', 400, 'query_required');
    const limit = normalizeLimit(input.limit);
    const all = await this.store.readMessagesByRoom(claims.roomId);
    const messages: CodeAgentRoomContextMessage[] = [];
    for (const raw of all.slice(-MAX_ROOM_CONTEXT_SEARCH_SCAN).reverse()) {
      const message = projectRoomContextMessage(raw);
      if (!message) continue;
      const haystack = [message.content, message.sender.name, message.tool?.name].filter(Boolean).join('\n').toLocaleLowerCase();
      if (haystack.includes(query)) messages.push(message);
      if (messages.length > limit) break;
    }
    return {
      roomId: claims.roomId,
      query: input.query.trim(),
      messages: messages.slice(0, limit),
      hasMore: messages.length > limit,
    };
  }

  async message(claims: CodeAgentRoomContextTokenClaims, messageId: string) {
    await this.assertRoomAccess(claims);
    const all = await this.store.readMessagesByRoom(claims.roomId);
    const found = all.find(message => message.id === messageId);
    const projected = found ? projectRoomContextMessage(found) : null;
    if (!projected) throw new CodeAgentRoomContextError('Message not found', 404, 'message_not_found');
    return { roomId: claims.roomId, message: projected };
  }

  private async assertRoomAccess(claims: CodeAgentRoomContextTokenClaims) {
    const room = await this.store.getRoomById(claims.roomId);
    if (!room) {
      throw new CodeAgentRoomContextError('Room not found', 404, 'room_not_found');
    }
    const role = room.creatorId === claims.clientId
      ? 'owner'
      : (await this.store.getRoomMember(claims.roomId, claims.clientId))?.role || null;
    if (!canUseCodeAgentRoom(room, claims.clientId, role)) {
      throw new CodeAgentRoomContextError('Room context access has been revoked', 403, 'room_access_revoked');
    }
  }
}

export const createCodeAgentRoomContextServiceFromEnv = (store: RoomStore, env: NodeJS.ProcessEnv = process.env) => {
  const tokenSecret = (
    env.CODE_AGENT_ROOM_CONTEXT_TOKEN_SECRET ||
    env.CODE_AGENT_STATIC_PUBLISH_TOKEN_SECRET ||
    env.CODE_AGENT_MODEL_GATEWAY_SECRET ||
    randomUUID()
  ).trim();
  return new CodeAgentRoomContextService(store, {
    tokenSecret,
    tokenTtlSeconds: Number(env.CODE_AGENT_ROOM_CONTEXT_TOKEN_TTL_SECONDS) || DEFAULT_ROOM_CONTEXT_TOKEN_TTL_SECONDS,
  });
};
