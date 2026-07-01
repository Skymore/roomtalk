interface WorkspaceImagePreloadTarget {
  onload: GlobalEventHandlers['onload'];
  onerror: GlobalEventHandlers['onerror'];
  src: string;
  complete?: boolean;
  naturalWidth?: number;
}

type WorkspaceImagePreloadFactory = () => WorkspaceImagePreloadTarget | null;

const imagePreviewPreloadCache = new Map<string, Promise<boolean>>();

const createBrowserImagePreloadTarget: WorkspaceImagePreloadFactory = () => {
  if (typeof Image === 'undefined') {
    return null;
  }
  return new Image();
};

export function preloadWorkspaceImagePreview(
  src: string,
  createImage: WorkspaceImagePreloadFactory = createBrowserImagePreloadTarget,
): Promise<boolean> {
  const existing = imagePreviewPreloadCache.get(src);
  if (existing) {
    return existing;
  }

  const promise = new Promise<boolean>((resolve) => {
    const image = createImage();
    if (!image) {
      resolve(true);
      return;
    }

    let settled = false;
    const settle = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      resolve(loaded);
    };

    image.onload = () => settle(true);
    image.onerror = () => settle(false);
    image.src = src;
    if (image.complete && (image.naturalWidth ?? 0) > 0) {
      settle(true);
    }
  }).then((loaded) => {
    if (!loaded) {
      imagePreviewPreloadCache.delete(src);
    }
    return loaded;
  });

  imagePreviewPreloadCache.set(src, promise);
  return promise;
}

export function resetWorkspaceImagePreviewCacheForTests(): void {
  imagePreviewPreloadCache.clear();
}
