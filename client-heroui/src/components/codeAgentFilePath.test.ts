import { describe, expect, it } from 'vitest';
import {
  basename,
  fileBreadcrumbs,
  isBrowserPreviewFile,
  isImagePreviewFile,
  isMarkdownPreviewFile,
  isSvgImagePreviewFile,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from './codeAgentFilePath';

describe('fileBreadcrumbs', () => {
  it('builds project, directory, and file crumbs', () => {
    expect(fileBreadcrumbs('t3code', 'apps/web/src/main.tsx')).toEqual([
      { label: 't3code', path: '', kind: 'project' },
      { label: 'apps', path: 'apps', kind: 'directory' },
      { label: 'web', path: 'apps/web', kind: 'directory' },
      { label: 'src', path: 'apps/web/src', kind: 'directory' },
      { label: 'main.tsx', path: 'apps/web/src/main.tsx', kind: 'file' },
    ]);
  });

  it('normalizes repeated separators', () => {
    expect(fileBreadcrumbs('workspace', '/src//index.ts').map((crumb) => crumb.label)).toEqual([
      'workspace',
      'src',
      'index.ts',
    ]);
  });

  it('normalizes Windows separators like the rest of the T3 file viewer path helpers', () => {
    expect(fileBreadcrumbs('workspace', 'src\\components//App.tsx')).toEqual([
      { label: 'workspace', path: '', kind: 'project' },
      { label: 'src', path: 'src', kind: 'directory' },
      { label: 'components', path: 'src/components', kind: 'directory' },
      { label: 'App.tsx', path: 'src/components/App.tsx', kind: 'file' },
    ]);
  });

  it('matches T3 basename handling across slash styles', () => {
    expect(basename('apps/web/src/main.tsx')).toBe('main.tsx');
    expect(basename('C:\\workspace\\src\\main.tsx')).toBe('main.tsx');
    expect(basename('/workspace/src/')).toBe('src');
  });

  it('resolves workspace file paths like T3', () => {
    expect(resolveWorkspaceFilePath('/workspace', 'src/App.tsx')).toBe('/workspace/src/App.tsx');
    expect(resolveWorkspaceFilePath('/workspace/', '/tmp/App.tsx')).toBe('/tmp/App.tsx');
    expect(resolveWorkspaceFilePath('C:\\workspace', 'src/App.tsx')).toBe('C:\\workspace\\src\\App.tsx');
    expect(resolveWorkspaceFilePath('C:\\workspace\\', 'C:\\tmp\\App.tsx')).toBe('C:\\tmp\\App.tsx');
  });

  it('resolves workspace-relative paths without allowing escapes like T3', () => {
    expect(resolveWorkspaceRelativeFilePath('/workspace', '/workspace/src/App.tsx')).toBe('src/App.tsx');
    expect(resolveWorkspaceRelativeFilePath('/workspace', './docs/../README.md')).toBe('README.md');
    expect(resolveWorkspaceRelativeFilePath('/workspace', '../secret.txt')).toBeNull();
    expect(resolveWorkspaceRelativeFilePath('/workspace', '~/secret.txt')).toBeNull();
    expect(resolveWorkspaceRelativeFilePath('/workspace', '/tmp/App.tsx')).toBeNull();
    expect(resolveWorkspaceRelativeFilePath('C:\\workspace', 'C:\\workspace\\src\\App.tsx')).toBe('src/App.tsx');
  });

  it('exposes T3 preview file classification helpers', () => {
    expect(isBrowserPreviewFile('dist/index.html')).toBe(true);
    expect(isBrowserPreviewFile('docs/manual.pdf?download=1')).toBe(true);
    expect(isImagePreviewFile('assets/photo.avif')).toBe(true);
    expect(isImagePreviewFile('assets/icon.svg#mark')).toBe(true);
    expect(isSvgImagePreviewFile('assets/icon.svg#mark')).toBe(true);
    expect(isSvgImagePreviewFile('assets/photo.png')).toBe(false);
    expect(isMarkdownPreviewFile('README.md?plain=1')).toBe(true);
    expect(isMarkdownPreviewFile('src/App.tsx')).toBe(false);
  });
});
