import { describe, expect, it } from 'vitest';
import { RoomMessageSyncStateMachine } from './roomMessageSyncStateMachine';

describe('RoomMessageSyncStateMachine', () => {
  it('keeps replace recovery authoritative over concurrent prepend pagination', () => {
    const state = new RoomMessageSyncStateMachine();

    expect(state.requestReplay()).toBe(true);
    const replace = state.beginSnapshot('replace');
    expect(replace).not.toBeNull();
    expect(state.phase).toBe('replace');
    expect(state.beginSnapshot('prepend')).toBeNull();
    expect(state.isSnapshotCurrent(replace!)).toBe(true);

    state.finishSnapshot(replace!);
    expect(state.phase).toBe('replay');
  });

  it('invalidates an older prepend response when replacement recovery starts', () => {
    const state = new RoomMessageSyncStateMachine();
    const prepend = state.beginSnapshot('prepend');
    expect(prepend).not.toBeNull();

    const replace = state.beginSnapshot('replace');
    expect(replace).not.toBeNull();
    expect(state.isSnapshotCurrent(prepend!)).toBe(false);
    expect(state.isSnapshotCurrent(replace!)).toBe(true);
  });

  it('invalidates an in-flight prepend as soon as replay is requested', () => {
    const state = new RoomMessageSyncStateMachine();
    const prepend = state.beginSnapshot('prepend');
    expect(prepend).not.toBeNull();

    expect(state.requestReplay()).toBe(true);

    expect(state.isSnapshotCurrent(prepend!)).toBe(false);
    expect(state.phase).toBe('replay');
  });

  it('invalidates an in-flight prepend before applying a contiguous fast path', () => {
    const state = new RoomMessageSyncStateMachine();
    const prepend = state.beginSnapshot('prepend');
    expect(prepend).not.toBeNull();

    state.beginRealtimeMutation();

    expect(state.isSnapshotCurrent(prepend!)).toBe(false);
    expect(state.phase).toBe('idle');
  });

  it('drops restored-database watermarks and gap targets together', () => {
    const state = new RoomMessageSyncStateMachine();
    state.applyCursor(20);
    state.notifyHead(30);
    state.markGapSnapshot(30);

    state.resetForCursorAhead();

    expect(state.desiredHeadSeq).toBe(0);
    expect(state.lastGapSnapshotTarget).toBe(0);
  });

  it('preserves notifications that arrive while a replacement snapshot is in flight', () => {
    const state = new RoomMessageSyncStateMachine();
    state.notifyHead(20);
    state.resetForCursorAhead();
    const replace = state.beginSnapshot('replace');
    state.notifyHead(9);

    state.applyReplacementSnapshot(8);
    state.finishSnapshot(replace!);

    expect(state.lastAppliedSeq).toBe(8);
    expect(state.desiredHeadSeq).toBe(9);
    expect(state.needsReplay).toBe(true);
  });
});
