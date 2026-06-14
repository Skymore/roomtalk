// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StickerPicker } from './StickerPicker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const CATALOG = {
  version: 1,
  packs: [
    { id: 'packA', name: 'PackA', cover: 'a1', stickerIds: ['a1', 'a2'] },
    { id: 'packB', name: 'PackB', cover: 'b1', stickerIds: ['b1'] },
  ],
  stickers: {
    a1: { id: 'a1', url: 'https://cdn/a1.jpg', pack: 'packA', keywords: ['打工'] },
    a2: { id: 'a2', url: 'https://cdn/a2.jpg', pack: 'packA', keywords: ['开心'] },
    b1: { id: 'b1', url: 'https://cdn/b1.jpg', pack: 'packB', keywords: ['哭'] },
  },
};

vi.mock('../hooks/useStickers', () => ({
  useStickerCatalog: () => CATALOG,
  useRecentStickers: () => ({ recentIds: ['a2'], pushRecent: vi.fn() }),
  useStickerSearch: (q: string) => {
    const query = q.trim();
    if (!query) return [];
    return Object.values(CATALOG.stickers).filter((s) => s.keywords.some((k) => k.includes(query)));
  },
}));

afterEach(() => cleanup());

describe('StickerPicker', () => {
  it('renders the active pack and selects a sticker on click', () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);

    // Active pack A stickers are shown
    fireEvent.click(screen.getByLabelText('打工'));
    expect(onSelect).toHaveBeenCalledWith('a1');
  });

  it('shows a recently-used row', () => {
    render(<StickerPicker onSelect={vi.fn()} />);
    expect(screen.getByText('recentlyUsed')).toBeTruthy();
  });

  it('filters by search query', () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);

    fireEvent.change(screen.getByLabelText('searchStickers'), { target: { value: '哭' } });
    expect(screen.getByLabelText('哭')).toBeTruthy();
    expect(screen.queryByLabelText('打工')).toBeNull();

    fireEvent.click(screen.getByLabelText('哭'));
    expect(onSelect).toHaveBeenCalledWith('b1');
  });

  it('switches packs via the pack tab', () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);

    // PackB tab is a button labelled with the pack name
    fireEvent.click(screen.getByRole('button', { name: 'PackB' }));
    fireEvent.click(screen.getByLabelText('哭'));
    expect(onSelect).toHaveBeenCalledWith('b1');
  });
});
