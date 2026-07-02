import type { CodeWorkspacePreviewNavStatus } from './codeWorkspacePreviewSessions';

export type CodeWorkspacePreviewAutomationReadiness = 'load' | 'domContentLoaded' | 'none';

type AutomationInput = Record<string, unknown>;

function isRecord(value: unknown): value is AutomationInput {
  return typeof value === 'object' && value !== null;
}

export function codeWorkspacePreviewAutomationReadiness(
  input: unknown,
): CodeWorkspacePreviewAutomationReadiness {
  const readiness = isRecord(input) ? input.readiness : undefined;
  return readiness === 'domContentLoaded' || readiness === 'none' ? readiness : 'load';
}

export function codeWorkspacePreviewAutomationTimeoutMs(
  input: unknown,
  fallback: number,
): number {
  const value = isRecord(input) ? input.timeoutMs : undefined;
  const timeout = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(1, Math.round(timeout)), 60000);
}

export function codeWorkspacePreviewAutomationOpenNeedsReadiness(
  input: unknown,
  navStatus: CodeWorkspacePreviewNavStatus,
): boolean {
  return (isRecord(input) && typeof input.url === 'string' && input.url.trim().length > 0)
    || navStatus._tag !== 'Idle';
}
