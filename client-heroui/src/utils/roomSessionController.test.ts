import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RoomSessionController,
  RoomSessionJoinAck,
  RoomSessionRegisterAck,
  RoomSessionSupersededError,
  RoomSessionTransport,
} from './roomSessionController';
import type { Room } from './types';

const room = (id: string): Room => ({
  id,
  name: id,
  description: '',
  createdAt: '2026-07-13T00:00:00.000Z',
  creatorId: 'client-1',
});

class FakeRoomSessionTransport implements RoomSessionTransport {
  connected = false;
  active = false;
  socketId: string | null = null;
  registerCallbacks: Array<(response: RoomSessionRegisterAck) => void> = [];
  joins: Array<{
    roomId: string;
    password?: string;
    callback: (response: RoomSessionJoinAck) => void;
  }> = [];
  leaves: string[] = [];
  connectCalls = 0;
  private readonly connectListeners = new Set<() => void>();
  private readonly disconnectListeners = new Set<(reason: string) => void>();

  isConnected = () => this.connected;
  isActive = () => this.active;
  getSocketId = () => this.socketId;
  connect = () => {
    this.connectCalls += 1;
    this.active = true;
  };
  onConnect = (callback: () => void) => {
    this.connectListeners.add(callback);
    return () => this.connectListeners.delete(callback);
  };
  onDisconnect = (callback: (reason: string) => void) => {
    this.disconnectListeners.add(callback);
    return () => this.disconnectListeners.delete(callback);
  };
  emitRegister = (callback: (response: RoomSessionRegisterAck) => void) => {
    this.registerCallbacks.push(callback);
  };
  emitJoin = (
    roomId: string,
    password: string | undefined,
    callback: (response: RoomSessionJoinAck) => void,
  ) => {
    this.joins.push({ roomId, password, callback });
  };
  emitLeave = (roomId: string) => {
    this.leaves.push(roomId);
  };

  establish(socketId: string) {
    this.connected = true;
    this.active = true;
    this.socketId = socketId;
    this.connectListeners.forEach(listener => listener());
  }

  disconnect(reason = 'transport close') {
    this.connected = false;
    this.active = true;
    this.socketId = null;
    this.disconnectListeners.forEach(listener => listener(reason));
  }
}

const flushPromises = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

describe('RoomSessionController', () => {
  let transport: FakeRoomSessionTransport;
  let controller: RoomSessionController;

  beforeEach(() => {
    transport = new FakeRoomSessionTransport();
    controller = new RoomSessionController(transport, {
      connectionTimeoutMs: 1000,
      registrationTimeoutMs: 1000,
      joinTimeoutMs: 1000,
      retryDelaysMs: [0],
      resyncCoalesceMs: 10,
    });
    controller.start();
  });

  afterEach(() => {
    controller.stop();
    vi.useRealTimers();
  });

  it('drives disconnected -> connecting -> registering -> joining -> ready', async () => {
    const joining = controller.selectRoom({ roomId: 'room-1', source: 'manual' });
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'connecting',
      roomId: 'room-1',
      sessionEpoch: 1,
      resyncRevision: 0,
    });
    expect(transport.connectCalls).toBe(1);

    transport.establish('socket-1');
    await flushPromises();
    expect(transport.registerCallbacks).toHaveLength(1);
    expect(controller.getSnapshot().phase).toBe('registering');

    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    expect(transport.joins).toHaveLength(1);
    expect(transport.joins[0]).toMatchObject({ roomId: 'room-1' });
    expect(controller.getSnapshot().phase).toBe('joining');

    transport.joins[0].callback({ success: true, room: room('room-1'), memberCount: 2 });
    await expect(joining).resolves.toMatchObject({ room: { id: 'room-1' }, memberCount: 2 });
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      roomId: 'room-1',
      socketId: 'socket-1',
      sessionEpoch: 1,
      resyncRevision: 1,
    });
  });

  it('coalesces lifecycle resumes into the initial disconnected storage restore', async () => {
    const joining = controller.selectRoom({ roomId: 'room-1', source: 'storage' });
    const pageShown = controller.resume('pageshow');
    const visible = controller.resume('visibility');

    expect(pageShown).toBe(joining);
    expect(visible).toBe(joining);
    expect(transport.connectCalls).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'connecting',
      roomId: 'room-1',
      source: 'storage',
      sessionEpoch: 1,
    });

    transport.establish('socket-1');
    await flushPromises();
    expect(transport.registerCallbacks).toHaveLength(1);
    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    expect(transport.joins).toHaveLength(1);

    transport.joins[0].callback({ success: true, room: room('room-1') });
    await expect(Promise.all([joining, pageShown, visible])).resolves.toHaveLength(3);
    expect(transport.registerCallbacks).toHaveLength(1);
    expect(transport.joins).toHaveLength(1);
    expect(transport.leaves).toHaveLength(0);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      roomId: 'room-1',
      source: 'storage',
      sessionEpoch: 1,
      resyncRevision: 1,
    });
  });

  it('restarts registration and join on a new socket after disconnecting before register ack', async () => {
    transport.establish('socket-1');
    const joining = controller.selectRoom({ roomId: 'room-1' });
    await flushPromises();
    expect(transport.registerCallbacks).toHaveLength(1);

    transport.disconnect();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'retrying',
      roomId: 'room-1',
      sessionEpoch: 1,
    });

    transport.establish('socket-2');
    await flushPromises();
    expect(transport.registerCallbacks).toHaveLength(2);
    expect(controller.getSnapshot().sessionEpoch).toBe(2);

    transport.registerCallbacks[1]({ success: true });
    await flushPromises();
    expect(transport.joins).toHaveLength(1);
    transport.joins[0].callback({ success: true, room: room('room-1') });
    await expect(joining).resolves.toMatchObject({ room: { id: 'room-1' } });

    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      socketId: 'socket-2',
      sessionEpoch: 2,
      resyncRevision: 1,
    });
  });

  it('restarts the full session on a new socket after disconnecting during join', async () => {
    transport.establish('socket-1');
    const joining = controller.selectRoom({ roomId: 'room-1' });
    await flushPromises();
    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    expect(transport.joins).toHaveLength(1);

    transport.disconnect();
    transport.establish('socket-2');
    await flushPromises();
    transport.registerCallbacks[1]({ success: true });
    await flushPromises();
    expect(transport.joins).toHaveLength(2);
    transport.joins[1].callback({ success: true, room: room('room-1') });

    await expect(joining).resolves.toMatchObject({ room: { id: 'room-1' } });
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      socketId: 'socket-2',
      sessionEpoch: 2,
    });
  });

  it('keeps the active registration drive alive when a same-room resume arrives before its ack', async () => {
    transport.establish('socket-1');
    const joining = controller.selectRoom({ roomId: 'room-1', source: 'storage' });
    await flushPromises();
    expect(transport.registerCallbacks).toHaveLength(1);

    const resumed = controller.resume('pageshow');
    expect(resumed).toBe(joining);

    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    expect(transport.registerCallbacks).toHaveLength(1);
    expect(transport.joins).toHaveLength(1);

    transport.joins[0].callback({ success: true, room: room('room-1') });
    await expect(Promise.all([joining, resumed])).resolves.toHaveLength(2);
    expect(transport.leaves).toHaveLength(0);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      roomId: 'room-1',
      sessionEpoch: 1,
      resyncRevision: 1,
    });
  });

  it('accepts a pending join ack after a same-room resume without leaving the room', async () => {
    transport.establish('socket-1');
    const joining = controller.selectRoom({ roomId: 'room-1', source: 'storage' });
    await flushPromises();
    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    expect(transport.joins).toHaveLength(1);

    const resumed = controller.resume('visibility');
    expect(resumed).toBe(joining);

    transport.joins[0].callback({ success: true, room: room('room-1') });
    await expect(Promise.all([joining, resumed])).resolves.toHaveLength(2);
    expect(transport.joins).toHaveLength(1);
    expect(transport.leaves).toHaveLength(0);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      roomId: 'room-1',
      sessionEpoch: 1,
      resyncRevision: 1,
    });
  });

  it('treats same-room navigation as navigation instead of a new session epoch', async () => {
    transport.establish('socket-1');
    const firstJoin = controller.selectRoom({ roomId: 'room-1', source: 'manual' });
    await flushPromises();
    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    transport.joins[0].callback({ success: true, room: room('room-1') });
    await firstJoin;

    const before = controller.getSnapshot();
    await expect(controller.selectRoom({ roomId: 'room-1', source: 'manual' })).resolves.toMatchObject({
      room: { id: 'room-1' },
    });

    expect(transport.registerCallbacks).toHaveLength(1);
    expect(transport.joins).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      sessionEpoch: before.sessionEpoch,
      resyncRevision: before.resyncRevision,
    });
  });

  it('coalesces foreground signals into one resync revision without joining again', async () => {
    vi.useFakeTimers();
    transport.establish('socket-1');
    const firstJoin = controller.selectRoom({ roomId: 'room-1' });
    await flushPromises();
    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    transport.joins[0].callback({ success: true, room: room('room-1') });
    await firstJoin;

    const revision = controller.getSnapshot().resyncRevision;
    await controller.resume('pageshow');
    await controller.resume('visibility');
    await controller.resume('online');
    await vi.advanceTimersByTimeAsync(10);

    expect(controller.getSnapshot().resyncRevision).toBe(revision + 1);
    expect(transport.joins).toHaveLength(1);
  });

  it('ignores a superseded room result and lets the newer serialized join own readiness', async () => {
    transport.establish('socket-1');
    const joinA = controller.selectRoom({ roomId: 'room-a', password: 'a' });
    const joinAOutcome = joinA.catch(error => error);
    await flushPromises();
    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    expect(transport.joins).toHaveLength(1);

    const joinB = controller.selectRoom({ roomId: 'room-b', password: 'b' });
    await expect(joinAOutcome).resolves.toBeInstanceOf(RoomSessionSupersededError);
    await flushPromises();
    expect(transport.joins).toHaveLength(2);

    transport.joins[0].callback({ success: true, room: room('room-a') });
    await flushPromises();
    expect(controller.getSnapshot()).toMatchObject({ roomId: 'room-b' });
    expect(transport.leaves).toContain('room-a');

    transport.joins[1].callback({ success: true, room: room('room-b') });
    await expect(joinB).resolves.toMatchObject({ room: { id: 'room-b' } });
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      roomId: 'room-b',
      sessionEpoch: 2,
    });
  });

  it('retries a timed-out join within the same epoch and advances resync only on ready', async () => {
    vi.useFakeTimers();
    transport.establish('socket-1');
    const joining = controller.selectRoom({ roomId: 'room-1' });
    await flushPromises();
    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    expect(transport.joins).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(transport.joins).toHaveLength(2);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'retrying',
      sessionEpoch: 1,
      resyncRevision: 0,
    });

    transport.joins[1].callback({ success: true, room: room('room-1') });
    await expect(joining).resolves.toMatchObject({ room: { id: 'room-1' } });
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      sessionEpoch: 1,
      resyncRevision: 1,
    });
  });

  it('cleans up a late successful join after leaving while it is pending', async () => {
    transport.establish('socket-1');
    const joining = controller.selectRoom({ roomId: 'room-1' });
    const joiningOutcome = joining.catch(error => error);
    await flushPromises();
    transport.registerCallbacks[0]({ success: true });
    await flushPromises();
    expect(transport.joins).toHaveLength(1);

    controller.leaveRoom('room-1');
    await expect(joiningOutcome).resolves.toBeInstanceOf(RoomSessionSupersededError);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', roomId: null, sessionEpoch: 2 });

    transport.joins[0].callback({ success: true, room: room('room-1') });
    await flushPromises();
    expect(transport.leaves.filter(roomId => roomId === 'room-1')).toHaveLength(2);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', roomId: null });
  });
});
