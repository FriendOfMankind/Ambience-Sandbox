/**
 * MusicSynth: a generative ambient ensemble.
 *
 * Voices: pad (detuned saws, breathing filter), keys (2-op FM), and from ./voices: a
 * just-tuned harmonic drone, singing bowls, Karplus–Strong plucks, a formant choir and a soft
 * lo-fi beat, plus an octave shimmer on the reverb send.
 *
 * Composition:
 *  - Chords move through the scale every `chordSeconds` (pad, choir and bowls follow them).
 *  - Melodic voices each have a role: keys wander (a random walk preferring small steps),
 *    plucks arpeggiate the chord, bowls sound the chord's root and fifth, sparsely.
 *  - Rhythm: "free" (random timing), "loops" (Eno-style: each voice owns a few loops of
 *    incommensurate lengths holding one or two chord-relative notes, so the music never
 *    repeats the same way), or "pulse" (notes land on a swung eighth grid shared with the beat).
 *  - Breath: in free/pulse modes, phrases alternate with rests; `breath` sets how long the
 *    silences are (Eno's rule of thumb: silence at least twice as long as the sound ≈ 0.7).
 *
 * Deterministic for a seed and parameter timeline. Constants are initial guesses.
 */

import { createRng, type Rng } from '../../core/rng';
import { scaleStepHz, type ScaleSnap } from './scales';
import { Beat, Bowls, Choir, Drone, Plucks, Shimmer, saw } from './voices';

export type Rhythm = 'free' | 'loops' | 'pulse';
export type MusicVoice = 'keys' | 'pluck' | 'bowl';

export interface MusicParams {
  padLevel: number;
  keysLevel: number;
  droneLevel: number;
  bowlsLevel: number;
  plucksLevel: number;
  choirLevel: number;
  beatLevel: number;
  /** Melodic notes per minute ("Motion"), 0..40. */
  density: number;
  /** Overall brightness 0..1 (the inverse of "Warmth"). */
  brightness: number;
  /** Average seconds between chord changes. */
  chordSeconds: number;
  /** Detune between pad/choir oscillators in cents (0 = pure, 40+ = seasick). */
  detune: number;
  /** FM ratio for the keys: 2 = e-piano-ish, 3.5 = bell, odd values = clangy. */
  keysRatio: number;
  /** Keys register: octaves above the scale root for the middle of the range. */
  keysOctave: number;
  /** 0..1: how long the silences between phrases are. */
  breath: number;
  rhythm: Rhythm;
  /** BPM for the pulse grid and the beat. */
  tempo: number;
  /** Where the off-beat eighth lands: 0.5 straight, 0.66 triplet swing. */
  swing: number;
  /** 0 off, up to 0.35 a soft heartbeat pulse, above that a gentle lo-fi kit. */
  beat: number;
  /** Ring time of bowls and plucks (×). */
  ring: number;
  /** Octave shimmer on the reverb send, 0..1. */
  shimmer: number;
  /** Optional binaural beat level, 0..1 (headphones only). */
  binaural: number;
  /** Binaural beat frequency in Hz. */
  binauralHz: number;
  scale: ScaleSnap;
}

export interface MusicEvent {
  kind: 'note' | 'chord' | 'beat';
  /** Which instrument played a note. */
  voice?: MusicVoice;
  frame: number;
  /** Note frequency, the chord root for chord changes, 0 for beats. */
  hz: number;
  velocity: number;
  /** Scale step of the note or chord root; for beats, the drum (0 kick, 1 snare). */
  step: number;
}

export const DEFAULT_MUSIC_PARAMS: MusicParams = {
  padLevel: 1,
  keysLevel: 1,
  droneLevel: 0.8,
  bowlsLevel: 0.7,
  plucksLevel: 0.6,
  choirLevel: 0.4,
  beatLevel: 1,
  density: 8,
  brightness: 0.4,
  chordSeconds: 35,
  detune: 9,
  keysRatio: 2,
  keysOctave: 2,
  breath: 0.5,
  rhythm: 'free',
  tempo: 66,
  swing: 0.58,
  beat: 0,
  ring: 1,
  shimmer: 0.3,
  binaural: 0,
  binauralHz: 6,
  scale: { enabled: true, rootHz: 146.83, cents: [0, 300, 500, 700, 1000], periodCents: 1200 },
};

const PAD_VOICES = 3;
const KEYS_VOICES = 10;
const BLOCK_MAX = 1024;

interface Loop { base: number; pos: number; notes: { at: number; deg: number; vel: number }[] }
interface Player {
  voice: MusicVoice;
  /** Share of the melodic note rate. */
  rate: number;
  gated: boolean;
  nextIn: number;
  loops: Loop[];
  /** Base loop lengths in seconds (incommensurate on purpose). */
  loopSeconds: number[];
  /** Chord-relative scale degrees loops may hold (octave offsets added by register). */
  degrees: number[];
  register: () => number;
}

export class MusicSynth {
  frame = 0;
  private p: MusicParams = { ...DEFAULT_MUSIC_PARAMS };
  private readonly rng: Rng;
  private readonly rngKeys: Rng;
  private readonly rngComp: Rng;
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

  // Delay (keys and plucks)
  private readonly dl: Float32Array;
  private readonly dr: Float32Array;
  private dPos = 0;
  private readonly dMask: number;
  private dlLp = 0;
  private drLp = 0;

  // New voices
  private readonly drone: Drone;
  private readonly bowls: Bowls;
  private readonly plucks: Plucks;
  private readonly choir: Choir;
  private readonly beatKit: Beat;
  private readonly shimmerFx: Shimmer;
  private readonly vL = new Float32Array(BLOCK_MAX);
  private readonly vR = new Float32Array(BLOCK_MAX);
  private readonly pL = new Float32Array(BLOCK_MAX);
  private readonly pR = new Float32Array(BLOCK_MAX);
  private readonly bL = new Float32Array(BLOCK_MAX);
  private readonly bR = new Float32Array(BLOCK_MAX);

  // Composition
  private readonly players: Player[];
  private arpIdx = 0;
  private phrasePlaying = true;
  private phraseLeft = 0;
  private lastRhythm: Rhythm = 'free';

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
    this.rngComp = createRng(seed, 'music.composer');
    let size = 1;
    while (size < fs * 1.5) size <<= 1;
    this.dl = new Float32Array(size);
    this.dr = new Float32Array(size);
    this.dMask = size - 1;
    this.drone = new Drone(fs, createRng(seed, 'music.drone'));
    this.bowls = new Bowls(fs, createRng(seed, 'music.bowls'));
    this.plucks = new Plucks(fs, createRng(seed, 'music.plucks'));
    this.choir = new Choir(fs, createRng(seed, 'music.choir'));
    this.beatKit = new Beat(fs, createRng(seed, 'music.beat'));
    this.shimmerFx = new Shimmer(fs);
    const n = () => this.p.scale.cents.length;
    this.players = [
      { voice: 'keys', rate: 1, gated: true, nextIn: 0, loops: [], loopSeconds: [17.3, 21.1, 25.7], degrees: [0, 1, 2, 3, 4, 6], register: () => n() * this.p.keysOctave },
      { voice: 'pluck', rate: 1.3, gated: true, nextIn: 0, loops: [], loopSeconds: [13.9, 19.3, 23.5], degrees: [0, 2, 4, 7], register: () => n() * 2 },
      { voice: 'bowl', rate: 0.22, gated: false, nextIn: 0, loops: [], loopSeconds: [19.9, 27.1], degrees: [0, 4], register: () => n() },
    ];
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
    for (const pl of this.players) pl.nextIn = this.rngComp.range(1, 5) * fs;
    this.players[0].nextIn = this.rngKeys.range(1, 4) * fs;
    this.keysStep = this.p.scale.cents.length * this.p.keysOctave;
    this.phraseLeft = this.rngComp.range(5, 10) * fs;
    this.padLevelCur = this.p.padLevel;
  }

  get params(): Readonly<MusicParams> {
    return this.p;
  }

  setParams(patch: Partial<MusicParams>): void {
    const scaleChanged = patch.scale !== undefined;
    this.p = { ...this.p, ...patch, scale: { ...this.p.scale, ...(patch.scale ?? {}) } };
    this.drone.setScale(this.droneRoot(), this.p.scale.cents);
    // Re-voice the current chord in the new scale; the glide makes the change smooth.
    if (scaleChanged && this.padTarget.length) this.applyChord(false);
  }

  drainEvents(): MusicEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** The drone sits on the key's root, in the 55–110 Hz octave. */
  private droneRoot(): number {
    let f = this.p.scale.rootHz;
    while (f > 110) f /= 2;
    while (f < 55) f *= 2;
    return f;
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
    const steps = [this.chordStep, this.chordStep + 2, this.chordStep + 4];
    for (let v = 0; v < PAD_VOICES; v++) {
      const f = scaleStepHz(this.p.scale, steps[v]);
      this.padTarget[v] = f;
      if (snap || this.padFreq[v] === 0) this.padFreq[v] = f;
    }
    // The choir sings the same chord an octave up, opened out.
    this.choir.setChord([steps[0] + n, steps[1] + n, steps[2] + n].map((s) => scaleStepHz(this.p.scale, s)));
    this.events.push({ kind: 'chord', frame: this.frame, hz: this.padTarget[0], velocity: 1, step: this.chordStep });
  }

  private nextChord(): void {
    // Move by a small interval most of the time; sometimes further.
    const moves = [1, -1, 2, -2, 3, -3];
    const weights = [3, 3, 2, 2, 1, 1];
    this.chordStep += moves[this.rng.weightedIndex(weights)];
    this.applyChord(false);
  }

  private voiceLevel(v: MusicVoice): number {
    return v === 'keys' ? this.p.keysLevel : v === 'pluck' ? this.p.plucksLevel : this.p.bowlsLevel;
  }

  /** Notes per second for one player, including the slow breath. */
  private rateOf(pl: Player): number {
    const breath = Math.max(0, Math.min(1.3, 0.55 + 0.5 * this.breath));
    const base = (this.p.density / 60) * pl.rate;
    return pl.voice === 'bowl' ? Math.max(base, this.p.density > 0 ? 1 / 45 : 0) : base * breath;
  }

  // ---------------------------------------------------------------- note choice

  private keysWalk(): number {
    const rng = this.rngKeys;
    const n = this.p.scale.cents.length;
    const centre = n * this.p.keysOctave + Math.floor(n / 2);
    // Random walk that prefers small steps and is pulled back toward the centre of the range.
    const steps = [1, -1, 2, -2, 3, -3, 5, -5];
    const weights = [4, 4, 3, 3, 1.5, 1.5, 0.5, 0.5];
    let step = this.keysStep + steps[rng.weightedIndex(weights)];
    if (Math.abs(step - centre) > n * 1.2) step += step > centre ? -2 : 2;
    this.keysStep = step;
    return step;
  }

  private freeStep(pl: Player): number {
    if (pl.voice === 'keys') return this.keysWalk();
    if (pl.voice === 'pluck') {
      // Broken chords: mostly upward, sometimes turning back.
      const tones = [0, 2, 4, 7, 9];
      this.arpIdx += this.rngComp.chance(0.8) ? 1 : -1;
      const i = ((this.arpIdx % tones.length) + tones.length) % tones.length;
      return pl.register() + this.chordStep + tones[i];
    }
    return pl.register() + this.chordStep + (this.rngComp.chance(0.65) ? 0 : 4);
  }

  private play(pl: Player, step: number, velocity: number): void {
    const f = scaleStepHz(this.p.scale, step);
    if (f >= this.fs * 0.2) return;
    const ring = this.p.ring;
    if (pl.voice === 'keys') this.startKeys(f, velocity);
    else if (pl.voice === 'pluck') this.plucks.pluck(f, velocity, this.p.brightness, ring);
    else this.bowls.strike(f, velocity, ring);
    this.events.push({ kind: 'note', voice: pl.voice, frame: this.frame, hz: f, velocity, step });
  }

  private startKeys(f: number, velocity: number): void {
    const rng = this.rngKeys;
    const pan = rng.range(-0.6, 0.6);
    const decaySec = rng.range(1.8, 3.5) * this.p.ring;
    let v = -1;
    for (let i = 0; i < KEYS_VOICES; i++) if (!this.kActive[i]) { v = i; break; }
    if (v < 0) {
      // Steal the quietest voice.
      let min = Infinity;
      for (let i = 0; i < KEYS_VOICES; i++) if (this.kAmp[i] < min) { min = this.kAmp[i]; v = i; }
    }
    this.kActive[v] = 1;
    this.kFreq[v] = f;
    this.kPhaseC[v] = 0;
    this.kPhaseM[v] = 0;
    this.kAmp[v] = velocity * 0.22;
    this.kAmpMul[v] = Math.exp(-1 / (decaySec * this.fs));
    this.kIndex[v] = (0.6 + 1.6 * this.p.brightness) + velocity * 1.4;
    this.kIndexMul[v] = Math.exp(-1 / (0.35 * this.fs));
    this.kAttack[v] = 0;
    this.kPanL[v] = Math.cos(((pan + 1) * Math.PI) / 4);
    this.kPanR[v] = Math.sin(((pan + 1) * Math.PI) / 4);
    this.kRatio[v] = this.p.keysRatio;
  }

  // ---------------------------------------------------------------- timing

  /** Samples until the next swung eighth on the beat grid, at least `min` samples away. */
  private toGrid(min: number): number {
    const beatsPerSample = this.p.tempo / 60 / this.fs;
    const now = this.beatKit.position;
    const target = now + min * beatsPerSample;
    const straight = Math.ceil(target * 2 - 1e-9) / 2;
    const swingOffset = straight % 1 === 0.5 ? this.p.swing - 0.5 : 0;
    let at = straight + swingOffset;
    if (at < target) at += 0.5;
    return (at - now) / beatsPerSample;
  }

  private makeLoops(pl: Player): void {
    const rng = this.rngComp;
    pl.loops = pl.loopSeconds.map((base) => ({
      base,
      pos: rng.next(),
      notes: Array.from({ length: rng.chance(0.4) ? 2 : 1 }, () => ({ at: rng.next(), deg: rng.pick(pl.degrees), vel: rng.range(0.45, 0.9) })),
    }));
  }

  private runLoops(pl: Player, frames: number): void {
    if (pl.loops.length === 0) this.makeLoops(pl);
    // Denser music → shorter loops; more breath → longer ones (more silence per note).
    const stretch = (1 + 1.5 * this.p.breath) * Math.min(2, Math.max(0.4, 8 / Math.max(1, this.p.density * Math.max(0.5, pl.rate))));
    for (const loop of pl.loops) {
      const len = loop.base * stretch * this.fs;
      const before = loop.pos;
      loop.pos += frames / len;
      const wrapped = loop.pos >= 1;
      if (wrapped) loop.pos -= 1;
      for (const note of loop.notes) {
        const hit = wrapped ? note.at > before || note.at <= loop.pos : note.at > before && note.at <= loop.pos;
        if (hit) this.play(pl, pl.register() + this.chordStep + note.deg, note.vel);
      }
      // Loops slowly re-write themselves so the piece keeps evolving.
      if (wrapped && this.rngComp.chance(0.3)) {
        const note = this.rngComp.pick(loop.notes);
        note.deg = this.rngComp.pick(pl.degrees);
        note.at = this.rngComp.next();
      }
    }
  }

  private schedule(frames: number): void {
    const fs = this.fs;
    const p = this.p;
    if (p.rhythm !== this.lastRhythm) {
      for (const pl of this.players) { pl.loops = []; pl.nextIn = Math.min(pl.nextIn, 2 * fs); }
      this.lastRhythm = p.rhythm;
    }
    // Phrases and rests (free and pulse modes).
    this.phraseLeft -= frames;
    if (this.phraseLeft <= 0) {
      this.phrasePlaying = !this.phrasePlaying;
      const play = this.rngComp.range(4, 10);
      this.phraseLeft = (this.phrasePlaying ? play : play * (0.15 + 2.6 * p.breath)) * fs;
    }
    for (const pl of this.players) {
      if (this.voiceLevel(pl.voice) < 0.01 || p.density <= 0) continue;
      if (p.rhythm === 'loops') { this.runLoops(pl, frames); continue; }
      pl.nextIn -= frames;
      if (pl.nextIn > 0) continue;
      const rate = this.rateOf(pl);
      const rng = pl.voice === 'keys' ? this.rngKeys : this.rngComp;
      if (rate > 1e-4 && (!pl.gated || this.phrasePlaying)) this.play(pl, this.freeStep(pl), rng.range(0.35, 1));
      const gap = rate > 1e-4 ? rng.exponential(rate) * fs : 2 * fs;
      pl.nextIn = p.rhythm === 'pulse' ? this.toGrid(Math.max(gap, fs * 0.05)) : gap;
    }
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
    if (frames > BLOCK_MAX) {
      for (let i = 0; i < frames; i += BLOCK_MAX) {
        const k = Math.min(BLOCK_MAX, frames - i);
        this.process(outL.subarray(i, i + k), outR.subarray(i, i + k), sendL.subarray(i, i + k), sendR.subarray(i, i + k), k);
      }
      return;
    }
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
    this.schedule(frames);

    const glide = 1 - Math.exp(-1 / (4 * fs));
    const detuneRatio = Math.pow(2, p.detune / 1200);
    const lfoInc = (2 * Math.PI) / (23 * fs);
    const baseCut = 250 + 2600 * p.brightness * p.brightness;
    const padGainTarget = p.padLevel * (0.75 + 0.25 * Math.max(-1, Math.min(1, this.breath)));
    const levelSmooth = 1 - Math.exp(-1 / (0.5 * fs));
    const dA = Math.round(0.47 * fs);
    const dB = Math.round(0.71 * fs);
    const dLp = Math.exp((-2 * Math.PI * 3200) / fs);

    // Plucks go through the keys' delay too, so they render first.
    const pL = this.pL, pR = this.pR;
    pL.fill(0, 0, frames);
    pR.fill(0, 0, frames);
    this.plucks.process(pL, pR, frames, p.plucksLevel);

    for (let n = 0; n < frames; n++) {
      // ---- pad
      this.padLevelCur += (padGainTarget - this.padLevelCur) * levelSmooth;
      let pl = 0;
      let pr = 0;
      if (this.padLevelCur > 1e-5 || padGainTarget > 0) {
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
      } else {
        for (let v = 0; v < PAD_VOICES; v++) this.padFreq[v] += (this.padTarget[v] - this.padFreq[v]) * glide;
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
      kl = kl * p.keysLevel + pL[n];
      kr = kr * p.keysLevel + pR[n];

      // ---- ping-pong delay on keys and plucks
      const rA = this.dl[(this.dPos - dA) & this.dMask];
      const rB = this.dr[(this.dPos - dB) & this.dMask];
      this.dlLp = (1 - dLp) * rA + dLp * this.dlLp;
      this.drLp = (1 - dLp) * rB + dLp * this.drLp;
      this.dl[this.dPos & this.dMask] = kl + this.drLp * 0.38;
      this.dr[this.dPos & this.dMask] = kr + this.dlLp * 0.38;
      this.dPos++;

      outL[n] = padL + kl + this.dlLp * 0.3;
      outR[n] = padR + kr + this.drLp * 0.3;
      sendL[n] = padL * 0.8 + kl + this.dlLp * 0.3;
      sendR[n] = padR * 0.8 + kr + this.drLp * 0.3;
    }

    // ---- drone, bowls, choir: sustained voices, mostly into the space
    const vL = this.vL, vR = this.vR;
    vL.fill(0, 0, frames);
    vR.fill(0, 0, frames);
    this.drone.process(vL, vR, frames, p.droneLevel, p.binaural, p.binauralHz);
    this.bowls.process(vL, vR, frames, p.bowlsLevel);
    this.choir.process(vL, vR, frames, p.choirLevel, p.detune);
    // ---- beat: dry, a touch of room
    const bL = this.bL, bR = this.bR;
    bL.fill(0, 0, frames);
    bR.fill(0, 0, frames);
    this.beatKit.process(bL, bR, frames, p.beat, p.tempo, p.swing, p.brightness);
    for (const h of this.beatKit.hits) this.events.push({ kind: 'beat', frame: this.frame + h.offset, hz: 0, velocity: h.vel, step: h.kind });
    const bg = p.beatLevel;
    for (let n = 0; n < frames; n++) {
      outL[n] += vL[n] + bL[n] * bg;
      outR[n] += vR[n] + bR[n] * bg;
      sendL[n] += vL[n] * 0.9 + bL[n] * bg * 0.08;
      sendR[n] += vR[n] * 0.9 + bR[n] * bg * 0.08;
    }
    this.shimmerFx.process(sendL, sendR, frames, p.shimmer);

    if (!Number.isFinite(this.filtL[1]) || !Number.isFinite(this.dlLp) || !Number.isFinite(sendL[0])) this.resetState(outL, outR, sendL, sendR, frames);
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
