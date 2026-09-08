import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

const storageKey = (clientId: string, roomId: string) =>
  `roomtalk.textDraft.${encodeURIComponent(clientId)}.${encodeURIComponent(roomId)}`;

type TextDraft = { text: string; updatedAt: number };

const readDraft = (key: string): TextDraft | null => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value && typeof value.text === 'string' && typeof value.updatedAt === 'number' ? value : null;
  } catch {
    return null;
  }
};

// Text only: never persist editor HTML, attachment URLs or recording blobs.
export const useRoomTextDraft = (
  clientId: string,
  roomId: string,
  editorRef: RefObject<HTMLDivElement>,
  onRestore: (text: string) => void,
) => {
  const key = storageKey(clientId, roomId);
  const observedText = useRef('');

  useLayoutEffect(() => {
    const text = readDraft(key)?.text || '';
    observedText.current = text;
    if (editorRef.current) editorRef.current.textContent = text;
    onRestore(text);
  }, [editorRef, key, onRestore]);

  const saveDraft = useCallback((text: string) => {
    if (observedText.current === text) return;
    observedText.current = text;
    try {
      if (text) {
        // Distinguish a newly typed identical draft from an in-flight send.
        const updatedAt = Math.max(Date.now(), (readDraft(key)?.updatedAt || 0) + 1);
        localStorage.setItem(key, JSON.stringify({ text, updatedAt }));
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // A full or unavailable local store must not block the live editor.
    }
  }, [key]);

  const beginDraftSend = useCallback(() => {
    saveDraft(editorRef.current?.innerText ?? editorRef.current?.textContent ?? '');
    let sentDraft: string | null = null;
    try { sentDraft = localStorage.getItem(key); } catch { /* best-effort persistence */ }
    // The optimistic clear is not a user edit. Retain the draft until ack.
    observedText.current = '';
    return () => {
      try {
        if (sentDraft !== null && localStorage.getItem(key) === sentDraft) {
          localStorage.removeItem(key);
        }
      } catch { /* best-effort persistence */ }
    };
  }, [editorRef, key, saveDraft]);

  return { saveDraft, beginDraftSend };
};
