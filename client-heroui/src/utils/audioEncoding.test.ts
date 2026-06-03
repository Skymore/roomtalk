import { describe, it, expect } from 'vitest';
import {
  buildTranscriptFromTurns,
  downsampleBuffer,
  floatToPCM16,
} from './audioEncoding';

describe('downsampleBuffer', () => {
  it('returns the input unchanged when the target rate is not lower', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsampleBuffer(input, 16000, 16000)).toBe(input);
    expect(downsampleBuffer(input, 16000, 32000)).toBe(input);
  });

  it('reduces the sample count by the rate ratio', () => {
    const input = new Float32Array(48000).fill(0.5);
    const output = downsampleBuffer(input, 48000, 16000);
    // 48k -> 16k is a 3:1 ratio.
    expect(output.length).toBe(16000);
    // Averaging a constant signal preserves its value.
    expect(output[0]).toBeCloseTo(0.5, 5);
    expect(output[output.length - 1]).toBeCloseTo(0.5, 5);
  });
});

describe('floatToPCM16', () => {
  it('maps the float range to signed 16-bit PCM', () => {
    const out = floatToPCM16(new Float32Array([0, 1, -1]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767); // 0x7fff
    expect(out[2]).toBe(-32768); // -0x8000
  });

  it('clamps values outside [-1, 1]', () => {
    const out = floatToPCM16(new Float32Array([2, -2]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  it('produces an Int16Array of matching length', () => {
    const out = floatToPCM16(new Float32Array([0.25, -0.5, 0.75]));
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(3);
  });
});

describe('buildTranscriptFromTurns', () => {
  it('joins turns in turn_order regardless of insertion order', () => {
    const turns = new Map<number, string>();
    turns.set(2, 'world');
    turns.set(1, 'hello');
    expect(buildTranscriptFromTurns(turns)).toBe('hello world');
  });

  it('reflects in-place updates to a turn', () => {
    const turns = new Map<number, string>();
    turns.set(1, 'hel');
    turns.set(1, 'hello there');
    expect(buildTranscriptFromTurns(turns)).toBe('hello there');
  });

  it('returns an empty string for no turns', () => {
    expect(buildTranscriptFromTurns(new Map())).toBe('');
  });
});
