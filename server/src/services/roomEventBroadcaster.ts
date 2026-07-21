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
  authorizeLocalRoom?: (roomId: string) => Promise<void>;
  emit: (event: RoomEventBroadcast) => void;
}

interface PendingRoomBroadcast {
  minSeq: number;
  maxSeq: number;
  waiters: Array<() => void>;
}

export interface RoomEventBroadcasterMetrics {
  pendingRooms: number;
  activeRooms: number;
  coalescedNotifications: number;
  broadcastBatches: number;
  fastPathEvents: number;
  fastPathBytes: number;
  headOnlyBroadcasts: number;
  maxPendingSequenceSpan: number;
}

export class RoomEventBroadcaster {
  private readonly pendingRooms = new Map<string, PendingRoomBroadcast>();
  private readonly activeRooms = new Set<string>();
  private readonly metrics = {
    coalescedNotifications: 0,
    broadcastBatches: 0,
    fastPathEvents: 0,
    fastPathBytes: 0,
    headOnlyBroadcasts: 0,
    maxPendingSequenceSpan: 0,
  };

  constructor(private readonly options: RoomEventBroadcasterOptions) {}

  handle(event: RoomEventAvailable): Promise<void> {
    return new Promise(resolve => {
      const pending = this.pendingRooms.get(event.roomId);
      if (pending) {
        pending.minSeq = Math.min(pending.minSeq, event.headSeq);
        pending.maxSeq = Math.max(pending.maxSeq, event.headSeq);
        pending.waiters.push(resolve);
        this.metrics.coalescedNotifications += 1;
        this.metrics.maxPendingSequenceSpan = Math.max(
          this.metrics.maxPendingSequenceSpan,
          pending.maxSeq - pending.minSeq + 1,
        );
      } else {
        this.pendingRooms.set(event.roomId, {
          minSeq: event.headSeq,
          maxSeq: event.headSeq,
          waiters: [resolve],
        });
      }

      if (!this.activeRooms.has(event.roomId)) {
        this.activeRooms.add(event.roomId);
        void this.drainRoom(event.roomId);
      }
    });
  }

  getMetrics(): RoomEventBroadcasterMetrics {
    return {
      pendingRooms: this.pendingRooms.size,
      activeRooms: this.activeRooms.size,
      ...this.metrics,
    };
  }

  private async drainRoom(roomId: string): Promise<void> {
    try {
      while (true) {
        const pending = this.pendingRooms.get(roomId);
        if (!pending) return;
        this.pendingRooms.delete(roomId);
        this.metrics.broadcastBatches += 1;
        try {
          await this.broadcastRange(roomId, pending.minSeq, pending.maxSeq);
        } catch (error) {
          this.options.logger.warn('Failed to broadcast committed room event payload', {
            error,
            roomId,
            minSeq: pending.minSeq,
            headSeq: pending.maxSeq,
          });
          this.emitHeadOnly({ roomId, headSeq: pending.maxSeq });
        } finally {
          pending.waiters.forEach(resolve => resolve());
        }
      }
    } finally {
      this.activeRooms.delete(roomId);
    }
  }

  private emitHeadOnly(event: RoomEventAvailable): void {
    this.metrics.headOnlyBroadcasts += 1;
    try {
      this.options.emit(event);
    } catch (error) {
      this.options.logger.error('Failed to broadcast room event head fallback', {
        error,
        roomId: event.roomId,
        headSeq: event.headSeq,
      });
    }
  }

  private async broadcastRange(roomId: string, minSeq: number, headSeq: number): Promise<void> {
    const event = { roomId, headSeq };
    if (!this.options.store.readRoomEvent && !this.options.store.readRoomEvents) {
      this.emitHeadOnly(event);
      return;
    }

    let committedEvents: RoomEvent[] = [];
    if (this.options.store.readRoomEvents) {
      const page = await this.options.store.readRoomEvents(roomId, {
        afterSeq: minSeq - 1,
        limit: Math.max(1, headSeq - minSeq + 1),
        maxBytes: Math.max(16 * 1024, this.options.maxPayloadBytes),
      });
      committedEvents = page.events.filter(candidate => candidate.seq >= minSeq && candidate.seq <= headSeq);
    } else if (minSeq === headSeq && this.options.store.readRoomEvent) {
      const committedEvent = await this.options.store.readRoomEvent(roomId, headSeq);
      if (committedEvent) committedEvents = [committedEvent];
    }

    const completeRange = committedEvents.length === headSeq - minSeq + 1
      && committedEvents.every((candidate, index) => candidate.seq === minSeq + index);
    if (!completeRange) {
      this.emitHeadOnly(event);
      return;
    }

    const fastPath: RoomEventBroadcast = { ...event, events: committedEvents };
    const payloadBytes = Buffer.byteLength(JSON.stringify(fastPath), 'utf8');
    if (payloadBytes > this.options.maxPayloadBytes) {
      this.emitHeadOnly(event);
      return;
    }

    await this.options.authorizeLocalRoom?.(roomId);
    this.metrics.fastPathEvents += committedEvents.length;
    this.metrics.fastPathBytes += payloadBytes;
    this.options.emit(fastPath);
  }
}
