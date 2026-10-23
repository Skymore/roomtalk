import { useEffect, useRef, useState } from 'react';
import { getMessageSpeechParts, getMessageSpeechText } from '../utils/messageSpeech';

// Speech synthesis has one queue for the page; starting a reply replaces the last.
let activePlayback: { stop: () => void } | null = null;

export function useMessageSpeech(messageId: string, content: string) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<'unsupported' | 'empty' | 'failed' | null>(null);
  const playbackRef = useRef<typeof activePlayback>(null);
  const utterancesRef = useRef<SpeechSynthesisUtterance[]>([]);

  useEffect(() => () => playbackRef.current?.stop(), [messageId, content]);

  const toggleSpeech = () => {
    setError(null);
    if (playbackRef.current) {
      playbackRef.current.stop();
      return;
    }
    if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') {
      setError('unsupported');
      return;
    }
    const parts = getMessageSpeechParts(getMessageSpeechText(content));
    if (!parts.length) {
      setError('empty');
      return;
    }

    activePlayback?.stop();
    const synthesis = window.speechSynthesis;
    const playback = {
      stop: () => {
        if (activePlayback !== playback) return;
        activePlayback = null;
        playbackRef.current = null;
        utterancesRef.current = [];
        synthesis.cancel();
        setIsSpeaking(false);
      },
    };
    activePlayback = playback;
    playbackRef.current = playback;
    setIsSpeaking(true);

    try {
      const voices = synthesis.getVoices();
      utterancesRef.current = parts.map(part => {
        const utterance = new SpeechSynthesisUtterance(part.text);
        utterance.lang = part.lang;
        const voice = voices.find(voice => voice.lang === part.lang)
          ?? voices.find(voice => voice.lang.split(/[-_]/)[0] === part.lang.split('-')[0]);
        if (voice) utterance.voice = voice;
        utterance.onerror = event => {
          if (activePlayback !== playback) return;
          playback.stop();
          if (event.error !== 'canceled' && event.error !== 'interrupted') setError('failed');
        };
        return utterance;
      });
      const lastUtterance = utterancesRef.current[utterancesRef.current.length - 1];
      lastUtterance.onend = () => playback.stop();
      // Keep speak synchronous with the menu press for browsers requiring activation.
      utterancesRef.current.forEach(utterance => synthesis.speak(utterance));
    } catch {
      playback.stop();
      setError('failed');
    }
  };

  return { isSpeaking, error, toggleSpeech };
}
