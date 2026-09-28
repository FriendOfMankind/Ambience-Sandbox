/**
 * WindSynth: procedural wind. It is also the world's source of gusts.
 *
 * - body:    noise through a resonant band-pass whose centre and level rise with wind speed
 * - whistle: narrow resonances (wind past edges, pine needles) that appear in strong gusts
 * - leaves:  a swelling tree canopy plus individual leaves fluttering nearby (see Leaves)
 *
 * Wind speed = amount × (1 + gusts). Gusts are two Ornstein–Uhlenbeck processes (fast
 * gusts plus slow swells). Other layers read `gust` and `speed` so the rain sheets and the
 * chime clapper move with the same wind you hear. After Farnell's procedural wind
 * (Designing Sound); all constants are initial guesses awaiting listening tests.
 */

import { createRng, type Rng } from '../../../core/rng';
import { Leaves } from './Leaves';

export interface WindParams {
  /** Base wind strength 0..1 (calm → strong). */
  amount: number;
  /** How much gusts vary the wind 0..1. */
  gustiness: number;
  /** Level of whistling resonances in strong gusts 0..1. */
  whistle: number;
  /** Level of leaves (canopy + flutters) 0..1. */
  rustle: number;
  /** Overall brightness shift in octaves (−1..1). */
  tone: number;
}

export const DEFAULT_WIND_PARAMS: WindParams = {
  amount: 0.35,
  gustiness: 0.6,
  whistle: 0.3,
  rustle: 0.4,
  tone: 0,
};

/** Simper/Cytomic state-variable filter, band-pass output. */
class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  set(fc: number, q: number, fs: number): void {
    const g = Math.tan((Math.PI * Math.min(fc, fs * 0.45)) / fs);
    const k = 1 / q;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  bp(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v1;
  }
  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
  }
}

export class WindSynth {
  /** Current gust value (≈ unit variance, 0 = average). Read by other layers. */
  gust = 0;
  /** Current wind speed 0..~2 (amount modulated by gusts). Read by other layers. */
  speed = 0;

  private p: WindParams = { ...DEFAULT_WIND_PARAMS };
  private readonly rng: Rng;
  private readonly rngGust: Rng;
  private slow = 0;

  private readonly bodyL = new Svf();
  private readonly bodyR = new Svf();
  private readonly whistleA = new Svf();
  private readonly whistleB = new Svf();
  private brownL = 0;
  private brownR = 0;
  private bodyAmp = 0;
  private whistleAmp = 0;
  private readonly leaves: Leaves;
  private whistlePan = 0;

  constructor(
    private readonly fs: number,
    seed: string,
    params?: Partial<WindParams>,
  ) {
    this.rng = createRng(seed, 'wind.noise');
    this.rngGust = createRng(seed, 'wind.gust');
    this.leaves = new Leaves(fs, createRng(seed, 'wind.leaves'));
    this.setParams(params ?? {});
    this.speed = this.p.amount;
  }

  get params(): Readonly<WindParams> {
    return this.p;
  }

  setParams(patch: Partial<WindParams>): void {
    this.p = { ...this.p, ...patch };
  }

  /** Advance the gust processes by one block and update speed. Call once per block. */
  private updateGusts(frames: number): void {
    const dt = frames / this.fs;
    this.gust += -0.3 * this.gust * dt + 0.78 * Math.sqrt(dt) * this.rngGust.gaussian();
    this.slow += -0.04 * this.slow * dt + 0.28 * Math.sqrt(dt) * this.rngGust.gaussian();
    const p = this.p;
    const mod = 1 + p.gustiness * (0.7 * this.gust + 0.5 * this.slow);
    this.speed = Math.max(0, p.amount * mod);
  }

  /** Render one block into outL/outR (overwrites). */
  process(outL: Float32Array, outR: Float32Array, frames = outL.length): void {
    this.updateGusts(frames);
    const fs = this.fs;
    const p = this.p;
    const s = this.speed;
    const toneMul = Math.pow(2, p.tone);

    // Per-block filter settings (the wind moves slowly enough for block-rate updates).
    const fcBody = (140 + 700 * s) * toneMul;
    this.bodyL.set(fcBody, 0.9, fs);
    this.bodyR.set(fcBody * 1.13, 0.9, fs);
    const fw = (700 + 900 * s) * toneMul;
    this.whistleA.set(fw, 18, fs);
    this.whistleB.set(fw * 1.49, 22, fs);

    const targetBody = 0.9 * Math.pow(Math.min(s, 2), 1.4);
    const targetWhistle = p.whistle * 1.6 * Math.pow(Math.max(0, s - 0.35), 2);
    const smooth = 1 - Math.exp(-1 / (0.08 * fs));
    this.whistlePan += (this.rng.next() - 0.5) * 0.02;
    this.whistlePan = Math.max(-0.6, Math.min(0.6, this.whistlePan));
    const wl = Math.cos(((this.whistlePan + 1) * Math.PI) / 4);
    const wr = Math.sin(((this.whistlePan + 1) * Math.PI) / 4);

    for (let n = 0; n < frames; n++) {
      this.bodyAmp += (targetBody - this.bodyAmp) * smooth;
      this.whistleAmp += (targetWhistle - this.whistleAmp) * smooth;
      const nl = this.rng.next() * 2 - 1;
      const nr = this.rng.next() * 2 - 1;
      // Brown-ish noise for the body: more low end than white.
      this.brownL = (this.brownL + 0.04 * nl) / 1.04;
      this.brownR = (this.brownR + 0.04 * nr) / 1.04;
      const bl = this.bodyL.bp(this.brownL * 6 + nl * 0.15) * this.bodyAmp;
      const br = this.bodyR.bp(this.brownR * 6 + nr * 0.15) * this.bodyAmp;

      const wn = this.rng.next() * 2 - 1;
      const w = (this.whistleA.bp(wn) + 0.6 * this.whistleB.bp(wn)) * this.whistleAmp;

      outL[n] = bl + w * wl;
      outR[n] = br + w * wr;
    }
    this.leaves.process(outL, outR, frames, s, p.rustle, toneMul);

    if (!Number.isFinite(this.bodyAmp)) this.resetState();
  }

  private resetState(): void {
    for (const f of [this.bodyL, this.bodyR, this.whistleA, this.whistleB]) f.reset();
    this.brownL = this.brownR = this.bodyAmp = this.whistleAmp = 0;
    this.leaves.reset();
  }
}
