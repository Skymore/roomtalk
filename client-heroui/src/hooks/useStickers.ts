import { useEffect, useMemo, useState } from 'react';
import { apiPath } from '../utils/apiBase';
import {
  getStickerCatalogSync,
  loadStickerCatalog,
  searchStickers,
  StickerCatalog,
  StickerDef,
} from '../utils/stickerCatalog';

/** Load the shared sticker catalog once and re-render when it arrives. */
export const useStickerCatalog = (): StickerCatalog | null => {
  const [catalog, setCatalog] = useState<StickerCatalog | null>(getStickerCatalogSync());
  useEffect(() => {
    if (catalog) return;
    let alive = true;
    loadStickerCatalog().then((loaded) => {
      if (alive) setCatalog(loaded);
    });
    return () => { alive = false; };
  }, [catalog]);
  return catalog;
};

/** Resolve a sticker's image URL, loading the catalog if needed. */
export const useStickerUrl = (id?: string): string | undefined => {
  const catalog = useStickerCatalog();
  if (!id) return undefined;
  const url = catalog?.stickers[id]?.url;
  return url ? apiPath(url) : undefined;
};

/** A sticker's display name: its primary keyword (OCR caption or note title). */
export const useStickerName = (id?: string): string | undefined => {
  const catalog = useStickerCatalog();
  if (!id) return undefined;
  return catalog?.stickers[id]?.keywords?.[0];
};

/** Live keyword search results (empty until the catalog is loaded). */
export const useStickerSearch = (query: string, limit = 40): StickerDef[] => {
  const catalog = useStickerCatalog();
  return useMemo(
    () => (catalog ? searchStickers(query, limit) : []),
    [catalog, query, limit],
  );
};

const RECENTS_KEY = 'roomtalk.stickers.recent';
const RECENTS_MAX = 24;

const readRecents = (): string[] => {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Recently-used sticker ids (most recent first), persisted to localStorage. */
export const useRecentStickers = (): { recentIds: string[]; pushRecent: (id: string) => void } => {
  const [recentIds, setRecentIds] = useState<string[]>(readRecents);
  const pushRecent = (id: string) => {
    setRecentIds((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENTS_MAX);
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
      return next;
    });
  };
  return { recentIds, pushRecent };
};
