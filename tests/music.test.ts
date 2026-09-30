import { describe, expect, it } from 'vitest';
import { MusicSynth, VOICINGS, type MusicParams } from '../src/audio/music/MusicSynth';
import { buildScale, DEFAULT_KEY, lightName, MODES, SCALES } from '../src/audio/music/scales';
import { snapToScale } from '../src/audio/nature/rain/physics';

const FS = 48_000;
const B = 128;
const SILENT = { padLevel: 0, keysLevel: 0, droneLevel: 0, bowlsLevel: 0, plucksLevel: 0, choirLevel: 0, pianoLevel: 0, beat: 0, shimmer: 0 };

function render(params: Partial<MusicParams>, seconds: number, seed = 'm') {
  const m = new MusicSynth(FS, seed, params);
  const l = new Float32Array(B), r = new Float32Array(B), sl = new Float32Array(B), sr = new Float32Array(B);
  let sq = 0, peak = 0, finite = true, hash = 0;
  const blocks = Math.ceil((seconds * FS) / B);
  const t0 = performance.now();
  for (let b = 0; b < blocks; b++) {
    m.process(l, r, sl, sr, B);
    for (let n = 0; n < B; n++) {
      if (!Number.isFinite(l[n]) || !Number.isFinite(sl[n])) finite = false;
      sq += l[n] * l[n] + r[n] * r[n];
      peak = Math.max(peak, Math.abs(l[n]), Math.abs(r[n]));
      hash = (Math.imul(hash, 31) + Math.round(l[n] * 1e6)) | 0;
    }
  }
  const ms = performance.now() - t0;
  return { m, rms: Math.sqrt(sq / (2 * blocks * B)), peak, finite, hash, cpu: ms / (seconds * 1000) };
}
const db = (x: number) => 20 * Math.log10(x + 1e-12);

describe('buildScale', () => {
  it('Light walks the modes from dark to bright', () => {
    expect(lightName({ family: 'modes', light: 0 })).toBe('Phrygian');
    expect(lightName({ family: 'modes', light: 0.99 })).toBe('Lydian');
    // Each brighter mode has a higher sum of degrees.
    const sums = MODES.map((_, i) => buildScale({ ...DEFAULT_KEY, light: (i + 0.5) / MODES.length, purity: 0.5 }).cents.reduce((a, b) => a + b, 0));
    for (let i = 1; i < sums.length; i++) expect(sums[i]).toBeGreaterThan(sums[i - 1]);
  });

  it('purity slides from equal temperament to just intonation', () => {
    const et = buildScale({ ...DEFAULT_KEY, light: 0.7, purity: 0.5 }); // Ionian
    const ji = buildScale({ ...DEFAULT_KEY, light: 0.7, purity: 1 });
    expect(et.cents[2]).toBeCloseTo(400, 6);
    expect(ji.cents[2]).toBeCloseTo(386.31, 1); // 5/4
    expect(ji.cents[4]).toBeCloseTo(701.96, 1); // 3/2
  });

  it('432 tuning lowers the root by about 32 cents', () => {
    const a = buildScale({ ...DEFAULT_KEY, a4: 440 });
    const b = buildScale({ ...DEFAULT_KEY, a4: 432 });
    expect(1200 * Math.log2(a.rootHz / b.rootHz)).toBeCloseTo(31.77, 1);
  });
});

describe('MusicSynth ensemble', { timeout: 120_000 }, () => {
  it('every voice stays finite, bounded and in key', () => {
    const scale = SCALES.dDorian;
    for (const rhythm of ['free', 'loops', 'pulse'] as const) {
      const { m, finite, peak, rms } = render({ scale, rhythm, density: 20, beat: 0.8, choirLevel: 1, bowlsLevel: 1, plucksLevel: 1, droneLevel: 1, shimmer: 1, chordSeconds: 8 }, 30);
      expect(finite).toBe(true);
      expect(peak).toBeLessThan(1.5);
      expect(rms).toBeGreaterThan(0.003);
      const ev = m.drainEvents();
      const notes = ev.filter((e) => e.kind === 'note');
      expect(notes.length).toBeGreaterThan(5);
      for (const v of ['keys', 'pluck', 'bowl'] as const) expect(notes.some((e) => e.voice === v), `${rhythm}: ${v}`).toBe(true);
      for (const e of notes) expect(snapToScale(e.hz, scale.rootHz, scale.cents)).toBeCloseTo(e.hz, 3);
      expect(ev.some((e) => e.kind === 'beat')).toBe(true);
    }
  });

  it('is deterministic for a seed', () => {
    const p = { rhythm: 'loops' as const, beat: 0.5, density: 12 };
    expect(render(p, 8).hash).toBe(render(p, 8).hash);
  });

  it('pulse mode puts notes on the swung eighth grid', () => {
    const { m } = render({ rhythm: 'pulse', tempo: 60, swing: 0.5, density: 30, breath: 0 }, 20);
    const notes = m.drainEvents().filter((e) => e.kind === 'note');
    expect(notes.length).toBeGreaterThan(5);
    // At 60 BPM straight, eighths are every 0.5 s; blocks quantise to 128 samples.
    for (const e of notes) {
      const beats = e.frame / FS;
      const off = Math.abs(beats * 2 - Math.round(beats * 2)) / 2;
      expect(off * FS).toBeLessThan(B + 1);
    }
  });

  it('more breath leaves more silence', () => {
    const count = (breath: number) => render({ breath, density: 20, rhythm: 'free' }, 60).m.drainEvents().filter((e) => e.kind === 'note' && e.voice !== 'bowl').length;
    expect(count(1)).toBeLessThan(count(0));
  });

  it('silence when every voice is off', () => {
    expect(render({ ...SILENT }, 5).peak).toBeLessThan(1e-6);
  });

  it('piano and swelled voices stay in key', () => {
    const scale = SCALES.dDorian;
    const { m, finite, peak } = render({ ...SILENT, scale, pianoLevel: 1, plucksLevel: 1, density: 20, swell: 1 }, 30);
    expect(finite).toBe(true);
    expect(peak).toBeLessThan(1.5);
    const notes = m.drainEvents().filter((e) => e.kind === 'note');
    expect(notes.some((e) => e.voice === 'piano')).toBe(true);
    for (const e of notes) expect(snapToScale(e.hz, scale.rootHz, scale.cents)).toBeCloseTo(e.hz, 3);
  });

  it('every voicing keeps the pad in key, and pedal holds the root', () => {
    const scale = SCALES.dDorian;
    for (const voicing of Object.keys(VOICINGS) as (keyof typeof VOICINGS)[]) {
      const r = render({ scale, voicing, pedal: true, chordSeconds: 6 }, 20);
      expect(r.finite).toBe(true);
      const pad = (r.m as unknown as { padTarget: Float64Array }).padTarget;
      expect(pad[0]).toBeCloseTo(scale.rootHz, 3);
      for (const f of pad) expect(snapToScale(f, scale.rootHz, scale.cents)).toBeCloseTo(f, 3);
    }
  });

  /** Plays plucks for `on` seconds, then silences every voice and measures what remains. */
  function tail(fx: Partial<MusicParams>, after: Partial<MusicParams> = {}): number {
    const m = new MusicSynth(FS, 'tail', { ...SILENT, plucksLevel: 1, density: 30, breath: 0, ...fx });
    const l = new Float32Array(B), r = new Float32Array(B), sl = new Float32Array(B), sr = new Float32Array(B);
    for (let b = 0; b < (12 * FS) / B; b++) m.process(l, r, sl, sr, B);
    m.setParams({ plucksLevel: 0, density: 0, ...after });
    let sq = 0;
    const blocks = (20 * FS) / B;
    for (let b = 0; b < blocks; b++) {
      m.process(l, r, sl, sr, B);
      if (b > blocks - (4 * FS) / B) for (let n = 0; n < B; n++) sq += l[n] * l[n];
    }
    return Math.sqrt(sq / ((4 * FS) / B * B));
  }

  it('the looper keeps layers sounding after the playing stops; freeze holds them', () => {
    const none = tail({});
    const layered = tail({ layers: 0.9, decay: 0.2, loopSeconds: 6 });
    // Freeze with Layers at zero: without the freeze the loop would empty.
    const frozen = tail({ layers: 0.9, loopSeconds: 6 }, { freeze: true, layers: 0 });
    expect(layered).toBeGreaterThan(none * 10 + 1e-5);
    expect(frozen).toBeGreaterThan(1e-4);
  });

  it('tape age and texture stay finite and bounded', () => {
    const r = render({ ...SILENT, padLevel: 1, plucksLevel: 1, density: 20, age: 1, texture: 1, layers: 1, orbit: 1 }, 30);
    expect(r.finite).toBe(true);
    expect(r.peak).toBeLessThan(1.5);
  });

  it('solo voice levels and CPU (report)', () => {
    const voices: [string, Partial<MusicParams>][] = [
      ['pad', { padLevel: 1 }],
      ['keys', { keysLevel: 1, density: 12 }],
      ['drone', { droneLevel: 1 }],
      ['bowls', { bowlsLevel: 1, density: 12 }],
      ['plucks', { plucksLevel: 1, density: 12 }],
      ['choir', { choirLevel: 1 }],
      ['piano', { pianoLevel: 1, density: 12 }],
      ['beat pulse', { beat: 0.25 }],
      ['beat lofi', { beat: 0.9 }],
      ['plucks + layers', { plucksLevel: 1, density: 12, layers: 0.8 }],
      ['plucks + texture', { plucksLevel: 1, density: 12, texture: 0.8 }],
      ['pad + age', { padLevel: 1, age: 1 }],
      ['all', { padLevel: 1, keysLevel: 1, droneLevel: 1, bowlsLevel: 1, plucksLevel: 1, choirLevel: 1, pianoLevel: 1, beat: 0.9, shimmer: 1, density: 12 }],
      ['all + fx', { padLevel: 1, keysLevel: 1, droneLevel: 1, bowlsLevel: 1, plucksLevel: 1, choirLevel: 1, pianoLevel: 1, beat: 0.9, shimmer: 1, density: 12, layers: 0.8, texture: 0.8, age: 0.6, orbit: 1, swell: 0.5 }],
    ];
    const rows = voices.map(([name, p]) => {
      const r = render({ ...SILENT, scale: SCALES.dDorian, ...p }, 30, 'lvl');
      return { name, rmsDb: +db(r.rms).toFixed(1), peakDb: +db(r.peak).toFixed(1), cpuPct: +(r.cpu * 100).toFixed(1) };
    });
    if (process.env.MEASURE) console.table(rows);
    for (const r of rows) expect(r.peakDb).toBeLessThan(3);
  });
});

describe('vibes', () => {
  it('every random roll gives valid, bounded, in-key music', async () => {
    const { randomVibe, sceneState, stateScale } = await import('../spikes/sandbox/scenes');
    const { mulberry } = { mulberry: (a: number) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; } };
    const rnd = mulberry(42);
    for (let i = 0; i < 40; i++) {
      const st = sceneState(randomVibe(rnd));
      const scale = stateScale(st);
      const m = new MusicSynth(FS, `v${i}`, { ...st.world.music, scale });
      const l = new Float32Array(B), r = new Float32Array(B), sl = new Float32Array(B), sr = new Float32Array(B);
      let peak = 0;
      for (let b = 0; b < (4 * FS) / B; b++) {
        m.process(l, r, sl, sr, B);
        for (let n = 0; n < B; n++) peak = Math.max(peak, Math.abs(l[n]));
      }
      expect(Number.isFinite(peak)).toBe(true);
      expect(peak).toBeLessThan(1.5);
      for (const e of m.drainEvents()) if (e.kind === 'note') expect(snapToScale(e.hz, scale.rootHz, scale.cents)).toBeCloseTo(e.hz, 3);
    }
  }, 120_000);
});
