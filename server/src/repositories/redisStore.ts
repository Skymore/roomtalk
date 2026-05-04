import { customAlphabet } from 'nanoid';
import { RedisClientType } from 'redis';
import { Logger } from '../logger';
import { AICost, Message, Room, RoomAICostTotal } from '../types';

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 10);

export class RedisStore {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly logger: Logger
  ) {}

  async generateUniqueRoomId(): Promise<string> {
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      const id = nanoid();
      const exists = await this.redisClient.hExists('rooms', id);
      if (!exists) {
        return id;
      }
      attempts++;
      this.logger.debug('Room ID collision detected, retrying', { attempt: attempts, maxAttempts });
    }

    this.logger.warn('Multiple collisions detected, using longer ID');
    attempts = 0;
    while (attempts < maxAttempts) {
      const id = nanoid(12);
      const exists = await this.redisClient.hExists('rooms', id);
      if (!exists) {
        return id;
      }
      attempts++;
      this.logger.debug('Long room ID collision detected, retrying', { attempt: attempts, maxAttempts });
    }

    this.logger.warn('Multiple long room ID collisions detected, using extra-long ID');
    return nanoid(16);
  }

  async appendMessage(message: Message): Promise<void> {
    try {
      await this.redisClient.rPush(`room:${message.roomId}:messages`, JSON.stringify(message));
      this.logger.debug('Message appended to Redis list', { messageId: message.id, roomId: message.roomId });
    } catch (error) {
      this.logger.error('Error appending message to Redis', { error, messageId: message.id, roomId: message.roomId });
    }
  }

  async saveMessageHistory(roomId: string, messages: Message[]): Promise<void> {
    try {
      const messageKey = `room:${roomId}:messages`;
      await this.redisClient.del(messageKey);
      if (messages.length > 0) {
        const messageStrings = messages.map(message => JSON.stringify(message));
        await this.redisClient.rPush(messageKey, messageStrings);
      }
      this.logger.debug('Message history saved/overwritten to Redis', { roomId, count: messages.length });
    } catch (error) {
      this.logger.error('Error saving message history to Redis', { error, roomId });
    }
  }

  async clearRoomMessages(roomId: string): Promise<number> {
    return this.redisClient.del(`room:${roomId}:messages`);
  }

  async readMessagesByRoom(roomId: string): Promise<Message[]> {
    try {
      const messages = await this.redisClient.lRange(`room:${roomId}:messages`, 0, -1);
      this.logger.debug('Messages read from Redis', { roomId, count: messages.length });
      return messages.map((message: string) => JSON.parse(message));
    } catch (error) {
      this.logger.error('Error reading messages from Redis', { error, roomId });
      return [];
    }
  }

  getRoomAICostKey(roomId: string): string {
    return `room:${roomId}:ai_cost_total_usd`;
  }

  async readRoomAICost(roomId: string): Promise<RoomAICostTotal> {
    try {
      const total = await this.redisClient.get(this.getRoomAICostKey(roomId));
      const totalUsd = Number.parseFloat(total || '0');

      return {
        roomId,
        currency: 'USD',
        totalUsd: Number.isFinite(totalUsd) ? totalUsd : 0,
      };
    } catch (error) {
      this.logger.error('Error reading room AI cost total', { error, roomId });
      return { roomId, currency: 'USD', totalUsd: 0 };
    }
  }

  async incrementRoomAICost(roomId: string, cost: AICost | null): Promise<RoomAICostTotal> {
    if (!cost || !Number.isFinite(cost.totalUsd) || cost.totalUsd <= 0) {
      return this.readRoomAICost(roomId);
    }

    try {
      const total = await this.redisClient.incrByFloat(this.getRoomAICostKey(roomId), cost.totalUsd);
      const totalUsd = typeof total === 'number' ? total : Number.parseFloat(String(total));
      return {
        roomId,
        currency: 'USD',
        totalUsd: Number.isFinite(totalUsd) ? totalUsd : cost.totalUsd,
      };
    } catch (error) {
      this.logger.error('Error incrementing room AI cost total', { error, roomId, cost });
      return this.readRoomAICost(roomId);
    }
  }

  async saveRoom(room: Room): Promise<Room | null> {
    try {
      await this.redisClient.hSet('rooms', room.id, JSON.stringify(room));
      await this.redisClient.sAdd(`user:${room.creatorId}:rooms`, room.id);
      this.logger.debug('Room saved to Redis', { roomId: room.id, creatorId: room.creatorId });
      return room;
    } catch (error) {
      this.logger.error('Error saving room to Redis', { error, roomId: room.id });
      return null;
    }
  }

  async readRoomsByUser(clientId: string): Promise<Room[]> {
    try {
      const roomIds = await this.redisClient.sMembers(`user:${clientId}:rooms`);
      const rooms = await Promise.all(
        roomIds.map((id: string) => this.redisClient.hGet('rooms', id))
      );
      this.logger.debug('Rooms read by user from Redis', { clientId, count: roomIds.length });
      return rooms.filter(room => room).map((room: string | undefined) => JSON.parse(room!));
    } catch (error) {
      this.logger.error('Error reading rooms for user from Redis', { error, clientId });
      return [];
    }
  }

  async getRoomById(roomId: string): Promise<Room | null> {
    try {
      const roomStr = await this.redisClient.hGet('rooms', roomId);
      this.logger.debug('Room read by ID from Redis', { roomId, found: !!roomStr });
      return roomStr ? JSON.parse(roomStr) : null;
    } catch (error) {
      this.logger.error('Error reading room by id from Redis', { error, roomId });
      return null;
    }
  }

  async updateRoomMemberCount(roomId: string, clientId: string, isJoining: boolean): Promise<number> {
    try {
      const roomMembersKey = `room:${roomId}:members`;

      if (isJoining) {
        await this.redisClient.sAdd(roomMembersKey, clientId);
      } else {
        await this.redisClient.sRem(roomMembersKey, clientId);
      }

      return await this.redisClient.sCard(roomMembersKey);
    } catch (error) {
      this.logger.error('Error updating room member count', { error, roomId, clientId, isJoining });
      return 0;
    }
  }

  async getRoomMemberCount(roomId: string): Promise<number> {
    try {
      return await this.redisClient.sCard(`room:${roomId}:members`);
    } catch (error) {
      this.logger.error('Error getting room member count', { error, roomId });
      return 0;
    }
  }

  async storeClientSession(socketId: string, userId: string): Promise<void> {
    try {
      await this.redisClient.hSet('socket:clients', socketId, userId);
    } catch (error) {
      this.logger.error('Error storing client session', { error, socketId, userId });
    }
  }

  async getClientId(socketId: string): Promise<string | null> {
    try {
      const clientId = await this.redisClient.hGet('socket:clients', socketId);
      return clientId || null;
    } catch (error) {
      this.logger.error('Error getting client ID', { error, socketId });
      return null;
    }
  }

  async removeClientSession(socketId: string): Promise<void> {
    try {
      await this.redisClient.hDel('socket:clients', socketId);
    } catch (error) {
      this.logger.error('Error removing client session', { error, socketId });
    }
  }

  async storeUserRooms(socketId: string, roomIds: string[]): Promise<void> {
    try {
      if (roomIds.length > 0) {
        await this.redisClient.hSet('socket:rooms', socketId, JSON.stringify(roomIds));
      } else {
        await this.redisClient.hDel('socket:rooms', socketId);
      }
    } catch (error) {
      this.logger.error('Error storing user rooms', { error, socketId, roomIds });
    }
  }

  async getUserRooms(socketId: string): Promise<string[]> {
    try {
      const roomsJson = await this.redisClient.hGet('socket:rooms', socketId);
      return roomsJson ? JSON.parse(roomsJson) : [];
    } catch (error) {
      this.logger.error('Error getting user rooms', { error, socketId });
      return [];
    }
  }

  async deleteRoom(roomId: string, creatorId: string): Promise<void> {
    try {
      await Promise.all([
        this.redisClient.hDel('rooms', roomId),
        this.redisClient.del(`room:${roomId}:messages`),
        this.redisClient.del(this.getRoomAICostKey(roomId)),
        this.redisClient.del(`room:${roomId}:members`),
        this.redisClient.sRem(`user:${creatorId}:rooms`, roomId),
      ]);
      this.logger.debug('Room deleted from Redis', { roomId, creatorId });
    } catch (error) {
      this.logger.error('Error deleting room from Redis', { error, roomId, creatorId });
    }
  }
}
