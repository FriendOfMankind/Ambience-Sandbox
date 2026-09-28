import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import {
  D_MAX,
  D_MIN,
  dropFlux,
  minnaertFrequency,
  mpLambda,
  sampleDropDiameter,
  snapToScale,
  terminalVelocity,
} from '../src/audio/nature/rain/physics';

describe('rain physics', () => {
  it('Marshall–Palmer slope matches the published form', () => {
    expect(mpLambda(1)).toBeCloseTo(4.1, 5);
    expect(mpLambda(10)).toBeCloseTo(4.1 * Math.pow(10, -0.21), 5);
  });

  it('terminal velocity is in the known range', () => {
    expect(terminalVelocity(1)).toBeGreaterThan(3.5);
    expect(terminalVelocity(1)).toBeLessThan(4.5);
    expect(terminalVelocity(5)).toBeGreaterThan(8.5);
  });

  it('drop flux rises with rain rate', () => {
    const f1 = dropFlux(1);
    const f10 = dropFlux(10);
    const f50 = dropFlux(50);
    expect(f10).toBeGreaterThan(f1);
    expect(f50).toBeGreaterThan(f10);
    expect(dropFlux(0)).toBe(0);
  });

  it('sampled diameters stay in range and get larger in heavier rain', () => {
    const r = createRng('dsd');
    const mean = (rate: number) => {
      const lambda = mpLambda(rate);
      let s = 0;
      for (let i = 0; i < 20_000; i++) {
        const d = sampleDropDiameter(r, lambda);
        expect(d).toBeGreaterThanOrEqual(D_MIN);
        expect(d).toBeLessThanOrEqual(D_MAX);
        s += d;
      }
      return s / 20_000;
    };
    expect(mean(50)).toBeGreaterThan(mean(1));
  });

  it('Minnaert frequency is ~3.26 kHz for a 1 mm bubble', () => {
    expect(minnaertFrequency(1)).toBeCloseTo(3260, 0);
  });

  it('snaps to the nearest scale degree across octaves', () => {
    const root = 220;
    const pent = [0, 300, 500, 700, 1000];
    expect(snapToScale(440, root, pent)).toBeCloseTo(440, 6);
    // 20 cents above A4 snaps back to A4
    expect(snapToScale(440 * Math.pow(2, 20 / 1200), root, pent)).toBeCloseTo(440, 6);
    // 1180 cents above root is closer to the next octave's root than to 1000
    expect(snapToScale(root * Math.pow(2, 1180 / 1200), root, pent)).toBeCloseTo(440, 6);
    // Below the root works too
    expect(snapToScale(root / 2, root, pent)).toBeCloseTo(110, 6);
  });
});
