import { useSyncExternalStore } from 'react';

export interface CodeAgentDiffFileVisibilityEntry {
  readonly collapsedFileKeys: readonly string[];
  readonly viewedFileKeys: readonly string[];
  readonly revealedLargeFileKeys: readonly string[];
}

interface CodeAgentDiffFileVisibilityStoreState {
  byScopeKey: Record<string, CodeAgentDiffFileVisibilityEntry>;
}

interface PersistedCodeAgentDiffFileVisibilityStore {
  state?: Partial<CodeAgentDiffFileVisibilityStoreState>;
  version?: number;
}

const STORAGE_KEY = 'roomtalk.codeWorkspace.diffFileVisibility.v1';
const EMPTY_VISIBILITY: CodeAgentDiffFileVisibilityEntry = {
  collapsedFileKeys: [],
  viewedFileKeys: [],
  revealedLargeFileKeys: [],
};

const listeners = new Set<() => void>();

function emptyState(): CodeAgentDiffFileVisibilityStoreState {
  return { byScopeKey: {} };
}

function normalizeScopeKey(scopeKey: string): string {
  return scopeKey.trim();
}

function normalizeFileKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const keys: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const key = entry.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function coerceEntry(value: unknown): CodeAgentDiffFileVisibilityEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<CodeAgentDiffFileVisibilityEntry>;
  return {
    collapsedFileKeys: normalizeFileKeys(candidate.collapsedFileKeys),
    viewedFileKeys: normalizeFileKeys(candidate.viewedFileKeys),
    revealedLargeFileKeys: normalizeFileKeys(candidate.revealedLargeFileKeys),
  };
}

function readPersistedState(): CodeAgentDiffFileVisibilityStoreState {
  if (typeof window === 'undefined') {
    return emptyState();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return emptyState();
    }
    const payload = JSON.parse(raw) as PersistedCodeAgentDiffFileVisibilityStore;
    const byScopeKey: Record<string, CodeAgentDiffFileVisibilityEntry> = {};
    for (const [scopeKey, entry] of Object.entries(payload.state?.byScopeKey ?? {})) {
      const normalizedScopeKey = normalizeScopeKey(scopeKey);
      const coerced = coerceEntry(entry);
      if (normalizedScopeKey && coerced) {
        byScopeKey[normalizedScopeKey] = coerced;
      }
    }
    return { byScopeKey };
  } catch {
    return emptyState();
  }
}

let storeState: CodeAgentDiffFileVisibilityStoreState = readPersistedState();

function writePersistedState(state: CodeAgentDiffFileVisibilityStoreState) {
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function updateStore(
  updater: (state: CodeAgentDiffFileVisibilityStoreState) => CodeAgentDiffFileVisibilityStoreState,
) {
  const nextState = updater(storeState);
  if (nextState === storeState) {
    return;
  }
  storeState = nextState;
  writePersistedState(storeState);
  emit();
}

export function readCodeAgentDiffFileVisibility(scopeKey: string): CodeAgentDiffFileVisibilityEntry {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  if (!normalizedScopeKey) {
    return EMPTY_VISIBILITY;
  }
  return storeState.byScopeKey[normalizedScopeKey] ?? EMPTY_VISIBILITY;
}

export function useCodeAgentDiffFileVisibility(scopeKey: string): CodeAgentDiffFileVisibilityEntry {
  return useSyncExternalStore(
    subscribe,
    () => readCodeAgentDiffFileVisibility(scopeKey),
    () => EMPTY_VISIBILITY,
  );
}

export function updateCodeAgentDiffFileVisibility(
  scopeKey: string,
  updater: (current: CodeAgentDiffFileVisibilityEntry) => CodeAgentDiffFileVisibilityEntry,
) {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  if (!normalizedScopeKey) {
    return;
  }

  updateStore((state) => {
    const current = state.byScopeKey[normalizedScopeKey] ?? EMPTY_VISIBILITY;
    const nextEntry = coerceEntry(updater(current)) ?? EMPTY_VISIBILITY;
    return {
      byScopeKey: {
        ...state.byScopeKey,
        [normalizedScopeKey]: nextEntry,
      },
    };
  });
}

export function removeCodeAgentDiffFileVisibilityScope(scopeKey: string) {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  if (!normalizedScopeKey) {
    return;
  }

  updateStore((state) => {
    if (!(normalizedScopeKey in state.byScopeKey)) {
      return state;
    }
    const { [normalizedScopeKey]: _removed, ...byScopeKey } = state.byScopeKey;
    return { byScopeKey };
  });
}

export function resetCodeAgentDiffFileVisibilityStoreForTests(
  state: CodeAgentDiffFileVisibilityStoreState = emptyState(),
) {
  storeState = state;
  writePersistedState(storeState);
  emit();
}
