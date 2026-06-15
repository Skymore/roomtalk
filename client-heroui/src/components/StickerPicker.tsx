import React from 'react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { useStickerCatalog, useStickerSearch, useRecentStickers } from '../hooks/useStickers';
import { useSwipePager } from '../hooks/useSwipePager';
import { StickerDef } from '../utils/stickerCatalog';
import { apiPath } from '../utils/apiBase';

interface StickerPickerProps {
  /** Called with the chosen stickerId. The parent is responsible for sending. */
  onSelect: (stickerId: string) => void;
}

/**
 * A single sticker cell: image + always-visible name caption. Hover (desktop) or
 * long-press (mobile) raises a one-up enlarged preview via onPreview; a plain
 * tap/click sends it. Long-press suppresses the click so it doesn't also send.
 */
const StickerCell: React.FC<{
  sticker: StickerDef;
  onSelect: (id: string) => void;
  onPreview: (id: string | null) => void;
  isInteractive?: boolean;
}> = ({ sticker, onSelect, onPreview, isInteractive = true }) => {
  const { t } = useTranslation();
  const timer = React.useRef<number | undefined>(undefined);
  const longPressed = React.useRef(false);
  const name = sticker.keywords[0] || '';

  const startPress = () => {
    longPressed.current = false;
    timer.current = window.setTimeout(() => {
      longPressed.current = true;
      onPreview(sticker.id);
    }, 350);
  };
  const cancelTimer = () => window.clearTimeout(timer.current);
  const endPress = () => {
    cancelTimer();
    if (longPressed.current) onPreview(null);
  };
  const handleClick = () => {
    if (!isInteractive) return;
    if (longPressed.current) { longPressed.current = false; return; }
    onSelect(sticker.id);
  };
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      aria-label={name || t('sticker')}
      tabIndex={isInteractive ? undefined : -1}
      onClick={handleClick}
      onMouseEnter={() => isInteractive && onPreview(sticker.id)}
      onMouseLeave={() => onPreview(null)}
      onTouchStart={() => isInteractive && startPress()}
      onTouchMove={cancelTimer}
      onTouchEnd={endPress}
      onContextMenu={(e) => e.preventDefault()}
      className="flex select-none flex-col items-center gap-0.5 rounded-lg p-1 transition-colors hover:bg-[#e8e6dc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c96442] dark:hover:bg-[#30302e] dark:focus-visible:ring-[#d97757]"
    >
      <img src={apiPath(sticker.url)} alt={name} loading="lazy" draggable={false} className="aspect-square w-full object-contain" />
      <span className="w-full truncate text-center text-[10px] leading-tight text-[#8a8a85]">{name}</span>
    </button>
  );
};

const StickerGrid: React.FC<{
  stickers: StickerDef[];
  onSelect: (id: string) => void;
  onPreview: (id: string | null) => void;
  label: string;
  isInteractive?: boolean;
}> = ({ stickers, onSelect, onPreview, label, isInteractive = true }) => {
  const { t } = useTranslation();
  if (stickers.length === 0) {
    return <div className="py-8 text-center text-sm text-[#8a8a85]">{t('noStickersFound')}</div>;
  }
  return (
    <div role="group" aria-label={label} className="grid grid-cols-4 gap-1">
      {stickers.map((s) => (
        <StickerCell key={s.id} sticker={s} onSelect={onSelect} onPreview={onPreview} isInteractive={isInteractive} />
      ))}
    </div>
  );
};

type Page = number | 'recent';

export const StickerPicker: React.FC<StickerPickerProps> = ({ onSelect }) => {
  const { t } = useTranslation();
  const catalog = useStickerCatalog();
  const { recentIds } = useRecentStickers();
  const [query, setQuery] = React.useState('');
  const [activePackId, setActivePackId] = React.useState<string | null>(null);
  const [page, setPage] = React.useState<Page>(0);
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const searchResults = useStickerSearch(query);
  const resolve = React.useCallback((ids: string[]) => (
    catalog ? ids.map((id) => catalog.stickers[id]).filter(Boolean) as StickerDef[] : []
  ), [catalog]);
  const packs = catalog?.packs ?? [];
  const currentPackId = activePackId ?? packs[0]?.id ?? null;
  const currentPack = packs.find((p) => p.id === currentPackId) ?? packs[0];
  const groups = currentPack?.groups ?? [];
  const hasGroups = groups.length > 0;
  const recents = resolve(recentIds);
  const isSearching = query.trim().length > 0;
  const previewDef = previewId && catalog ? catalog.stickers[previewId] : null;

  // One group (or the recents row) per page.
  const groupIndex = typeof page === 'number' ? Math.max(0, Math.min(page, groups.length - 1)) : 0;
  const onRecentPage = page === 'recent' && recents.length > 0;
  const pageTitle = isSearching ? '' : onRecentPage ? t('recentlyUsed') : (groups[groupIndex]?.title ?? currentPack?.name ?? t('stickers'));
  const pageStickers = isSearching
    ? searchResults
    : onRecentPage
      ? recents
      : hasGroups
        ? resolve(groups[groupIndex].stickerIds)
        : resolve(currentPack?.stickerIds ?? []);

  const gotoGroup = React.useCallback((i: number) => {
    setPage(Math.max(0, Math.min(i, groups.length - 1)));
  }, [groups.length]);
  const groupPager = useSwipePager({
    pageCount: groups.length,
    index: groupIndex,
    onIndexChange: gotoGroup,
    enabled: !isSearching && hasGroups && !onRecentPage,
  });

  React.useEffect(() => {
    setPreviewId(null);
  }, [page, query, activePackId]);

  if (!catalog || packs.length === 0) {
    return (
      <div className="flex h-40 w-[18rem] items-center justify-center text-sm text-[#8a8a85] sm:w-[22rem]">
        {catalog ? t('noStickersFound') : <Icon icon="lucide:loader-2" className="h-5 w-5 animate-spin" />}
      </div>
    );
  }

  return (
    <div className="relative flex w-[18rem] flex-col sm:w-[22rem]">
      {/* Enlarged one-up preview (hover on desktop, long-press on mobile) */}
      {previewDef && (
        <div className="pointer-events-none absolute inset-x-0 top-10 z-40 flex justify-center">
          <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-[#dedbd0] bg-[#faf9f5] p-3 shadow-xl dark:border-[#30302e] dark:bg-[#2a2a28]">
            <img src={apiPath(previewDef.url)} alt={previewDef.keywords[0] || ''} className="h-40 w-40 object-contain" />
            {previewDef.keywords[0] && (
              <span className="max-w-[10rem] truncate text-sm font-medium text-[#141413] dark:text-[#faf9f5]">{previewDef.keywords[0]}</span>
            )}
          </div>
        </div>
      )}

      {/* Search */}
      <div className="flex items-center gap-2 border-b border-[#e3e1d8] px-3 py-2 dark:border-[#30302e]">
        <Icon icon="lucide:search" className="h-4 w-4 flex-shrink-0 text-[#8a8a85]" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchStickers')}
          aria-label={t('searchStickers')}
          className="w-full bg-transparent text-sm outline-none placeholder:text-[#8a8a85]"
        />
        {query && (
          <button type="button" aria-label={t('clearStickerSearch')} onClick={() => setQuery('')} className="text-[#8a8a85] hover:text-[#141413] dark:hover:text-[#faf9f5]">
            <Icon icon="lucide:x" className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Page header: current note title + prev/next (one group per page) */}
      {!isSearching && hasGroups && !onRecentPage && (
        <div className="flex items-center gap-1 px-2 py-1.5">
          <button
            type="button"
            aria-label={t('previousStickerGroup')}
            onClick={() => gotoGroup(groupIndex - 1)}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[#5e5d59] enabled:hover:bg-[#e8e6dc] disabled:opacity-30 dark:text-[#b0aea5] dark:enabled:hover:bg-[#30302e]"
            disabled={groupIndex <= 0}
          >
            <Icon icon="lucide:chevron-left" className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1 truncate text-center text-xs font-medium text-[#141413] dark:text-[#faf9f5]">
            {pageTitle}
            <span className="ml-1 text-[#8a8a85]">{groupIndex + 1}/{groups.length}</span>
          </div>
          <button
            type="button"
            aria-label={t('nextStickerGroup')}
            onClick={() => gotoGroup(groupIndex + 1)}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[#5e5d59] enabled:hover:bg-[#e8e6dc] disabled:opacity-30 dark:text-[#b0aea5] dark:enabled:hover:bg-[#30302e]"
            disabled={groupIndex >= groups.length - 1}
          >
            <Icon icon="lucide:chevron-right" className="h-4 w-4" />
          </button>
        </div>
      )}
      {!isSearching && onRecentPage && (
        <div className="px-3 py-1.5 text-center text-xs font-medium text-[#141413] dark:text-[#faf9f5]">{t('recentlyUsed')}</div>
      )}

      {/* Body: a single page of stickers */}
      {!isSearching && hasGroups && !onRecentPage ? (
        <div
          {...groupPager.viewportProps}
          data-testid="sticker-group-pager"
          className="overflow-hidden px-3 py-1"
          style={{ touchAction: 'pan-y' }}
        >
          <div {...groupPager.trackProps} className="flex will-change-transform">
            {groups.map((group, index) => {
              const isActive = index === groupIndex;
              return (
                <div
                  key={`${group.title}-${index}`}
                  aria-hidden={!isActive}
                  className="max-h-[15rem] min-w-full overflow-y-auto"
                >
                  <StickerGrid
                    stickers={resolve(group.stickerIds)}
                    onSelect={onSelect}
                    onPreview={setPreviewId}
                    label={group.title}
                    isInteractive={isActive}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="max-h-[15rem] overflow-y-auto px-3 py-1">
          <StickerGrid stickers={pageStickers} onSelect={onSelect} onPreview={setPreviewId} label={pageTitle || t('stickers')} />
        </div>
      )}

      {/* Tab strip: recents + one cover per note group (or packs when ungrouped) */}
      {!isSearching && hasGroups && (
        <div className="flex items-center gap-1 overflow-x-auto border-t border-[#e3e1d8] px-2 py-1.5 dark:border-[#30302e]">
          {recents.length > 0 && (
            <button
              type="button"
              aria-label={t('recentlyUsed')}
              aria-pressed={onRecentPage}
              onClick={() => setPage('recent')}
              className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ${onRecentPage ? 'bg-[#e8e6dc] dark:bg-[#30302e]' : 'hover:bg-[#efede5] dark:hover:bg-[#262625]'}`}
            >
              <Icon icon="lucide:clock" className="h-4 w-4 text-[#5e5d59] dark:text-[#b0aea5]" />
            </button>
          )}
          {groups.map((group, i) => {
            const cover = catalog.stickers[group.stickerIds[0]];
            const active = !onRecentPage && i === groupIndex;
            return (
              <button
                key={`${group.title}-${i}`}
                type="button"
                aria-label={group.title}
                aria-pressed={active}
                title={group.title}
                onClick={() => setPage(i)}
                className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-1 ${active ? 'bg-[#e8e6dc] dark:bg-[#30302e]' : 'hover:bg-[#efede5] dark:hover:bg-[#262625]'}`}
              >
                {cover ? <img src={apiPath(cover.url)} alt="" className="max-h-full max-w-full object-contain" /> : <Icon icon="lucide:sticker" className="h-4 w-4" />}
              </button>
            );
          })}
        </div>
      )}

      {/* Ungrouped fallback: pack tabs */}
      {!isSearching && !hasGroups && packs.length > 1 && (
        <div className="flex items-center gap-1 overflow-x-auto border-t border-[#e3e1d8] px-2 py-1.5 dark:border-[#30302e]">
          {packs.map((pack) => {
            const cover = catalog.stickers[pack.cover] ?? catalog.stickers[pack.stickerIds[0]];
            const active = pack.id === currentPackId;
            return (
              <button
                key={pack.id}
                type="button"
                aria-label={pack.name}
                aria-pressed={active}
                onClick={() => setActivePackId(pack.id)}
                className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-1 ${active ? 'bg-[#e8e6dc] dark:bg-[#30302e]' : 'hover:bg-[#efede5] dark:hover:bg-[#262625]'}`}
              >
                {cover ? <img src={apiPath(cover.url)} alt="" className="max-h-full max-w-full object-contain" /> : <Icon icon="lucide:sticker" className="h-4 w-4" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
