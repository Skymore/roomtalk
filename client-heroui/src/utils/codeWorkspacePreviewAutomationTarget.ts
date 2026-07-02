import type { CodeWorkspacePreviewSession } from './codeWorkspacePreviewSessions';

export interface CodeWorkspacePreviewAutomationSessionIndex {
  readonly snapshot: CodeWorkspacePreviewSession | null;
  readonly sessions: Readonly<Record<string, CodeWorkspacePreviewSession>>;
}

export function needsCodeWorkspacePreviewAutomationSessionSync(
  state: CodeWorkspacePreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
): boolean {
  return (
    Object.keys(state.sessions).length === 0 ||
    requestedTabId === undefined ||
    state.sessions[requestedTabId] === undefined
  );
}

export function resolveCodeWorkspacePreviewAutomationTarget(
  state: CodeWorkspacePreviewAutomationSessionIndex,
  requestedTabId: string | null,
): { readonly tabId: string | null; readonly snapshot: CodeWorkspacePreviewSession | null } {
  const snapshot = requestedTabId ? (state.sessions[requestedTabId] ?? null) : state.snapshot;
  return { tabId: snapshot?.tabId ?? null, snapshot };
}

export function resolveCodeWorkspacePreviewAutomationOpenTab(
  state: CodeWorkspacePreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
  reuseExistingTab: boolean,
): string | null {
  if (!reuseExistingTab) return null;
  if (requestedTabId !== undefined) {
    return state.sessions[requestedTabId]?.tabId ?? null;
  }
  return state.snapshot?.tabId ?? null;
}
