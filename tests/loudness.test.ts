import { describe, expect, it } from 'vitest';
import { loudnessLufs } from '../src/audio/dsp/loudness';

describe('loudness', () => {
  it('a full-scale 1 kHz sine in one channel measures about −3.01 LUFS', () => {
    for (const fs of [44_100, 48_000]) {
      const x = new Float32Array(fs * 2);
      for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 1000 * i) / fs);
      expect(loudnessLufs([x], fs)).toBeCloseTo(-3.01, 1);
    }
  });

  it('silence is −Infinity', () => {
    expect(loudnessLufs([new Float32Array(100)], 48_000)).toBe(-Infinity);
  });
});
