import { describe, expect, it } from 'vitest';
import { Limiter } from '../src/audio/dsp/limiter';
import { createRng } from '../src/core/rng';

const FS = 48_000;

function run(lim: Limiter, l: Float32Array, r: Float32Array) {
  const outL = new Float32Array(l.length);
  const outR = new Float32Array(r.length);
  for (let i = 0; i < l.length; i += 128) {
    const n = Math.min(128, l.length - i);
    lim.process(l.subarray(i, i + n), r.subarray(i, i + n), outL.subarray(i, i + n), outR.subarray(i, i + n), n);
  }
  return { outL, outR };
}

describe('Limiter', () => {
  it('never exceeds the ceiling, even on violent input', () => {
    const lim = new Limiter({ sampleRate: FS });
    const rng = createRng('lim');
    const n = FS * 2;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Noise with random bursts up to +30 dB and a sudden step halfway.
      const burst = rng.chance(0.001) ? 30 : 1;
      const step = i > n / 2 ? 10 : 0.5;
      l[i] = (rng.next() * 2 - 1) * burst * step;
      r[i] = (rng.next() * 2 - 1) * step;
    }
    const { outL, outR } = run(lim, l, r);
    for (let i = 0; i < n; i++) {
      expect(Math.abs(outL[i])).toBeLessThanOrEqual(lim.ceiling + 1e-6);
      expect(Math.abs(outR[i])).toBeLessThanOrEqual(lim.ceiling + 1e-6);
    }
  });

  it('passes quiet signals through unchanged, delayed by the lookahead', () => {
    const lim = new Limiter({ sampleRate: FS });
    const n = 4800;
    const l = new Float32Array(n);
    for (let i = 0; i < n; i++) l[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / FS);
    const { outL } = run(lim, l, l.slice());
    for (let i = lim.lookahead; i < n; i++) expect(outL[i]).toBeCloseTo(l[i - lim.lookahead], 6);
  });

  it('mutes and recovers after NaN input', () => {
    const lim = new Limiter({ sampleRate: FS, muteMs: 50 });
    const n = FS / 2;
    const l = new Float32Array(n).fill(0.2);
    l[1000] = Number.NaN;
    const { outL } = run(lim, l, new Float32Array(n).fill(0.2));
    expect(lim.nanEvents).toBe(1);
    expect(outL[1000 + 100]).toBe(0);
    // After the mute window plus lookahead, signal is back.
    const back = 1000 + Math.round(0.05 * FS) + lim.lookahead + 10;
    expect(outL[back]).toBeCloseTo(0.2, 5);
    expect(outL.every(Number.isFinite)).toBe(true);
  });
});
