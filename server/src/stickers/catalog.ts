import fs from 'fs';
import path from 'path';

/**
 * Sticker catalog — a fixed, shared library of reusable stickers.
 *
 * Unlike user-uploaded media, stickers are NOT stored per message/room. A sticker
 * message stores only a stable `stickerId` in its `content`; the bytes live once in
 * the catalog (public objects in the media bucket). This module is the server-side
 * source of truth: it loads the catalog and validates that an incoming stickerId is
 * a real, known sticker before a sticker message is accepted.
 */

export interface StickerDef {
  /** Stable id, e.g. "xiaokumao/008/03" (pack/note/index). Stored in message.content. */
  id: string;
  /** Public, stable URL to the image (no signing, immutable content). */
  url: string;
  /** Owning pack id. */
  pack: string;
  /** Search terms: OCR text + visual description. Powers panel search & inline hints. */
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
  /** stickerId used as the pack thumbnail. */
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

const EMPTY_CATALOG: StickerCatalog = { version: 0, packs: [], stickers: {} };

let cachedCatalog: StickerCatalog = EMPTY_CATALOG;
let validIds: Set<string> = new Set();

const catalogPath = () =>
  process.env.STICKER_CATALOG_PATH || path.resolve(__dirname, 'data', 'catalog.json');

/** Load (or reload) the catalog from disk. Safe to call at startup; never throws. */
export const loadStickerCatalog = (): StickerCatalog => {
  try {
    const raw = fs.readFileSync(catalogPath(), 'utf8');
    const parsed = JSON.parse(raw) as StickerCatalog;
    if (!parsed || typeof parsed !== 'object' || !parsed.stickers) {
      throw new Error('Malformed catalog');
    }
    cachedCatalog = parsed;
    validIds = new Set(Object.keys(parsed.stickers));
  } catch {
    // No catalog yet (e.g. before the asset pipeline runs) — degrade gracefully.
    cachedCatalog = EMPTY_CATALOG;
    validIds = new Set();
  }
  return cachedCatalog;
};

export const getStickerCatalog = (): StickerCatalog => cachedCatalog;

export const isValidStickerId = (id: unknown): id is string =>
  typeof id === 'string' && validIds.has(id);

export const getSticker = (id: string): StickerDef | undefined => cachedCatalog.stickers[id];
