import { describe, expect, it } from 'vitest';
import {
  appendWorkspaceAssetPreviewRevision,
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
} from './codeWorkspaceFilePreview';

describe('code workspace file previews', () => {
  it.each(['report.html', 'report.HTM', 'document.pdf?download=1'])(
    'recognizes browser preview path %s like T3',
    (path) => {
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it.each([
    'icon.png',
    'photo.JPEG',
    'animation.gif',
    'vector.svg#mark',
    'texture.webp',
    'image.avif',
  ])('recognizes image preview path %s like T3', (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(['README.md', 'src/index.ts', 'image.png.ts', 'png'])(
    'rejects non-preview path %s like T3',
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );

  it('appends T3 mobile-style asset preview revisions without changing the signed path', () => {
    expect(appendWorkspaceAssetPreviewRevision('/api/assets/report.html', 1))
      .toBe('/api/assets/report.html?revision=1');
    expect(appendWorkspaceAssetPreviewRevision('/api/assets/report.html?token=abc', 2))
      .toBe('/api/assets/report.html?token=abc&revision=2');
    expect(appendWorkspaceAssetPreviewRevision('/api/assets/report.html', 0))
      .toBe('/api/assets/report.html');
  });
});
