/**
 * The music layer's instrument voices. Each is pure DSP: deterministic for its RNG stream,
 * no allocation in the audio loop, and it ADDS into the buffers it is given.
 *
 *   Drone   additive harmonic series on the key's root; only harmonics that land on a scale
 *           degree sound, so it can never clash; each partial breathes on its own slow cycle
 *   Bowls   singing/crystal bowls: each mode is a pair of damped sines a few Hz apart, and
 *           their beating is the bowl's "wah"
 *   Plucks  Karplus–Strong strings (harp/koto/kalimba region)
 *   Choir   band-limited voices through three moving vowel formants
 *   Beat    soft lo-fi kit: felt kick, brush snare, dusty hats, a little vinyl
 *   Shimmer octave-up pitch shifter with feedback, for the reverb send
 */

import type { Rng } from '../../core/rng';

const TAU = Math.PI * 2;

/** PolyBLEP sawtooth, phase in [0,1). */
export function saw(phase: number, inc: number): number {
  let v = 2 * phase - 1;
  if (phase < inc) {
    const t = phase / inc;
    v -= t + t - t * t - 1;
  } else if (phase > 1 - inc) {
    const t = (phase - 1) / inc;
    v -= t * t + t + t + 1;
  }
  return v;
}

/** Smoothed gain that lets a voice skip work entirely while silent. */
export class Level {
  cur = 0;
  constructor(private readonly k: number) {}
  /** Advance by `frames` samples (1 when called per sample). */
  step(target: number, frames = 1): number {
    const k = frames === 1 ? this.k : 1 - Math.pow(1 - this.k, frames);
    this.cur += (target - this.cur) * k;
    if (target === 0 && this.cur < 1e-5) this.cur = 0;
    return this.cur;
  }
  silent(target: number): boolean {
    return target === 0 && this.cur === 0;
  }
}

// ------------------------------------------------------------------ drone

const HARMONICS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12];

export class Drone {
  private rootHz = 0;
  private targetHz = 110;
  private readonly c = new Float64Array(HARMONICS.length).fill(1);
  private readonly s = new Float64Array(HARMONICS.length);
  private readonly amp = new Float64Array(HARMONICS.length);
  private readonly allowed = new Float64Array(HARMONICS.length);
  private readonly swell = new Float64Array(HARMONICS.length);
  private readonly swellRate = new Float64Array(HARMONICS.length);
  private readonly panL = new Float64Array(HARMONICS.length);
  private readonly panR = new Float64Array(HARMONICS.length);
  private readonly orbitPh = new Float64Array(HARMONICS.length);
  private readonly orbitRate = new Float64Array(HARMONICS.length);
  private readonly cw = new Float64Array(HARMONICS.length);
  private readonly sw = new Float64Array(HARMONICS.length);
  private bl = [1, 0];
  private br = [1, 0];
  private readonly level: Level;

  constructor(private readonly fs: number, rng: Rng) {
    this.level = new Level(1 - Math.exp(-1 / (1.5 * fs)));
    HARMONICS.forEach((h, i) => {
      this.swell[i] = rng.next() * TAU;
      this.swellRate[i] = TAU / rng.range(14, 48);
      this.orbitPh[i] = h * 1.7;
      this.orbitRate[i] = (TAU / rng.range(18, 60)) * (i % 2 ? -1 : 1);
      const pan = Math.sin(h * 1.7) * 0.5;
      this.panL[i] = Math.cos(((pan + 1) * Math.PI) / 4);
      this.panR[i] = Math.sin(((pan + 1) * Math.PI) / 4);
    });
  }

  /** The scale sets the root and which harmonics are consonant with it. */
  setScale(rootHz: number, cents: number[]): void {
    this.targetHz = rootHz;
    if (this.rootHz === 0) this.rootHz = rootHz;
    HARMONICS.forEach((h, i) => {
      const pc = (1200 * Math.log2(h)) % 1200;
      const near = cents.some((c) => Math.min(Math.abs(c - pc), 1200 - Math.abs(c - pc)) < 25);
      this.allowed[i] = h === 1 || h === 2 || h === 4 || h === 8 || near ? 1 : 0;
    });
  }

  process(L: Float32Array, R: Float32Array, frames: number, level: number, binaural: number, beatHz: number, orbit = 0): void {
    if (this.level.silent(level) && binaural === 0) return;
    const fs = this.fs;
    const dt = frames / fs;
    // Orbit: each partial circles slowly through the stereo field, some one way, some the other.
    if (orbit > 0.001) {
      for (let i = 0; i < HARMONICS.length; i++) {
        this.orbitPh[i] += this.orbitRate[i] * orbit * dt;
        const pan = Math.sin(this.orbitPh[i]) * (0.5 + 0.35 * orbit);
        this.panL[i] = Math.cos(((pan + 1) * Math.PI) / 4);
        this.panR[i] = Math.sin(((pan + 1) * Math.PI) / 4);
      }
    }
    this.rootHz += (this.targetHz - this.rootHz) * (1 - Math.exp(-dt / 3));
    const g = this.level.step(level, frames);
    // Per-block partial amplitudes and rotation coefficients.
    const cw = this.cw;
    const sw = this.sw;
    let active = 0;
    HARMONICS.forEach((h, i) => {
      const f = this.rootHz * h;
      this.swell[i] += this.swellRate[i] * dt;
      const target = f < fs * 0.2 ? (this.allowed[i] / Math.pow(h, 1.15)) * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.swell[i]))) : 0;
      this.amp[i] += (target - this.amp[i]) * (1 - Math.exp(-dt / 2));
      cw[i] = Math.cos((TAU * f) / fs);
      sw[i] = Math.sin((TAU * f) / fs);
      if (this.amp[i] > 1e-5) active++;
    });
    const k = 0.05 * g;
    if (active && g > 0) {
      for (let n = 0; n < frames; n++) {
        let l = 0;
        let r = 0;
        for (let i = 0; i < HARMONICS.length; i++) {
          const a = this.amp[i];
          if (a < 1e-5) continue;
          const c = this.c[i] * cw[i] - this.s[i] * sw[i];
          this.s[i] = this.c[i] * sw[i] + this.s[i] * cw[i];
          this.c[i] = c;
          l += this.s[i] * a * this.panL[i];
          r += this.s[i] * a * this.panR[i];
        }
        L[n] += l * k;
        R[n] += r * k;
      }
    }
    // Keep the rotating oscillators on the unit circle.
    for (let i = 0; i < HARMONICS.length; i++) {
      const m = 1 / Math.hypot(this.c[i], this.s[i]);
      this.c[i] *= m;
      this.s[i] *= m;
    }

    // Optional binaural beat: pure tones an octave above the root, offset between the ears.
    if (binaural > 0) {
      const fc = this.rootHz * 2;
      const wl = (TAU * fc) / fs;
      const wr = (TAU * (fc + beatHz)) / fs;
      const cl = Math.cos(wl), sl = Math.sin(wl), cr = Math.cos(wr), sr = Math.sin(wr);
      const b = binaural * 0.03;
      for (let n = 0; n < frames; n++) {
        const x = this.bl[0] * cl - this.bl[1] * sl;
        this.bl[1] = this.bl[0] * sl + this.bl[1] * cl;
        this.bl[0] = x;
        const y = this.br[0] * cr - this.br[1] * sr;
        this.br[1] = this.br[0] * sr + this.br[1] * cr;
        this.br[0] = y;
        L[n] += this.bl[1] * b;
        R[n] += this.br[1] * b;
      }
      const ml = 1 / Math.hypot(this.bl[0], this.bl[1]);
      const mr = 1 / Math.hypot(this.br[0], this.br[1]);
      this.bl = [this.bl[0] * ml, this.bl[1] * ml];
      this.br = [this.br[0] * mr, this.br[1] * mr];
    }
  }
}

// ------------------------------------------------------------------ bowls

const BOWL_VOICES = 6;
const BOWL_MODES = 3;
/** Partial ratios and weights between a singing bowl (inharmonic) and a crystal bowl (nearly pure). */
const BOWL_RATIO = [1, 2.76, 5.4];
const BOWL_WEIGHT = [1, 0.3, 0.1];
const BOWL_T60 = [16, 8, 3.5];

export class Bowls {
  private readonly active = new Uint8Array(BOWL_VOICES);
  // Per voice × mode × pair: rotation state and coefficients.
  private readonly c = new Float64Array(BOWL_VOICES * BOWL_MODES * 2);
  private readonly s = new Float64Array(BOWL_VOICES * BOWL_MODES * 2);
  private readonly cw = new Float64Array(BOWL_VOICES * BOWL_MODES * 2);
  private readonly sw = new Float64Array(BOWL_VOICES * BOWL_MODES * 2);
  private readonly amp = new Float64Array(BOWL_VOICES * BOWL_MODES);
  private readonly decay = new Float64Array(BOWL_VOICES * BOWL_MODES);
  private readonly env = new Float64Array(BOWL_VOICES);
  private readonly envRate = new Float64Array(BOWL_VOICES);
  private readonly panL = new Float64Array(BOWL_VOICES);
  private readonly panR = new Float64Array(BOWL_VOICES);
  private readonly panAngle = new Float64Array(BOWL_VOICES);
  private readonly level: Level;

  constructor(private readonly fs: number, private readonly rng: Rng) {
    this.level = new Level(1 - Math.exp(-1 / (0.5 * fs)));
  }

  strike(hz: number, velocity: number, ring: number): void {
    let v = -1;
    for (let i = 0; i < BOWL_VOICES; i++) if (!this.active[i]) { v = i; break; }
    if (v < 0) {
      let min = Infinity;
      for (let i = 0; i < BOWL_VOICES; i++) if (this.amp[i * BOWL_MODES] < min) { min = this.amp[i * BOWL_MODES]; v = i; }
    }
    const fs = this.fs;
    const rng = this.rng;
    this.active[v] = 1;
    // Some bowls are struck, some are "rubbed" into a slow swell.
    const rubbed = rng.chance(0.35);
    this.env[v] = 0;
    this.envRate[v] = 1 / ((rubbed ? rng.range(0.9, 1.8) : 0.006) * fs);
    const pan = rng.range(-0.7, 0.7);
    this.panAngle[v] = Math.asin(pan);
    this.panL[v] = Math.cos(((pan + 1) * Math.PI) / 4);
    this.panR[v] = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let m = 0; m < BOWL_MODES; m++) {
      const f = hz * BOWL_RATIO[m];
      const beat = rng.range(0.4, 2.4) * (m + 1) * 0.6;
      const k = v * BOWL_MODES + m;
      this.amp[k] = f < fs * 0.2 ? velocity * BOWL_WEIGHT[m] : 0;
      this.decay[k] = Math.pow(10, -3 / (BOWL_T60[m] * ring * fs));
      for (let p = 0; p < 2; p++) {
        const w = (TAU * (f + (p ? beat / 2 : -beat / 2))) / fs;
        const j = k * 2 + p;
        this.cw[j] = Math.cos(w);
        this.sw[j] = Math.sin(w);
        this.c[j] = 1;
        this.s[j] = 0;
      }
    }
  }

  process(L: Float32Array, R: Float32Array, frames: number, level: number, orbit = 0): void {
    const g = this.level.step(level, frames);
    let any = false;
    for (let v = 0; v < BOWL_VOICES; v++) if (this.active[v]) any = true;
    if (!any) return;
    const k0 = 0.07 * g;
    if (orbit > 0.001) {
      const dt = frames / this.fs;
      for (let v = 0; v < BOWL_VOICES; v++) {
        this.panAngle[v] += (TAU / (14 + v * 3)) * orbit * dt * (v % 2 ? -1 : 1);
        const pan = Math.sin(this.panAngle[v]) * 0.85;
        this.panL[v] = Math.cos(((pan + 1) * Math.PI) / 4);
        this.panR[v] = Math.sin(((pan + 1) * Math.PI) / 4);
      }
    }
    for (let v = 0; v < BOWL_VOICES; v++) {
      if (!this.active[v]) continue;
      for (let n = 0; n < frames; n++) {
        if (this.env[v] < 1) this.env[v] = Math.min(1, this.env[v] + this.envRate[v]);
        let x = 0;
        for (let m = 0; m < BOWL_MODES; m++) {
          const k = v * BOWL_MODES + m;
          const a = this.amp[k];
          if (a < 1e-6) continue;
          for (let p = 0; p < 2; p++) {
            const j = k * 2 + p;
            const c = this.c[j] * this.cw[j] - this.s[j] * this.sw[j];
            this.s[j] = this.c[j] * this.sw[j] + this.s[j] * this.cw[j];
            this.c[j] = c;
            x += this.s[j] * a;
          }
          this.amp[k] = a * this.decay[k];
        }
        x *= this.env[v] * k0;
        L[n] += x * this.panL[v];
        R[n] += x * this.panR[v];
      }
      let alive = false;
      for (let m = 0; m < BOWL_MODES; m++) {
        const k = v * BOWL_MODES + m;
        if (this.amp[k] > 1e-5) alive = true;
        for (let p = 0; p < 2; p++) {
          const j = k * 2 + p;
          const r = 1 / Math.hypot(this.c[j], this.s[j]);
          this.c[j] *= r;
          this.s[j] *= r;
        }
      }
      if (!alive) this.active[v] = 0;
    }
  }
}

// ------------------------------------------------------------------ plucks (Karplus–Strong)

const PLUCK_VOICES = 8;

export class Plucks {
  private readonly buf: Float32Array[];
  private readonly len = new Int32Array(PLUCK_VOICES);
  private readonly pos = new Int32Array(PLUCK_VOICES);
  private readonly ap = new Float64Array(PLUCK_VOICES);
  private readonly apX = new Float64Array(PLUCK_VOICES);
  private readonly apY = new Float64Array(PLUCK_VOICES);
  private readonly prev = new Float64Array(PLUCK_VOICES);
  private readonly rho = new Float64Array(PLUCK_VOICES);
  private readonly bright = new Float64Array(PLUCK_VOICES);
  private readonly energy = new Float64Array(PLUCK_VOICES);
  private readonly active = new Uint8Array(PLUCK_VOICES);
  private readonly panL = new Float64Array(PLUCK_VOICES);
  private readonly panR = new Float64Array(PLUCK_VOICES);
  private readonly env = new Float64Array(PLUCK_VOICES);
  private readonly envInc = new Float64Array(PLUCK_VOICES);
  private readonly level: Level;
  private next = 0;

  constructor(private readonly fs: number, private readonly rng: Rng) {
    const max = Math.ceil(fs / 40) + 4;
    this.buf = Array.from({ length: PLUCK_VOICES }, () => new Float32Array(max));
    this.level = new Level(1 - Math.exp(-1 / (0.3 * fs)));
  }

  /** `attackSec` > 0 fades the string in: a volume swell instead of a pluck. */
  pluck(hz: number, velocity: number, brightness: number, ring: number, attackSec = 0): void {
    const fs = this.fs;
    if (hz < 45 || hz > fs * 0.15) return;
    const v = this.next++ % PLUCK_VOICES;
    const rng = this.rng;
    const D = fs / hz - 0.5;
    const N = Math.max(2, Math.floor(D - 0.1));
    const frac = D - N;
    this.len[v] = N;
    this.pos[v] = 0;
    this.ap[v] = (1 - frac) / (1 + frac);
    this.apX[v] = this.apY[v] = this.prev[v] = 0;
    const t60 = (1.6 + 2.2 * rng.next()) * ring;
    this.rho[v] = Math.pow(10, -3 / (t60 * hz));
    this.bright[v] = 0.1 + 0.5 * brightness;
    // Excitation: soft, low-passed noise (a finger rather than a pick).
    const b = this.buf[v];
    const lp = 0.35 + 0.5 * (1 - brightness);
    let y = 0;
    let mean = 0;
    for (let i = 0; i < N; i++) {
      y = (1 - lp) * rng.range(-1, 1) + lp * y;
      b[i] = y;
      mean += y;
    }
    mean /= N;
    for (let i = 0; i < N; i++) b[i] = (b[i] - mean) * velocity;
    this.energy[v] = 1;
    this.active[v] = 1;
    this.env[v] = attackSec > 0.005 ? 0 : 1;
    this.envInc[v] = attackSec > 0.005 ? 1 / (attackSec * fs) : 0;
    const pan = rng.range(-0.6, 0.6);
    this.panL[v] = Math.cos(((pan + 1) * Math.PI) / 4);
    this.panR[v] = Math.sin(((pan + 1) * Math.PI) / 4);
  }

  process(L: Float32Array, R: Float32Array, frames: number, level: number): void {
    const g = this.level.step(level, frames) * 0.5;
    for (let v = 0; v < PLUCK_VOICES; v++) {
      if (!this.active[v]) continue;
      const b = this.buf[v];
      const N = this.len[v];
      const C = this.ap[v];
      const rho = this.rho[v];
      const br = this.bright[v];
      let pos = this.pos[v];
      let prev = this.prev[v];
      let x1 = this.apX[v];
      let y1 = this.apY[v];
      let e = 0;
      for (let n = 0; n < frames; n++) {
        const out = b[pos];
        // Loss filter: blend of a two-point average (dark) and the raw sample (bright).
        const lossy = rho * ((1 - br) * 0.5 * (out + prev) + br * out);
        prev = out;
        // Fractional delay via first-order all-pass.
        const y = C * lossy + x1 - C * y1;
        x1 = lossy;
        y1 = y;
        b[pos] = y;
        pos = pos + 1 === N ? 0 : pos + 1;
        if (this.env[v] < 1) this.env[v] = Math.min(1, this.env[v] + this.envInc[v]);
        const s = out * g * this.env[v];
        L[n] += s * this.panL[v];
        R[n] += s * this.panR[v];
        e += out * out;
      }
      this.pos[v] = pos;
      this.prev[v] = prev;
      this.apX[v] = x1;
      this.apY[v] = y1;
      if (e / frames < 1e-9 || !Number.isFinite(e)) this.active[v] = 0;
    }
  }
}

// ------------------------------------------------------------------ soft piano

const PIANO_VOICES = 8;
const PIANO_PARTIALS = 6;
/** Oscillators per voice: partials 1 and 2 are pairs (two strings, slightly apart), the rest single. */
const PIANO_OSC = PIANO_PARTIALS + 2;
const PIANO_B = 0.0003; // string inharmonicity

/**
 * "Soft pedal" piano after Harold Budd: a felt-hammer attack, dark partials on quiet notes,
 * long decays, and the two strings of the lower partials beating slowly against each other.
 */
export class Piano {
  private readonly active = new Uint8Array(PIANO_VOICES);
  private readonly c = new Float64Array(PIANO_VOICES * PIANO_OSC);
  private readonly s = new Float64Array(PIANO_VOICES * PIANO_OSC);
  private readonly cw = new Float64Array(PIANO_VOICES * PIANO_OSC);
  private readonly sw = new Float64Array(PIANO_VOICES * PIANO_OSC);
  private readonly amp = new Float64Array(PIANO_VOICES * PIANO_OSC);
  private readonly decay = new Float64Array(PIANO_VOICES * PIANO_OSC);
  private readonly env = new Float64Array(PIANO_VOICES);
  private readonly envInc = new Float64Array(PIANO_VOICES);
  private readonly panL = new Float64Array(PIANO_VOICES);
  private readonly panR = new Float64Array(PIANO_VOICES);
  private lpL = 0;
  private lpR = 0;
  private next = 0;
  private readonly level: Level;

  constructor(private readonly fs: number, private readonly rng: Rng) {
    this.level = new Level(1 - Math.exp(-1 / (0.4 * fs)));
  }

  strike(hz: number, velocity: number, ring: number, attackSec = 0): void {
    const fs = this.fs;
    if (hz < 40 || hz > 2500) return;
    const v = this.next++ % PIANO_VOICES;
    const rng = this.rng;
    // Lower notes ring longer.
    const t60 = Math.max(2, Math.min(9, 8 - 1.2 * Math.log2(hz / 65))) * ring;
    let o = 0;
    for (let n = 1; n <= PIANO_PARTIALS; n++) {
      const f = hz * n * Math.sqrt(1 + PIANO_B * n * n);
      // Soft hits are darker: upper partials fall away with lower velocity.
      const a = f < fs * 0.2 ? Math.pow(n, -1.3) * Math.exp(-(n - 1) * (1.1 - velocity) * 0.7) * velocity : 0;
      const d = Math.pow(10, -3 / ((t60 / (1 + 0.5 * (n - 1))) * fs));
      const strings = n <= 2 ? 2 : 1;
      for (let k = 0; k < strings; k++) {
        const j = v * PIANO_OSC + o++;
        const detune = strings === 2 ? (k ? 1 : -1) * rng.range(0.1, 0.35) : 0;
        const w = (TAU * (f + detune)) / fs;
        this.cw[j] = Math.cos(w);
        this.sw[j] = Math.sin(w);
        this.c[j] = 1;
        this.s[j] = 0;
        this.amp[j] = a / strings;
        this.decay[j] = d;
      }
    }
    this.env[v] = 0;
    // Felt hammer: a few ms; with Swell, a slow fade-in.
    this.envInc[v] = 1 / (Math.max(0.006, attackSec) * fs);
    const pan = rng.range(-0.4, 0.4) + (Math.log2(hz / 262) * 0.15);
    this.panL[v] = Math.cos(((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4);
    this.panR[v] = Math.sin(((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4);
    this.active[v] = 1;
  }

  process(L: Float32Array, R: Float32Array, frames: number, level: number, brightness: number): void {
    const g = this.level.step(level, frames) * 0.36;
    let any = false;
    for (let v = 0; v < PIANO_VOICES; v++) if (this.active[v]) any = true;
    if (!any) return;
    const lp = Math.exp((-TAU * (2500 + 4500 * brightness)) / this.fs);
    for (let n = 0; n < frames; n++) {
      let l = 0;
      let r = 0;
      for (let v = 0; v < PIANO_VOICES; v++) {
        if (!this.active[v]) continue;
        if (this.env[v] < 1) this.env[v] = Math.min(1, this.env[v] + this.envInc[v]);
        let x = 0;
        for (let o = 0; o < PIANO_OSC; o++) {
          const j = v * PIANO_OSC + o;
          const a = this.amp[j];
          if (a < 1e-7) continue;
          const c = this.c[j] * this.cw[j] - this.s[j] * this.sw[j];
          this.s[j] = this.c[j] * this.sw[j] + this.s[j] * this.cw[j];
          this.c[j] = c;
          x += this.s[j] * a;
          this.amp[j] = a * this.decay[j];
        }
        x *= this.env[v];
        l += x * this.panL[v];
        r += x * this.panR[v];
      }
      this.lpL = (1 - lp) * l + lp * this.lpL;
      this.lpR = (1 - lp) * r + lp * this.lpR;
      L[n] += this.lpL * g;
      R[n] += this.lpR * g;
    }
    for (let v = 0; v < PIANO_VOICES; v++) {
      if (!this.active[v]) continue;
      let alive = false;
      for (let o = 0; o < PIANO_OSC; o++) {
        const j = v * PIANO_OSC + o;
        if (this.amp[j] > 1e-6) alive = true;
        const m = 1 / Math.hypot(this.c[j], this.s[j]);
        this.c[j] *= m;
        this.s[j] *= m;
      }
      if (!alive) this.active[v] = 0;
    }
  }
}

// ------------------------------------------------------------------ choir (formant voices)

const VOWELS = [
  [300, 870, 2240], // oo
  [570, 840, 2410], // oh
  [730, 1090, 2440], // ah
  [530, 1840, 2480], // eh (brief, for colour)
];
const FORMANT_GAIN = [1, 0.5, 0.22];
const FORMANT_BW = [80, 100, 130];

class Biquad {
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  bandpass(fs: number, f: number, bw: number): void {
    const w = (TAU * f) / fs;
    const q = f / bw;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  peaking(fs: number, f: number, q: number, db: number): void {
    const A = Math.pow(10, db / 40);
    const w = (TAU * f) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * Math.cos(w)) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = this.b1;
    this.a2 = (1 - alpha / A) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}
export { Biquad };

const CHOIR_VOICES = 3;

export class Choir {
  private readonly freq = new Float64Array(CHOIR_VOICES);
  private readonly target = new Float64Array(CHOIR_VOICES);
  private readonly phase = new Float64Array(CHOIR_VOICES * 2);
  private readonly vib = new Float64Array(CHOIR_VOICES);
  private readonly drift = new Float64Array(CHOIR_VOICES * 2);
  private readonly fL = [new Biquad(), new Biquad(), new Biquad()];
  private readonly fR = [new Biquad(), new Biquad(), new Biquad()];
  private vowelPos = 0;
  private noise = 0;
  private readonly level: Level;

  constructor(private readonly fs: number, private readonly rng: Rng) {
    this.level = new Level(1 - Math.exp(-1 / (2 * fs)));
    for (let i = 0; i < CHOIR_VOICES; i++) {
      this.vib[i] = rng.next() * TAU;
      this.phase[i * 2] = rng.next();
      this.phase[i * 2 + 1] = rng.next();
    }
    this.vowelPos = rng.next() * VOWELS.length;
  }

  setChord(freqs: number[]): void {
    for (let i = 0; i < CHOIR_VOICES; i++) {
      this.target[i] = freqs[i % freqs.length];
      if (this.freq[i] === 0) this.freq[i] = this.target[i];
    }
  }

  process(L: Float32Array, R: Float32Array, frames: number, level: number, detuneCents: number): void {
    if (this.level.silent(level)) return;
    const fs = this.fs;
    const dt = frames / fs;
    const rng = this.rng;
    // Vowel drifts slowly through oo → oh → ah → eh and back.
    this.vowelPos = (this.vowelPos + dt / 11) % VOWELS.length;
    const i0 = Math.floor(this.vowelPos);
    const i1 = (i0 + 1) % VOWELS.length;
    const t = this.vowelPos - i0;
    const tt = t * t * (3 - 2 * t);
    for (let f = 0; f < 3; f++) {
      const fc = VOWELS[i0][f] * (1 - tt) + VOWELS[i1][f] * tt;
      this.fL[f].bandpass(fs, fc, FORMANT_BW[f]);
      this.fR[f].bandpass(fs, fc * 1.02, FORMANT_BW[f]);
    }
    const glide = 1 - Math.exp(-dt / 3);
    const spread = Math.pow(2, Math.max(4, detuneCents) / 1200);
    for (let i = 0; i < CHOIR_VOICES; i++) {
      this.freq[i] += (this.target[i] - this.freq[i]) * glide;
      for (let s = 0; s < 2; s++) this.drift[i * 2 + s] += (rng.range(-1, 1) * 0.002 - this.drift[i * 2 + s] * 0.05);
    }
    for (let n = 0; n < frames; n++) {
      const g = this.level.step(level) * 0.05;
      let sl = 0;
      let sr = 0;
      for (let i = 0; i < CHOIR_VOICES; i++) {
        this.vib[i] += (TAU * (4.8 + i * 0.37)) / fs;
        const vib = 1 + 0.004 * Math.sin(this.vib[i]);
        for (let s = 0; s < 2; s++) {
          const j = i * 2 + s;
          const f = this.freq[i] * vib * (s ? spread : 1 / spread) * (1 + this.drift[j]);
          const inc = f / fs;
          this.phase[j] += inc;
          if (this.phase[j] >= 1) this.phase[j] -= 1;
          const x = saw(this.phase[j], inc);
          if (s) sr += x; else sl += x;
        }
      }
      // Breath noise, low-passed, into both.
      this.noise = 0.8 * this.noise + 0.2 * (rng.next() * 2 - 1);
      sl += this.noise * 0.25;
      sr += this.noise * 0.25;
      let yl = 0;
      let yr = 0;
      for (let f = 0; f < 3; f++) {
        yl += this.fL[f].run(sl) * FORMANT_GAIN[f];
        yr += this.fR[f].run(sr) * FORMANT_GAIN[f];
      }
      L[n] += yl * g;
      R[n] += yr * g;
    }
  }
}

// ------------------------------------------------------------------ lo-fi beat

interface Hit { at: number; kind: 0 | 1 | 2; vel: number }

export class Beat {
  /** Position in beats since start. */
  private pos = 0;
  private bar: Hit[] = [];
  private barStart = -1;
  private hi = 0;
  // kick
  private kT = 1e9; private kVel = 0; private kPh = 0;
  // snare/brush
  private sT = 1e9; private sVel = 0; private sBody = 0;
  private readonly sBp = new Biquad();
  // hat
  private hT = 1e9; private hVel = 0; private hHp = 0; private hPrev = 0;
  // bus
  private lpL = 0; private lpR = 0;
  private crackle = 0;
  private readonly level: Level;
  hits: { offset: number; kind: 0 | 1 | 2; vel: number }[] = [];

  constructor(private readonly fs: number, private readonly rng: Rng) {
    this.sBp.bandpass(fs, 1900, 1700);
    this.level = new Level(1 - Math.exp(-1 / (0.4 * fs)));
  }

  /** Beats elapsed; the melodic pulse grid reads this so notes and drums share one clock. */
  get position(): number {
    return this.pos;
  }

  /** Swing: the off-beat eighth lands at `swing` of the beat (0.5 straight, 0.66 triplet). */
  private swung(b: number, swing: number): number {
    const f = b - Math.floor(b);
    return Math.abs(f - 0.5) < 1e-6 ? Math.floor(b) + swing : b;
  }

  private makeBar(amount: number, swing: number): void {
    const rng = this.rng;
    const hits: Hit[] = [];
    const push = (b: number, kind: 0 | 1 | 2, vel: number) => hits.push({ at: this.swung(b, swing), kind, vel });
    if (amount < 0.35) {
      // Heartbeat: lub-dub on beats 1 and 3.
      for (const b of [0, 2]) { push(b, 0, 0.75); hits.push({ at: b + 0.3, kind: 0, vel: 0.42 }); }
    } else {
      push(0, 0, 0.9);
      if (rng.chance(0.55)) push(1.5, 0, 0.5);
      push(2.5, 0, 0.75);
      if (rng.chance(0.25)) push(3.5, 0, 0.4);
      const sn = Math.min(1, (amount - 0.35) / 0.4);
      push(1, 1, 0.8 * sn);
      push(3, 1, 0.8 * sn);
      if (rng.chance(0.3)) push(2.75, 1, 0.25 * sn);
      if (amount > 0.6) {
        const hv = Math.min(1, (amount - 0.6) / 0.4);
        for (let e = 0; e < 8; e++) if (!rng.chance(0.15)) push(e / 2, 2, (e % 2 ? 0.45 : 0.75) * hv);
      }
    }
    hits.sort((a, b) => a.at - b.at);
    this.bar = hits;
    this.hi = 0;
  }

  process(L: Float32Array, R: Float32Array, frames: number, amount: number, tempo: number, swing: number, brightness: number): void {
    this.hits.length = 0;
    const target = amount > 0.02 ? 1 : 0;
    if (this.level.silent(target)) { this.pos += (frames / this.fs) * (tempo / 60); return; }
    const fs = this.fs;
    const rng = this.rng;
    const inc = tempo / 60 / fs;
    const lp = Math.exp((-TAU * (2500 + 6000 * brightness)) / fs);
    const drive = 1.6;
    for (let n = 0; n < frames; n++) {
      const g = this.level.step(target);
      const barIdx = Math.floor(this.pos / 4);
      if (barIdx !== this.barStart) { this.barStart = barIdx; this.makeBar(amount, swing); }
      const inBar = this.pos - barIdx * 4;
      while (this.hi < this.bar.length && this.bar[this.hi].at <= inBar) {
        const h = this.bar[this.hi++];
        const vel = h.vel * (0.85 + 0.3 * rng.next());
        if (h.kind === 0) { this.kT = 0; this.kVel = vel; this.kPh = 0; }
        else if (h.kind === 1) { this.sT = 0; this.sVel = vel; }
        else { this.hT = 0; this.hVel = vel; }
        if (h.kind !== 2) this.hits.push({ offset: n, kind: h.kind, vel });
      }
      this.pos += inc;

      let x = 0;
      // Felt kick: a sine dropping 110 → 45 Hz with a soft, round decay.
      if (this.kT < 0.6 * fs) {
        const t = this.kT / fs;
        const f = 45 + 65 * Math.exp(-t / 0.03);
        this.kPh += f / fs;
        x += Math.sin(TAU * this.kPh) * Math.exp(-t / 0.22) * Math.min(1, t / 0.003) * this.kVel * 0.9;
        this.kT++;
      }
      // Brush snare: band-passed noise with a short body.
      if (this.sT < 0.4 * fs) {
        const t = this.sT / fs;
        const nz = this.sBp.run(rng.next() * 2 - 1);
        this.sBody += (TAU * 190) / fs;
        x += (nz * 2.2 * Math.exp(-t / 0.13) + Math.sin(this.sBody) * 0.18 * Math.exp(-t / 0.05)) * Math.min(1, t / 0.004) * this.sVel * 0.5;
        this.sT++;
      }
      // Dusty hat: high-passed noise, very short.
      let hat = 0;
      if (this.hT < 0.1 * fs) {
        const t = this.hT / fs;
        const w = rng.next() * 2 - 1;
        this.hHp = 0.6 * (this.hHp + w - this.hPrev);
        this.hPrev = w;
        hat = this.hHp * Math.exp(-t / 0.028) * this.hVel * 0.16;
        this.hT++;
      }
      // Vinyl: sparse soft crackle once the beat is more than a pulse.
      if (amount > 0.5 && rng.next() < 5 / fs) this.crackle = (rng.next() - 0.5) * 0.02 * (amount - 0.5);
      this.crackle *= 0.9;

      const dl = Math.tanh((x + hat * 0.8 + this.crackle) * drive) / drive;
      const dr = Math.tanh((x + hat * 1.2 + this.crackle) * drive) / drive;
      this.lpL = (1 - lp) * dl + lp * this.lpL;
      this.lpR = (1 - lp) * dr + lp * this.lpR;
      L[n] += this.lpL * g * 0.17;
      R[n] += this.lpR * g * 0.17;
    }
  }
}

// ------------------------------------------------------------------ shimmer

/** Octave-up pitch shifter (two crossfaded moving read heads) with feedback. */
export class Shimmer {
  private readonly bl: Float32Array;
  private readonly br: Float32Array;
  private readonly mask: number;
  private w = 0;
  private phase = 0;
  private yl = 0; private yr = 0;
  private lpL = 0; private lpR = 0;
  private hpL = 0; private hpR = 0;
  private pxL = 0; private pxR = 0;
  private readonly W: number;

  constructor(private readonly fs: number) {
    let size = 1;
    while (size < fs * 0.1) size <<= 1;
    this.bl = new Float32Array(size);
    this.br = new Float32Array(size);
    this.mask = size - 1;
    this.W = Math.round(fs * 0.045);
  }

  /** Adds the shimmer of sendL/R back into sendL/R. */
  process(sendL: Float32Array, sendR: Float32Array, frames: number, amount: number): void {
    if (amount <= 0.001) return;
    const W = this.W;
    const lp = Math.exp((-TAU * 5000) / this.fs);
    const hp = Math.exp((-TAU * 350) / this.fs);
    const fb = 0.42 * amount;
    for (let n = 0; n < frames; n++) {
      this.bl[this.w & this.mask] = sendL[n] + this.yl * fb;
      this.br[this.w & this.mask] = sendR[n] + this.yr * fb;
      this.phase += 1 / W;
      if (this.phase >= 1) this.phase -= 1;
      let ol = 0;
      let or = 0;
      for (let h = 0; h < 2; h++) {
        const ph = (this.phase + h * 0.5) % 1;
        const d = W * (1 - ph) + 2;
        const win = Math.sin(Math.PI * ph);
        const pos = this.w - d;
        const i = Math.floor(pos);
        const f = pos - i;
        ol += (this.bl[i & this.mask] * (1 - f) + this.bl[(i + 1) & this.mask] * f) * win;
        or += (this.br[i & this.mask] * (1 - f) + this.br[(i + 1) & this.mask] * f) * win;
      }
      this.w++;
      this.lpL = (1 - lp) * ol + lp * this.lpL;
      this.lpR = (1 - lp) * or + lp * this.lpR;
      this.hpL = hp * (this.hpL + this.lpL - this.pxL);
      this.hpR = hp * (this.hpR + this.lpR - this.pxR);
      this.pxL = this.lpL;
      this.pxR = this.lpR;
      this.yl = this.hpL;
      this.yr = this.hpR;
      sendL[n] += this.hpL * amount * 0.6;
      sendR[n] += this.hpR * amount * 0.6;
    }
  }
}
