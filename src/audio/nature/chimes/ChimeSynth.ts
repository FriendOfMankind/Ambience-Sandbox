/**
 * ChimeSynth: a set of tuned wind-chime tubes struck by a clapper the wind swings.
 *
 * Each tube is modal: a free–free bar's partial ratios (1, 2.756, 5.404, 8.933, textbook
 * Euler–Bernoulli beam values), higher partials decaying faster. Strikes arrive when the
 * wind speed passes a threshold, at a rate that grows with speed; the clapper tends to
 * hit neighbouring tubes and sometimes bounces (a quieter second hit a few ms later).
 * Tubes are tuned to the world's scale, so the chimes are always in key with the music.
 */

import { createRng, type Rng } from '../../../core/rng';
import { scaleStepHz, type ScaleSnap } from '../../music/scales';

export interface ChimeParams {
  /** Number of tubes, 3..8. */
  tubes: number;
  /** The lowest tube is the first scale note at or above this frequency (Hz). Same register in any scale. */
  lowestHz: number;
  /** Ring time multiplier (1 = natural). */
  sustain: number;
  /** Wind speed at which the clapper starts reaching the tubes, 0..1. */
  threshold: number;
  /** Strike-rate multiplier. */
  activity: number;
  /** Upper-partial emphasis: 0 = mellow wood-like, 1 = bright aluminium. */
  brightness: number;
  scale: ScaleSnap;
}

export interface ChimeEvent {
  frame: number;
  tube: number;
  velocity: number;
}

export const DEFAULT_CHIME_PARAMS: ChimeParams = {
  tubes: 6,
  lowestHz: 520,
  sustain: 1,
  threshold: 0.25,
  activity: 1,
  brightness: 0.6,
  scale: { enabled: true, rootHz: 146.83, cents: [0, 300, 500, 700, 1000], periodCents: 1200 },
};

const RATIOS = [1, 2.756, 5.404, 8.933];
const BASE_AMPS = [1, 0.5, 0.26, 0.12];
/** Decay of each partial as a fraction of the fundamental's (upper partials die faster). */
const DECAY_FRACTION = [1, 0.45, 0.22, 0.1];
const FUNDAMENTAL_TAU = 2.6; // seconds
const MAX_TUBES = 8;
const MODES = RATIOS.length;

export class ChimeSynth {
  frame = 0;
  private p: ChimeParams = { ...DEFAULT_CHIME_PARAMS };
  private readonly rng: Rng;
  private speed = 0;
  private nextStrikeIn = 0;
  private lastTube = 0;
  private events: ChimeEvent[] = [];
  private pending: { frame: number; tube: number; amp: number }[] = [];

  private readonly b1 = new Float64Array(MAX_TUBES * MODES);
  private readonly b2 = new Float64Array(MAX_TUBES * MODES);
  private readonly g = new Float64Array(MAX_TUBES * MODES);
  private readonly y1 = new Float64Array(MAX_TUBES * MODES);
  private readonly y2 = new Float64Array(MAX_TUBES * MODES);
  private readonly panL = new Float32Array(MAX_TUBES);
  private readonly panR = new Float32Array(MAX_TUBES);
  private readonly tubeHz = new Float64Array(MAX_TUBES);
  /** Short clapper click per tube (noise burst envelope). */
  private readonly click = new Float32Array(MAX_TUBES);
  private clickMul = 0;

  constructor(
    private readonly fs: number,
    seed: string,
    params?: Partial<ChimeParams>,
  ) {
    this.rng = createRng(seed, 'chimes');
    this.clickMul = Math.exp(-1 / (0.0015 * fs));
    this.setParams(params ?? {});
    this.nextStrikeIn = Number.POSITIVE_INFINITY;
  }

  get params(): Readonly<ChimeParams> {
    return this.p;
  }

  get tubeFrequencies(): number[] {
    return Array.from(this.tubeHz.subarray(0, this.tubeCount));
  }

  private get tubeCount(): number {
    return Math.max(3, Math.min(MAX_TUBES, Math.round(this.p.tubes)));
  }

  setParams(patch: Partial<ChimeParams>): void {
    this.p = { ...this.p, ...patch, scale: { ...this.p.scale, ...(patch.scale ?? {}) } };
    this.configure();
  }

  /** Wind speed from the world (0..~2). */
  setWindSpeed(speed: number): void {
    this.speed = speed;
  }

  drainEvents(): ChimeEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private configure(): void {
    const fs = this.fs;
    const n = this.tubeCount;
    const p = this.p;
    let start = 0;
    while (scaleStepHz(p.scale, start) < p.lowestHz && start < 200) start++;
    while (start > -200 && scaleStepHz(p.scale, start - 1) >= p.lowestHz) start--;
    for (let t = 0; t < n; t++) {
      const f0 = scaleStepHz(p.scale, start + t);
      this.tubeHz[t] = f0;
      const pan = n === 1 ? 0 : (t / (n - 1)) * 1.0 - 0.5;
      this.panL[t] = Math.cos(((pan + 1) * Math.PI) / 4);
      this.panR[t] = Math.sin(((pan + 1) * Math.PI) / 4);
      for (let m = 0; m < MODES; m++) {
        const i = t * MODES + m;
        const f = f0 * RATIOS[m];
        if (f >= fs * 0.45) {
          this.b1[i] = 0;
          this.b2[i] = 0;
          this.g[i] = 0;
          continue;
        }
        const tau = FUNDAMENTAL_TAU * DECAY_FRACTION[m] * p.sustain;
        const r = Math.exp(-1 / (tau * fs));
        const w = (2 * Math.PI * f) / fs;
        this.b1[i] = 2 * r * Math.cos(w);
        this.b2[i] = -r * r;
        // Brightness tilts the upper partials; impulse of height A rings at ≈ A·amp.
        const tilt = m === 0 ? 1 : Math.pow(0.35 + 1.3 * p.brightness, m * 0.8);
        this.g[i] = BASE_AMPS[m] * tilt * Math.sin(w);
      }
    }
    // Silence tubes that were removed.
    for (let t = n; t < MAX_TUBES; t++) {
      for (let m = 0; m < MODES; m++) this.g[t * MODES + m] = 0;
    }
  }

  private strikeRate(): number {
    // Nothing below the threshold; then rising steeply with speed.
    const over = Math.max(0, this.speed - this.p.threshold);
    return 12 * Math.pow(over, 1.3) * this.p.activity;
  }

  private scheduleStrikes(frames: number): void {
    const rate = this.strikeRate();
    if (!Number.isFinite(this.nextStrikeIn)) {
      if (rate > 1e-4) this.nextStrikeIn = this.rng.exponential(rate) * this.fs;
      else return;
    }
    while (this.nextStrikeIn < frames) {
      const at = this.frame + Math.floor(this.nextStrikeIn);
      const n = this.tubeCount;
      // The clapper swings: usually a neighbour of the last tube it hit.
      let tube: number;
      if (this.rng.chance(0.6)) tube = this.lastTube + (this.rng.chance(0.5) ? 1 : -1);
      else tube = this.rng.int(0, n - 1);
      tube = Math.max(0, Math.min(n - 1, tube));
      this.lastTube = tube;
      const velocity = Math.min(1, (0.25 + 0.75 * this.rng.next()) * Math.min(1, 0.4 + this.speed));
      this.pending.push({ frame: at, tube, amp: velocity });
      this.events.push({ frame: at, tube, velocity });
      if (this.rng.chance(0.2)) {
        const bounce = at + Math.round(this.rng.range(0.02, 0.08) * this.fs);
        this.pending.push({ frame: bounce, tube, amp: velocity * 0.35 });
      }
      this.nextStrikeIn += rate > 1e-4 ? this.rng.exponential(rate) * this.fs : Number.POSITIVE_INFINITY;
    }
    this.nextStrikeIn -= frames;
  }

  /** Render one block into outL/outR (overwrites). */
  process(outL: Float32Array, outR: Float32Array, frames = outL.length): void {
    this.scheduleStrikes(frames);
    const end = this.frame + frames;
    const due = this.pending.filter((s) => s.frame < end).sort((a, b) => a.frame - b.frame);
    if (due.length) this.pending = this.pending.filter((s) => s.frame >= end);
    let di = 0;
    const n = this.tubeCount;
    let energy = 0;

    for (let k = 0; k < frames; k++) {
      const abs = this.frame + k;
      while (di < due.length && due[di].frame <= abs) {
        const s = due[di++];
        const base = s.tube * MODES;
        for (let m = 0; m < MODES; m++) this.y1[base + m] += this.g[base + m] * s.amp * 0.3;
        this.click[s.tube] = Math.max(this.click[s.tube], s.amp * 0.04);
      }
      let l = 0;
      let r = 0;
      for (let t = 0; t < n; t++) {
        const base = t * MODES;
        let x = 0;
        for (let m = 0; m < MODES; m++) {
          const i = base + m;
          const y = this.b1[i] * this.y1[i] + this.b2[i] * this.y2[i];
          this.y2[i] = this.y1[i];
          this.y1[i] = y;
          x += y;
        }
        if (this.click[t] > 1e-6) {
          x += (this.rng.next() * 2 - 1) * this.click[t];
          this.click[t] *= this.clickMul;
        }
        l += x * this.panL[t];
        r += x * this.panR[t];
      }
      outL[k] = l;
      outR[k] = r;
      energy += Math.abs(l);
    }

    if (!Number.isFinite(energy)) {
      this.y1.fill(0);
      this.y2.fill(0);
      outL.fill(0, 0, frames);
      outR.fill(0, 0, frames);
    }
    this.frame = end;
  }
}
