import { Logger } from '../logger';
import { Room, RoomSandboxStatus } from '../types';
import { CocoSandboxHandle, CocoSandboxService } from './cocoSandboxService';

export type EnsureCocoSandboxResult =
  | { ok: true; room: Room; handle: CocoSandboxHandle; created: boolean }
  | { ok: false; reason: 'missing_room' | 'not_coco_room' | 'forbidden' | 'creating' | 'limit_exceeded' | 'store_conflict' | 'sandbox_error'; room?: Room; error?: Error };

export interface CocoSandboxLifecycleOptions {
  sandboxTtlMs: number;
  turnTimeoutMs: number;
  creatingStaleMs: number;
  maxActiveSandboxes: number;
  maxActiveSandboxesPerUser: number;
  reconnectTimedOutSandboxes: boolean;
}

export interface CocoSandboxLifecycleStore {
  getRoomById(roomId: string): Promise<Room | null>;
  saveRoom(room: Room): Promise<Room | null>;
  compareAndSetRoomSandboxStatus(
    roomId: string,
    expectedStatuses: RoomSandboxStatus[],
    nextStatus: RoomSandboxStatus,
    updatedAt?: string
  ): Promise<Room | null>;
  findInterruptedCocoRooms(): Promise<Room[]>;
}

const defaultOptions: CocoSandboxLifecycleOptions = {
  sandboxTtlMs: 60 * 60 * 1000,
  turnTimeoutMs: 5 * 60 * 1000,
  creatingStaleMs: 2 * 60 * 1000,
  maxActiveSandboxes: Number.POSITIVE_INFINITY,
  maxActiveSandboxesPerUser: Number.POSITIVE_INFINITY,
  reconnectTimedOutSandboxes: false,
};

export class CocoSandboxLifecycleService {
  private readonly options: CocoSandboxLifecycleOptions;

  constructor(
    private readonly store: CocoSandboxLifecycleStore,
    private readonly sandboxService: CocoSandboxService,
    private readonly logger: Logger,
    options: Partial<CocoSandboxLifecycleOptions> = {},
    private readonly now: () => Date = () => new Date()
  ) {
    this.options = { ...defaultOptions, ...options };
  }

  async ensureReadySandbox(roomId: string, clientId: string): Promise<EnsureCocoSandboxResult> {
    const room = await this.store.getRoomById(roomId);
    if (!room) {
      return { ok: false, reason: 'missing_room' };
    }
    if (room.type !== 'coco') {
      return { ok: false, reason: 'not_coco_room', room };
    }
    const access = room.cocoAccess || 'owner';
    if (access === 'owner' && room.creatorId !== clientId) {
      return { ok: false, reason: 'forbidden', room };
    }

    if (this.isReadyAndUsable(room)) {
      try {
        const handle = await this.sandboxService.connect(room.sandboxId!);
        return { ok: true, room, handle: this.withRoomIdentity(handle, room), created: false };
      } catch (error) {
        await this.store.compareAndSetRoomSandboxStatus(room.id, ['ready'], 'expired', this.now().toISOString());
        this.logger.warn('Coco sandbox reconnect failed; marking sandbox expired', { roomId: room.id, sandboxId: room.sandboxId, error });
        return this.createSandbox(room);
      }
    }

    if (room.sandboxStatus === 'creating' && !this.isCreatingStale(room)) {
      return { ok: false, reason: 'creating', room };
    }
    if (room.sandboxStatus === 'creating') {
      await this.store.compareAndSetRoomSandboxStatus(room.id, ['creating'], 'error', this.now().toISOString());
    }
    if (room.sandboxStatus === 'ready' && room.sandboxId && !this.isReadyAndUsable(room)) {
      await this.store.compareAndSetRoomSandboxStatus(room.id, ['ready'], 'expired', this.now().toISOString());
    }

    return this.createSandbox(room);
  }

  async recoverInterruptedSandboxes(): Promise<number> {
    const rooms = await this.store.findInterruptedCocoRooms();
    let recovered = 0;
    const timestamp = this.now().toISOString();

    for (const room of rooms) {
      let currentRoom = room;
      let roomRecovered = false;

      if (room.sandboxStatus === 'creating') {
        const updatedRoom = await this.store.compareAndSetRoomSandboxStatus(room.id, ['creating'], 'error', timestamp);
        if (updatedRoom) {
          currentRoom = updatedRoom;
          roomRecovered = true;
        } else {
          currentRoom = await this.store.getRoomById(room.id) || room;
        }
      }

      if (currentRoom.cocoStatus === 'running') {
        const updatedRoom = await this.store.saveRoom({
          ...currentRoom,
          cocoStatus: 'error',
          sandboxUpdatedAt: currentRoom.sandboxUpdatedAt || timestamp,
        });
        if (updatedRoom) {
          roomRecovered = true;
        }
      }

      if (roomRecovered) {
        recovered++;
      }
    }

    if (recovered > 0) {
      this.logger.warn('Recovered interrupted Coco sandbox room states', { count: recovered });
    }
    return recovered;
  }

  async destroyRoomSandbox(roomId: string, clientId: string): Promise<{ destroyed: boolean; room: Room | null; error?: Error }> {
    const room = await this.store.getRoomById(roomId);
    if (!room || room.creatorId !== clientId || room.type !== 'coco' || !room.sandboxId || room.sandboxStatus === 'creating') {
      return { destroyed: false, room };
    }

    try {
      await this.sandboxService.destroy(room.sandboxId);
      await this.store.compareAndSetRoomSandboxStatus(room.id, ['ready', 'error', 'expired', 'none'], 'expired', this.now().toISOString());
      return { destroyed: true, room };
    } catch (error) {
      this.logger.error('Error destroying Coco sandbox', { error, roomId, sandboxId: room.sandboxId });
      return { destroyed: false, room, error: error as Error };
    }
  }

  private async createSandbox(room: Room): Promise<EnsureCocoSandboxResult> {
    const limitError = await this.checkActiveLimits(room.creatorId);
    if (limitError) {
      return { ok: false, reason: 'limit_exceeded', room, error: new Error(limitError) };
    }

    const lockedRoom = await this.store.compareAndSetRoomSandboxStatus(room.id, ['none', 'error', 'expired'], 'creating', this.now().toISOString());
    if (!lockedRoom) {
      return { ok: false, reason: 'store_conflict', room };
    }

    let handle: CocoSandboxHandle | null = null;
    try {
      handle = await this.sandboxService.create({
        roomId: room.id,
        creatorId: room.creatorId,
        ttlMs: this.options.sandboxTtlMs,
      });
      const readyRoom = await this.store.saveRoom({
        ...lockedRoom,
        sandboxId: handle.id,
        sandboxStatus: 'ready',
        sandboxUpdatedAt: handle.createdAt,
      });
      if (!readyRoom) {
        await this.sandboxService.destroy(handle.id);
        await this.store.compareAndSetRoomSandboxStatus(room.id, ['creating'], 'error', this.now().toISOString());
        return { ok: false, reason: 'store_conflict', room };
      }

      return { ok: true, room: readyRoom, handle, created: true };
    } catch (error) {
      if (handle) {
        await this.sandboxService.destroy(handle.id).catch(destroyError => {
          this.logger.error('Error destroying Coco sandbox after lifecycle failure', { error: destroyError, roomId: room.id, sandboxId: handle?.id });
        });
      }
      await this.store.compareAndSetRoomSandboxStatus(room.id, ['creating'], 'error', this.now().toISOString());
      this.logger.error('Error creating Coco sandbox', { error, roomId: room.id });
      return { ok: false, reason: 'sandbox_error', room, error: error as Error };
    }
  }

  private isReadyAndUsable(room: Room): boolean {
    if (room.sandboxStatus !== 'ready' || !room.sandboxId || !room.sandboxUpdatedAt) {
      return false;
    }
    if (this.options.reconnectTimedOutSandboxes) {
      return true;
    }

    const updatedAt = Date.parse(room.sandboxUpdatedAt);
    if (!Number.isFinite(updatedAt)) {
      return false;
    }
    const remainingTtlMs = updatedAt + this.options.sandboxTtlMs - this.now().getTime();
    return remainingTtlMs >= this.options.turnTimeoutMs;
  }

  private isCreatingStale(room: Room): boolean {
    const updatedAt = Date.parse(room.sandboxUpdatedAt || '');
    if (!Number.isFinite(updatedAt)) {
      return true;
    }
    return this.now().getTime() - updatedAt >= this.options.creatingStaleMs;
  }

  private async checkActiveLimits(creatorId: string): Promise<string | null> {
    const globalCount = await this.sandboxService.countActiveSandboxes?.();
    if (globalCount !== undefined && globalCount >= this.options.maxActiveSandboxes) {
      return 'Coco sandbox global limit exceeded';
    }

    const userCount = await this.sandboxService.countActiveSandboxesForUser?.(creatorId);
    if (userCount !== undefined && userCount >= this.options.maxActiveSandboxesPerUser) {
      return 'Coco sandbox per-user limit exceeded';
    }

    return null;
  }

  private withRoomIdentity(handle: CocoSandboxHandle, room: Room): CocoSandboxHandle {
    return {
      ...handle,
      roomId: handle.roomId || room.id,
      creatorId: handle.creatorId || room.creatorId,
    };
  }
}
