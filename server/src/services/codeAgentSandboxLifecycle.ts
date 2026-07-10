import { Logger } from '../logger';
import { Room, RoomSandboxStatus } from '../types';
import { CodeAgentSandboxHandle, CodeAgentSandboxService } from './codeAgentSandboxService';

export type EnsureCodeAgentSandboxResult =
  | { ok: true; room: Room; handle: CodeAgentSandboxHandle; created: boolean }
  | { ok: false; reason: 'missing_room' | 'not_code_agent_room' | 'forbidden' | 'creating' | 'limit_exceeded' | 'store_conflict' | 'sandbox_error'; room?: Room; error?: Error };

export interface CodeAgentSandboxLifecycleOptions {
  sandboxTtlMs: number;
  activeSandboxTtlMs: number;
  idleSandboxTtlMs: number;
  creatingStaleMs: number;
  maxActiveSandboxes: number;
  maxActiveSandboxesPerUser: number;
  reconnectTimedOutSandboxes: boolean;
  artifactVersion?: string;
  codeAgentSourceRef?: string;
  artifactMigrationMaxArchiveBytes: number;
  artifactMigrationTimeoutMs: number;
}

export interface CodeAgentSandboxLifecycleStore {
  getRoomById(roomId: string): Promise<Room | null>;
  saveRoom(room: Room): Promise<Room | null>;
  compareAndSetRoomSandboxStatus(
    roomId: string,
    expectedStatuses: RoomSandboxStatus[],
    nextStatus: RoomSandboxStatus,
    updatedAt?: string
  ): Promise<Room | null>;
  replaceRoomSandbox(
    roomId: string,
    expectedSandboxId: string,
    next: {
      sandboxId: string;
      sandboxStatus: RoomSandboxStatus;
      sandboxUpdatedAt: string;
      sandboxArtifactVersion?: string;
      sandboxCodeAgentSourceRef?: string;
    }
  ): Promise<Room | null>;
  findInterruptedCodeAgentRooms(): Promise<Room[]>;
}

export const DEFAULT_ARTIFACT_MIGRATION_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_ARTIFACT_MIGRATION_TIMEOUT_MS = 5 * 60 * 1000;

const defaultOptions: CodeAgentSandboxLifecycleOptions = {
  sandboxTtlMs: 60 * 60 * 1000,
  activeSandboxTtlMs: 60 * 60 * 1000,
  idleSandboxTtlMs: 2 * 60 * 1000,
  creatingStaleMs: 2 * 60 * 1000,
  maxActiveSandboxes: Number.POSITIVE_INFINITY,
  maxActiveSandboxesPerUser: Number.POSITIVE_INFINITY,
  reconnectTimedOutSandboxes: false,
  artifactMigrationMaxArchiveBytes: DEFAULT_ARTIFACT_MIGRATION_MAX_ARCHIVE_BYTES,
  artifactMigrationTimeoutMs: DEFAULT_ARTIFACT_MIGRATION_TIMEOUT_MS,
};

export class CodeAgentSandboxLifecycleService {
  private readonly options: CodeAgentSandboxLifecycleOptions;

  constructor(
    private readonly store: CodeAgentSandboxLifecycleStore,
    private readonly sandboxService: CodeAgentSandboxService,
    private readonly logger: Logger,
    options: Partial<CodeAgentSandboxLifecycleOptions> = {},
    private readonly now: () => Date = () => new Date()
  ) {
    this.options = { ...defaultOptions, ...options };
  }

  async ensureReadySandbox(roomId: string, clientId: string): Promise<EnsureCodeAgentSandboxResult> {
    const room = await this.store.getRoomById(roomId);
    if (!room) {
      return { ok: false, reason: 'missing_room' };
    }
    if (room.type !== 'codeAgent') {
      return { ok: false, reason: 'not_code_agent_room', room };
    }
    const access = room.codeAgentAccess || 'owner';
    if (access === 'owner' && room.creatorId !== clientId) {
      return { ok: false, reason: 'forbidden', room };
    }

    if (this.isReadyAndUsable(room)) {
      try {
        const handle = this.withRoomIdentity(await this.sandboxService.connect(room.sandboxId!), room);
        if (!this.isSandboxArtifactCompatible(room)) {
          return this.migrateReadySandboxArtifact(room, handle);
        }
        return { ok: true, room, handle, created: false };
      } catch (error) {
        await this.store.compareAndSetRoomSandboxStatus(room.id, ['ready'], 'expired', this.now().toISOString());
        this.logger.warn('code-agent sandbox reconnect failed; marking sandbox expired', { roomId: room.id, sandboxId: room.sandboxId, error });
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
    const rooms = await this.store.findInterruptedCodeAgentRooms();
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

      if (currentRoom.codeAgentStatus === 'running') {
        const updatedRoom = await this.store.saveRoom({
          ...currentRoom,
          codeAgentStatus: 'error',
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
      this.logger.warn('Recovered interrupted code-agent sandbox room states', { count: recovered });
    }
    return recovered;
  }

  async extendSandboxForActiveTurn(handle: CodeAgentSandboxHandle): Promise<CodeAgentSandboxHandle> {
    return this.updateSandboxTimeout(handle, this.options.activeSandboxTtlMs, 'active');
  }

  async shortenSandboxAfterTurn(handle: CodeAgentSandboxHandle): Promise<CodeAgentSandboxHandle> {
    return this.updateSandboxTimeout(handle, this.options.idleSandboxTtlMs, 'idle');
  }

  async destroyRoomSandbox(roomId: string, clientId: string): Promise<{ destroyed: boolean; room: Room | null; error?: Error }> {
    const room = await this.store.getRoomById(roomId);
    if (!room || room.creatorId !== clientId || room.type !== 'codeAgent' || !room.sandboxId || room.sandboxStatus === 'creating') {
      return { destroyed: false, room };
    }

    try {
      await this.sandboxService.destroy(room.sandboxId);
      await this.store.compareAndSetRoomSandboxStatus(room.id, ['ready', 'error', 'expired', 'none'], 'expired', this.now().toISOString());
      return { destroyed: true, room };
    } catch (error) {
      this.logger.error('Error destroying code-agent sandbox', { error, roomId, sandboxId: room.sandboxId });
      return { destroyed: false, room, error: error as Error };
    }
  }

  private async createSandbox(room: Room): Promise<EnsureCodeAgentSandboxResult> {
    const limitError = await this.checkActiveLimits(room.creatorId);
    if (limitError) {
      return { ok: false, reason: 'limit_exceeded', room, error: new Error(limitError) };
    }

    const lockedRoom = await this.store.compareAndSetRoomSandboxStatus(room.id, ['none', 'error', 'expired'], 'creating', this.now().toISOString());
    if (!lockedRoom) {
      return { ok: false, reason: 'store_conflict', room };
    }

    let handle: CodeAgentSandboxHandle | null = null;
    try {
      handle = await this.sandboxService.create({
        roomId: room.id,
        creatorId: room.creatorId,
        ttlMs: this.options.sandboxTtlMs,
      });
      await this.initializeNewSandboxWorkspace(handle);
      const readyRoom = await this.store.saveRoom({
        ...lockedRoom,
        sandboxId: handle.id,
        sandboxStatus: 'ready',
        sandboxUpdatedAt: handle.createdAt,
        ...this.currentSandboxArtifactMetadata(),
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
          this.logger.error('Error destroying code-agent sandbox after lifecycle failure', { error: destroyError, roomId: room.id, sandboxId: handle?.id });
        });
      }
      await this.store.compareAndSetRoomSandboxStatus(room.id, ['creating'], 'error', this.now().toISOString());
      this.logger.error('Error creating code-agent sandbox', { error, roomId: room.id });
      return { ok: false, reason: 'sandbox_error', room, error: error as Error };
    }
  }

  private async updateSandboxTimeout(
    handle: CodeAgentSandboxHandle,
    ttlMs: number,
    state: 'active' | 'idle'
  ): Promise<CodeAgentSandboxHandle> {
    if (!this.sandboxService.setSandboxTimeout) {
      return handle;
    }
    try {
      return await this.sandboxService.setSandboxTimeout(handle, ttlMs);
    } catch (error) {
      this.logger.warn('Unable to update code-agent sandbox timeout', {
        error,
        sandboxId: handle.id,
        roomId: handle.roomId,
        ttlMs,
        state,
      });
      return handle;
    }
  }

  private async migrateReadySandboxArtifact(room: Room, oldHandle: CodeAgentSandboxHandle): Promise<EnsureCodeAgentSandboxResult> {
    if (!room.sandboxId) {
      return { ok: false, reason: 'sandbox_error', room, error: new Error('Ready code-agent room is missing sandboxId') };
    }
    if (!this.sandboxService.exportWorkspaceArchive || !this.sandboxService.importWorkspaceArchive) {
      const error = new Error('code-agent sandbox service does not support workspace archive migration');
      this.logger.error('code-agent sandbox artifact migration unavailable', {
        roomId: room.id,
        sandboxId: room.sandboxId,
        error,
      });
      return { ok: false, reason: 'sandbox_error', room, error };
    }

    const limitError = await this.checkActiveLimits(room.creatorId, 1);
    if (limitError) {
      return { ok: false, reason: 'limit_exceeded', room, error: new Error(limitError) };
    }

    let newHandle: CodeAgentSandboxHandle | null = null;
    try {
      const archive = await this.sandboxService.exportWorkspaceArchive(oldHandle, {
        maxBytes: this.options.artifactMigrationMaxArchiveBytes,
        timeoutMs: this.options.artifactMigrationTimeoutMs,
      });
      newHandle = await this.sandboxService.create({
        roomId: room.id,
        creatorId: room.creatorId,
        ttlMs: this.options.sandboxTtlMs,
      });
      await this.sandboxService.importWorkspaceArchive(newHandle, archive, {
        timeoutMs: this.options.artifactMigrationTimeoutMs,
      });
      await this.initializeNewSandboxWorkspace(newHandle);

      const readyRoom = await this.store.replaceRoomSandbox(room.id, room.sandboxId, {
        sandboxId: newHandle.id,
        sandboxStatus: 'ready',
        sandboxUpdatedAt: newHandle.createdAt,
        ...this.currentSandboxArtifactMetadata(),
      });
      if (!readyRoom) {
        await this.sandboxService.destroy(newHandle.id);
        return { ok: false, reason: 'store_conflict', room };
      }

      await this.sandboxService.destroy(room.sandboxId).catch(error => {
        this.logger.warn('Unable to destroy old code-agent sandbox after artifact migration', {
          error,
          roomId: room.id,
          sandboxId: room.sandboxId,
        });
      });

      this.logger.info('Migrated code-agent sandbox artifact for room', {
        roomId: room.id,
        oldSandboxId: room.sandboxId,
        newSandboxId: newHandle.id,
        archiveBytes: archive.byteSize,
        expectedArtifactVersion: this.options.artifactVersion,
        expectedCodeAgentSourceRef: this.options.codeAgentSourceRef,
      });
      return { ok: true, room: readyRoom, handle: this.withRoomIdentity(newHandle, readyRoom), created: true };
    } catch (error) {
      if (newHandle) {
        await this.sandboxService.destroy(newHandle.id).catch(destroyError => {
          this.logger.error('Error destroying replacement code-agent sandbox after migration failure', {
            error: destroyError,
            roomId: room.id,
            sandboxId: newHandle?.id,
          });
        });
      }
      this.logger.error('Error migrating code-agent sandbox artifact', {
        error,
        roomId: room.id,
        sandboxId: room.sandboxId,
        expectedArtifactVersion: this.options.artifactVersion,
        expectedCodeAgentSourceRef: this.options.codeAgentSourceRef,
      });
      return { ok: false, reason: 'sandbox_error', room, error: error as Error };
    }
  }

  private async initializeNewSandboxWorkspace(handle: CodeAgentSandboxHandle): Promise<void> {
    if (!this.sandboxService.initializeWorkspaceVersionControl) {
      return;
    }
    try {
      await this.sandboxService.initializeWorkspaceVersionControl(handle);
    } catch (error) {
      this.logger.warn('code-agent sandbox workspace version control initialization failed', {
        error,
        roomId: handle.roomId,
        sandboxId: handle.id,
      });
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
    return remainingTtlMs > 0;
  }

  private isSandboxArtifactCompatible(room: Room): boolean {
    if (this.options.artifactVersion && room.sandboxArtifactVersion !== this.options.artifactVersion) {
      return false;
    }
    if (this.options.codeAgentSourceRef && room.sandboxCodeAgentSourceRef !== this.options.codeAgentSourceRef) {
      return false;
    }
    return true;
  }

  private currentSandboxArtifactMetadata(): Pick<Room, 'sandboxArtifactVersion' | 'sandboxCodeAgentSourceRef'> {
    return {
      ...(this.options.artifactVersion ? { sandboxArtifactVersion: this.options.artifactVersion } : {}),
      ...(this.options.codeAgentSourceRef ? { sandboxCodeAgentSourceRef: this.options.codeAgentSourceRef } : {}),
    };
  }

  private isCreatingStale(room: Room): boolean {
    const updatedAt = Date.parse(room.sandboxUpdatedAt || '');
    if (!Number.isFinite(updatedAt)) {
      return true;
    }
    return this.now().getTime() - updatedAt >= this.options.creatingStaleMs;
  }

  private async checkActiveLimits(creatorId: string, replacingActiveSandboxes = 0): Promise<string | null> {
    const globalCount = await this.sandboxService.countActiveSandboxes?.();
    if (globalCount !== undefined && Math.max(0, globalCount - replacingActiveSandboxes) >= this.options.maxActiveSandboxes) {
      return 'code-agent sandbox global limit exceeded';
    }

    const userCount = await this.sandboxService.countActiveSandboxesForUser?.(creatorId);
    if (userCount !== undefined && Math.max(0, userCount - replacingActiveSandboxes) >= this.options.maxActiveSandboxesPerUser) {
      return 'code-agent sandbox per-user limit exceeded';
    }

    return null;
  }

  private withRoomIdentity(handle: CodeAgentSandboxHandle, room: Room): CodeAgentSandboxHandle {
    return {
      ...handle,
      roomId: handle.roomId || room.id,
      creatorId: handle.creatorId || room.creatorId,
    };
  }
}
