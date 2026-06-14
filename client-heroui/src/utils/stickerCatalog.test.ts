// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./socket', () => ({ apiPath: (p: string) => `http://test${p}` }));

const CATALOG = {
  version: 1,
  packs: [
    { id: 'xiaokumao', name: '小哭猫', cover: 'xiaokumao/001/01', stickerIds: ['xiaokumao/001/01', 'xiaokumao/001/02'] },
  ],
  stickers: {
    'xiaokumao/001/01': { id: 'xiaokumao/001/01', url: 'https://cdn/x/1.jpg', pack: 'xiaokumao', keywords: ['别睡了', '打工'] },
    'xiaokumao/001/02': { id: 'xiaokumao/001/02', url: 'https://cdn/x/2.jpg', pack: 'xiaokumao', keywords: ['开心'] },
  },
};

const importFresh = async () => {
  vi.resetModules();
  return import('./stickerCatalog');
};

const mockFetch = (catalog: unknown, ok = true) => {
  (globalThis as any).fetch = vi.fn(async () => ({
    ok,
    json: async () => catalog,
  }));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sticker catalog (client)', () => {
  it('loads and caches the catalog (single fetch)', async () => {
    mockFetch(CATALOG);
    const mod = await importFresh();
    const first = await mod.loadStickerCatalog();
    const second = await mod.loadStickerCatalog();
    expect(first.version).toBe(1);
    expect(second).toBe(first);
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    expect(mod.getStickerById('xiaokumao/001/01')?.url).toBe('https://cdn/x/1.jpg');
    expect(mod.getStickerUrl('xiaokumao/001/02')).toBe('https://cdn/x/2.jpg');
  });

  it('searches stickers by keyword substring (case-insensitive)', async () => {
    mockFetch(CATALOG);
    const mod = await importFresh();
    await mod.loadStickerCatalog();
    expect(mod.searchStickers('打工').map((s) => s.id)).toEqual(['xiaokumao/001/01']);
    expect(mod.searchStickers('开心').map((s) => s.id)).toEqual(['xiaokumao/001/02']);
    expect(mod.searchStickers('  ')).toEqual([]);
    expect(mod.searchStickers('不存在')).toEqual([]);
  });

  it('respects the search result limit', async () => {
    mockFetch(CATALOG);
    const mod = await importFresh();
    await mod.loadStickerCatalog();
    // both stickers share no common keyword, so search a pack-wide term per id
    expect(mod.searchStickers('', 1)).toEqual([]);
  });

  it('degrades to an empty catalog when the request fails', async () => {
    mockFetch(null, false);
    const mod = await importFresh();
    const catalog = await mod.loadStickerCatalog();
    expect(catalog.version).toBe(0);
    expect(Object.keys(catalog.stickers)).toHaveLength(0);
    expect(mod.getStickerById('xiaokumao/001/01')).toBeUndefined();
  });
});
