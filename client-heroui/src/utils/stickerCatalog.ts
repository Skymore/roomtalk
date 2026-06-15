import { apiPath } from './apiBase';

/**
 * Client-side sticker catalog: a fixed, shared library fetched once from the
 * server. Sticker messages carry only a stickerId; rendering and the picker
 * resolve the image URL + metadata from here.
 */

export interface StickerDef {
  id: string;
  url: string;
  pack: string;
  keywords: string[];
  width?: number;
  height?: number;
}

export interface StickerGroup {
  /** Source 小红书 note title, used as the section header. */
  title: string;
  stickerIds: string[];
}

export interface StickerPack {
  id: string;
  name: string;
  cover: string;
  stickerIds: string[];
  /** Stickers grouped by their source note (title sections in the picker). */
  groups?: StickerGroup[];
}

export interface StickerCatalog {
  version: number;
  packs: StickerPack[];
  stickers: Record<string, StickerDef>;
}

const EMPTY: StickerCatalog = { version: 0, packs: [], stickers: {} };

let cache: StickerCatalog | null = null;
let inflight: Promise<StickerCatalog> | null = null;

/** Fetch (once) and cache the catalog. Safe to call repeatedly. */
export const loadStickerCatalog = (): Promise<StickerCatalog> => {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch(apiPath('/api/stickers/catalog'), { cache: 'no-store' })
    .then((res) => {
      if (!res.ok) throw new Error('Failed to load sticker catalog');
      return res.json() as Promise<StickerCatalog>;
    })
    .then((catalog) => {
      cache = catalog && catalog.stickers ? catalog : EMPTY;
      return cache;
    })
    .catch(() => EMPTY) // Degrade gracefully; the picker simply shows nothing.
    .finally(() => { inflight = null; });
  return inflight;
};

export const getStickerCatalogSync = (): StickerCatalog | null => cache;

/**
 * The inline-hint trigger: returns the keyword to search when the composer holds
 * just a short keyword (1-2 CJK characters), else an empty string (no hint).
 */
export const inlineStickerQuery = (text: string): string => {
  const trimmed = text.trim();
  return /^[一-鿿]{1,2}$/.test(trimmed) ? trimmed : '';
};

export const getStickerById = (id: string): StickerDef | undefined => cache?.stickers[id];

export const getStickerUrl = (id: string): string | undefined => cache?.stickers[id]?.url;

/**
 * Keyword search over the catalog. Matches stickers whose keywords contain the
 * (trimmed, lowercased) query as a substring. Ordered by pack then catalog order.
 */
export const searchStickers = (query: string, limit = 40): StickerDef[] => {
  const q = query.trim().toLowerCase();
  if (!cache || !q) return [];
  const out: StickerDef[] = [];
  for (const pack of cache.packs) {
    for (const id of pack.stickerIds) {
      const def = cache.stickers[id];
      if (def && def.keywords.some((k) => k.toLowerCase().includes(q))) {
        out.push(def);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
};
