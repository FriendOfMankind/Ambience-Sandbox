import { describe, expect, it } from 'vitest';
import { WindSynth } from '../src/audio/nature/wind/WindSynth';
import { ChimeSynth } from '../src/audio/nature/chimes/ChimeSynth';
import { MusicSynth } from '../src/audio/music/MusicSynth';
import { Reverb } from '../src/audio/dsp/Reverb';
import { WorldSynth, type WorldParamsPatch } from '../src/audio/world/WorldSynth';
import { SCALES, scaleStepHz } from '../src/audio/music/scales';
import { snapToScale } from '../src/audio/nature/rain/physics';

const FS = 48_000;
const B = 128;

function stats(render: (l: Float32Array, r: Float32Array) => void, seconds: number) {
  const l = new Float32Array(B);
  const r = new Float32Array(B);
  let peak = 0, sq = 0, hash = 0, finite = true;
  const blocks = Math.ceil((seconds * FS) / B);
  for (let b = 0; b < blocks; b++) {
    render(l, r);
    for (let n = 0; n < B; n++) {
      if (!Number.isFinite(l[n]) || !Number.isFinite(r[n])) finite = false;
      peak = Math.max(peak, Math.abs(l[n]), Math.abs(r[n]));
      sq += l[n] * l[n];
      hash = (Math.imul(hash, 31) + Math.round(l[n] * 1e6)) | 0;
    }
  }
  return { peak, rms: Math.sqrt(sq / (blocks * B)), hash, finite };
}

describe('scales', () => {
  it('steps wrap across octaves', () => {
    const s = SCALES.dPent;
    expect(scaleStepHz(s, 0)).toBeCloseTo(s.rootHz, 6);
    expect(scaleStepHz(s, 5)).toBeCloseTo(s.rootHz * 2, 6);
    expect(scaleStepHz(s, -5)).toBeCloseTo(s.rootHz / 2, 6);
  });
});

describe('WindSynth', () => {
  it('is deterministic, finite, and louder when windier', () => {
    const run = (amount: number, seed = 'w') => {
      const w = new WindSynth(FS, seed, { amount });
      return stats((l, r) => w.process(l, r, B), 4);
    };
    expect(run(0.3).hash).toBe(run(0.3).hash);
    expect(run(0.9).rms).toBeGreaterThan(run(0.1).rms);
    for (const a of [0, 0.5, 1]) {
      const s = run(a);
      expect(s.finite).toBe(true);
      expect(s.peak).toBeLessThan(4);
    }
  });

  it('gusts vary the speed around the base amount', () => {
    const w = new WindSynth(FS, 'g', { amount: 0.5, gustiness: 1 });
    const l = new Float32Array(B), r = new Float32Array(B);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < (30 * FS) / B; i++) {
      w.process(l, r, B);
      min = Math.min(min, w.speed);
      max = Math.max(max, w.speed);
    }
    expect(max - min).toBeGreaterThan(0.2);
  });
});

describe('ChimeSynth', () => {
  it('is silent in calm air and rings in wind', () => {
    const calm = new ChimeSynth(FS, 'c', { threshold: 0.3 });
    calm.setWindSpeed(0.1);
    expect(stats((l, r) => calm.process(l, r, B), 5).peak).toBe(0);

    const windy = new ChimeSynth(FS, 'c', { threshold: 0.3 });
    windy.setWindSpeed(1);
    const s = stats((l, r) => windy.process(l, r, B), 5);
    expect(s.peak).toBeGreaterThan(0.01);
    expect(s.peak).toBeLessThan(2);
    expect(s.finite).toBe(true);
  });

  it('tubes are tuned to the scale, from the requested register', () => {
    const scale = SCALES.dDorian;
    const c = new ChimeSynth(FS, 't', { scale, tubes: 6, lowestHz: 500 });
    const f = c.tubeFrequencies;
    expect(f).toHaveLength(6);
    expect(f[0]).toBeGreaterThanOrEqual(500);
    for (const hz of f) expect(snapToScale(hz, scale.rootHz, scale.cents)).toBeCloseTo(hz, 3);
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThan(f[i - 1]);
  });
});

describe('MusicSynth', () => {
  it('plays notes in the scale and changes chords', () => {
    const scale = SCALES.fLydian;
    const m = new MusicSynth(FS, 'm', { scale, density: 30, chordSeconds: 8 });
    const sl = new Float32Array(B), sr = new Float32Array(B);
    const s = stats((l, r) => m.process(l, r, sl, sr, B), 40);
    expect(s.finite).toBe(true);
    expect(s.peak).toBeLessThan(2);
    expect(s.rms).toBeGreaterThan(0.001);
    const ev = m.drainEvents();
    const notes = ev.filter((e) => e.kind === 'note');
    const chords = ev.filter((e) => e.kind === 'chord');
    expect(notes.length).toBeGreaterThan(5);
    expect(chords.length).toBeGreaterThan(2);
    for (const n of notes) expect(snapToScale(n.hz, scale.rootHz, scale.cents)).toBeCloseTo(n.hz, 3);
  });
});

describe('Reverb', () => {
  it('decays roughly as asked and stays finite', () => {
    const rv = new Reverb(FS, { t60: 1 });
    const inL = new Float32Array(B), inR = new Float32Array(B);
    const outL = new Float32Array(B), outR = new Float32Array(B);
    inL[0] = 1;
    inR[0] = 1;
    const energy: number[] = [];
    for (let b = 0; b < (2.5 * FS) / B; b++) {
      rv.process(inL, inR, outL, outR, B);
      inL.fill(0);
      inR.fill(0);
      let e = 0;
      for (let n = 0; n < B; n++) e += outL[n] * outL[n] + outR[n] * outR[n];
      energy.push(e);
    }
    const sum = (a: number, b: number) => energy.slice(Math.floor((a * FS) / B), Math.floor((b * FS) / B)).reduce((x, y) => x + y, 0);
    const early = sum(0.1, 0.3);
    const late = sum(1.1, 1.3); // one T60 later: expect about −60 dB
    expect(Number.isFinite(early)).toBe(true);
    const dropDb = 10 * Math.log10(early / late);
    expect(dropDb).toBeGreaterThan(45);
    expect(dropDb).toBeLessThan(80);
  });
});

describe('WorldSynth', () => {
  const run = (patch: WorldParamsPatch, seed = 'world', seconds = 4) => {
    const w = new WorldSynth(FS, seed, patch);
    const s = stats((l, r) => w.process(l, r, B), seconds);
    return { ...s, w };
  };

  it('is deterministic for a seed', () => {
    expect(run({}).hash).toBe(run({}).hash);
  });

  it('stays finite and bounded, including a strange configuration', () => {
    const strange: WorldParamsPatch = {
      scale: SCALES.cluster,
      wind: { amount: 1, gustiness: 1, whistle: 1 },
      rain: { rate: 200, stretch: 10, surfaceMix: { water: 1, leaves: 0, grass: 0, stone: 0, tin: 1, glass: 1, bells: 1 } },
      music: { detune: 60, density: 40, keysRatio: 3.7 },
      chimes: { sustain: 3, activity: 4 },
      reverb: { t60: 20 },
    };
    for (const patch of [{}, strange]) {
      const s = run(patch, 'x', 6);
      expect(s.finite).toBe(true);
      expect(s.peak).toBeLessThan(6); // the master limiter handles anything above 1
    }
  });

  it('muting a layer removes it', () => {
    const allOff: WorldParamsPatch = {
      mix: { rain: { on: false }, wind: { on: false }, chimes: { on: false }, music: { on: false } },
    };
    const w = new WorldSynth(FS, 'mute', allOff);
    const s = stats((l, r) => w.process(l, r, B), 2);
    expect(s.peak).toBeLessThan(1e-3);
  });

  it('wind drives the chimes: no wind, no chimes', () => {
    const calm = run({ wind: { amount: 0, gustiness: 0 } }, 'c', 8).w;
    expect(calm.drainEvents().chimes.length).toBe(0);
    const windy = run({ wind: { amount: 0.9 } }, 'c', 8).w;
    expect(windy.drainEvents().chimes.length).toBeGreaterThan(3);
  });

  it('reports per-layer levels', () => {
    const w = run({ mix: { music: { on: false } } }, 'f', 3).w;
    const f = w.features();
    expect(f.level.rain).toBeGreaterThan(0);
    expect(f.level.wind).toBeGreaterThan(0);
    expect(f.level.music).toBeLessThan(1e-3);
  });
});

describe('Leaves', () => {
  it('leaves add sound that grows with the wind, and none when set to zero', () => {
    const rms = (rustle: number, amount: number) => {
      const w = new WindSynth(FS, 'leaf', { amount, rustle, whistle: 0, gustiness: 0 });
      const base = new WindSynth(FS, 'leaf', { amount, rustle: 0, whistle: 0, gustiness: 0 });
      const l = new Float32Array(B), r = new Float32Array(B), l2 = new Float32Array(B), r2 = new Float32Array(B);
      let sq = 0;
      for (let i = 0; i < (6 * FS) / B; i++) {
        w.process(l, r, B);
        base.process(l2, r2, B);
        if (i * B > FS) for (let n = 0; n < B; n++) sq += (l[n] - l2[n]) ** 2;
      }
      return Math.sqrt(sq / (5 * FS));
    };
    expect(rms(0, 0.6)).toBe(0);
    expect(rms(1, 0.8)).toBeGreaterThan(rms(1, 0.2) * 1.5);
  });
});
