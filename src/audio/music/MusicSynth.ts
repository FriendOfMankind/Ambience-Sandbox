/**
 * MusicSynth: a small generative ambient ensemble.
 *
 * - Pad:  three voices of detuned saws through a slowly breathing low-pass filter, gliding
 *         between chords built from the world's scale every 20–60 s.
 * - Keys: sparse FM bell/e-piano notes wandering the scale (a weighted random walk that
 *         prefers small steps), through a ping-pong delay.
 * - Breath: a slow random process that thins everything out now and then, so the music
 *         leaves space instead of noodling forever.
 *
 * Deterministic for a seed and parameter timeline. Constants are initial guesses.
 */

import { createRng, type Rng } from '../../core/rng';
import { scaleStepHz, type ScaleSnap } from './scales';

export interface MusicParams {
  padLevel: number;
  keysLevel: number;
  /** Keys notes per minute at full breath (0..40). */
  density: number;
  /** Pad filter brightness 0..1. */
  brightness: number;
  /** Average seconds between chord changes. */
  chordSeconds: number;
  /** Detune between pad oscillators in cents (0 = pure, 40+ = seasick). */
  detune: number;
  /** FM ratio for the keys: 2 = e-piano-ish, 3.5 = bell, odd values = clangy. */
  keysRatio: number;
  /** Keys register: octaves above the scale root for the middle of the range. */
  keysOctave: number;
  scale: ScaleSnap;
}

export interface MusicEvent {
  kind: 'note' | 'chord';
  frame: number;
  /** Note frequency, or the chord root for chord changes. */
  hz: number;
  velocity: number;
  /** Scale step of the note or chord root. */
  step: number;
}

export const DEFAULT_MUSIC_PARAMS: MusicParams = {
  padLevel: 1,
  keysLevel: 1,
  density: 8,
  brightness: 0.4,
  chordSeconds: 35,
  detune: 9,
  keysRatio: 2,
  keysOctave: 2,
  scale: { enabled: true, rootHz: 146.83, cents: [0, 300, 500, 700, 1000], periodCents: 1200 },
};

const PAD_VOICES = 3;
const KEYS_VOICES = 10;

/** PolyBLEP-corrected sawtooth, phase in [0,1). */
function saw(phase: number, inc: number): number {
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

export class MusicSynth {
  frame = 0;
  private p: MusicParams = { ...DEFAULT_MUSIC_PARAMS };
  private readonly rng: Rng;
  private readonly rngKeys: Rng;
  private events: MusicEvent[] = [];

  // Pad
  private chordStep = 0;
  private readonly padTarget = new Float64Array(PAD_VOICES);
  private readonly padFreq = new Float64Array(PAD_VOICES);
  private readonly padPhaseA = new Float64Array(PAD_VOICES);
  private readonly padPhaseB = new Float64Array(PAD_VOICES);
  private readonly padSwell = new Float64Array(PAD_VOICES);
  private readonly padSwellRate = new Float64Array(PAD_VOICES);
  private nextChordIn = 0;
  private filtL = [0, 0];
  private filtR = [0, 0];
  private filterLfo = 0;

  // Keys
  private keysStep = 0;
  private nextNoteIn = 0;
  private readonly kActive = new Uint8Array(KEYS_VOICES);
  private readonly kFreq = new Float64Array(KEYS_VOICES);
  private readonly kPhaseC = new Float64Array(KEYS_VOICES);
  private readonly kPhaseM = new Float64Array(KEYS_VOICES);
  private readonly kAmp = new Float64Array(KEYS_VOICES);
  private readonly kAmpMul = new Float64Array(KEYS_VOICES);
  private readonly kIndex = new Float64Array(KEYS_VOICES);
  private readonly kIndexMul = new Float64Array(KEYS_VOICES);
  private readonly kAttack = new Float64Array(KEYS_VOICES);
  private readonly kPanL = new Float64Array(KEYS_VOICES);
  private readonly kPanR = new Float64Array(KEYS_VOICES);
  private readonly kRatio = new Float64Array(KEYS_VOICES);

  // Delay (keys only)
  private readonly dl: Float32Array;
  private readonly dr: Float32Array;
  private dPos = 0;
  private readonly dMask: number;
  private dlLp = 0;
  private drLp = 0;

  // Breath: slow OU process on overall density
  private breath = 0;
  private padLevelCur = 1;

  constructor(
    private readonly fs: number,
    seed: string,
    params?: Partial<MusicParams>,
  ) {
    this.rng = createRng(seed, 'music.pad');
    this.rngKeys = createRng(seed, 'music.keys');
    let size = 1;
    while (size < fs * 1.5) size <<= 1;
    this.dl = new Float32Array(size);
    this.dr = new Float32Array(size);
    this.dMask = size - 1;
    this.setParams(params ?? {});
    for (let v = 0; v < PAD_VOICES; v++) {
      this.padPhaseA[v] = this.rng.next();
      this.padPhaseB[v] = this.rng.next();
      this.padSwell[v] = this.rng.next() * Math.PI * 2;
      this.padSwellRate[v] = (2 * Math.PI) / (this.rng.range(14, 30) * fs);
    }
    this.chordStep = 0;
    this.applyChord(true);
    this.nextChordIn = this.chordInterval();
    this.nextNoteIn = this.rngKeys.range(1, 4) * fs;
    this.keysStep = this.p.scale.cents.length * this.p.keysOctave;
  }

  get params(): Readonly<MusicParams> {
    return this.p;
  }

  setParams(patch: Partial<MusicParams>): void {
    const scaleChanged = patch.scale !== undefined;
    this.p = { ...this.p, ...patch, scale: { ...this.p.scale, ...(patch.scale ?? {}) } };
    // Re-voice the current chord in the new scale; the glide makes the change smooth.
    if (scaleChanged && this.padTarget.length) this.applyChord(false);
  }

  drainEvents(): MusicEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private chordInterval(): number {
    const mean = Math.max(5, this.p.chordSeconds);
    return this.rng.range(mean * 0.6, mean * 1.4) * this.fs;
  }

  /** Voice a chord on scale steps chordStep, +2, +4 (stacked "thirds" in any scale). */
  private applyChord(snap: boolean): void {
    const n = this.p.scale.cents.length;
    // Keep the chord root in the lowest octave or two.
    this.chordStep = ((this.chordStep % n) + n) % n;
    const steps = [this.chordStep, this.chordStep + 2, this.chordStep + 4 + (n <= 5 ? 0 : 0)];
    for (let v = 0; v < PAD_VOICES; v++) {
      const f = scaleStepHz(this.p.scale, steps[v]);
      this.padTarget[v] = f;
      if (snap || this.padFreq[v] === 0) this.padFreq[v] = f;
    }
    this.events.push({ kind: 'chord', frame: this.frame, hz: this.padTarget[0], velocity: 1, step: this.chordStep });
  }

  private nextChord(): void {
    // Move by a small interval most of the time; sometimes further.
    const moves = [1, -1, 2, -2, 3, -3];
    const weights = [3, 3, 2, 2, 1, 1];
    this.chordStep += moves[this.rng.weightedIndex(weights)];
    this.applyChord(false);
  }

  private noteRate(): number {
    const breath = Math.max(0, Math.min(1.3, 0.55 + 0.5 * this.breath));
    return (this.p.density / 60) * breath;
  }

  private startNote(offset: number): void {
    const rng = this.rngKeys;
    const n = this.p.scale.cents.length;
    const centre = n * this.p.keysOctave + Math.floor(n / 2);
    // Random walk that prefers small steps and is pulled back toward the centre of the range.
    const steps = [1, -1, 2, -2, 3, -3, 5, -5];
    const weights = [4, 4, 3, 3, 1.5, 1.5, 0.5, 0.5];
    let step = this.keysStep + steps[rng.weightedIndex(weights)];
    if (Math.abs(step - centre) > n * 1.2) step += step > centre ? -2 : 2;
    this.keysStep = step;
    const f = scaleStepHz(this.p.scale, step);
    const velocity = rng.range(0.35, 1);
    const pan = rng.range(-0.6, 0.6);
    const decaySec = rng.range(1.8, 3.5);

    let v = -1;
    for (let i = 0; i < KEYS_VOICES; i++) if (!this.kActive[i]) { v = i; break; }
    if (v < 0) {
      // Steal the quietest voice.
      let min = Infinity;
      for (let i = 0; i < KEYS_VOICES; i++) if (this.kAmp[i] < min) { min = this.kAmp[i]; v = i; }
    }
    if (f >= this.fs * 0.2) return;
    this.kActive[v] = 1;
    this.kFreq[v] = f;
    this.kPhaseC[v] = 0;
    this.kPhaseM[v] = 0;
    this.kAmp[v] = velocity * 0.22;
    this.kAmpMul[v] = Math.exp(-1 / (decaySec * this.fs));
    this.kIndex[v] = 1.2 + velocity * 1.8;
    this.kIndexMul[v] = Math.exp(-1 / (0.35 * this.fs));
    this.kAttack[v] = 0;
    this.kPanL[v] = Math.cos(((pan + 1) * Math.PI) / 4);
    this.kPanR[v] = Math.sin(((pan + 1) * Math.PI) / 4);
    this.kRatio[v] = this.p.keysRatio;
    this.events.push({ kind: 'note', frame: this.frame + offset, hz: f, velocity, step });
  }

  /**
   * Render one block. Writes dry output into outL/outR (overwrites) and a copy of the
   * reverb send into sendL/sendR.
   */
  process(
    outL: Float32Array,
    outR: Float32Array,
    sendL: Float32Array,
    sendR: Float32Array,
    frames = outL.length,
  ): void {
    const fs = this.fs;
    const p = this.p;
    const dt = frames / fs;
    this.breath += -0.03 * this.breath * dt + 0.25 * Math.sqrt(dt) * this.rng.gaussian();

    // Chords
    this.nextChordIn -= frames;
    if (this.nextChordIn <= 0) {
      this.nextChord();
      this.nextChordIn = this.chordInterval();
    }

    // Keys scheduling (offsets within the block).
    const rate = this.noteRate();
    const starts: number[] = [];
    if (rate > 1e-4) {
      while (this.nextNoteIn < frames) {
        starts.push(Math.max(0, Math.floor(this.nextNoteIn)));
        this.nextNoteIn += this.rngKeys.exponential(rate) * fs;
      }
      this.nextNoteIn -= frames;
    } else {
      this.nextNoteIn = Math.max(this.nextNoteIn - frames, fs);
    }
    let si = 0;

    const glide = 1 - Math.exp(-1 / (4 * fs));
    const detuneRatio = Math.pow(2, p.detune / 1200);
    const lfoInc = (2 * Math.PI) / (23 * fs);
    const baseCut = 250 + 2600 * p.brightness * p.brightness;
    const padGainTarget = p.padLevel * (0.75 + 0.25 * Math.max(-1, Math.min(1, this.breath)));
    const levelSmooth = 1 - Math.exp(-1 / (0.5 * fs));
    const dA = Math.round(0.47 * fs);
    const dB = Math.round(0.71 * fs);
    const dLp = Math.exp((-2 * Math.PI * 3200) / fs);

    for (let n = 0; n < frames; n++) {
      while (si < starts.length && starts[si] <= n) {
        this.startNote(n);
        si++;
      }

      // ---- pad
      this.padLevelCur += (padGainTarget - this.padLevelCur) * levelSmooth;
      let pl = 0;
      let pr = 0;
      for (let v = 0; v < PAD_VOICES; v++) {
        this.padFreq[v] += (this.padTarget[v] - this.padFreq[v]) * glide;
        const fA = this.padFreq[v] * detuneRatio;
        const fB = this.padFreq[v] / detuneRatio;
        const incA = fA / fs;
        const incB = fB / fs;
        this.padPhaseA[v] += incA;
        if (this.padPhaseA[v] >= 1) this.padPhaseA[v] -= 1;
        this.padPhaseB[v] += incB;
        if (this.padPhaseB[v] >= 1) this.padPhaseB[v] -= 1;
        this.padSwell[v] += this.padSwellRate[v];
        const swell = 0.6 + 0.4 * Math.sin(this.padSwell[v]);
        const a = saw(this.padPhaseA[v], incA) * swell;
        const b = saw(this.padPhaseB[v], incB) * swell;
        // Voice 0 centre, 1 left-ish, 2 right-ish; each osc slightly spread.
        const spread = v === 0 ? 0 : v === 1 ? -0.35 : 0.35;
        pl += a * (0.55 - spread * 0.5) + b * (0.45 - spread * 0.5);
        pr += a * (0.45 + spread * 0.5) + b * (0.55 + spread * 0.5);
      }
      this.filterLfo += lfoInc;
      const cut = Math.min(baseCut * (1 + 0.35 * Math.sin(this.filterLfo)), fs * 0.2);
      const c = Math.exp((-2 * Math.PI * cut) / fs);
      // Two cascaded one-poles per channel: a gentle 12 dB/oct low-pass.
      this.filtL[0] = (1 - c) * pl + c * this.filtL[0];
      this.filtL[1] = (1 - c) * this.filtL[0] + c * this.filtL[1];
      this.filtR[0] = (1 - c) * pr + c * this.filtR[0];
      this.filtR[1] = (1 - c) * this.filtR[0] + c * this.filtR[1];
      const padL = this.filtL[1] * 0.09 * this.padLevelCur;
      const padR = this.filtR[1] * 0.09 * this.padLevelCur;

      // ---- keys (2-operator FM)
      let kl = 0;
      let kr = 0;
      for (let v = 0; v < KEYS_VOICES; v++) {
        if (!this.kActive[v]) continue;
        const f = this.kFreq[v];
        this.kPhaseM[v] += (f * this.kRatio[v]) / fs;
        if (this.kPhaseM[v] >= 1) this.kPhaseM[v] -= 1;
        this.kPhaseC[v] += f / fs;
        if (this.kPhaseC[v] >= 1) this.kPhaseC[v] -= 1;
        const mod = Math.sin(2 * Math.PI * this.kPhaseM[v]) * this.kIndex[v];
        this.kAttack[v] = Math.min(1, this.kAttack[v] + 1 / (0.004 * fs));
        const s = Math.sin(2 * Math.PI * this.kPhaseC[v] + mod) * this.kAmp[v] * this.kAttack[v];
        this.kAmp[v] *= this.kAmpMul[v];
        this.kIndex[v] *= this.kIndexMul[v];
        if (this.kAmp[v] < 1e-5) this.kActive[v] = 0;
        kl += s * this.kPanL[v];
        kr += s * this.kPanR[v];
      }
      kl *= p.keysLevel;
      kr *= p.keysLevel;

      // ---- ping-pong delay on keys
      const rA = this.dl[(this.dPos - dA) & this.dMask];
      const rB = this.dr[(this.dPos - dB) & this.dMask];
      this.dlLp = (1 - dLp) * rA + dLp * this.dlLp;
      this.drLp = (1 - dLp) * rB + dLp * this.drLp;
      this.dl[this.dPos & this.dMask] = kl + this.drLp * 0.38;
      this.dr[this.dPos & this.dMask] = kr + this.dlLp * 0.38;
      this.dPos++;

      const L = padL + kl + this.dlLp * 0.3;
      const R = padR + kr + this.drLp * 0.3;
      outL[n] = L;
      outR[n] = R;
      sendL[n] = padL * 0.8 + kl + this.dlLp * 0.3;
      sendR[n] = padR * 0.8 + kr + this.drLp * 0.3;
    }

    if (!Number.isFinite(this.filtL[1]) || !Number.isFinite(this.dlLp)) this.resetState(outL, outR, sendL, sendR, frames);
    this.frame += frames;
  }

  private resetState(outL: Float32Array, outR: Float32Array, sendL: Float32Array, sendR: Float32Array, frames: number): void {
    this.filtL = [0, 0];
    this.filtR = [0, 0];
    this.dl.fill(0);
    this.dr.fill(0);
    this.dlLp = this.drLp = 0;
    this.kActive.fill(0);
    for (const b of [outL, outR, sendL, sendR]) b.fill(0, 0, frames);
  }
}
