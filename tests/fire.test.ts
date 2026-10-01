import { describe, expect, it } from 'vitest';
import { FireSynth, type FireParams } from '../src/audio/nature/fire/FireSynth';
import { WorldSynth } from '../src/audio/world/WorldSynth';

const FS = 48_000;
const B = 128;

function run(params: Partial<FireParams>, seconds: number, seed = 'f', wind = 0, gust = 0, rain = 0) {
  const f = new FireSynth(FS, seed, params);
  f.setWind(wind, gust);
  f.setRain(rain);
  const l = new Float32Array(B), r = new Float32Array(B);
  let sq = 0, peak = 0, hash = 0, finite = true;
  const blocks = Math.ceil((seconds * FS) / B);
  for (let b = 0; b < blocks; b++) {
    f.process(l, r, B);
    for (let n = 0; n < B; n++) {
      if (!Number.isFinite(l[n]) || !Number.isFinite(r[n])) finite = false;
      sq += l[n] * l[n] + r[n] * r[n];
      peak = Math.max(peak, Math.abs(l[n]), Math.abs(r[n]));
      hash = (Math.imul(hash, 31) + Math.round(l[n] * 1e6)) | 0;
    }
  }
  return { f, rms: Math.sqrt(sq / (2 * blocks * B)), peak, hash, finite };
}
const db = (x: number) => 20 * Math.log10(x + 1e-12);

describe('FireSynth', () => {
  it('is deterministic, finite and bounded at every setting', () => {
    expect(run({}, 4).hash).toBe(run({}, 4).hash);
    for (const amount of [0, 0.5, 1]) for (const crackle of [0, 1]) {
      const s = run({ amount, crackle, roar: 1 }, 6, 'b', 1.5, 2, 40);
      expect(s.finite).toBe(true);
      expect(s.peak).toBeLessThan(1.5);
    }
  });

  it('crackles and pops, more with more crackle and in gusts', () => {
    const count = (p: Partial<FireParams>, wind = 0, gust = 0) => run(p, 20, 'c', wind, gust).f.drainEvents().length;
    const calm = count({ amount: 0.6, crackle: 0.2 });
    const busy = count({ amount: 0.6, crackle: 0.9 });
    expect(busy).toBeGreaterThan(calm);
    expect(count({ amount: 0.6, crackle: 0.6 }, 1.2, 1.5)).toBeGreaterThan(count({ amount: 0.6, crackle: 0.6 }));
    expect(busy).toBeGreaterThan(5);
  });

  it('is louder as it grows, and sits near the other ambience levels (report)', () => {
    const small = run({ amount: 0.15 }, 20);
    const mid = run({ amount: 0.5 }, 20);
    const big = run({ amount: 1 }, 20);
    expect(big.rms).toBeGreaterThan(small.rms);
    if (process.env.MEASURE) console.log('fire rms dB', db(small.rms).toFixed(1), db(mid.rms).toFixed(1), db(big.rms).toFixed(1), 'peak', db(big.peak).toFixed(1));
  });

  it('is off by default in the world and reports levels and events when lit', () => {
    const w = new WorldSynth(FS, 'w', { mix: { fire: { on: true } }, fire: { amount: 0.7, crackle: 0.8 } });
    const l = new Float32Array(B), r = new Float32Array(B);
    for (let b = 0; b < (6 * FS) / B; b++) w.process(l, r, B);
    expect(w.features().level.fire).toBeGreaterThan(1e-3);
    expect(w.drainEvents().fire.length).toBeGreaterThan(0);
    const off = new WorldSynth(FS, 'w');
    for (let b = 0; b < (2 * FS) / B; b++) off.process(l, r, B);
    expect(off.features().level.fire).toBeLessThan(1e-6);
  });
});
