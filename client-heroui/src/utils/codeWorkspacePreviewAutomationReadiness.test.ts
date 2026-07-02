import { describe, expect, it } from 'vitest';
import {
  codeWorkspacePreviewAutomationOpenNeedsReadiness,
  codeWorkspacePreviewAutomationReadiness,
  codeWorkspacePreviewAutomationTimeoutMs,
} from './codeWorkspacePreviewAutomationReadiness';
import type { CodeWorkspacePreviewNavStatus } from './codeWorkspacePreviewSessions';

const snapshot = (status: CodeWorkspacePreviewNavStatus): CodeWorkspacePreviewNavStatus => status;

describe('codeWorkspacePreviewAutomationReadiness', () => {
  it('defaults navigation readiness to load', () => {
    expect(codeWorkspacePreviewAutomationReadiness({})).toBe('load');
    expect(codeWorkspacePreviewAutomationReadiness({ readiness: 'load' })).toBe('load');
    expect(codeWorkspacePreviewAutomationReadiness({ readiness: 'domContentLoaded' })).toBe('domContentLoaded');
    expect(codeWorkspacePreviewAutomationReadiness({ readiness: 'none' })).toBe('none');
    expect(codeWorkspacePreviewAutomationReadiness({ readiness: 'paint' })).toBe('load');
  });

  it('clamps nested navigation timeout values', () => {
    expect(codeWorkspacePreviewAutomationTimeoutMs({}, 15000)).toBe(15000);
    expect(codeWorkspacePreviewAutomationTimeoutMs({ timeoutMs: 250 }, 15000)).toBe(250);
    expect(codeWorkspacePreviewAutomationTimeoutMs({ timeoutMs: -1 }, 15000)).toBe(1);
    expect(codeWorkspacePreviewAutomationTimeoutMs({ timeoutMs: 120000 }, 15000)).toBe(60000);
  });

  it('matches open readiness to URL inputs or existing rendered content', () => {
    expect(codeWorkspacePreviewAutomationOpenNeedsReadiness(
      {},
      snapshot({ _tag: 'Idle' }),
    )).toBe(false);
    expect(codeWorkspacePreviewAutomationOpenNeedsReadiness(
      { url: 'https://example.com' },
      snapshot({ _tag: 'Idle' }),
    )).toBe(true);
    expect(codeWorkspacePreviewAutomationOpenNeedsReadiness(
      {},
      snapshot({ _tag: 'Success', url: 'https://example.com/', title: 'Example' }),
    )).toBe(true);
  });
});
