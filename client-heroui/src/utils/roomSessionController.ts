import type { Room, RoomPermissions } from './types';

export type RoomSessionPhase =
  | 'idle'
  | 'connecting'
  | 'registering'
  | 'joining'
  | 'ready'
  | 'retrying'
  | 'unavailable';

export type RoomSessionSource =
  | 'storage'
  | 'manual'
  | 'url'
  | 'visibility'
  | 'pageshow'
  | 'online'
  | 'socket-connect'
  | 'socket-disconnect'
  | 'operation'
  | 'retry';

export type RoomSessionResult = {
  room?: Room;
  permissions?: RoomPermissions;
  memberCount?: number;
};

export type RoomSessionSnapshot = {
  phase: RoomSessionPhase;
  roomId: string | null;
  socketId: string | null;
  sessionEpoch: number;
  resyncRevision: number;
  result: RoomSessionResult | null;
  source: RoomSessionSource | null;
  attempt: number;
  error: Error | null;
};

type AckResponse = {
  success: boolean;
  error?: string;
  message?: unknown;
};

export type RoomSessionRegisterAck = AckResponse & {
  clientId?: string;
  nickname?: string;
};

export type RoomSessionJoinAck = AckResponse & RoomSessionResult;

export type RoomSessionTransport = {
  isConnected: () => boolean;
  isActive: () => boolean;
  getSocketId: () => string | null;
  connect: () => void;
  onConnect: (callback: () => void) => () => void;
  onDisconnect: (callback: (reason: string) => void) => () => void;
  emitRegister: (callback: (response: RoomSessionRegisterAck) => void) => void;
  emitJoin: (
    roomId: string,
    password: string | undefined,
    callback: (response: RoomSessionJoinAck) => void,
  ) => void;
  emitLeave: (roomId: string) => void;
};

type RoomSessionControllerOptions = {
  registrationTimeoutMs?: number;
  joinTimeoutMs?: number;
  connectionTimeoutMs?: number;
  maxRegistrationAttempts?: number;
  maxJoinAttempts?: number;
  retryDelaysMs?: number[];
  resyncCoalesceMs?: number;
  onRegistered?: (response: RoomSessionRegisterAck) => void;
  onJoinResult?: (roomId: string, result: RoomSessionResult) => void;
  onDiagnostic?: (event: string, details: Record<string, unknown>) => void;
};

type DesiredRoom = {
  roomId: string;
  password?: string;
  source: RoomSessionSource;
  epoch: number;
};

type Completion = {
  epoch: number;
  roomId: string;
  promise: Promise<RoomSessionResult>;
  resolve: (result: RoomSessionResult) => void;
  reject: (error: Error) => void;
};

type PendingAck = {
  cancel: (error: Error) => void;
};

type ConnectionWaiter = {
  timer: ReturnType<typeof setTimeout>;
  resolve: (socketId: string) => void;
  reject: (error: Error) => void;
};

const DEFAULT_RETRY_DELAYS_MS = [0, 250, 1000];

class RoomSessionTransportChangedError extends Error {
  constructor() {
    super('Socket transport changed during room session operation');
    this.name = 'RoomSessionTransportChangedError';
  }
}

export class RoomSessionSupersededError extends Error {
  constructor() {
    super('Room session request was superseded');
    this.name = 'RoomSessionSupersededError';
  }
}

const responseError = (response: AckResponse, fallback: string) => {
  const message = typeof response.message === 'string' ? response.message : undefined;
  return new Error(response.error || message || fallback);
};

const isRegistrationErrorDefinitive = (error: Error) => (
  /password login is required|invalid user id|invalid client auth token/i.test(error.message)
);

const isJoinErrorDefinitive = (error: Error) => (
  /room not found|room access was removed|password is required or incorrect|workspace is (?:unavailable|disabled)|not enabled for this user/i.test(error.message)
);

export class RoomSessionController {
  private snapshot: RoomSessionSnapshot = {
    phase: 'idle',
    roomId: null,
    socketId: null,
    sessionEpoch: 0,
    resyncRevision: 0,
    result: null,
    source: null,
    attempt: 0,
    error: null,
  };

  private readonly listeners = new Set<() => void>();
  private readonly pendingAcks = new Set<PendingAck>();
  private readonly connectionWaiters = new Set<ConnectionWaiter>();
  private desiredRoom: DesiredRoom | null = null;
  private completion: Completion | null = null;
  private registeredSocketId: string | null = null;
  private currentSocketId: string | null = null;
  private lastConnectedSocketId: string | null = null;
  private registrationPromise: Promise<void> | null = null;
  private activeDrive: { epoch: number; socketId: string | null; promise: Promise<void> } | null = null;
  private driveVersion = 0;
  private stopConnectListener: (() => void) | null = null;
  private stopDisconnectListener: (() => void) | null = null;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly registrationTimeoutMs: number;
  private readonly joinTimeoutMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly maxRegistrationAttempts: number;
  private readonly maxJoinAttempts: number;
  private readonly retryDelaysMs: number[];
  private readonly resyncCoalesceMs: number;

  constructor(
    private readonly transport: RoomSessionTransport,
    private readonly options: RoomSessionControllerOptions = {},
  ) {
    this.registrationTimeoutMs = options.registrationTimeoutMs ?? 15000;
    this.joinTimeoutMs = options.joinTimeoutMs ?? 15000;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 45000;
    this.maxRegistrationAttempts = Math.max(1, options.maxRegistrationAttempts ?? 3);
    this.maxJoinAttempts = Math.max(1, options.maxJoinAttempts ?? 3);
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.resyncCoalesceMs = Math.max(0, options.resyncCoalesceMs ?? 150);
  }

  start = () => {
    if (this.stopConnectListener || this.stopDisconnectListener) return;
    this.stopConnectListener = this.transport.onConnect(this.handleConnected);
    this.stopDisconnectListener = this.transport.onDisconnect(this.handleDisconnected);
    if (this.transport.isConnected()) {
      const socketId = this.transport.getSocketId();
      if (socketId) {
        this.currentSocketId = socketId;
        this.lastConnectedSocketId = socketId;
        this.snapshot = { ...this.snapshot, socketId };
      }
    }
  };

  stop = () => {
    this.stopConnectListener?.();
    this.stopDisconnectListener?.();
    this.stopConnectListener = null;
    this.stopDisconnectListener = null;
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  isReady = (roomId: string) => (
    this.snapshot.phase === 'ready'
    && this.snapshot.roomId === roomId
    && this.snapshot.socketId === this.currentSocketId
    && this.registeredSocketId === this.currentSocketId
  );

  ensureRegistered = (acknowledgementTimeoutMs = this.registrationTimeoutMs): Promise<void> => {
    const socketId = this.connectedSocketId();
    if (socketId && this.registeredSocketId === socketId) {
      return Promise.resolve();
    }
    if (this.registrationPromise) return this.registrationPromise;

    let promise: Promise<void>;
    promise = this.runRegistrationLoop(acknowledgementTimeoutMs).finally(() => {
      if (this.registrationPromise === promise) {
        this.registrationPromise = null;
      }
    });
    this.registrationPromise = promise;
    return promise;
  };

  selectRoom = (input: {
    roomId: string;
    password?: string;
    source?: RoomSessionSource;
  }): Promise<RoomSessionResult> => {
    const roomId = input.roomId.trim();
    if (!roomId) return Promise.reject(new Error('Room ID is required'));
    const source = input.source ?? 'manual';
    const sameRoom = this.desiredRoom?.roomId === roomId;

    if (sameRoom && this.isReady(roomId) && this.snapshot.result) {
      this.log('join-skipped-already-ready', { roomId, source });
      return Promise.resolve(this.snapshot.result);
    }

    if (!sameRoom) {
      this.supersedeCompletion();
      this.advanceEpoch('room-change', roomId, source);
      this.desiredRoom = {
        roomId,
        password: input.password,
        source,
        epoch: this.snapshot.sessionEpoch,
      };
      this.setSnapshot({
        roomId,
        result: null,
        source,
        error: null,
        attempt: 0,
      }, 'room-selected');
    } else if (this.desiredRoom) {
      // Keep the desired-room identity stable within one epoch. The active
      // drive uses object identity to reject work from superseded rooms; if a
      // same-room lifecycle signal replaced this object while register/join
      // was pending, the coalesced drive would reject its own acknowledgement
      // as stale and leave the completion unresolved.
      this.desiredRoom.password = input.password ?? this.desiredRoom.password;
      // The initiating source also owns foreground error handling for this
      // completion. Lifecycle nudges are diagnostics, not a transfer of that
      // ownership to the background recovery path.
      this.setSnapshot({ error: null }, 'room-retry-requested', { requestedSource: source });
    }

    const desired = this.desiredRoom;
    if (!desired) return Promise.reject(new Error('Room session target is unavailable'));
    if (!this.completion || this.completion.epoch !== desired.epoch) {
      this.completion = this.createCompletion(desired);
    }

    this.setSnapshot({ phase: this.nextWorkingPhase(), error: null }, 'room-drive-requested');
    void this.driveDesiredRoom();
    return this.completion.promise;
  };

  ensureRoom = (roomId: string, source: RoomSessionSource = 'retry') => {
    const password = this.desiredRoom?.roomId === roomId ? this.desiredRoom.password : undefined;
    return this.selectRoom({ roomId, password, source });
  };

  resume = (source: Extract<RoomSessionSource, 'visibility' | 'pageshow' | 'online'>) => {
    if (!this.desiredRoom) {
      return this.ensureRegistered().then(() => null);
    }

    if (this.isReady(this.desiredRoom.roomId)) {
      this.requestResync(source);
      return Promise.resolve(this.snapshot.result);
    }
    return this.selectRoom({
      roomId: this.desiredRoom.roomId,
      password: this.desiredRoom.password,
      source,
    });
  };

  requestResync = (source: RoomSessionSource) => {
    if (!this.desiredRoom || !this.isReady(this.desiredRoom.roomId) || this.resyncTimer) return;
    const epoch = this.desiredRoom.epoch;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (!this.desiredRoom || this.desiredRoom.epoch !== epoch || !this.isReady(this.desiredRoom.roomId)) return;
      this.setSnapshot({
        source,
        resyncRevision: this.snapshot.resyncRevision + 1,
      }, 'resync-requested');
    }, this.resyncCoalesceMs);
  };

  leaveRoom = (roomId: string) => {
    this.transport.emitLeave(roomId);
    if (this.desiredRoom?.roomId !== roomId) return;

    this.supersedeCompletion();
    this.driveVersion += 1;
    this.activeDrive = null;
    this.desiredRoom = null;
    this.clearResyncTimer();
    this.advanceEpoch('room-change', null, 'manual');
    this.setSnapshot({
      phase: 'idle',
      roomId: null,
      result: null,
      source: 'manual',
      attempt: 0,
      error: null,
    }, 'room-left');
  };

  refreshRegistration = () => {
    this.registeredSocketId = null;
    this.driveVersion += 1;
    this.activeDrive = null;
    this.cancelPendingAcks(new RoomSessionTransportChangedError());
    this.setSnapshot({
      phase: this.desiredRoom ? this.nextWorkingPhase() : this.snapshot.phase,
      source: 'operation',
      attempt: 0,
      error: null,
    }, 'registration-invalidated');
    if (this.desiredRoom) {
      void this.driveDesiredRoom();
    } else if (this.transport.isConnected()) {
      void this.ensureRegistered().catch(error => {
        this.log('registration-background-failed', { error: error.message });
      });
    }
  };

  resetForTests = () => {
    this.stop();
    this.cancelPendingAcks(new RoomSessionTransportChangedError());
    this.rejectConnectionWaiters(new RoomSessionTransportChangedError());
    this.clearResyncTimer();
    this.desiredRoom = null;
    this.completion = null;
    this.registeredSocketId = null;
    this.currentSocketId = this.transport.isConnected() ? this.transport.getSocketId() : null;
    this.lastConnectedSocketId = this.currentSocketId;
    this.registrationPromise = null;
    this.activeDrive = null;
    this.driveVersion += 1;
    this.snapshot = {
      phase: 'idle',
      roomId: null,
      socketId: this.currentSocketId,
      sessionEpoch: 0,
      resyncRevision: 0,
      result: null,
      source: null,
      attempt: 0,
      error: null,
    };
    this.start();
    this.emitChange();
  };

  private readonly handleConnected = () => {
    const socketId = this.transport.getSocketId();
    if (!socketId) return;
    const socketChanged = Boolean(this.lastConnectedSocketId && this.lastConnectedSocketId !== socketId);
    this.currentSocketId = socketId;
    this.lastConnectedSocketId = socketId;
    this.registeredSocketId = null;
    this.resolveConnectionWaiters(socketId);

    if (socketChanged && this.desiredRoom) {
      const pendingCompletion = this.completion;
      this.advanceEpoch('socket-change', this.desiredRoom.roomId, 'socket-connect');
      this.desiredRoom = {
        ...this.desiredRoom,
        source: 'socket-connect',
        epoch: this.snapshot.sessionEpoch,
      };
      // A transport replacement creates a new session epoch, but it does not
      // supersede the user's room intent. Keep the original caller waiting for
      // the recovered room instead of surfacing a false navigation failure.
      if (pendingCompletion?.roomId === this.desiredRoom.roomId) {
        pendingCompletion.epoch = this.desiredRoom.epoch;
        this.completion = pendingCompletion;
      }
    }

    this.setSnapshot({
      socketId,
      phase: this.desiredRoom ? 'registering' : 'idle',
      source: 'socket-connect',
      error: null,
      attempt: 0,
    }, 'socket-connected');

    if (this.desiredRoom) {
      void this.driveDesiredRoom();
    } else {
      // Defer proactive registration by one microtask. If connect() fired
      // synchronously inside an operation's existing registration loop, that
      // loop gets to publish registrationPromise first and this call dedupes.
      void Promise.resolve().then(() => this.ensureRegistered()).catch(error => {
        this.log('registration-background-failed', { error: error.message });
      });
    }
  };

  private readonly handleDisconnected = (reason: string) => {
    const previousSocketId = this.currentSocketId;
    this.currentSocketId = null;
    this.registeredSocketId = null;
    this.driveVersion += 1;
    this.activeDrive = null;
    this.cancelPendingAcks(new RoomSessionTransportChangedError());
    this.setSnapshot({
      phase: this.desiredRoom ? 'retrying' : 'idle',
      socketId: null,
      source: 'socket-disconnect',
      attempt: 0,
      error: null,
    }, 'socket-disconnected', { reason, previousSocketId });
  };

  private async runRegistrationLoop(acknowledgementTimeoutMs: number) {
    let attempt = 0;
    let attemptSocketId: string | null = null;
    while (true) {
      const socketId = await this.waitForConnectedSocket();
      if (this.registeredSocketId === socketId) return;
      if (attemptSocketId !== socketId) {
        attemptSocketId = socketId;
        attempt = 0;
      }
      attempt += 1;
      this.setSnapshot({
        phase: this.desiredRoom ? (attempt === 1 ? 'registering' : 'retrying') : this.snapshot.phase,
        socketId,
        attempt,
        error: null,
      }, 'registration-attempt');

      try {
        const response = await this.waitForAck<RoomSessionRegisterAck>({
          socketId,
          timeoutMs: acknowledgementTimeoutMs,
          timeoutMessage: 'Timed out while registering client',
          emit: callback => this.transport.emitRegister(callback),
          onLateResponse: lateResponse => {
            if (lateResponse.success && this.connectedSocketId() === socketId) {
              this.registeredSocketId = socketId;
              this.options.onRegistered?.(lateResponse);
            }
          },
        });
        if (!response.success) throw responseError(response, 'Failed to register client');
        if (this.connectedSocketId() !== socketId) throw new RoomSessionTransportChangedError();
        this.registeredSocketId = socketId;
        this.options.onRegistered?.(response);
        this.log('registration-ready', { socketId, attempt });
        return;
      } catch (error) {
        const registrationError = error instanceof Error ? error : new Error('Failed to register client');
        if (registrationError instanceof RoomSessionTransportChangedError) {
          attemptSocketId = null;
          continue;
        }
        if (isRegistrationErrorDefinitive(registrationError) || attempt >= this.maxRegistrationAttempts) {
          throw registrationError;
        }
        this.setSnapshot({ phase: this.desiredRoom ? 'retrying' : this.snapshot.phase }, 'registration-retrying', {
          error: registrationError.message,
          attempt,
        });
        await this.waitBeforeRetry(attempt);
      }
    }
  }

  private driveDesiredRoom() {
    const desired = this.desiredRoom;
    if (!desired) return Promise.resolve();
    const driveSocketId = this.connectedSocketId();
    if (
      this.activeDrive
      && this.activeDrive.epoch === desired.epoch
      && this.activeDrive.socketId === driveSocketId
    ) {
      return this.activeDrive.promise;
    }

    const driveVersion = ++this.driveVersion;
    let promise: Promise<void>;
    promise = this.runDesiredRoomDrive(desired, driveVersion).finally(() => {
      if (this.activeDrive?.promise === promise) this.activeDrive = null;
    });
    this.activeDrive = { epoch: desired.epoch, socketId: driveSocketId, promise };
    return promise;
  }

  private async runDesiredRoomDrive(desired: DesiredRoom, driveVersion: number) {
    try {
      await this.ensureRegistered();
    } catch (error) {
      if (!this.isCurrentDrive(desired, driveVersion)) return;
      this.markUnavailable(error instanceof Error ? error : new Error('Failed to register client'));
      return;
    }
    if (!this.isCurrentDrive(desired, driveVersion)) return;

    let joinAttempt = 0;
    while (joinAttempt < this.maxJoinAttempts && this.isCurrentDrive(desired, driveVersion)) {
      joinAttempt += 1;
      const socketId = this.connectedSocketId();
      if (!socketId) return;
      this.setSnapshot({
        phase: joinAttempt === 1 ? 'joining' : 'retrying',
        socketId,
        source: desired.source,
        attempt: joinAttempt,
        error: null,
      }, 'join-attempt');

      try {
        const response = await this.waitForAck<RoomSessionJoinAck>({
          socketId,
          timeoutMs: this.joinTimeoutMs,
          timeoutMessage: 'Timed out while joining room',
          emit: callback => this.transport.emitJoin(desired.roomId, desired.password, callback),
          onLateResponse: lateResponse => {
            if (lateResponse.success && this.desiredRoom?.roomId !== desired.roomId) {
              this.transport.emitLeave(desired.roomId);
            }
          },
        });
        if (!response.success) throw responseError(response, 'Failed to join room');
        if (!this.isCurrentDrive(desired, driveVersion) || this.connectedSocketId() !== socketId) {
          this.transport.emitLeave(desired.roomId);
          return;
        }
        const result: RoomSessionResult = {
          room: response.room,
          permissions: response.permissions,
          memberCount: response.memberCount,
        };
        this.options.onJoinResult?.(desired.roomId, result);
        this.markReady(desired, socketId, result);
        return;
      } catch (error) {
        const joinError = error instanceof Error ? error : new Error('Failed to join room');
        if (joinError instanceof RoomSessionTransportChangedError || !this.isCurrentDrive(desired, driveVersion)) {
          return;
        }
        if (/not registered/i.test(joinError.message)) {
          this.registeredSocketId = null;
          try {
            await this.ensureRegistered();
          } catch (registrationError) {
            if (this.isCurrentDrive(desired, driveVersion)) {
              this.markUnavailable(registrationError instanceof Error ? registrationError : joinError);
            }
            return;
          }
          continue;
        }
        if (isJoinErrorDefinitive(joinError) || joinAttempt >= this.maxJoinAttempts) {
          this.markUnavailable(joinError);
          return;
        }
        this.setSnapshot({ phase: 'retrying' }, 'join-retrying', {
          error: joinError.message,
          attempt: joinAttempt,
        });
        await this.waitBeforeRetry(joinAttempt);
      }
    }
  }

  private waitForAck<TResponse extends AckResponse>(input: {
    socketId: string;
    timeoutMs: number;
    timeoutMessage: string;
    emit: (callback: (response: TResponse) => void) => void;
    onLateResponse?: (response: TResponse) => void;
  }): Promise<TResponse> {
    return new Promise<TResponse>((resolve, reject) => {
      let settled = false;
      const pending: PendingAck = {
        cancel: error => settle(() => reject(error)),
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error(input.timeoutMessage)));
      }, input.timeoutMs);
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingAcks.delete(pending);
        callback();
      };

      this.pendingAcks.add(pending);
      input.emit(response => {
        if (settled) {
          input.onLateResponse?.(response);
          return;
        }
        if (this.connectedSocketId() !== input.socketId) {
          settle(() => reject(new RoomSessionTransportChangedError()));
          return;
        }
        settle(() => resolve(response));
      });
    });
  }

  private waitForConnectedSocket(): Promise<string> {
    const connectedSocketId = this.connectedSocketId();
    if (connectedSocketId) return Promise.resolve(connectedSocketId);

    this.setSnapshot({
      phase: this.desiredRoom ? (this.snapshot.result ? 'retrying' : 'connecting') : this.snapshot.phase,
      socketId: null,
      attempt: 0,
    }, 'connection-waiting');
    if (!this.transport.isActive()) this.transport.connect();

    // Some transports (and the Socket.IO test adapter) can emit `connect`
    // synchronously from connect(). Re-check before installing a waiter so the
    // event cannot be lost between the first check and waiter registration.
    const connectedAfterConnect = this.connectedSocketId();
    if (connectedAfterConnect) return Promise.resolve(connectedAfterConnect);

    return new Promise<string>((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        timer: setTimeout(() => {
          this.connectionWaiters.delete(waiter);
          reject(new Error('Timed out while connecting to server'));
        }, this.connectionTimeoutMs),
        resolve,
        reject,
      };
      this.connectionWaiters.add(waiter);
    });
  }

  private connectedSocketId() {
    if (!this.transport.isConnected()) return null;
    return this.transport.getSocketId();
  }

  private nextWorkingPhase(): RoomSessionPhase {
    const socketId = this.connectedSocketId();
    if (!socketId) return this.snapshot.result ? 'retrying' : 'connecting';
    if (this.registeredSocketId !== socketId) return 'registering';
    return 'joining';
  }

  private isCurrentDrive(desired: DesiredRoom, driveVersion: number) {
    return (
      this.driveVersion === driveVersion
      && this.desiredRoom === desired
      && this.desiredRoom.epoch === this.snapshot.sessionEpoch
    );
  }

  private markReady(desired: DesiredRoom, socketId: string, result: RoomSessionResult) {
    const alreadyReady = this.snapshot.phase === 'ready'
      && this.snapshot.sessionEpoch === desired.epoch
      && this.snapshot.socketId === socketId;
    this.setSnapshot({
      phase: 'ready',
      roomId: desired.roomId,
      socketId,
      result,
      source: desired.source,
      attempt: 0,
      error: null,
      resyncRevision: alreadyReady
        ? this.snapshot.resyncRevision
        : this.snapshot.resyncRevision + 1,
    }, 'room-ready');
    if (this.completion?.epoch === desired.epoch) {
      this.completion.resolve(result);
      this.completion = null;
    }
  }

  private markUnavailable(error: Error) {
    this.setSnapshot({
      phase: 'unavailable',
      attempt: 0,
      error,
    }, 'room-unavailable', { error: error.message });
    if (this.completion && this.completion.epoch === this.snapshot.sessionEpoch) {
      this.completion.reject(error);
      this.completion = null;
    }
  }

  private createCompletion(desired: DesiredRoom): Completion {
    let resolve = (_result: RoomSessionResult) => {};
    let reject = (_error: Error) => {};
    const promise = new Promise<RoomSessionResult>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { epoch: desired.epoch, roomId: desired.roomId, promise, resolve, reject };
  }

  private supersedeCompletion() {
    if (!this.completion) return;
    this.completion.reject(new RoomSessionSupersededError());
    this.completion = null;
  }

  private advanceEpoch(reason: 'room-change' | 'socket-change', roomId: string | null, source: RoomSessionSource) {
    this.driveVersion += 1;
    this.activeDrive = null;
    this.setSnapshot({
      sessionEpoch: this.snapshot.sessionEpoch + 1,
      roomId,
      source,
      attempt: 0,
      error: null,
    }, 'epoch-advanced', { reason });
  }

  private waitBeforeRetry(attempt: number) {
    const delay = this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 0;
    if (delay <= 0) return Promise.resolve();
    return new Promise<void>(resolve => setTimeout(resolve, delay));
  }

  private resolveConnectionWaiters(socketId: string) {
    [...this.connectionWaiters].forEach(waiter => {
      clearTimeout(waiter.timer);
      this.connectionWaiters.delete(waiter);
      waiter.resolve(socketId);
    });
  }

  private rejectConnectionWaiters(error: Error) {
    [...this.connectionWaiters].forEach(waiter => {
      clearTimeout(waiter.timer);
      this.connectionWaiters.delete(waiter);
      waiter.reject(error);
    });
  }

  private cancelPendingAcks(error: Error) {
    [...this.pendingAcks].forEach(pending => pending.cancel(error));
  }

  private clearResyncTimer() {
    if (!this.resyncTimer) return;
    clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
  }

  private setSnapshot(
    update: Partial<RoomSessionSnapshot>,
    event: string,
    details: Record<string, unknown> = {},
  ) {
    const previous = this.snapshot;
    const next = { ...previous, ...update };
    const changed = Object.keys(update).some(key => (
      previous[key as keyof RoomSessionSnapshot] !== next[key as keyof RoomSessionSnapshot]
    ));
    this.snapshot = next;
    this.log(event, {
      ...details,
      phase: next.phase,
      roomId: next.roomId,
      socketId: next.socketId,
      sessionEpoch: next.sessionEpoch,
      resyncRevision: next.resyncRevision,
      attempt: next.attempt,
      source: next.source,
    });
    if (changed) this.emitChange();
  }

  private emitChange() {
    this.listeners.forEach(listener => listener());
  }

  private log(event: string, details: Record<string, unknown>) {
    this.options.onDiagnostic?.(event, details);
  }
}
