/**
 * A fixed set of ringing objects (sills, panes, roof panels) that every drop excites.
 * Physically closer than giving each drop its own resonances, and constant cost no
 * matter how many drops land or how long the ring is stretched.
 *
 * Each object is a small modal model: the surface's modes, transposed by a per-object
 * random amount (objects differ in size), each mode a two-pole resonator driven by impulses.
 */

import type { Rng } from '../../../core/rng';
import { snapToScale } from './physics';
import type { Surface } from './surfaces';
import type { ScaleSnap } from '../../music/scales';

interface Pending {
  frame: number;
  obj: number;
  amp: number;
}

export class ResonatorBank {
  readonly objects: number;
  private readonly modesPer: number;
  private readonly ratio: Float64Array; // per-object transposition
  private readonly gainL: Float32Array;
  private readonly gainR: Float32Array;
  private readonly b1: Float64Array;
  private readonly b2: Float64Array;
  private readonly g: Float64Array;
  private readonly y1: Float64Array;
  private readonly y2: Float64Array;
  private readonly lpA: number;
  private lpL = 0;
  private lpR = 0;
  private pending: Pending[] = [];
  private idle = true;

  constructor(
    private readonly fs: number,
    rng: Rng,
    private readonly surface: Surface,
    objects: number,
    panSpread: number,
    lpHz: number,
  ) {
    this.objects = objects;
    this.modesPer = surface.modes.length;
    const n = objects * this.modesPer;
    this.ratio = new Float64Array(objects);
    this.gainL = new Float32Array(objects);
    this.gainR = new Float32Array(objects);
    const spread = surface.bankSpreadOct ?? 0;
    for (let o = 0; o < objects; o++) {
      this.ratio[o] = Math.pow(2, rng.range(-spread, spread));
      const pan = objects === 1 ? 0 : (o / (objects - 1)) * 2 * panSpread - panSpread;
      const theta = ((pan + 1) * Math.PI) / 4;
      this.gainL[o] = Math.cos(theta);
      this.gainR[o] = Math.sin(theta);
    }
    this.b1 = new Float64Array(n);
    this.b2 = new Float64Array(n);
    this.g = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.y2 = new Float64Array(n);
    this.lpA = Math.exp((-2 * Math.PI * Math.min(lpHz, fs * 0.45)) / fs);
  }

  /** Recompute resonances. Safe to call while ringing (state is kept). */
  configure(stretch: number, scale: ScaleSnap): void {
    const fs = this.fs;
    const modes = this.surface.modes;
    // Steady-state power ∝ strike rate · amplitude² · ring time, so 1/√stretch keeps loudness constant.
    const norm = 1 / Math.sqrt(Math.max(stretch, 1e-3));
    for (let o = 0; o < this.objects; o++) {
      let snapRatio = 1;
      if (scale.enabled && modes.length > 0) {
        const f0 = modes[0].f * this.ratio[o];
        snapRatio = snapToScale(f0, scale.rootHz, scale.cents, scale.periodCents) / f0;
      }
      for (let m = 0; m < this.modesPer; m++) {
        const i = o * this.modesPer + m;
        const f = Math.min(modes[m].f * this.ratio[o] * snapRatio, fs * 0.45);
        const tau = (modes[m].tauMs / 1000) * stretch;
        const r = Math.exp(-1 / (tau * fs));
        const w = (2 * Math.PI * f) / fs;
        this.b1[i] = 2 * r * Math.cos(w);
        this.b2[i] = -r * r;
        // An impulse of height A then rings at amplitude ≈ A·mode.amp.
        this.g[i] = modes[m].amp * Math.sin(w) * norm;
      }
    }
  }

  /** Strike object `obj` with amplitude `amp` at absolute sample `frame`. */
  excite(frame: number, obj: number, amp: number): void {
    this.pending.push({ frame, obj, amp });
    this.idle = false;
  }

  /** Add this block's output into outL/outR. `frame` is the absolute sample at index 0. */
  process(outL: Float32Array, outR: Float32Array, frames: number, frame: number): void {
    if (this.idle) return;
    const mp = this.modesPer;
    const end = frame + frames;
    // Strikes due in this block, sorted by time.
    const due = this.pending.filter((p) => p.frame < end).sort((a, b) => a.frame - b.frame);
    if (due.length > 0) this.pending = this.pending.filter((p) => p.frame >= end);
    let di = 0;
    let energy = 0;

    for (let n = 0; n < frames; n++) {
      const abs = frame + n;
      let l = 0;
      let r = 0;
      for (let o = 0; o < this.objects; o++) {
        let x = 0;
        while (di < due.length && due[di].frame <= abs && due[di].obj === o) {
          x += due[di].amp;
          di++;
        }
        let objOut = 0;
        const base = o * mp;
        for (let m = 0; m < mp; m++) {
          const i = base + m;
          const y = this.b1[i] * this.y1[i] + this.b2[i] * this.y2[i] + this.g[i] * x;
          this.y2[i] = this.y1[i];
          this.y1[i] = y;
          objOut += y;
        }
        l += objOut * this.gainL[o];
        r += objOut * this.gainR[o];
      }
      // Strikes for objects we already passed this sample: apply next sample (≤1 sample late).
      while (di < due.length && due[di].frame <= abs) {
        const p = due[di];
        const base = p.obj * mp;
        for (let m = 0; m < mp; m++) this.y1[base + m] += this.g[base + m] * p.amp;
        di++;
      }
      this.lpL = (1 - this.lpA) * l + this.lpA * this.lpL;
      this.lpR = (1 - this.lpA) * r + this.lpA * this.lpR;
      outL[n] += this.lpL;
      outR[n] += this.lpR;
      energy += Math.abs(l) + Math.abs(r);
    }

    if (!Number.isFinite(energy)) {
      this.y1.fill(0);
      this.y2.fill(0);
      this.lpL = 0;
      this.lpR = 0;
    }
    if (energy < 1e-6 * frames && this.pending.length === 0) this.idle = true;
  }
}
