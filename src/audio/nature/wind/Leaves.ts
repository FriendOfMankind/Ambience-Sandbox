/**
 * Leaves in the wind, in two parts:
 *
 * - canopy: the smooth, swelling "shhhh" of a whole tree. Band-passed pink noise whose
 *   level follows the wind with a slow attack and release (a canopy doesn't react
 *   instantly), brighter in stronger wind.
 * - flutters: individual leaves flapping close by. A flutter is a short run of papery ticks
 *   at a flap rate (8–30 Hz) that swells and fades, each tick a 1–2 ms noise burst through
 *   a resonant band-pass (every leaf has its own pitch). Flutters start more often, and
 *   flap faster, as the wind picks up.
 *
 * Constants are initial guesses awaiting listening tests.
 */

import type { Rng } from '../../../core/rng';

const MAX_FLUTTERS = 32;

export class Leaves {
  private canopyAmp = 0;
  private readonly pinkL = new Float64Array(7);
  private readonly pinkR = new Float64Array(7);
  private cL = { ic1: 0, ic2: 0 };
  private cR = { ic1: 0, ic2: 0 };
  private nextFlutterIn = 0;

  // Flutter voices (structure of arrays)
  private readonly active = new Uint8Array(MAX_FLUTTERS);
  private readonly ticksTotal = new Int32Array(MAX_FLUTTERS);
  private readonly tickIdx = new Int32Array(MAX_FLUTTERS);
  private readonly nextTickIn = new Float64Array(MAX_FLUTTERS);
  private readonly tickInterval = new Float64Array(MAX_FLUTTERS);
  private readonly tickEnv = new Float64Array(MAX_FLUTTERS);
  private readonly tickMul = new Float64Array(MAX_FLUTTERS);
  private readonly baseAmp = new Float64Array(MAX_FLUTTERS);
  private readonly gL = new Float64Array(MAX_FLUTTERS);
  private readonly gR = new Float64Array(MAX_FLUTTERS);
  private readonly a1 = new Float64Array(MAX_FLUTTERS);
  private readonly a2 = new Float64Array(MAX_FLUTTERS);
  private readonly a3 = new Float64Array(MAX_FLUTTERS);
  private readonly ic1 = new Float64Array(MAX_FLUTTERS);
  private readonly ic2 = new Float64Array(MAX_FLUTTERS);

  constructor(
    private readonly fs: number,
    private readonly rng: Rng,
  ) {
    this.nextFlutterIn = fs * 0.5;
  }

  /** Add leaves for one block into outL/outR. `speed` is wind speed, `amount` the leaves level 0..1. */
  process(outL: Float32Array, outR: Float32Array, frames: number, speed: number, amount: number, toneMul: number): void {
    const fs = this.fs;
    const rng = this.rng;
    const s = Math.max(0, speed);

    // ---- canopy coefficients (block rate)
    const fc = Math.min((900 + 1800 * Math.min(s, 1.5)) * toneMul, fs * 0.45);
    const g = Math.tan((Math.PI * fc) / fs);
    const k = 1 / 0.6;
    const ca1 = 1 / (1 + g * (g + k));
    const ca2 = g * ca1;
    const ca3 = g * ca2;
    const target = amount * 1.75 * Math.pow(Math.min(s, 2), 1.5);
    // Canopies swell slowly and settle slower still.
    const attack = 1 - Math.exp(-1 / (0.35 * fs));
    const release = 1 - Math.exp(-1 / (0.9 * fs));

    // ---- flutter starts (Poisson, rate grows steeply with wind)
    const rate = amount * 45 * Math.pow(Math.max(0, s - 0.08), 1.6);
    const starts: number[] = [];
    if (rate > 1e-3) {
      while (this.nextFlutterIn < frames) {
        starts.push(Math.max(0, Math.floor(this.nextFlutterIn)));
        this.nextFlutterIn += rng.exponential(rate) * fs;
      }
      this.nextFlutterIn -= frames;
    } else {
      this.nextFlutterIn = Math.max(1, this.nextFlutterIn - frames);
    }
    for (const at of starts) this.startFlutter(at, s, amount, toneMul);

    const cL = this.cL;
    const cR = this.cR;
    for (let n = 0; n < frames; n++) {
      const coef = target > this.canopyAmp ? attack : release;
      this.canopyAmp += (target - this.canopyAmp) * coef;
      let l = 0;
      let r = 0;
      if (this.canopyAmp > 1e-6) {
        const pl = pink(this.pinkL, rng.next() * 2 - 1);
        const pr = pink(this.pinkR, rng.next() * 2 - 1);
        // Band-pass (Simper SVF), one per channel for a wide, decorrelated canopy.
        let v3 = pl - cL.ic2;
        let v1 = ca1 * cL.ic1 + ca2 * v3;
        let v2 = cL.ic2 + ca2 * cL.ic1 + ca3 * v3;
        cL.ic1 = 2 * v1 - cL.ic1;
        cL.ic2 = 2 * v2 - cL.ic2;
        l += v1 * this.canopyAmp;
        v3 = pr - cR.ic2;
        v1 = ca1 * cR.ic1 + ca2 * v3;
        v2 = cR.ic2 + ca2 * cR.ic1 + ca3 * v3;
        cR.ic1 = 2 * v1 - cR.ic1;
        cR.ic2 = 2 * v2 - cR.ic2;
        r += v1 * this.canopyAmp;
      }

      for (let v = 0; v < MAX_FLUTTERS; v++) {
        if (!this.active[v]) continue;
        this.nextTickIn[v] -= 1;
        if (this.nextTickIn[v] <= 0) {
          const i = this.tickIdx[v]++;
          const total = this.ticksTotal[v];
          if (i >= total) {
            if (this.tickEnv[v] < 1e-5) {
              this.active[v] = 0;
              continue;
            }
          } else {
            // Swell and fade across the flutter; each tick a little different.
            const shape = Math.sin((Math.PI * (i + 0.5)) / total);
            this.tickEnv[v] = this.baseAmp[v] * shape * rng.range(0.5, 1);
            this.nextTickIn[v] = this.tickInterval[v] * rng.range(0.7, 1.3);
          }
        }
        if (this.tickEnv[v] > 1e-6) {
          const x = (rng.next() * 2 - 1) * this.tickEnv[v];
          this.tickEnv[v] *= this.tickMul[v];
          const v3 = x - this.ic2[v];
          const v1 = this.a1[v] * this.ic1[v] + this.a2[v] * v3;
          const v2 = this.ic2[v] + this.a2[v] * this.ic1[v] + this.a3[v] * v3;
          this.ic1[v] = 2 * v1 - this.ic1[v];
          this.ic2[v] = 2 * v2 - this.ic2[v];
          l += v1 * this.gL[v];
          r += v1 * this.gR[v];
        }
      }

      outL[n] += l;
      outR[n] += r;
    }

    if (!Number.isFinite(this.canopyAmp) || !Number.isFinite(cL.ic1)) this.reset();
  }

  private startFlutter(offset: number, s: number, amount: number, toneMul: number): void {
    const rng = this.rng;
    const fs = this.fs;
    // Draw everything first so the random stream doesn't depend on voice availability.
    const ticks = rng.int(3, 12);
    const flapHz = rng.range(8, 20) * (0.7 + 0.6 * Math.min(s, 1.5));
    const fc = Math.min(rng.range(1800, 6000) * toneMul, fs * 0.45);
    const q = rng.range(2.5, 4.5);
    const amp = amount * rng.range(0.65, 1.9) * Math.min(1, 0.3 + s);
    const pan = rng.range(-0.8, 0.8);
    const tickMs = rng.range(0.6, 1.8);

    let v = -1;
    for (let i = 0; i < MAX_FLUTTERS; i++) if (!this.active[i]) { v = i; break; }
    if (v < 0) return;
    this.active[v] = 1;
    this.ticksTotal[v] = ticks;
    this.tickIdx[v] = 0;
    this.nextTickIn[v] = offset + 1;
    this.tickInterval[v] = fs / flapHz;
    this.tickEnv[v] = 0;
    this.tickMul[v] = Math.exp(-1 / ((tickMs / 1000) * fs));
    // Resonant band-pass boosts by ~Q at the centre; compensate so Q doesn't change level.
    this.baseAmp[v] = amp * (2.2 / q);
    const theta = ((pan + 1) * Math.PI) / 4;
    this.gL[v] = Math.cos(theta);
    this.gR[v] = Math.sin(theta);
    const g = Math.tan((Math.PI * fc) / fs);
    const k = 1 / q;
    this.a1[v] = 1 / (1 + g * (g + k));
    this.a2[v] = g * this.a1[v];
    this.a3[v] = g * this.a2[v];
    this.ic1[v] = 0;
    this.ic2[v] = 0;
  }

  reset(): void {
    this.canopyAmp = 0;
    this.cL = { ic1: 0, ic2: 0 };
    this.cR = { ic1: 0, ic2: 0 };
    this.pinkL.fill(0);
    this.pinkR.fill(0);
    this.active.fill(0);
  }
}

/** Paul Kellet's refined pink-noise filter. */
function pink(b: Float64Array, w: number): number {
  b[0] = 0.99886 * b[0] + w * 0.0555179;
  b[1] = 0.99332 * b[1] + w * 0.0750759;
  b[2] = 0.969 * b[2] + w * 0.153852;
  b[3] = 0.8665 * b[3] + w * 0.3104856;
  b[4] = 0.55 * b[4] + w * 0.5329522;
  b[5] = -0.7616 * b[5] - w * 0.016898;
  const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
  b[6] = w * 0.115926;
  return out * 0.11;
}
