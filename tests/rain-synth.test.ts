import { describe, expect, it } from 'vitest';
import { DEFAULT_RAIN_PARAMS, RainSynth, type RainParams } from '../src/audio/nature/rain/RainSynth';
import { snapToScale } from '../src/audio/nature/rain/physics';

const FS = 48_000;

function render(seed: string, seconds: number, params: Partial<RainParams> = {}) {
  const synth = new RainSynth(FS, seed, params);
  const block = 128;
  const blocks = Math.ceil((seconds * FS) / block);
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  let peak = 0;
  let sumSq = 0;
  let hash = 0;
  let finite = true;
  for (let b = 0; b < blocks; b++) {
    synth.process(l, r, block);
    for (let n = 0; n < block; n++) {
      if (!Number.isFinite(l[n]) || !Number.isFinite(r[n])) finite = false;
      peak = Math.max(peak, Math.abs(l[n]), Math.abs(r[n]));
      sumSq += l[n] * l[n] + r[n] * r[n];
      hash = (Math.imul(hash, 31) + Math.round(l[n] * 1e6)) | 0;
    }
  }
  const rms = Math.sqrt(sumSq / (blocks * block * 2));
  return { synth, peak, rms, hash, finite, events: synth.drainEvents() };
}

describe('RainSynth', () => {
  it('is deterministic for a seed', () => {
    expect(render('tarn', 2).hash).toBe(render('tarn', 2).hash);
  });

  it('differs between seeds', () => {
    expect(render('tarn', 2).hash).not.toBe(render('other', 2).hash);
  });

  it('gets louder with heavier rain', () => {
    expect(render('x', 3, { rate: 40 }).rms).toBeGreaterThan(render('x', 3, { rate: 1 }).rms);
  });

  it('stays finite and bounded at sandbox extremes', () => {
    const extremes: Partial<RainParams>[] = [
      { rate: 500, sizeBias: 2, nearDensity: 4, midDensity: 4 },
      { rate: 50, stretch: 20, surfaceMix: { water: 0, leaves: 0, grass: 0, stone: 0, metal: 1, glass: 1 } },
      { rate: 0.1, sizeBias: -2 },
      { rate: 20, bubblePitch: 2, bubbleGlide: 2 },
      { rate: 20, bubblePitch: -3 },
      { rate: 0 },
    ];
    for (const p of extremes) {
      const res = render('extreme', 3, p);
      expect(res.finite).toBe(true);
      // Pre-limiter headroom; the master limiter handles anything above 1.
      expect(res.peak).toBeLessThan(8);
    }
  });

  it('is silent with zero rate and zero far level', () => {
    const res = render('quiet', 1, { rate: 0, farLevel: 0 });
    expect(res.peak).toBe(0);
  });

  it('near-drop event rate is in the expected range', () => {
    const res = render('rate', 20, { rate: 5, wind: 0 });
    const perSec = res.events.length / 20;
    expect(perSec).toBeGreaterThan(res.synth.stats.nearRate * 0.7);
    expect(perSec).toBeLessThan(res.synth.stats.nearRate * 1.3);
  });

  it('snaps near-drop timing to the grid when enabled', () => {
    const bpm = 90;
    const division = 4;
    const res = render('grid', 10, { rate: 10, grid: { enabled: true, bpm, division } });
    const step = (60 / bpm / division) * FS;
    expect(res.events.length).toBeGreaterThan(10);
    for (const e of res.events) {
      const k = e.frame / step;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1 / step + 1e-6);
    }
  });

  it('snaps bubble pitches to the scale when enabled', () => {
    const scale = { enabled: true, rootHz: 146.83, cents: [0, 300, 500, 700, 1000], periodCents: 1200 };
    const res = render('key', 10, {
      rate: 10,
      surfaceMix: { water: 1, leaves: 0, grass: 0, stone: 0, metal: 0, glass: 0 },
      scale,
    });
    const bubbles = res.events.filter((e) => e.bubbleHz > 0);
    expect(bubbles.length).toBeGreaterThan(5);
    for (const e of bubbles) {
      expect(snapToScale(e.bubbleHz, scale.rootHz, scale.cents)).toBeCloseTo(e.bubbleHz, 3);
    }
  });

  it('default params produce a reasonable level', () => {
    const res = render('level', 4, DEFAULT_RAIN_PARAMS);
    expect(res.rms).toBeGreaterThan(0.005);
    expect(res.rms).toBeLessThan(0.5);
  });
});

describe('RainSynth in a worklet-like scope', () => {
  it('does not depend on structuredClone (missing in AudioWorkletGlobalScope)', () => {
    const g = globalThis as { structuredClone?: unknown };
    const saved = g.structuredClone;
    g.structuredClone = undefined;
    try {
      const s = new RainSynth(FS, 'worklet', { rate: 5 });
      s.setParams({ rate: 10 });
      s.process(new Float32Array(128), new Float32Array(128), 128);
    } finally {
      g.structuredClone = saved;
    }
  });
});
