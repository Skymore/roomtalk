import { useSyncExternalStore } from 'react';

type ChangedFilesExpansionState = Record<string, Record<string, false>>;

const STORAGE_KEY = 'roomtalk.codeAgent.changedFilesExpanded.v1';
const listeners = new Set<() => void>();

function normalizeKey(value: string): string {
  return value.trim();
}

function sanitizeState(value: unknown): ChangedFilesExpansionState {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const nextState: ChangedFilesExpansionState = {};
  for (const [roomId, scopes] of Object.entries(value)) {
    const roomKey = normalizeKey(roomId);
    if (!roomKey || !scopes || typeof scopes !== 'object') {
      continue;
    }
    const nextScopes: Record<string, false> = {};
    for (const [scopeKey, expanded] of Object.entries(scopes)) {
      const normalizedScopeKey = normalizeKey(scopeKey);
      if (normalizedScopeKey && expanded === false) {
        nextScopes[normalizedScopeKey] = false;
      }
    }
    if (Object.keys(nextScopes).length > 0) {
      nextState[roomKey] = nextScopes;
    }
  }
  return nextState;
}

function readPersistedState(): ChangedFilesExpansionState {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    return sanitizeState(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    return {};
  }
}

let expansionState = readPersistedState();

function writePersistedState(state: ChangedFilesExpansionState) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is best-effort; live expansion state remains available.
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function selectExpanded(roomId: string, scopeKey: string): boolean {
  const roomKey = normalizeKey(roomId);
  const normalizedScopeKey = normalizeKey(scopeKey);
  if (!roomKey || !normalizedScopeKey) {
    return true;
  }
  return expansionState[roomKey]?.[normalizedScopeKey] ?? true;
}

export function readCodeAgentChangedFilesExpanded(roomId: string, scopeKey: string): boolean {
  return selectExpanded(roomId, scopeKey);
}

export function setCodeAgentChangedFilesExpanded(roomId: string, scopeKey: string, expanded: boolean) {
  const roomKey = normalizeKey(roomId);
  const normalizedScopeKey = normalizeKey(scopeKey);
  if (!roomKey || !normalizedScopeKey) {
    return;
  }

  const currentExpanded = selectExpanded(roomKey, normalizedScopeKey);
  if (currentExpanded === expanded) {
    return;
  }

  let nextState: ChangedFilesExpansionState;
  if (expanded) {
    const currentRoomState = expansionState[roomKey];
    if (!currentRoomState || !(normalizedScopeKey in currentRoomState)) {
      return;
    }
    const nextRoomState = { ...currentRoomState };
    delete nextRoomState[normalizedScopeKey];
    if (Object.keys(nextRoomState).length === 0) {
      const { [roomKey]: _removed, ...rest } = expansionState;
      nextState = rest;
    } else {
      nextState = {
        ...expansionState,
        [roomKey]: nextRoomState,
      };
    }
  } else {
    nextState = {
      ...expansionState,
      [roomKey]: {
        ...(expansionState[roomKey] || {}),
        [normalizedScopeKey]: false,
      },
    };
  }

  expansionState = nextState;
  writePersistedState(expansionState);
  emit();
}

export function useCodeAgentChangedFilesExpanded(roomId: string, scopeKey: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => selectExpanded(roomId, scopeKey),
    () => true,
  );
}

export function resetCodeAgentChangedFilesExpansionStoreForTests() {
  expansionState = readPersistedState();
  listeners.clear();
}
