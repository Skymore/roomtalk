import { describe, expect, it } from 'vitest';
import { formatCodeAgentWorkspaceRelativePath } from './codeAgentFilePathDisplay';

describe('codeAgentFilePathDisplay', () => {
  it('formats absolute workspace paths from the workspace root like T3', () => {
    expect(
      formatCodeAgentWorkspaceRelativePath(
        'C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501',
        'C:/Users/mike/dev-stuff/t3code',
      ),
    ).toBe('t3code/apps/web/src/session-logic.ts:501');
  });

  it('prefixes relative paths with the workspace root label like T3', () => {
    expect(
      formatCodeAgentWorkspaceRelativePath(
        'apps/web/src/session-logic.ts:501',
        'C:/Users/mike/dev-stuff/t3code',
      ),
    ).toBe('t3code/apps/web/src/session-logic.ts:501');
  });

  it('keeps paths already rooted at the workspace label stable', () => {
    expect(
      formatCodeAgentWorkspaceRelativePath(
        't3code/apps/web/src/session-logic.ts:501',
        'C:/Users/mike/dev-stuff/t3code',
      ),
    ).toBe('t3code/apps/web/src/session-logic.ts:501');
  });

  it('preserves columns when present', () => {
    expect(
      formatCodeAgentWorkspaceRelativePath(
        '/C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501:9',
        'C:/Users/mike/dev-stuff/t3code',
      ),
    ).toBe('t3code/apps/web/src/session-logic.ts:501:9');
  });

  it('formats cloud sandbox paths against the default workspace root', () => {
    expect(formatCodeAgentWorkspaceRelativePath('/workspace/src/App.tsx:42', '/workspace')).toBe(
      'workspace/src/App.tsx:42',
    );
    expect(formatCodeAgentWorkspaceRelativePath('src/App.tsx:42', '/workspace')).toBe(
      'workspace/src/App.tsx:42',
    );
  });
});
