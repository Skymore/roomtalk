// Pure audio/transcript helpers for streaming voice-to-text. Kept free of any
// module side effects (no socket import) so they're trivially unit-testable.

// Linear-interpolation downsample from the AudioContext rate to a lower rate (mono).
export function downsampleBuffer(input: Float32Array, inputRate: number, targetRate: number): Float32Array {
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
export function floatToPCM16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

// Join per-turn transcripts (keyed by turn_order) into one ordered string.
// Turns can arrive out of order and update in place as they finalize.
export function buildTranscriptFromTurns(turns: Map<number, string>): string {
  return [...turns.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, transcript]) => transcript)
    .join(' ')
    .trim();
}
