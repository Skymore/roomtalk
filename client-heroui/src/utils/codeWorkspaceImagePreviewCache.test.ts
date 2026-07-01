import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  preloadWorkspaceImagePreview,
  resetWorkspaceImagePreviewCacheForTests,
} from './codeWorkspaceImagePreviewCache';

class FakeImage {
  onload: GlobalEventHandlers['onload'] = null;
  onerror: GlobalEventHandlers['onerror'] = null;
  complete = false;
  naturalWidth = 0;
  assignedSrc: string | null = null;

  constructor(private readonly shouldLoad: boolean) {}

  set src(nextSrc: string) {
    this.assignedSrc = nextSrc;
    queueMicrotask(() => {
      if (this.shouldLoad) {
        this.complete = true;
        this.naturalWidth = 640;
        this.onload?.call(this as unknown as GlobalEventHandlers, new Event('load'));
        return;
      }
      this.onerror?.call(this as unknown as GlobalEventHandlers, new Event('error'));
    });
  }

  get src(): string {
    return this.assignedSrc ?? '';
  }
}

describe('codeWorkspaceImagePreviewCache', () => {
  afterEach(() => {
    resetWorkspaceImagePreviewCacheForTests();
  });

  it('reuses a prefetched image across route remounts like T3', async () => {
    const createImage = vi.fn(() => new FakeImage(true));

    await expect(preloadWorkspaceImagePreview('https://example.test/image.png', createImage)).resolves.toBe(true);
    await expect(preloadWorkspaceImagePreview('https://example.test/image.png', createImage)).resolves.toBe(true);

    expect(createImage).toHaveBeenCalledTimes(1);
  });

  it('prefetches different asset URLs independently like T3', async () => {
    const createImage = vi.fn(() => new FakeImage(true));

    await Promise.all([
      preloadWorkspaceImagePreview('https://example.test/first.png', createImage),
      preloadWorkspaceImagePreview('https://example.test/second.png', createImage),
    ]);

    expect(createImage).toHaveBeenCalledTimes(2);
  });

  it('exposes prefetch failures and allows a later retry', async () => {
    const createImage = vi
      .fn()
      .mockImplementationOnce(() => new FakeImage(false))
      .mockImplementationOnce(() => new FakeImage(true));

    await expect(preloadWorkspaceImagePreview('https://example.test/missing.png', createImage)).resolves.toBe(false);
    await expect(preloadWorkspaceImagePreview('https://example.test/missing.png', createImage)).resolves.toBe(true);

    expect(createImage).toHaveBeenCalledTimes(2);
  });
});
