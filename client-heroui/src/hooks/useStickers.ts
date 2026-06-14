import { useEffect, useMemo, useState } from 'react';
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
  return catalog?.stickers[id]?.url;
};

/** Live keyword search results (empty until the catalog is loaded). */
export const useStickerSearch = (query: string, limit = 40): StickerDef[] => {
  const catalog = useStickerCatalog();
  return useMemo(
    () => (catalog ? searchStickers(query, limit) : []),
    [catalog, query, limit],
  );
};
