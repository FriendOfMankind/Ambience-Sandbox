/**
 * RainSynth: fully procedural rain, in three distance tiers.
 *
 *  - near: individual drops you could point at (a few to tens per second). Each one is
 *    reported as an event so visuals can draw a ripple at the same moment and place.
 *  - mid:  a dense cloud of simplified drops (hundreds to thousands per second).
 *  - far:  shaped noise; at a distance, drops blur into a wash.
 *
 * Each drop = impact (noise burst through a surface band-pass, optionally ringing surface
 * modes) + optionally a bubble (a damped sine at the Minnaert frequency with a small
 * upward glide, after van den Doel's liquid-sound model).
 *
 * Pure DSP with no Web Audio dependency, so it runs in an AudioWorklet, in Node tests,
 * or on the main thread for offline measurement. Deterministic for a given seed and
 * parameter timeline.
 */

import { createRng, type Rng } from '../../../core/rng';
import {
  dropAmplitude,
  dropFlux,
  minnaertFrequency,
  mpLambda,
  sampleDropDiameter,
  snapToScale,
} from './physics';
import type { ScaleSnap } from '../../music/scales';
import { ResonatorBank } from './ResonatorBank';
import { SURFACE_IDS, SURFACES, type SurfaceId } from './surfaces';

export type { ScaleSnap } from '../../music/scales';

export interface GridSnap {
  enabled: boolean;
  bpm: number;
  /** Steps per beat (4 = sixteenth notes). */
  division: number;
}

export interface RainParams {
  /** Rain rate in mm/h. ~0.5 drizzle, 5 steady, 25 heavy, 50+ downpour. Sandbox allows up to 500. */
  rate: number;
  /** Shifts the drop-size distribution; +1 ≈ drops twice as large. */
  sizeBias: number;
  surfaceMix: Record<SurfaceId, number>;
  nearLevel: number;
  midLevel: number;
  farLevel: number;
  /** Multipliers on the physically derived drop rates. */
  nearDensity: number;
  midDensity: number;
  /** Gustiness 0..1: rain arriving in sheets. */
  wind: number;
  /** Bubble pitch shift in octaves. */
  bubblePitch: number;
  /** Upward pitch glide per decay time constant (van den Doel's ξ; ~0.1 is natural). */
  bubbleGlide: number;
  /** Multiplies ring/decay times of bubbles and surface modes. 1 = natural. */
  stretch: number;
  scale: ScaleSnap;
  grid: GridSnap;
}

export interface RainEvent {
  /** Absolute sample frame at which the drop sounds. */
  frame: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  diameterMm: number;
  surface: SurfaceId;
  /** Bubble frequency in Hz, or 0 if the drop made no bubble. */
  bubbleHz: number;
}

export const DEFAULT_RAIN_PARAMS: RainParams = {
  rate: 5,
  sizeBias: 0,
  surfaceMix: { water: 0.6, leaves: 0.3, grass: 0.1, stone: 0.05, tin: 0, glass: 0, bells: 0 },
  nearLevel: 1,
  midLevel: 1,
  farLevel: 1,
  nearDensity: 1,
  midDensity: 1,
  wind: 0.3,
  bubblePitch: 0,
  bubbleGlide: 0.1,
  stretch: 1,
  scale: { enabled: false, rootHz: 146.83, cents: [0, 300, 500, 700, 1000], periodCents: 1200 },
  grid: { enabled: false, bpm: 72, division: 4 },
};

/**
 * Deep copy of params. (structuredClone isn't available in AudioWorkletGlobalScope.)
 */
export function cloneRainParams(p: RainParams): RainParams {
  return {
    ...p,
    surfaceMix: { ...p.surfaceMix },
    scale: { ...p.scale, cents: [...p.scale.cents] },
    grid: { ...p.grid },
  };
}

/** Areas (m²) whose drops make up each tier. Initial guesses; tune by listening. */
const NEAR_AREA = 0.003;
const MID_AREA = 0.15;
const MAX_NEAR_RATE = 250;
const MAX_MID_RATE = 6000;
const MAX_VOICES = 512;
/** Mid-tier drops may not take the whole pool; near drops (the ones you can see) always get voices. */
const MAX_MID_VOICES = 384;
const MAX_MODES = 4;
/** Voices are released once their envelope has decayed by ~60 dB (near) or ~40 dB (mid, which sits deeper in the mix). */
const LIFE_TAUS_NEAR = 7;
const LIFE_TAUS_MID = 4.6;
const MAX_LIFE_SECONDS = 30;

export class RainSynth {
  readonly sampleRate: number;
  /** Absolute sample position. */
  frame = 0;
  stats = { voices: 0, dropped: 0, nearRate: 0, midRate: 0 };

  private p: RainParams = cloneRainParams(DEFAULT_RAIN_PARAMS);
  private lambda = 1;
  private nearRate = 0;
  private midRate = 0;
  private surfaceWeights: number[] = [];

  private readonly rngNear: Rng;
  private readonly rngMid: Rng;
  private readonly rngFar: Rng;
  private readonly rngGust: Rng;

  private nextNearIn = 0;
  private nextMidIn = 0;
  private gust = 0;
  private gustMul = 1;
  /** When set, gusts come from the shared world wind instead of this synth's own random walk. */
  private externalGust: number | null = null;
  private events: RainEvent[] = [];
  /** Shared ringing objects for long-ringing surfaces, per tier. */
  private readonly banks: Partial<Record<SurfaceId, { near: ResonatorBank; mid: ResonatorBank }>> = {};

  // Far tier state
  private pinkL = new Float64Array(7);
  private pinkR = new Float64Array(7);
  private brownL = 0;
  private brownR = 0;
  private farLpL = 0;
  private farLpR = 0;
  private farHpL = 0;
  private farHpR = 0;
  private farHpXL = 0;
  private farHpXR = 0;
  private rumbleLpL = 0;
  private rumbleLpR = 0;
  private farLevelCur = 0;
  private rumbleLevelCur = 0;

  // Voice pool (structure of arrays)
  private readonly vActive = new Uint8Array(MAX_VOICES);
  /** 1 = near, 2 = mid */
  private readonly vTier = new Uint8Array(MAX_VOICES);
  private midVoices = 0;
  private readonly vStartIn = new Int32Array(MAX_VOICES);
  private readonly vLife = new Int32Array(MAX_VOICES);
  private readonly vGainL = new Float32Array(MAX_VOICES);
  private readonly vGainR = new Float32Array(MAX_VOICES);
  private readonly vLpA = new Float32Array(MAX_VOICES);
  private readonly vLpZ = new Float32Array(MAX_VOICES);
  // impact: noise burst -> SVF band-pass (Simper TPT form)
  private readonly vImpEnv = new Float32Array(MAX_VOICES);
  private readonly vImpMul = new Float32Array(MAX_VOICES);
  private readonly vA1 = new Float32Array(MAX_VOICES);
  private readonly vA2 = new Float32Array(MAX_VOICES);
  private readonly vA3 = new Float32Array(MAX_VOICES);
  private readonly vIc1 = new Float32Array(MAX_VOICES);
  private readonly vIc2 = new Float32Array(MAX_VOICES);
  // modes: damped sinusoids via two-pole recursion
  private readonly vModeCount = new Uint8Array(MAX_VOICES);
  private readonly mB1 = new Float32Array(MAX_VOICES * MAX_MODES);
  private readonly mB2 = new Float32Array(MAX_VOICES * MAX_MODES);
  private readonly mY1 = new Float32Array(MAX_VOICES * MAX_MODES);
  private readonly mY2 = new Float32Array(MAX_VOICES * MAX_MODES);
  // bubble
  private readonly vBubOn = new Uint8Array(MAX_VOICES);
  private readonly vBubStartIn = new Int32Array(MAX_VOICES);
  private readonly vBubAmp = new Float32Array(MAX_VOICES);
  private readonly vBubMul = new Float32Array(MAX_VOICES);
  private readonly vBubPhase = new Float64Array(MAX_VOICES);
  private readonly vBubFreq = new Float64Array(MAX_VOICES);
  private readonly vBubFreqInc = new Float64Array(MAX_VOICES);

  constructor(sampleRate: number, seed: string, params?: Partial<RainParams>) {
    this.sampleRate = sampleRate;
    this.rngNear = createRng(seed, 'rain.near');
    this.rngMid = createRng(seed, 'rain.mid');
    this.rngFar = createRng(seed, 'rain.far');
    this.rngGust = createRng(seed, 'rain.gust');
    const rngBank = createRng(seed, 'rain.bank');
    for (const id of SURFACE_IDS) {
      const surf = SURFACES[id];
      if (surf.bankSpreadOct === undefined || surf.modes.length === 0) continue;
      this.banks[id] = {
        near: new ResonatorBank(sampleRate, rngBank, surf, 8, 0.9, 14000),
        mid: new ResonatorBank(sampleRate, rngBank, surf, 6, 1, 5000),
      };
    }
    this.setParams(params ?? {});
    this.farLevelCur = this.targetFarLevel();
    this.rumbleLevelCur = this.targetRumbleLevel();
    this.nextNearIn = this.nextInterval(this.rngNear, this.nearRate);
    this.nextMidIn = this.nextInterval(this.rngMid, this.midRate);
  }

  get params(): Readonly<RainParams> {
    return this.p;
  }

  setParams(patch: Partial<RainParams>): void {
    this.p = {
      ...this.p,
      ...patch,
      surfaceMix: { ...this.p.surfaceMix, ...(patch.surfaceMix ?? {}) },
      scale: { ...this.p.scale, ...(patch.scale ?? {}) },
      grid: { ...this.p.grid, ...(patch.grid ?? {}) },
    };
    const p = this.p;
    this.lambda = mpLambda(p.rate, p.sizeBias);
    const flux = dropFlux(p.rate, p.sizeBias);
    this.nearRate = Math.min(MAX_NEAR_RATE, flux * NEAR_AREA * Math.max(0, p.nearDensity));
    this.midRate = Math.min(MAX_MID_RATE, flux * MID_AREA * Math.max(0, p.midDensity));
    this.surfaceWeights = SURFACE_IDS.map((id) => Math.max(0, p.surfaceMix[id] ?? 0));
    this.stats.nearRate = this.nearRate;
    this.stats.midRate = this.midRate;
    for (const bank of Object.values(this.banks)) {
      bank.near.configure(p.stretch, p.scale);
      bank.mid.configure(p.stretch, p.scale);
    }
  }

  /** Couple to a shared wind: pass the world's gust value (≈ unit-variance), or null to decouple. */
  setExternalGust(g: number | null): void {
    this.externalGust = g;
  }

  drainEvents(): RainEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Render `frames` samples, overwriting outL/outR. */
  process(outL: Float32Array, outR: Float32Array, frames = outL.length): void {
    outL.fill(0, 0, frames);
    outR.fill(0, 0, frames);
    this.updateGust(frames);
    this.spawnDrops(frames);
    this.renderVoices(outL, outR, frames);
    for (const bank of Object.values(this.banks)) {
      bank.near.process(outL, outR, frames, this.frame);
      bank.mid.process(outL, outR, frames, this.frame);
    }
    this.renderFar(outL, outR, frames);
    this.frame += frames;
  }

  // ---------------------------------------------------------------- scheduling

  private nextInterval(rng: Rng, rate: number): number {
    const r = rate * this.gustMul;
    if (r <= 1e-6) return Number.POSITIVE_INFINITY;
    return rng.exponential(r) * this.sampleRate;
  }

  private updateGust(frames: number): void {
    // Ornstein–Uhlenbeck process: wanders, pulled back to 0.
    const dt = frames / this.sampleRate;
    const theta = 0.35;
    const sigma = 0.7;
    const noise = this.rngGust.gaussian(); // always drawn, so the stream stays aligned either way
    if (this.externalGust !== null) this.gust = this.externalGust;
    else this.gust += -theta * this.gust * dt + sigma * Math.sqrt(dt) * noise;
    this.gustMul = Math.exp(this.p.wind * 0.9 * this.gust);
  }

  private spawnDrops(frames: number): void {
    while (this.nextNearIn < frames) {
      this.spawn('near', Math.floor(this.nextNearIn));
      this.nextNearIn += this.nextInterval(this.rngNear, this.nearRate);
    }
    this.nextNearIn -= frames;
    while (this.nextMidIn < frames) {
      this.spawn('mid', Math.floor(this.nextMidIn));
      this.nextMidIn += this.nextInterval(this.rngMid, this.midRate);
    }
    this.nextMidIn -= frames;
  }

  private findFreeVoice(): number {
    for (let i = 0; i < MAX_VOICES; i++) if (!this.vActive[i]) return i;
    return -1;
  }

  private spawn(tier: 'near' | 'mid', offset: number): void {
    const rng = tier === 'near' ? this.rngNear : this.rngMid;
    const p = this.p;
    const fs = this.sampleRate;

    // Always consume the same random numbers regardless of voice availability,
    // so the stream stays deterministic under load.
    const surfIdx = rng.weightedIndex(this.surfaceWeights);
    const d = sampleDropDiameter(rng, this.lambda);
    const pan = tier === 'near' ? rng.range(-0.9, 0.9) : rng.range(-1, 1);
    const cutoff = tier === 'near' ? rng.range(9000, 14000) : rng.range(2200, 7000);
    const jitters = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
    const bubbleRoll = rng.next();
    const bubbleRadiusMm = 0.25 + 0.4 * d * rng.next();
    const bubbleDelayMs = rng.range(1.5, 6) * Math.sqrt(d);
    const ampJitter = rng.range(0.75, 1.25);
    const objectRoll = rng.next();

    if (surfIdx < 0) return;
    const surface = SURFACES[SURFACE_IDS[surfIdx]];

    let startIn = offset;
    if (tier === 'near' && p.grid.enabled && p.grid.bpm > 0) {
      const step = (60 / p.grid.bpm / Math.max(1, p.grid.division)) * fs;
      const abs = this.frame + offset;
      startIn = Math.ceil(abs / step) * step - this.frame;
      startIn = Math.round(startIn);
    }

    const tierGain = tier === 'near' ? 0.55 * p.nearLevel : 0.1 * p.midLevel;
    const amp = dropAmplitude(d) * tierGain * ampJitter;

    // Bubble: most likely for ~1 mm drops (regular entrainment regime), sometimes otherwise.
    const bubbleP = surface.bubbleProb * (0.35 + 0.65 * Math.exp(-(((d - 1) / 0.45) ** 2)));
    const hasBubble = bubbleRoll < bubbleP;
    let bubbleHz = 0;
    if (hasBubble) {
      bubbleHz = minnaertFrequency(bubbleRadiusMm) * Math.pow(2, p.bubblePitch);
      if (p.scale.enabled) bubbleHz = snapToScale(bubbleHz, p.scale.rootHz, p.scale.cents, p.scale.periodCents);
      bubbleHz = Math.min(bubbleHz, fs * 0.45);
    }

    if (tier === 'near') {
      this.events.push({ frame: this.frame + startIn, pan, diameterMm: d, surface: surface.id, bubbleHz });
    }

    // Long-ringing surfaces: strike the shared bank (independent of voice availability).
    const bank = this.banks[surface.id];
    if (bank && amp > 1e-6) {
      const b = tier === 'near' ? bank.near : bank.mid;
      b.excite(this.frame + startIn, Math.min(b.objects - 1, Math.floor(objectRoll * b.objects)), amp);
    }

    const v = tier === 'mid' && this.midVoices >= MAX_MID_VOICES ? -1 : this.findFreeVoice();
    if (v < 0) {
      this.stats.dropped++;
      return;
    }
    if (amp <= 1e-6) return;

    this.vActive[v] = 1;
    this.vTier[v] = tier === 'near' ? 1 : 2;
    if (tier === 'mid') this.midVoices++;
    const lifeTaus = tier === 'near' ? LIFE_TAUS_NEAR : LIFE_TAUS_MID;
    const stretch = p.stretch;
    // Longer rings add up to more power; 1/√stretch keeps loudness roughly constant.
    const stretchNorm = 1 / Math.sqrt(Math.max(stretch, 1e-3));
    this.vStartIn[v] = startIn;
    const theta = ((pan + 1) * Math.PI) / 4;
    this.vGainL[v] = Math.cos(theta);
    this.vGainR[v] = Math.sin(theta);
    this.vLpA[v] = Math.exp((-2 * Math.PI * Math.min(cutoff, fs * 0.45)) / fs);
    this.vLpZ[v] = 0;

    // Impact: larger drops sound lower and last slightly longer.
    const impTau = (surface.impactDecayMs / 1000) * Math.pow(d / 2, 0.5);
    this.vImpEnv[v] = amp * surface.impactGain;
    this.vImpMul[v] = Math.exp(-1 / (impTau * fs));
    const fc = Math.min(surface.impactHz * Math.pow(2 / d, 0.3), fs * 0.45);
    const g = Math.tan((Math.PI * fc) / fs);
    const k = 1 / surface.impactQ;
    const a1 = 1 / (1 + g * (g + k));
    this.vA1[v] = a1;
    this.vA2[v] = g * a1;
    this.vA3[v] = g * g * a1;
    this.vIc1[v] = 0;
    this.vIc2[v] = 0;
    let lifeSec = impTau * lifeTaus;

    // Modes. Long-ringing surfaces strike a shared resonator bank instead of per-drop modes.
    // Otherwise distant drops only get their main resonance: cheaper, and inaudible in the wash anyway.
    const modes = bank ? [] : surface.modes;
    const nModes = Math.min(modes.length, tier === 'near' ? MAX_MODES : 1);
    this.vModeCount[v] = nModes;
    let modeRatio = 1;
    if (nModes > 0 && p.scale.enabled) {
      const f0 = modes[0].f * (1 + surface.modeJitter * jitters[0]);
      modeRatio = snapToScale(f0, p.scale.rootHz, p.scale.cents, p.scale.periodCents) / f0;
    }
    for (let m = 0; m < nModes; m++) {
      const mode = modes[m];
      const f = Math.min(mode.f * (1 + surface.modeJitter * jitters[m]) * modeRatio, fs * 0.45);
      const tau = (mode.tauMs / 1000) * stretch;
      const r = Math.exp(-1 / (tau * fs));
      const w = (2 * Math.PI * f) / fs;
      const idx = v * MAX_MODES + m;
      this.mB1[idx] = 2 * r * Math.cos(w);
      this.mB2[idx] = -r * r;
      // Damped sine a·rⁿ·sin(wn), starting at zero phase (click-free).
      this.mY2[idx] = 0;
      this.mY1[idx] = amp * mode.amp * stretchNorm * r * Math.sin(w);
      lifeSec = Math.max(lifeSec, tau * lifeTaus);
    }

    // Bubble
    this.vBubOn[v] = hasBubble ? 1 : 0;
    if (hasBubble) {
      // Decay is an initial guess (not from the paper): small (high) bubbles ring briefly, larger ones a little longer.
      const tau = 0.006 * Math.sqrt(3000 / bubbleHz) * stretch;
      this.vBubStartIn[v] = startIn + Math.round((bubbleDelayMs / 1000) * fs);
      this.vBubAmp[v] = amp * 0.8 * stretchNorm;
      this.vBubMul[v] = Math.exp(-1 / (tau * fs));
      this.vBubPhase[v] = 0;
      this.vBubFreq[v] = bubbleHz;
      // f(t) = f0·(1 + ξ·t/τ)
      this.vBubFreqInc[v] = (bubbleHz * p.bubbleGlide) / (tau * fs);
      lifeSec = Math.max(lifeSec, bubbleDelayMs / 1000 + tau * lifeTaus);
    }

    this.vLife[v] = startIn + Math.round(Math.min(lifeSec, MAX_LIFE_SECONDS) * fs);
  }

  // ----------------------------------------------------------------- rendering

  private renderVoices(outL: Float32Array, outR: Float32Array, frames: number): void {
    const fs = this.sampleRate;
    const nyq = fs * 0.45;
    const twoPiOverFs = (2 * Math.PI) / fs;
    const rng = this.rngMid;
    let active = 0;

    for (let v = 0; v < MAX_VOICES; v++) {
      if (!this.vActive[v]) continue;
      active++;

      let startIn = this.vStartIn[v];
      let life = this.vLife[v];
      const gL = this.vGainL[v];
      const gR = this.vGainR[v];
      const lpA = this.vLpA[v];
      let lpZ = this.vLpZ[v];
      let impEnv = this.vImpEnv[v];
      const impMul = this.vImpMul[v];
      const a1 = this.vA1[v];
      const a2 = this.vA2[v];
      const a3 = this.vA3[v];
      let ic1 = this.vIc1[v];
      let ic2 = this.vIc2[v];
      const nModes = this.vModeCount[v];
      const bubOn = this.vBubOn[v];
      let bubStartIn = this.vBubStartIn[v];
      let bubAmp = this.vBubAmp[v];
      const bubMul = this.vBubMul[v];
      let bubPhase = this.vBubPhase[v];
      let bubFreq = this.vBubFreq[v];
      const bubFreqInc = this.vBubFreqInc[v];
      const mBase = v * MAX_MODES;

      for (let n = 0; n < frames; n++) {
        if (startIn > 0) {
          startIn--;
          bubStartIn--;
          life--;
          continue;
        }
        let x = 0;

        if (impEnv > 1e-7) {
          const noise = rng.next() * 2 - 1;
          const v0 = noise * impEnv;
          impEnv *= impMul;
          const v3 = v0 - ic2;
          const v1 = a1 * ic1 + a2 * v3;
          const v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1;
          ic2 = 2 * v2 - ic2;
          x += v1;
        }

        for (let m = 0; m < nModes; m++) {
          const i = mBase + m;
          const y = this.mB1[i] * this.mY1[i] + this.mB2[i] * this.mY2[i];
          this.mY2[i] = this.mY1[i];
          this.mY1[i] = y;
          x += y;
        }

        if (bubOn) {
          if (bubStartIn > 0) {
            bubStartIn--;
          } else if (bubAmp > 1e-7) {
            x += bubAmp * Math.sin(bubPhase);
            bubPhase += twoPiOverFs * bubFreq;
            if (bubFreq < nyq) bubFreq += bubFreqInc;
            bubAmp *= bubMul;
          }
        }

        lpZ = (1 - lpA) * x + lpA * lpZ;
        outL[n] += lpZ * gL;
        outR[n] += lpZ * gR;
        life--;
      }

      if (life <= 0 || !Number.isFinite(lpZ)) {
        this.vActive[v] = 0;
        if (this.vTier[v] === 2) this.midVoices--;
        continue;
      }
      this.vStartIn[v] = startIn;
      this.vLife[v] = life;
      this.vLpZ[v] = lpZ;
      this.vImpEnv[v] = impEnv;
      this.vIc1[v] = ic1;
      this.vIc2[v] = ic2;
      this.vBubStartIn[v] = bubStartIn;
      this.vBubAmp[v] = bubAmp;
      this.vBubPhase[v] = bubPhase % (2 * Math.PI);
      this.vBubFreq[v] = bubFreq;
    }
    this.stats.voices = active;
  }

  private targetFarLevel(): number {
    const r = Math.min(this.p.rate, 200);
    return this.p.farLevel * 0.3 * Math.sqrt(r / 50);
  }

  private targetRumbleLevel(): number {
    const x = Math.min(Math.max((this.p.rate - 8) / 40, 0), 1);
    return this.p.farLevel * 0.5 * x;
  }

  private renderFar(outL: Float32Array, outR: Float32Array, frames: number): void {
    const fs = this.sampleRate;
    const rng = this.rngFar;
    const gustAmp = Math.sqrt(this.gustMul);
    const targetFar = this.targetFarLevel() * gustAmp;
    const targetRumble = this.targetRumbleLevel() * gustAmp;
    if (targetFar < 1e-6 && this.farLevelCur < 1e-6 && targetRumble < 1e-6 && this.rumbleLevelCur < 1e-6) {
      this.farLevelCur = 0;
      this.rumbleLevelCur = 0;
      return;
    }
    // Brighter wash for heavier rain.
    const brightness = Math.min(Math.log10(1 + this.p.rate) / 2, 1);
    const fc = 1200 + 3000 * brightness;
    const lpA = Math.exp((-2 * Math.PI * fc) / fs);
    const hpA = Math.exp((-2 * Math.PI * 120) / fs);
    const rumA = Math.exp((-2 * Math.PI * 180) / fs);
    // Per-sample smoothing towards the block target (~50 ms).
    const smooth = 1 - Math.exp(-1 / (0.05 * fs));

    const pl = this.pinkL;
    const pr = this.pinkR;
    let farLevel = this.farLevelCur;
    let rumbleLevel = this.rumbleLevelCur;

    for (let n = 0; n < frames; n++) {
      farLevel += (targetFar - farLevel) * smooth;
      rumbleLevel += (targetRumble - rumbleLevel) * smooth;
      const wl = rng.next() * 2 - 1;
      const wr = rng.next() * 2 - 1;
      const pinkLv = pink(pl, wl);
      const pinkRv = pink(pr, wr);

      this.farLpL = (1 - lpA) * pinkLv + lpA * this.farLpL;
      this.farLpR = (1 - lpA) * pinkRv + lpA * this.farLpR;
      // One-pole high-pass: y = a·(y + x − x_prev)
      this.farHpL = hpA * (this.farHpL + this.farLpL - this.farHpXL);
      this.farHpXL = this.farLpL;
      this.farHpR = hpA * (this.farHpR + this.farLpR - this.farHpXR);
      this.farHpXR = this.farLpR;

      this.brownL = (this.brownL + 0.02 * wl) / 1.02;
      this.brownR = (this.brownR + 0.02 * wr) / 1.02;
      this.rumbleLpL = (1 - rumA) * this.brownL + rumA * this.rumbleLpL;
      this.rumbleLpR = (1 - rumA) * this.brownR + rumA * this.rumbleLpR;

      outL[n] += this.farHpL * farLevel + this.rumbleLpL * 3.5 * rumbleLevel;
      outR[n] += this.farHpR * farLevel + this.rumbleLpR * 3.5 * rumbleLevel;
    }
    this.farLevelCur = farLevel;
    this.rumbleLevelCur = rumbleLevel;
  }
}

/** Paul Kellet's refined pink-noise filter. State: 7 values. */
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
