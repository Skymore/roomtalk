import { describe, expect, it } from 'vitest';
import {
  normalizeWorkspaceOpenPath,
  parseWorkspaceFileOpenTarget,
} from './workspaceFileOpenTarget';

describe('workspace file open targets', () => {
  it('normalizes workspace-prefixed paths', () => {
    expect(normalizeWorkspaceOpenPath('/workspace/src/App.tsx')).toBe('src/App.tsx');
    expect(normalizeWorkspaceOpenPath('workspace/docs/README.md/')).toBe('docs/README.md');
  });

  it('parses T3-style line targets', () => {
    expect(parseWorkspaceFileOpenTarget('/workspace/src/App.tsx:42')).toEqual({
      path: 'src/App.tsx',
      line: 42,
    });
    expect(parseWorkspaceFileOpenTarget('src/App.tsx#L87')).toEqual({
      path: 'src/App.tsx',
      line: 87,
    });
  });

  it('strips query strings and file URL wrappers', () => {
    expect(parseWorkspaceFileOpenTarget('file:///workspace/docs/Guide.md?plain=1#L3')).toEqual({
      path: 'docs/Guide.md',
      line: 3,
    });
  });
});
