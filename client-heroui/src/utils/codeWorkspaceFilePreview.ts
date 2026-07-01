// Mirrored from T3's shared workspace file preview classification.
export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = ['.htm', '.html', '.pdf'] as const;

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
] as const;

const hasPreviewExtension = (path: string, extensions: ReadonlyArray<string>): boolean => {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? '';
  return extensions.some((extension) => pathWithoutQuery.endsWith(extension));
};

export const isWorkspaceBrowserPreviewPath = (path: string): boolean => (
  hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS)
);

export const isWorkspaceImagePreviewPath = (path: string): boolean => (
  hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS)
);

export const isWorkspacePreviewEntryPath = (path: string): boolean => (
  isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path)
);

export function appendWorkspaceAssetPreviewRevision(url: string, revision: number): string {
  const normalizedRevision = Math.floor(revision);
  if (!Number.isFinite(normalizedRevision) || normalizedRevision <= 0) {
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}revision=${normalizedRevision}`;
}
