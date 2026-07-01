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
    expect(parseWorkspaceFileOpenTarget('src/App.tsx#L87C5')).toEqual({
      path: 'src/App.tsx',
      line: 87,
    });
    expect(parseWorkspaceFileOpenTarget('src/App.tsx:42:7')).toEqual({
      path: 'src/App.tsx',
      line: 42,
    });
  });

  it('strips query strings and file URL wrappers', () => {
    expect(parseWorkspaceFileOpenTarget('file:///workspace/docs/Guide.md?plain=1#L3C9')).toEqual({
      path: 'docs/Guide.md',
      line: 3,
    });
  });

  it('keeps Windows drive letters while stripping T3-style positions', () => {
    expect(parseWorkspaceFileOpenTarget('C:\\workspace\\src\\App.tsx:12:4')).toEqual({
      path: 'C:/workspace/src/App.tsx',
      line: 12,
    });
    expect(parseWorkspaceFileOpenTarget('C:\\workspace\\src\\App.tsx')).toEqual({
      path: 'C:/workspace/src/App.tsx',
      line: null,
    });
  });
});
