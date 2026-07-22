export type RoomMessageSyncPhase = 'idle' | 'replay' | 'replace' | 'prepend';
export type RoomMessageSnapshotMode = 'replace' | 'prepend';

export interface RoomMessageSnapshotToken {
  mode: RoomMessageSnapshotMode;
  generation: number;
  replaceGenerationAtStart: number;
}

/**
 * Owns the ordering state for one room. React state remains a projection of
 * this controller; cursor recovery, replacement snapshots, and pagination do
 * not invalidate one another through unrelated counters.
 */
export class RoomMessageSyncStateMachine {
  private replayRunning = false;
  private replayRequested = false;
  private replaceGeneration = 0;
  private prependGeneration = 0;
  private activeReplaceGeneration: number | null = null;
  private activePrependGeneration: number | null = null;
  private historyInvalidated = false;

  lastAppliedSeq = 0;
  desiredHeadSeq = 0;
  lastGapSnapshotTarget = 0;

  get phase(): RoomMessageSyncPhase {
    if (this.activeReplaceGeneration !== null) return 'replace';
    if (this.activePrependGeneration !== null) return 'prepend';
    return this.replayRunning ? 'replay' : 'idle';
  }

  requestReplay(): boolean {
    this.invalidatePrepend();
    this.replayRequested = true;
    if (this.replayRunning) return false;
    this.replayRunning = true;
    return true;
  }

  beginRealtimeMutation(): void {
    this.invalidatePrepend();
  }

  consumeReplayRequest(): boolean {
    if (!this.replayRequested) return false;
    this.replayRequested = false;
    return true;
  }

  finishReplay(): boolean {
    this.replayRunning = false;
    return this.replayRequested;
  }

  beginSnapshot(mode: RoomMessageSnapshotMode): RoomMessageSnapshotToken | null {
    if (mode === 'prepend') {
      // Historical pagination is optional UI work. It must never supersede a
      // live replay or replacement recovery already in progress.
      if (this.replayRunning || this.activeReplaceGeneration !== null) return null;
      const generation = ++this.prependGeneration;
      this.activePrependGeneration = generation;
      return { mode, generation, replaceGenerationAtStart: this.replaceGeneration };
    }

    const generation = ++this.replaceGeneration;
    this.activeReplaceGeneration = generation;
    this.prependGeneration += 1;
    this.activePrependGeneration = null;
    return { mode, generation, replaceGenerationAtStart: generation };
  }

  isSnapshotCurrent(token: RoomMessageSnapshotToken): boolean {
    if (token.mode === 'replace') {
      return this.activeReplaceGeneration === token.generation
        && this.replaceGeneration === token.generation;
    }
    return this.activePrependGeneration === token.generation
      && this.prependGeneration === token.generation
      && this.replaceGeneration === token.replaceGenerationAtStart
      && this.activeReplaceGeneration === null;
  }

  finishSnapshot(token: RoomMessageSnapshotToken): void {
    if (token.mode === 'replace' && this.activeReplaceGeneration === token.generation) {
      this.activeReplaceGeneration = null;
    }
    if (token.mode === 'prepend' && this.activePrependGeneration === token.generation) {
      this.activePrependGeneration = null;
    }
  }

  notifyHead(headSeq: number): void {
    this.desiredHeadSeq = Math.max(this.desiredHeadSeq, headSeq);
  }

  applyCursor(seq: number): void {
    this.lastAppliedSeq = seq;
  }

  applyReplacementSnapshot(snapshotSeq: number): void {
    this.lastAppliedSeq = snapshotSeq;
    this.desiredHeadSeq = Math.max(this.desiredHeadSeq, snapshotSeq);
    this.historyInvalidated = false;
  }

  resetForCursorAhead(): void {
    this.desiredHeadSeq = 0;
    this.lastGapSnapshotTarget = 0;
  }

  markGapSnapshot(targetSeq: number): void {
    this.lastGapSnapshotTarget = targetSeq;
  }

  shouldReplaceLargeGap(headSeq: number, threshold: number): boolean {
    return headSeq - this.lastAppliedSeq > threshold
      && headSeq > this.lastGapSnapshotTarget;
  }

  markHistoryInvalidated(): void {
    this.historyInvalidated = true;
  }

  clearHistoryInvalidated(): void {
    this.historyInvalidated = false;
  }

  get needsHistorySnapshot(): boolean {
    return this.historyInvalidated;
  }

  get needsReplay(): boolean {
    return this.lastAppliedSeq < this.desiredHeadSeq || this.historyInvalidated;
  }

  private invalidatePrepend(): void {
    if (this.activePrependGeneration === null) return;
    this.prependGeneration += 1;
    this.activePrependGeneration = null;
  }
}
