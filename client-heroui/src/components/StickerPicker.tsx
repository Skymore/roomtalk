import React from 'react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { useStickerCatalog, useStickerSearch, useRecentStickers } from '../hooks/useStickers';
import { StickerDef } from '../utils/stickerCatalog';

interface StickerPickerProps {
  /** Called with the chosen stickerId. The parent is responsible for sending. */
  onSelect: (stickerId: string) => void;
}

const StickerGrid: React.FC<{ stickers: StickerDef[]; onSelect: (id: string) => void; label: string }> = ({ stickers, onSelect, label }) => {
  const { t } = useTranslation();
  if (stickers.length === 0) {
    return <div className="py-8 text-center text-sm text-[#8a8a85]">{t('noStickersFound')}</div>;
  }
  return (
    <div role="group" aria-label={label} className="grid grid-cols-4 gap-1.5 sm:grid-cols-5">
      {stickers.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-label={s.keywords[0] || t('sticker')}
          title={s.keywords[0] || ''}
          onClick={() => onSelect(s.id)}
          className="flex aspect-square items-center justify-center rounded-lg p-1 transition-colors hover:bg-[#e8e6dc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c96442] dark:hover:bg-[#30302e] dark:focus-visible:ring-[#d97757]"
        >
          <img src={s.url} alt={s.keywords[0] || ''} loading="lazy" draggable={false} className="max-h-full max-w-full object-contain" />
        </button>
      ))}
    </div>
  );
};

export const StickerPicker: React.FC<StickerPickerProps> = ({ onSelect }) => {
  const { t } = useTranslation();
  const catalog = useStickerCatalog();
  const { recentIds } = useRecentStickers();
  const [query, setQuery] = React.useState('');
  const [activePackId, setActivePackId] = React.useState<string | null>(null);
  const searchResults = useStickerSearch(query);

  if (!catalog || catalog.packs.length === 0) {
    return (
      <div className="flex h-40 w-[18rem] items-center justify-center text-sm text-[#8a8a85] sm:w-[22rem]">
        {catalog ? t('noStickersFound') : <Icon icon="lucide:loader-2" className="h-5 w-5 animate-spin" />}
      </div>
    );
  }

  const packs = catalog.packs;
  const currentPackId = activePackId ?? packs[0].id;
  const currentPack = packs.find((p) => p.id === currentPackId) ?? packs[0];
  const recents = recentIds.map((id) => catalog.stickers[id]).filter(Boolean) as StickerDef[];
  const packStickers = currentPack.stickerIds.map((id) => catalog.stickers[id]).filter(Boolean) as StickerDef[];
  const isSearching = query.trim().length > 0;

  return (
    <div className="flex w-[18rem] flex-col sm:w-[22rem]">
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
          <button type="button" aria-label="clear" onClick={() => setQuery('')} className="text-[#8a8a85] hover:text-[#141413] dark:hover:text-[#faf9f5]">
            <Icon icon="lucide:x" className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="max-h-[16rem] overflow-y-auto px-3 py-2">
        {isSearching ? (
          <StickerGrid stickers={searchResults} onSelect={onSelect} label={t('searchStickers')} />
        ) : (
          <>
            {recents.length > 0 && (
              <div className="mb-2">
                <div className="mb-1 px-1 text-xs font-medium text-[#8a8a85]">{t('recentlyUsed')}</div>
                <StickerGrid stickers={recents} onSelect={onSelect} label={t('recentlyUsed')} />
              </div>
            )}
            <StickerGrid stickers={packStickers} onSelect={onSelect} label={currentPack.name} />
          </>
        )}
      </div>

      {/* Pack tabs */}
      {!isSearching && packs.length > 1 && (
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
                {cover ? <img src={cover.url} alt="" className="max-h-full max-w-full object-contain" /> : <Icon icon="lucide:sticker" className="h-4 w-4" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
