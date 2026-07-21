import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { RoomEvent } from '../types';
import { RoomEventAvailable } from './roomEventNotifier';
import type { Server } from 'socket.io';

export interface RoomEventBroadcast extends RoomEventAvailable {
  events?: RoomEvent[];
}

export interface RoomSyncRequired {
  reason: 'postgres_listener_reconnected';
}

export const emitRoomEventLocally = (
  io: Pick<Server, 'local'>,
  event: RoomEventBroadcast,
) => io.local.to(event.roomId).emit('room_event_available', event);

export const emitRoomSyncRequiredLocally = (
  io: Pick<Server, 'local'>,
  event: RoomSyncRequired,
) => io.local.emit('room_sync_required', event);

interface RoomEventBroadcasterOptions {
  store: RoomStore;
  logger: Logger;
  maxPayloadBytes: number;
  emit: (event: RoomEventBroadcast) => void;
}

export class RoomEventBroadcaster {
  private readonly roomQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: RoomEventBroadcasterOptions) {}

  handle(event: RoomEventAvailable): Promise<void> {
    const previous = this.roomQueues.get(event.roomId) || Promise.resolve();
    const queued = previous
      .then(() => this.broadcast(event))
      .catch(error => {
        this.options.logger.warn('Failed to broadcast committed room event payload', {
          error,
          roomId: event.roomId,
          headSeq: event.headSeq,
        });
        try {
          this.options.emit(event);
        } catch (fallbackError) {
          this.options.logger.error('Failed to broadcast room event head fallback', {
            error: fallbackError,
            roomId: event.roomId,
            headSeq: event.headSeq,
          });
        }
      });
    this.roomQueues.set(event.roomId, queued);
    void queued.finally(() => {
      if (this.roomQueues.get(event.roomId) === queued) {
        this.roomQueues.delete(event.roomId);
      }
    });
    return queued;
  }

  private async broadcast(event: RoomEventAvailable): Promise<void> {
    if (!this.options.store.readRoomEvent && !this.options.store.readRoomEvents) {
      this.options.emit(event);
      return;
    }

    const committedEvent = this.options.store.readRoomEvent
      ? await this.options.store.readRoomEvent(event.roomId, event.headSeq)
      : (await this.options.store.readRoomEvents!(event.roomId, {
          afterSeq: event.headSeq - 1,
          limit: 1,
          maxBytes: Math.max(16 * 1024, this.options.maxPayloadBytes),
        })).events.find(candidate => candidate.seq === event.headSeq);
    if (!committedEvent) {
      this.options.emit(event);
      return;
    }

    const fastPath: RoomEventBroadcast = {
      ...event,
      events: [committedEvent],
    };
    if (Buffer.byteLength(JSON.stringify(fastPath), 'utf8') > this.options.maxPayloadBytes) {
      this.options.emit(event);
      return;
    }
    this.options.emit(fastPath);
  }
}
