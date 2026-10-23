import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageSpeech } from './useMessageSpeech';
import { getMessageSpeechParts, getMessageSpeechText } from '../utils/messageSpeech';

class Utterance {
  lang = '';
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

const chinese = { lang: 'zh-CN', name: 'Chinese' };
const english = { lang: 'en-US', name: 'English' };
const synthesis = {
  cancel: vi.fn(),
  speak: vi.fn<(utterance: Utterance) => void>(),
  getVoices: vi.fn(() => [chinese, english]),
};

beforeEach(() => {
  vi.clearAllMocks();
  synthesis.getVoices.mockReturnValue([chinese, english]);
  vi.stubGlobal('speechSynthesis', synthesis);
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('message read aloud', () => {
  it('reads prose, inline code and link labels, skipping fenced code and images', () => {
    const text = getMessageSpeechText('# 你好\n\n**Hello** [world](https://example.com).\n\nUse `npm`.\n\n```js\nsecretCode()\n```\n\n![image](picture.png)');
    expect(text).toContain('你好');
    expect(text).toContain('Hello world.');
    expect(text).toContain('Use npm.');
    expect(text).not.toMatch(/secretCode|https:|picture.png|\*\*|```/);
    expect(getMessageSpeechText('```js\ncode()\n```')).toBe('');
  });

  it('chooses Chinese and English for sentences and bounds long utterances', () => {
    expect(getMessageSpeechParts('你好，RoomTalk！\nHello world.')).toEqual([
      { text: '你好，RoomTalk！', lang: 'zh-CN' },
      { text: 'Hello world.', lang: 'en-US' },
    ]);
    const longText = '长'.repeat(700);
    const parts = getMessageSpeechParts(longText);
    expect(parts.map(part => part.text).join('')).toBe(longText);
    expect(parts.every(part => part.text.length <= 181)).toBe(true);
  });

  it('speaks with matching voices and resets when playback ends', () => {
    const { result } = renderHook(() => useMessageSpeech('one', '你好。Hello.'));
    act(() => result.current.toggleSpeech());
    expect(result.current.isSpeaking).toBe(true);
    const utterances = synthesis.speak.mock.calls.map(call => call[0] as Utterance);
    expect(utterances.map(part => [part.lang, part.voice])).toEqual([['zh-CN', chinese], ['en-US', english]]);
    act(() => utterances[1].onend?.());
    expect(result.current.isSpeaking).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('stops the previous reply and ignores its late completion/error events', () => {
    const first = renderHook(() => useMessageSpeech('one', 'First.'));
    const second = renderHook(() => useMessageSpeech('two', 'Second.'));
    act(() => first.result.current.toggleSpeech());
    const oldUtterance = synthesis.speak.mock.calls[0][0] as Utterance;
    act(() => second.result.current.toggleSpeech());
    expect(first.result.current.isSpeaking).toBe(false);
    expect(second.result.current.isSpeaking).toBe(true);
    act(() => {
      oldUtterance.onend?.();
      oldUtterance.onerror?.({ error: 'interrupted' });
    });
    expect(second.result.current.isSpeaking).toBe(true);
    expect(first.result.current.error).toBeNull();
    first.unmount();
    expect(second.result.current.isSpeaking).toBe(true);
    act(() => second.result.current.toggleSpeech());
    expect(second.result.current.isSpeaking).toBe(false);
    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
  });

  it('cancels when a message changes or unmounts', () => {
    const { result, rerender, unmount } = renderHook(({ content }) => useMessageSpeech('one', content), {
      initialProps: { content: 'Original.' },
    });
    act(() => result.current.toggleSpeech());
    rerender({ content: 'Edited.' });
    expect(result.current.isSpeaking).toBe(false);
    act(() => result.current.toggleSpeech());
    unmount();
    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
  });

  it('handles unsupported browsers, empty prose and engine errors', () => {
    const { result } = renderHook(() => useMessageSpeech('one', 'Hello.'));
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    // The property can exist without a usable constructor in restricted browsers.
    vi.stubGlobal('speechSynthesis', undefined);
    act(() => result.current.toggleSpeech());
    expect(result.current.error).toBe('unsupported');
    vi.stubGlobal('speechSynthesis', synthesis);
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    const empty = renderHook(() => useMessageSpeech('empty', '```js\ncode()\n```'));
    act(() => empty.result.current.toggleSpeech());
    expect(empty.result.current.error).toBe('empty');
    act(() => result.current.toggleSpeech());
    act(() => (synthesis.speak.mock.calls[0][0] as Utterance).onerror?.({ error: 'language-unavailable' }));
    expect(result.current.isSpeaking).toBe(false);
    expect(result.current.error).toBe('failed');
  });

  it('lets the browser select a voice when voices have not loaded yet', () => {
    synthesis.getVoices.mockReturnValue([]);
    const { result } = renderHook(() => useMessageSpeech('one', '你好。'));
    act(() => result.current.toggleSpeech());
    expect(synthesis.speak.mock.calls[0][0]).toMatchObject({ lang: 'zh-CN', voice: null });
  });
});
