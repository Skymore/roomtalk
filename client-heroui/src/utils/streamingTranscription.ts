import { createTranscriptionToken } from './socket';
import { buildTranscriptFromTurns, downsampleBuffer, floatToPCM16 } from './audioEncoding';

const ASSEMBLYAI_WS_BASE = 'wss://streaming.assemblyai.com/v3/ws';
const TARGET_SAMPLE_RATE = 16000;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;
const TRANSCRIPTION_WS_OPEN_TIMEOUT_MS = 5000;

export interface StreamingTranscriber {
  /** Stop capture, terminate the session, and resolve once cleaned up. */
  stop: () => Promise<void>;
  /** The full transcript accumulated so far. */
  getText: () => string;
}

/**
 * Streams microphone audio from an existing MediaStream to AssemblyAI's
 * Universal-3 Pro realtime model and reports the running transcript.
 *
 * The same MediaStream is shared with the MediaRecorder used to capture the
 * voice clip, so transcription runs in parallel with recording.
 */
export async function startStreamingTranscription(
  stream: MediaStream,
  onTranscript: (text: string) => void,
): Promise<StreamingTranscriber> {
  const { token } = await createTranscriptionToken();

  const params = new URLSearchParams({
    sample_rate: String(TARGET_SAMPLE_RATE),
    speech_model: 'u3-rt-pro',
    token,
  });
  const ws = new WebSocket(`${ASSEMBLYAI_WS_BASE}?${params.toString()}`);
  ws.binaryType = 'arraybuffer';
  let isStopped = false;
  let didSendAudio = false;

  if (import.meta.env.DEV) {
    console.info('[VoiceToText] transcription token received');
  }

  // Each turn (utterance separated by a pause) updates in place by turn_order.
  const turns = new Map<number, string>();
  let fullText = '';
  const rebuild = () => {
    fullText = buildTranscriptFromTurns(turns);
    onTranscript(fullText);
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    try {
      const msg = JSON.parse(event.data);
      if (import.meta.env.DEV) {
        console.debug('[VoiceToText] transcription message', msg.type);
      }
      if (msg.type === 'Turn' && typeof msg.transcript === 'string') {
        turns.set(typeof msg.turn_order === 'number' ? msg.turn_order : 0, msg.transcript);
        rebuild();
      }
    } catch {
      /* ignore malformed frames */
    }
  };

  await new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      ws.removeEventListener('open', handleOpen);
      ws.removeEventListener('error', handleError);
      ws.removeEventListener('close', handleClose);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const handleOpen = () => {
      if (import.meta.env.DEV) {
        console.info('[VoiceToText] AssemblyAI websocket opened');
      }
      settle(resolve);
    };
    const handleError = () => {
      settle(() => reject(new Error('Voice transcription websocket failed')));
    };
    const handleClose = () => {
      settle(() => reject(new Error('Voice transcription websocket closed before opening')));
    };
    const timeout = window.setTimeout(() => {
      settle(() => reject(new Error('Timed out connecting to voice transcription')));
    }, TRANSCRIPTION_WS_OPEN_TIMEOUT_MS);

    ws.addEventListener('open', handleOpen);
    ws.addEventListener('error', handleError);
    ws.addEventListener('close', handleClose);
  });

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioCtx();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
  const inputRate = audioContext.sampleRate;

  processor.onaudioprocess = (e) => {
    if (isStopped || ws.readyState !== WebSocket.OPEN) return;
    const channelData = e.inputBuffer.getChannelData(0);
    const downsampled = downsampleBuffer(channelData, inputRate, TARGET_SAMPLE_RATE);
    const pcm = floatToPCM16(downsampled);
    if (import.meta.env.DEV && !didSendAudio) {
      console.info('[VoiceToText] sending microphone audio');
      didSendAudio = true;
    }
    ws.send(pcm.buffer);
  };

  // The processor only fires while connected to the graph. We never write to the
  // output buffer, so it emits silence — no echo back through the speakers.
  source.connect(processor);
  processor.connect(audioContext.destination);
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const stop = async () => {
    isStopped = true;
    try { processor.disconnect(); } catch { /* noop */ }
    try { source.disconnect(); } catch { /* noop */ }
    try { processor.onaudioprocess = null; } catch { /* noop */ }
    try { await audioContext.close(); } catch { /* noop */ }
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'Terminate' }));
      }
    } catch { /* noop */ }
    window.setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
    }, 300);
  };

  return { stop, getText: () => fullText };
}
