import { createTranscriptionToken } from './socket';
import { buildTranscriptFromTurns, downsampleBuffer, floatToPCM16 } from './audioEncoding';

const ASSEMBLYAI_WS_BASE = 'wss://streaming.assemblyai.com/v3/ws';
const TARGET_SAMPLE_RATE = 16000;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

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
      if (msg.type === 'Turn' && typeof msg.transcript === 'string') {
        turns.set(typeof msg.turn_order === 'number' ? msg.turn_order : 0, msg.transcript);
        rebuild();
      }
    } catch {
      /* ignore malformed frames */
    }
  };

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioCtx();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
  const inputRate = audioContext.sampleRate;

  processor.onaudioprocess = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const channelData = e.inputBuffer.getChannelData(0);
    const downsampled = downsampleBuffer(channelData, inputRate, TARGET_SAMPLE_RATE);
    const pcm = floatToPCM16(downsampled);
    ws.send(pcm.buffer);
  };

  // The processor only fires while connected to the graph. We never write to the
  // output buffer, so it emits silence — no echo back through the speakers.
  source.connect(processor);
  processor.connect(audioContext.destination);

  // Best-effort wait for the socket to open before counting on audio delivery.
  await new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(resolve, 3000);
    ws.addEventListener('open', () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });

  const stop = async () => {
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
