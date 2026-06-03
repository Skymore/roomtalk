import { createTranscriptionToken } from './socket';

const ASSEMBLYAI_WS_BASE = 'wss://streaming.assemblyai.com/v3/ws';
const TARGET_SAMPLE_RATE = 16000;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

export interface StreamingTranscriber {
  /** Stop capture, terminate the session, and resolve once cleaned up. */
  stop: () => Promise<void>;
  /** The full transcript accumulated so far. */
  getText: () => string;
}

// Linear-interpolation downsample from the AudioContext rate to 16 kHz mono.
function downsampleBuffer(input: Float32Array, inputRate: number, targetRate: number): Float32Array {
  if (targetRate >= inputRate) return input;
  const ratio = inputRate / targetRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  let outIndex = 0;
  let inIndex = 0;
  while (outIndex < outLength) {
    const nextInIndex = Math.round((outIndex + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let i = inIndex; i < nextInIndex && i < input.length; i++) {
      sum += input[i];
      count++;
    }
    output[outIndex] = count > 0 ? sum / count : 0;
    outIndex++;
    inIndex = nextInIndex;
  }
  return output;
}

// Convert Float32 [-1, 1] samples to signed 16-bit PCM little-endian.
function floatToPCM16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
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
    fullText = [...turns.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, transcript]) => transcript)
      .join(' ')
      .trim();
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
