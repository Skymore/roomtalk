import { describe, expect, it } from 'vitest';
import {
  normalizeWorkspaceOpenPath,
  parseWorkspaceFileOpenTarget,
  resolveWorkspaceOpenRelativePath,
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

  it('resolves absolute paths through the T3 workspace-relative guard', () => {
    expect(parseWorkspaceFileOpenTarget('/workspace/src/App.tsx:12')).toEqual({
      path: 'src/App.tsx',
      line: 12,
    });
    expect(parseWorkspaceFileOpenTarget('/tmp/src/App.tsx:12')).toBeNull();
  });

  it('resolves Windows workspace roots like T3 when a root is provided', () => {
    expect(parseWorkspaceFileOpenTarget('C:\\workspace\\src\\App.tsx:12:4', {
      workspaceRoot: 'C:\\workspace',
    })).toEqual({
      path: 'src/App.tsx',
      line: 12,
    });
    expect(parseWorkspaceFileOpenTarget('C:\\workspace\\src\\App.tsx', {
      workspaceRoot: 'C:\\workspace',
    })).toEqual({
      path: 'src/App.tsx',
      line: null,
    });
    expect(parseWorkspaceFileOpenTarget('D:\\workspace\\src\\App.tsx', {
      workspaceRoot: 'C:\\workspace',
    })).toBeNull();
  });

  it('normalizes relative paths without allowing them to escape the workspace', () => {
    expect(resolveWorkspaceOpenRelativePath('./src/../README.md')).toBe('README.md');
    expect(resolveWorkspaceOpenRelativePath('../secrets.txt')).toBeNull();
    expect(resolveWorkspaceOpenRelativePath('~/notes.txt')).toBeNull();
  });
});
