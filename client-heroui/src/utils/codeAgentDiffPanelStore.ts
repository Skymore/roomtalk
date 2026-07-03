import { useEffect, useSyncExternalStore } from 'react';
import type { CodeAgentWorkspaceDiffScope } from './cocoWorkspace';

export type CodeAgentDiffPanelSelection =
  | { kind: 'branch'; baseRef: string | null; filePath: string | null; revealRequestId: number }
  | { kind: 'unstaged'; filePath: string | null; revealRequestId: number };

export const CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID = 'git:branch-range';
export const CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID = 'git:working-tree';
export type CodeAgentDiffReviewSectionId =
  | typeof CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID
  | typeof CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID;

interface CodeAgentDiffPanelStoreState {
  byRoomId: Record<string, CodeAgentDiffPanelSelection>;
  branchBaseRefByRoomId: Record<string, string | null>;
}

interface PersistedCodeAgentDiffPanelStore {
  state?: Partial<CodeAgentDiffPanelStoreState>;
  version?: number;
}

const STORAGE_KEY = 'roomtalk.codeWorkspace.diffPanelState.v1';
const LEGACY_DIFF_SCOPE_STORAGE_KEY = 'roomtalk.codeWorkspace.diffScope';
const LEGACY_DIFF_BASE_REF_STORAGE_PREFIX = 'roomtalk.codeWorkspace.diffBaseRef.';
const DEFAULT_SELECTION: CodeAgentDiffPanelSelection = {
  kind: 'branch',
  baseRef: null,
  filePath: null,
  revealRequestId: 0,
};

const listeners = new Set<() => void>();

function normalizeRoomId(roomId: string): string {
  return roomId.trim();
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

function normalizeFilePath(filePath: string | null | undefined): string | null {
  const normalized = filePath?.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  return normalized ? normalized : null;
}

function emptyState(): CodeAgentDiffPanelStoreState {
  return {
    byRoomId: {},
    branchBaseRefByRoomId: {},
  };
}

function coerceSelection(value: unknown): CodeAgentDiffPanelSelection | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<CodeAgentDiffPanelSelection>;
  const rawRevealRequestId = (value as { revealRequestId?: unknown }).revealRequestId;
  const filePath = normalizeFilePath(candidate.filePath);
  const revealRequestId = typeof rawRevealRequestId === 'number' &&
    Number.isSafeInteger(rawRevealRequestId) &&
    rawRevealRequestId >= 0
    ? rawRevealRequestId
    : 0;
  if (candidate.kind === 'branch') {
    return {
      kind: 'branch',
      baseRef: normalizeBaseRef(candidate.baseRef ?? null),
      filePath,
      revealRequestId,
    };
  }
  if (candidate.kind === 'unstaged') {
    return {
      kind: 'unstaged',
      filePath,
      revealRequestId,
    };
  }
  return null;
}

function readPersistedState(): CodeAgentDiffPanelStoreState {
  if (typeof window === 'undefined') {
    return emptyState();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return emptyState();
    }
    const payload = JSON.parse(raw) as PersistedCodeAgentDiffPanelStore;
    const byRoomId: Record<string, CodeAgentDiffPanelSelection> = {};
    for (const [roomId, selection] of Object.entries(payload.state?.byRoomId ?? {})) {
      const normalizedRoomId = normalizeRoomId(roomId);
      const coerced = coerceSelection(selection);
      if (normalizedRoomId && coerced) {
        byRoomId[normalizedRoomId] = coerced;
      }
    }

    const branchBaseRefByRoomId: Record<string, string | null> = {};
    for (const [roomId, baseRef] of Object.entries(payload.state?.branchBaseRefByRoomId ?? {})) {
      const normalizedRoomId = normalizeRoomId(roomId);
      if (normalizedRoomId) {
        branchBaseRefByRoomId[normalizedRoomId] = normalizeBaseRef(
          typeof baseRef === 'string' ? baseRef : null,
        );
      }
    }

    return { byRoomId, branchBaseRefByRoomId };
  } catch {
    return emptyState();
  }
}

let storeState: CodeAgentDiffPanelStoreState = readPersistedState();

function writePersistedState(state: CodeAgentDiffPanelStoreState) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      state,
      version: 1,
    }));
  } catch {
    // Persistence is best-effort; the live store remains usable.
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

function updateStore(updater: (state: CodeAgentDiffPanelStoreState) => CodeAgentDiffPanelStoreState) {
  const nextState = updater(storeState);
  if (nextState === storeState) {
    return;
  }
  storeState = nextState;
  writePersistedState(storeState);
  emit();
}

function readLegacySelection(roomId: string): CodeAgentDiffPanelSelection | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const legacyScope = window.localStorage.getItem(LEGACY_DIFF_SCOPE_STORAGE_KEY);
    const legacyBaseRef = window.localStorage.getItem(`${LEGACY_DIFF_BASE_REF_STORAGE_PREFIX}${roomId}`);
    if (legacyScope !== 'unstaged' && legacyScope !== 'branch' && legacyBaseRef === null) {
      return null;
    }
    if (legacyScope === 'unstaged') {
      return { kind: 'unstaged', filePath: null, revealRequestId: 0 };
    }
    return {
      kind: 'branch',
      baseRef: normalizeBaseRef(legacyBaseRef),
      filePath: null,
      revealRequestId: 0,
    };
  } catch {
    return null;
  }
}

function migrateLegacyRoomSelection(roomId: string): string {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return roomKey;
  }
  if (storeState.byRoomId[roomKey]) {
    return roomKey;
  }
  const legacySelection = readLegacySelection(roomKey);
  if (!legacySelection) {
    return roomKey;
  }
  storeState = {
    byRoomId: {
      ...storeState.byRoomId,
      [roomKey]: legacySelection,
    },
    branchBaseRefByRoomId: {
      ...storeState.branchBaseRefByRoomId,
      ...(legacySelection.kind === 'branch' ? { [roomKey]: legacySelection.baseRef } : {}),
    },
  };
  writePersistedState(storeState);
  return roomKey;
}

function selectRoomSelection(roomId: string): CodeAgentDiffPanelSelection {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return DEFAULT_SELECTION;
  }
  return storeState.byRoomId[roomKey] ?? readLegacySelection(roomKey) ?? DEFAULT_SELECTION;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCodeAgentDiffPanelSelection(roomId: string): CodeAgentDiffPanelSelection {
  useEffect(() => {
    const roomKey = migrateLegacyRoomSelection(roomId);
    if (roomKey && storeState.byRoomId[roomKey]) {
      emit();
    }
  }, [roomId]);

  return useSyncExternalStore(
    subscribe,
    () => selectRoomSelection(roomId),
    () => DEFAULT_SELECTION,
  );
}

export function readCodeAgentDiffPanelSelection(roomId: string): CodeAgentDiffPanelSelection {
  migrateLegacyRoomSelection(roomId);
  return selectRoomSelection(roomId);
}

export function selectCodeAgentDiffScope(roomId: string, scope: CodeAgentWorkspaceDiffScope) {
  const roomKey = migrateLegacyRoomSelection(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => {
    const previous = state.byRoomId[roomKey];
    const previousBaseRef = previous?.kind === 'branch'
      ? previous.baseRef
      : (state.branchBaseRefByRoomId[roomKey] ?? null);
    return {
      byRoomId: {
        ...state.byRoomId,
        [roomKey]: scope === 'branch'
          ? { kind: 'branch', baseRef: previousBaseRef, filePath: null, revealRequestId: 0 }
          : { kind: 'unstaged', filePath: null, revealRequestId: 0 },
      },
      branchBaseRefByRoomId: previous?.kind === 'branch'
        ? { ...state.branchBaseRefByRoomId, [roomKey]: previous.baseRef }
        : state.branchBaseRefByRoomId,
    };
  });
}

export function getCodeAgentDiffReviewSectionId(
  selection: CodeAgentDiffPanelSelection,
): CodeAgentDiffReviewSectionId {
  return selection.kind === 'unstaged'
    ? CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID
    : CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID;
}

export function getCodeAgentDiffScopeForReviewSectionId(
  sectionId: CodeAgentDiffReviewSectionId,
): CodeAgentWorkspaceDiffScope {
  return sectionId === CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID ? 'unstaged' : 'branch';
}

export function selectCodeAgentDiffReviewSection(
  roomId: string,
  sectionId: CodeAgentDiffReviewSectionId,
) {
  selectCodeAgentDiffScope(roomId, getCodeAgentDiffScopeForReviewSectionId(sectionId));
}

export function selectCodeAgentDiffBranchBaseRef(roomId: string, baseRef: string | null) {
  const roomKey = migrateLegacyRoomSelection(roomId);
  if (!roomKey) {
    return;
  }
  const normalizedBaseRef = normalizeBaseRef(baseRef);
  updateStore((state) => ({
    byRoomId: {
      ...state.byRoomId,
      [roomKey]: {
        kind: 'branch',
        baseRef: normalizedBaseRef,
        filePath: null,
        revealRequestId: 0,
      },
    },
    branchBaseRefByRoomId: {
      ...state.branchBaseRefByRoomId,
      [roomKey]: normalizedBaseRef,
    },
  }));
}

export function selectCodeAgentDiffFile(roomId: string, filePath: string) {
  const roomKey = migrateLegacyRoomSelection(roomId);
  const normalizedFilePath = normalizeFilePath(filePath);
  if (!roomKey || !normalizedFilePath) {
    return;
  }
  updateStore((state) => {
    const previous = state.byRoomId[roomKey] ?? DEFAULT_SELECTION;
    const nextRevealRequestId = previous.revealRequestId + 1;
    return {
      ...state,
      byRoomId: {
        ...state.byRoomId,
        [roomKey]: previous.kind === 'branch'
          ? {
            kind: 'branch',
            baseRef: previous.baseRef,
            filePath: normalizedFilePath,
            revealRequestId: nextRevealRequestId,
          }
          : {
            kind: 'unstaged',
            filePath: normalizedFilePath,
            revealRequestId: nextRevealRequestId,
          },
      },
    };
  });
}

export function clearCodeAgentDiffFile(roomId: string) {
  const roomKey = migrateLegacyRoomSelection(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => {
    const previous = state.byRoomId[roomKey];
    if (!previous?.filePath) {
      return state;
    }
    return {
      ...state,
      byRoomId: {
        ...state.byRoomId,
        [roomKey]: previous.kind === 'branch'
          ? { ...previous, filePath: null }
          : { ...previous, filePath: null },
      },
    };
  });
}

export function removeCodeAgentDiffPanelRoom(roomId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => {
    if (!(roomKey in state.byRoomId) && !(roomKey in state.branchBaseRefByRoomId)) {
      return state;
    }
    const { [roomKey]: _removedSelection, ...byRoomId } = state.byRoomId;
    const { [roomKey]: _removedBaseRef, ...branchBaseRefByRoomId } = state.branchBaseRefByRoomId;
    return { byRoomId, branchBaseRefByRoomId };
  });
}

export function resetCodeAgentDiffPanelStoreForTests(state: CodeAgentDiffPanelStoreState = emptyState()) {
  storeState = state;
  writePersistedState(storeState);
  emit();
}
