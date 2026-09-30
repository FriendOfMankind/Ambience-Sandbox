/**
 * The music bus's live processors, after the research in docs/AMBIENT-RESEARCH.md:
 *
 *   Looper    sound-on-sound in the Frippertronics tradition: a long delay whose output is fed
 *             back and re-recorded with the new input, darkening and wobbling a little on every
 *             pass, so layers pile up and slowly decay (Layers = how long they last, Decay = how
 *             much each pass loses). Freeze holds the loop forever and stops recording into it.
 *   Tape      "Age": wow (slow pitch drift), flutter, saturation, hiss, dropouts and a falling
 *             top end, like a worn cassette (Generation Loss, Basinski).
 *   Granular  "Texture": grains of the last few seconds, re-pitched (unison, octave up/down,
 *             fifth) and scattered in the stereo field (Microcosm, Clouds).
 *
 * Pure DSP, deterministic for an RNG stream, no allocation in the audio loop. Each adds into
 * the buffers it is given (the Tape processes them in place).
 */

import type { Rng } from '../../core/rng';

const TAU = Math.PI * 2;

function readLerp(buf: Float32Array, mask: number, pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  return buf[i & mask] * (1 - f) + buf[(i + 1) & mask] * f;
}

// ------------------------------------------------------------------ looper

export const LOOP_MAX_SECONDS = 24;

export class Looper {
  private readonly bl: Float32Array;
  private readonly br: Float32Array;
  private readonly mask: number;
  private w = 0;
  private len: number;
  private lpL = 0; private lpR = 0;
  private hpL = 0; private hpR = 0; private pxL = 0; private pxR = 0;
  private wow = 0;
  private inGain = 1;
  private wet = 0;
  private energy = 0;

  constructor(private readonly fs: number) {
    let size = 1;
    while (size < fs * (LOOP_MAX_SECONDS + 1)) size <<= 1;
    this.bl = new Float32Array(size);
    this.br = new Float32Array(size);
    this.mask = size - 1;
    this.len = fs * 11.3;
  }

  /** Reads inL/inR (the music), adds the loop into out and send. */
  process(
    inL: Float32Array, inR: Float32Array,
    outL: Float32Array, outR: Float32Array, sendL: Float32Array, sendR: Float32Array,
    frames: number, layers: number, decay: number, freeze: boolean, loopSeconds: number,
  ): void {
    const on = layers > 0.01 || freeze;
    if (!on && this.energy < 1e-9 && this.wet < 1e-4) return;
    const fs = this.fs;
    const target = Math.max(2, Math.min(LOOP_MAX_SECONDS, loopSeconds)) * fs;
    // Length changes glide slowly, like varispeed tape.
    const kLen = 1 - Math.exp(-1 / (3 * fs));
    const fb = freeze ? 1 : on ? 0.4 + 0.57 * Math.min(1, layers) : 0.3;
    const cutoff = freeze ? 20000 : 14000 * Math.pow(0.12, Math.max(0, Math.min(1, decay)));
    const lp = Math.exp((-TAU * Math.min(cutoff, fs * 0.45)) / fs);
    const hp = Math.exp((-TAU * 60) / fs);
    const wowDepth = freeze ? 0 : fs * 0.0006 * (0.3 + decay);
    const wowInc = (TAU * 0.37) / fs;
    const k = 1 - Math.exp(-1 / (0.3 * fs));
    const inTarget = freeze || !on ? 0 : 1;
    const wetTarget = on ? 0.75 : 0;
    const drive = 1.15;
    let e = 0;
    for (let n = 0; n < frames; n++) {
      this.len += (target - this.len) * kLen;
      this.inGain += (inTarget - this.inGain) * k;
      this.wet += (wetTarget - this.wet) * k;
      this.wow += wowInc;
      const pos = this.w - this.len - wowDepth * (1 + Math.sin(this.wow));
      const rl = readLerp(this.bl, this.mask, pos);
      const rr = readLerp(this.br, this.mask, pos);
      // Each pass: darker, no rumble, gently saturated.
      let xl = rl;
      let xr = rr;
      if (!freeze) {
        this.lpL = (1 - lp) * rl + lp * this.lpL;
        this.lpR = (1 - lp) * rr + lp * this.lpR;
        this.hpL = hp * (this.hpL + this.lpL - this.pxL);
        this.hpR = hp * (this.hpR + this.lpR - this.pxR);
        this.pxL = this.lpL;
        this.pxR = this.lpR;
        xl = Math.tanh(this.hpL * drive) / drive;
        xr = Math.tanh(this.hpR * drive) / drive;
      }
      const i = this.w & this.mask;
      this.bl[i] = inL[n] * this.inGain * 0.8 + xl * fb;
      this.br[i] = inR[n] * this.inGain * 0.8 + xr * fb;
      this.w++;
      outL[n] += rl * this.wet;
      outR[n] += rr * this.wet;
      sendL[n] += rl * this.wet * 0.5;
      sendR[n] += rr * this.wet * 0.5;
      e += rl * rl + rr * rr;
    }
    this.energy = e / frames;
    if (!Number.isFinite(this.energy)) this.clear();
  }

  clear(): void {
    this.bl.fill(0);
    this.br.fill(0);
    this.lpL = this.lpR = this.hpL = this.hpR = this.pxL = this.pxR = 0;
    this.energy = 0;
  }
}

// ------------------------------------------------------------------ tape age

export class Tape {
  private readonly lines: Float32Array[];
  private readonly mask: number;
  private w = 0;
  private wowPh = 0;
  private wowDrift = 0;
  private flutPh = 0;
  private readonly tone = new Float64Array(4);
  private hiss = 0;
  private drop = 1;
  private dropLeft = 0;

  constructor(private readonly fs: number, private readonly rng: Rng) {
    let size = 1;
    while (size < fs * 0.05) size <<= 1;
    this.mask = size - 1;
    this.lines = Array.from({ length: 4 }, () => new Float32Array(size));
  }

  /** Ages out and send in place, with the same wobble on both so dry and wet stay together. */
  process(outL: Float32Array, outR: Float32Array, sendL: Float32Array, sendR: Float32Array, frames: number, age: number): void {
    if (age < 0.005) return;
    const fs = this.fs;
    const rng = this.rng;
    const a = Math.min(1, age);
    const base = 0.008 * fs;
    const wowAmp = a * 0.0018 * fs; // ≈ ±10 cents at full age
    const flutAmp = a * 0.00003 * fs;
    const wowInc = (TAU * 0.55) / fs;
    const flutInc = (TAU * 6.8) / fs;
    const lp = Math.exp((-TAU * 18000 * Math.pow(0.25, a)) / fs);
    const drive = 1 + 2 * a;
    const hissLevel = a * a * 0.003;
    const dropRate = a * a * 0.25; // per second
    const bufs = [outL, outR, sendL, sendR];
    for (let n = 0; n < frames; n++) {
      this.wowPh += wowInc;
      this.flutPh += flutInc;
      this.wowDrift += (rng.next() - 0.5) * 0.0004 - this.wowDrift * 0.0001;
      const d = base + wowAmp * (Math.sin(this.wowPh) + this.wowDrift * 20) + flutAmp * Math.sin(this.flutPh);
      // Dropouts: brief dips as if the oxide were thin.
      if (this.dropLeft > 0) this.dropLeft--;
      else if (rng.next() < dropRate / fs) this.dropLeft = Math.floor(rng.range(0.08, 0.3) * fs);
      this.drop += ((this.dropLeft > 0 ? 0.35 : 1) - this.drop) * 0.002;
      this.hiss = 0.7 * this.hiss + 0.3 * (rng.next() * 2 - 1);
      for (let c = 0; c < 4; c++) {
        const line = this.lines[c];
        line[this.w & this.mask] = bufs[c][n];
        let y = readLerp(line, this.mask, this.w - d);
        y = Math.tanh(y * drive) / drive;
        this.tone[c] = (1 - lp) * y + lp * this.tone[c];
        bufs[c][n] = this.tone[c] * this.drop + (c < 2 ? this.hiss * hissLevel : 0);
      }
      this.w++;
    }
    if (!Number.isFinite(this.tone[0])) { this.tone.fill(0); for (const l of this.lines) l.fill(0); }
  }
}

// ------------------------------------------------------------------ granular

const GRAINS = 24;
const PITCHES = [1, 2, 0.5, 1.5];
const PITCH_WEIGHTS = [4, 2, 1, 1];

export class Granular {
  private readonly bl: Float32Array;
  private readonly br: Float32Array;
  private readonly mask: number;
  private w = 0;
  private readonly active = new Uint8Array(GRAINS);
  private readonly pos = new Float64Array(GRAINS);
  private readonly inc = new Float64Array(GRAINS);
  private readonly t = new Float64Array(GRAINS);
  private readonly len = new Float64Array(GRAINS);
  private readonly gl = new Float64Array(GRAINS);
  private readonly gr = new Float64Array(GRAINS);
  private toNext = 0;

  constructor(private readonly fs: number, private readonly rng: Rng) {
    let size = 1;
    while (size < fs * 4) size <<= 1;
    this.bl = new Float32Array(size);
    this.br = new Float32Array(size);
    this.mask = size - 1;
  }

  private spawn(): void {
    let g = -1;
    for (let i = 0; i < GRAINS; i++) if (!this.active[i]) { g = i; break; }
    if (g < 0) return;
    const rng = this.rng;
    const fs = this.fs;
    const len = rng.range(0.08, 0.4) * fs;
    const ratio = PITCHES[rng.weightedIndex(PITCH_WEIGHTS)] * Math.pow(2, rng.range(-5, 5) / 1200);
    // Start far enough back that a fast grain never overtakes the write head.
    const back = rng.range(0.15, 3.2) * fs + Math.max(0, ratio - 1) * len;
    this.pos[g] = this.w - Math.min(back, this.mask - len * 2);
    this.inc[g] = ratio;
    this.t[g] = 0;
    this.len[g] = len;
    const pan = rng.range(-0.9, 0.9);
    this.gl[g] = Math.cos(((pan + 1) * Math.PI) / 4);
    this.gr[g] = Math.sin(((pan + 1) * Math.PI) / 4);
    this.active[g] = 1;
  }

  process(
    inL: Float32Array, inR: Float32Array,
    outL: Float32Array, outR: Float32Array, sendL: Float32Array, sendR: Float32Array,
    frames: number, texture: number,
  ): void {
    const fs = this.fs;
    // Always record, so turning Texture up finds material already there.
    for (let n = 0; n < frames; n++) {
      const i = (this.w + n) & this.mask;
      this.bl[i] = inL[n];
      this.br[i] = inR[n];
    }
    const rate = Math.pow(Math.max(0, Math.min(1, texture)), 1.5) * 28; // grains per second
    let any = false;
    for (let g = 0; g < GRAINS; g++) if (this.active[g]) any = true;
    if (rate <= 0.01 && !any) { this.w += frames; return; }
    const gain = 0.55 * Math.min(1, texture * 2) / Math.sqrt(1 + rate * 0.2);
    for (let n = 0; n < frames; n++) {
      if (rate > 0.01) {
        this.toNext -= 1;
        if (this.toNext <= 0) {
          this.spawn();
          this.toNext = this.rng.exponential(rate) * fs;
        }
      }
      let l = 0;
      let r = 0;
      for (let g = 0; g < GRAINS; g++) {
        if (!this.active[g]) continue;
        const ph = this.t[g] / this.len[g];
        const win = Math.sin(Math.PI * ph);
        const env = win * win;
        const p = this.pos[g];
        l += readLerp(this.bl, this.mask, p) * env * this.gl[g];
        r += readLerp(this.br, this.mask, p) * env * this.gr[g];
        this.pos[g] += this.inc[g];
        if (++this.t[g] >= this.len[g]) this.active[g] = 0;
      }
      this.w++;
      outL[n] += l * gain * 0.6;
      outR[n] += r * gain * 0.6;
      sendL[n] += l * gain;
      sendR[n] += r * gain;
    }
  }
}
