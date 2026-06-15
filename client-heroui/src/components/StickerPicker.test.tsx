// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StickerPicker } from './StickerPicker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const CATALOG = {
  version: 1,
  packs: [
    {
      id: 'xiaokumao',
      name: '小哭猫',
      cover: 'a1',
      stickerIds: ['a1', 'a2', 'b1'],
      groups: [
        { title: 'NoteA', stickerIds: ['a1', 'a2'] },
        { title: 'NoteB', stickerIds: ['b1'] },
      ],
    },
  ],
  stickers: {
    a1: { id: 'a1', url: 'https://cdn/a1.jpg', pack: 'xiaokumao', keywords: ['打工'] },
    a2: { id: 'a2', url: 'https://cdn/a2.jpg', pack: 'xiaokumao', keywords: ['开心'] },
    b1: { id: 'b1', url: 'https://cdn/b1.jpg', pack: 'xiaokumao', keywords: ['哭'] },
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

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('StickerPicker (grouped, one note per page)', () => {
  it('shows the first note group and selects a sticker', () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);

    // First page = NoteA (a1, a2). NoteB is offscreen and hidden from the active accessibility tree.
    const activeGroup = screen.getByRole('group', { name: 'NoteA' });
    expect(within(activeGroup).getByLabelText('打工')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'NoteB' })).toBeNull();

    fireEvent.click(screen.getByLabelText('打工'));
    expect(onSelect).toHaveBeenCalledWith('a1');
  });

  it('pages to the next note with the next arrow', () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: 'nextStickerGroup' }));
    expect(screen.getByRole('group', { name: 'NoteB' })).toBeTruthy();
  });

  it('swipes horizontally to the next note', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);

    const pager = screen.getByTestId('sticker-group-pager');
    Object.defineProperty(pager, 'clientWidth', {
      configurable: true,
      value: 288,
    });

    fireEvent.mouseDown(pager, { button: 0, clientX: 250, clientY: 90 });
    fireEvent.mouseMove(pager, { buttons: 1, clientX: 90, clientY: 94 });
    fireEvent.mouseUp(pager, { button: 0, clientX: 90, clientY: 94 });

    expect(screen.getByRole('group', { name: 'NoteB' })).toBeTruthy();

    fireEvent.click(screen.getByLabelText('哭'));
    expect(onSelect).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(350);
    });
    fireEvent.click(screen.getByLabelText('哭'));
    expect(onSelect).toHaveBeenCalledWith('b1');
  });

  it('jumps to a note via its tab', () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: 'NoteB' }));
    fireEvent.click(screen.getByLabelText('哭'));
    expect(onSelect).toHaveBeenCalledWith('b1');
  });

  it('searches across all groups', () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);

    fireEvent.change(screen.getByLabelText('searchStickers'), { target: { value: '哭' } });
    expect(screen.getByLabelText('哭')).toBeTruthy();
    expect(screen.queryByLabelText('打工')).toBeNull();
    fireEvent.click(screen.getByLabelText('哭'));
    expect(onSelect).toHaveBeenCalledWith('b1');
  });

  it('shows recently-used stickers via the recents tab', () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: 'recentlyUsed' }));
    // recents = [a2] -> 开心
    expect(screen.getByLabelText('开心')).toBeTruthy();
  });
});
