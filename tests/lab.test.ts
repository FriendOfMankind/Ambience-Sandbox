import { describe, expect, it } from 'vitest';
import { WorldSynth } from '../src/audio/world/WorldSynth';
import { LAB_TESTS } from '../spikes/lab/tests';
import { sceneState, stateToPatch } from '../spikes/sandbox/scenes';
import { buildReport, emptyFeedback, getPath, hasFeedback, patchFor, setPath, type Feedback } from '../spikes/lab/feedback';

const FS = 48_000;

describe('lab tests catalogue', () => {
  it('has unique ids and every tunable path resolves to a number', () => {
    expect(new Set(LAB_TESTS.map((t) => t.id)).size).toBe(LAB_TESTS.length);
    for (const t of LAB_TESTS) {
      const w = sceneState(t.scene).world;
      for (const tune of t.tune) {
        const v = getPath(w, tune.path);
        expect(typeof v, `${t.id} ${tune.path}`).toBe('number');
        expect(tune.fmt(tune.invert ? 1 - v : v).length).toBeGreaterThan(0);
        expect(v, `${t.id} ${tune.path} start value inside its slider range`).toBeGreaterThanOrEqual(tune.min - 1e-9);
        expect(v, `${t.id} ${tune.path} start value inside its slider range`).toBeLessThanOrEqual(tune.max + 1e-9);
      }
    }
  });

  it('isolates the layers it says it measures', () => {
    for (const t of LAB_TESTS) {
      const mix = sceneState(t.scene).world.mix;
      for (const l of t.layers) expect(mix[l].on, `${t.id}: ${l} should be on`).toBe(true);
      if (!t.id.startsWith('scene-')) for (const l of ['rain', 'wind', 'chimes', 'music'] as const) if (!t.layers.includes(l)) expect(mix[l].on, `${t.id}: ${l} should be off`).toBe(false);
    }
  });

  // Levels are what the lab is for calibrating (the gale peaks well above full scale before the
  // limiter), so this only guards against blow-ups and dead tests, not against loudness.
  it('renders every test to finite, non-blown-up audio', () => {
    for (const t of LAB_TESTS) {
      const st = sceneState(t.scene);
      const w = new WorldSynth(FS, `lab-${t.id}`, stateToPatch(st));
      const l = new Float32Array(1024);
      const r = new Float32Array(1024);
      let peak = 0;
      let sq = 0;
      let n = 0;
      // 8 s per test keeps the suite quick.
      for (let b = 0; b < (8 * FS) / 1024; b++) {
        w.process(l, r);
        for (let i = 0; i < 1024; i++) {
          expect(Number.isFinite(l[i]) && Number.isFinite(r[i]), `${t.id} finite`).toBe(true);
          peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
          sq += l[i] * l[i];
          n++;
        }
      }
      // Chimes in light air are sparse on purpose (a strike every ~8 s), so a short window can be silent.
      if (t.id !== 'chimes-light') expect(Math.sqrt(sq / n), `${t.id} is not silent`).toBeGreaterThan(1e-5);
      expect(peak, `${t.id} peak`).toBeLessThan(50);
    }
  }, 120_000);
});

describe('feedback', () => {
  it('sets and reads paths, and builds the patch for a top-level key', () => {
    const w = sceneState(LAB_TESTS[0].scene).world;
    setPath(w, 'rain.surfaceMix.tin', 0.5);
    expect(getPath(w, 'rain.surfaceMix.tin')).toBe(0.5);
    expect(Object.keys(patchFor(w as never, 'mix.rain.level'))).toEqual(['mix']);
    expect(Object.keys(patchFor(w as never, 'rain.rate'))).toEqual(['rain']);
  });

  it('reports only tests with feedback, and lists the rest as not heard', () => {
    const tin = LAB_TESTS.find((t) => t.id === 'tin')!;
    const f: Feedback = { ...emptyFeedback(), real: 4, pleasant: 3, level: -1, tags: ['metallic'], note: 'sounds\nlike a  shed', tuned: { 'rain.rate': 22 }, measured: { rmsDb: -31.2, peakDb: -9, limiterDb: 0, seconds: 42 } };
    expect(hasFeedback(emptyFeedback())).toBe(false);
    const text = buildReport(LAB_TESTS, { tin: f }, { device: 'Headphones', volumeDb: -12 }, (t, tune) => getPath(sceneState(t.scene).world, tune.path), new Date('2026-09-28T00:00:00Z'));
    expect(text).toContain('# Tarn Lab feedback, 2026-09-28');
    expect(text).toContain('Sounds like tin: 4');
    expect(text).toContain('level too quiet');
    expect(text).toContain('problems: metallic');
    expect(text).toContain('Rain (`rain.rate`): 10 mm/h → 22 mm/h');
    expect(text).toContain('note: sounds like a  shed');
    expect(text).toContain('Not heard yet:');
    expect(text).not.toContain(`## ${tin.group} / Rain on a window`);
  });
});
