/**
 * FireSynth: a wood fire, fully procedural, after Farnell's fire model (Designing Sound):
 *
 * - roar:     low-passed noise "lapping", breathing on slow random swells; gusts fan it
 * - hiss:     band-passed noise flickering in the flames (gas escaping)
 * - crackles: many tiny impulses ringing through short resonances (1.5–7 kHz), often in
 *             little clusters, like sap cells bursting
 * - pops:     occasional louder, lower snaps (a knot giving way) with a soft thump
 * - sizzle:   when it rains, drops hissing on the embers
 *
 * Pops (and the strongest crackles) are reported as events for the visuals.
 * Deterministic for a seed; constants are initial guesses awaiting listening tests.
 */

import { createRng, type Rng } from '../../../core/rng';
import { Biquad } from '../../music/voices';

export interface FireParams {
  /** Size and intensity: embers 0 → roaring hearth 1. */
  amount: number;
  /** How busy the crackling is, 0..1. */
  crackle: number;
  /** Level of the low flame roar, 0..1. */
  roar: number;
  /** Brightness shift in octaves (−1..1). */
  tone: number;
}

export interface FireEvent {
  frame: number;
  /** 0 crackle, 1 pop. */
  kind: 0 | 1;
  velocity: number;
  /** −1 left … 1 right. */
  pan: number;
}

export const DEFAULT_FIRE_PARAMS: FireParams = { amount: 0.5, crackle: 0.5, roar: 0.5, tone: 0 };

const VOICES = 20;

export class FireSynth {
  frame = 0;
  private p: FireParams = { ...DEFAULT_FIRE_PARAMS };
  private readonly rng: Rng;
  private events: FireEvent[] = [];
  private wind = 0;
  private gust = 0;
  private rain = 0;

  // roar and hiss
  private lpL = [0, 0];
  private lpR = [0, 0];
  private swell = 0;
  private swellSlow = 0;
  private flicker = 0;
  private readonly hissL = new Biquad();
  private readonly hissR = new Biquad();
  private readonly sizzle = new Biquad();
  private sizzleEnv = 0;

  // crackle / pop voices
  private readonly active = new Uint8Array(VOICES);
  private readonly env = new Float64Array(VOICES);
  private readonly envMul = new Float64Array(VOICES);
  private readonly gain = new Float64Array(VOICES);
  private readonly panL = new Float64Array(VOICES);
  private readonly panR = new Float64Array(VOICES);
  private readonly thump = new Float64Array(VOICES);
  private readonly thumpPh = new Float64Array(VOICES);
  private readonly bq: Biquad[] = Array.from({ length: VOICES }, () => new Biquad());
  private nextCrackle = 0;
  private nextPop = 0;
  private cluster = 0;

  constructor(private readonly fs: number, seed: string, params?: Partial<FireParams>) {
    this.rng = createRng(seed, 'fire');
    this.setParams(params ?? {});
    this.nextCrackle = this.rng.range(0.05, 0.4) * fs;
    this.nextPop = this.rng.range(1, 4) * fs;
  }

  get params(): Readonly<FireParams> {
    return this.p;
  }

  setParams(patch: Partial<FireParams>): void {
    this.p = { ...this.p, ...patch };
    const t = Math.pow(2, Math.max(-1, Math.min(1, this.p.tone)));
    this.hissL.bandpass(this.fs, Math.min(this.fs * 0.4, 3800 * t), 2600 * t);
    this.hissR.bandpass(this.fs, Math.min(this.fs * 0.4, 4300 * t), 2800 * t);
    this.sizzle.bandpass(this.fs, Math.min(this.fs * 0.4, 6500 * t), 3500 * t);
  }

  /** Wind fans the flames (more roar, more crackle in gusts). */
  setWind(speed: number, gust: number): void {
    this.wind = speed;
    this.gust = gust;
  }

  /** Rain rate in mm/h: drops sizzle on the embers. */
  setRain(rate: number): void {
    this.rain = rate;
  }

  drainEvents(): FireEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private start(kind: 0 | 1, velocity: number, offset: number): void {
    let v = -1;
    for (let i = 0; i < VOICES; i++) if (!this.active[i]) { v = i; break; }
    if (v < 0) {
      let min = Infinity;
      for (let i = 0; i < VOICES; i++) if (this.env[i] * this.gain[i] < min) { min = this.env[i] * this.gain[i]; v = i; }
    }
    const rng = this.rng;
    const fs = this.fs;
    const t = Math.pow(2, Math.max(-1, Math.min(1, this.p.tone)));
    if (kind === 0) {
      // A crackle: a sub-millisecond-to-few-ms burst ringing in a short high resonance.
      const fc = Math.min(fs * 0.42, rng.range(1500, 7000) * t);
      this.bq[v].bandpass(fs, fc, fc / rng.range(3, 8));
      this.envMul[v] = Math.exp(-1 / (rng.range(0.0005, 0.004) * fs));
      this.gain[v] = velocity * 1.6;
      this.thump[v] = 0;
    } else {
      // A pop: lower, longer, with a soft low thump under it.
      const fc = Math.min(fs * 0.42, rng.range(400, 1800) * t);
      this.bq[v].bandpass(fs, fc, fc / rng.range(2, 4));
      this.envMul[v] = Math.exp(-1 / (rng.range(0.006, 0.016) * fs));
      this.gain[v] = velocity * 2.4;
      this.thump[v] = velocity * 0.35;
      this.thumpPh[v] = 0;
    }
    this.bq[v].reset();
    this.env[v] = 1;
    const pan = rng.range(-0.5, 0.5);
    this.panL[v] = Math.cos(((pan + 1) * Math.PI) / 4);
    this.panR[v] = Math.sin(((pan + 1) * Math.PI) / 4);
    this.active[v] = 1;
    if (kind === 1 || velocity > 0.8) this.events.push({ frame: this.frame + offset, kind, velocity, pan });
  }

  /** Render one block into outL/outR (overwrites). */
  process(outL: Float32Array, outR: Float32Array, frames = outL.length): void {
    const fs = this.fs;
    const rng = this.rng;
    const p = this.p;
    const dt = frames / fs;
    const amount = Math.max(0, Math.min(1, p.amount));
    // Gusts fan the flames, up to +60% (capped so a gale doesn't turn it into a blowtorch).
    const fan = 1 + 0.4 * Math.min(1.5, Math.max(0, this.gust)) * Math.min(1, this.wind);
    // Slow "breathing" of the flames (two random processes) and a faster flicker.
    this.swell += -0.8 * this.swell * dt + 0.9 * Math.sqrt(dt) * rng.gaussian();
    this.swellSlow += -0.08 * this.swellSlow * dt + 0.25 * Math.sqrt(dt) * rng.gaussian();
    const breath = Math.min(2, Math.max(0.15, 1 + 0.35 * this.swell + 0.25 * this.swellSlow)) * fan;
    const tone = Math.pow(2, Math.max(-1, Math.min(1, p.tone)));
    const roarCut = Math.min(fs * 0.2, (140 + 380 * amount) * tone * (0.8 + 0.3 * breath));
    const c = Math.exp((-2 * Math.PI * roarCut) / fs);
    const roarGain = p.roar * (0.25 + 0.75 * amount) * breath * 0.55;
    const hissGain = (0.15 + 0.5 * amount) * 0.05;
    const wet = Math.min(1, this.rain / 15);
    const sizzleGain = wet * (0.3 + 0.7 * amount) * 0.12;

    // Crackle and pop scheduling (clusters: a crackle often brings a few quick neighbours).
    const crackleRate = (2 + 30 * p.crackle * (0.3 + 0.7 * amount)) * fan * (1 - 0.3 * wet);
    const popRate = (0.08 + 1.1 * p.crackle * amount) * fan;
    const starts: { at: number; kind: 0 | 1; vel: number }[] = [];
    this.nextCrackle -= frames;
    while (this.nextCrackle < 0) {
      const at = Math.max(0, frames + Math.floor(this.nextCrackle));
      starts.push({ at, kind: 0, vel: Math.pow(rng.next(), 2.5) * (0.4 + 0.6 * amount) });
      if (this.cluster > 0) { this.cluster--; this.nextCrackle += rng.range(0.004, 0.04) * fs; }
      else {
        if (rng.chance(0.35)) this.cluster = rng.int(1, 4);
        this.nextCrackle += rng.exponential(crackleRate) * fs;
      }
    }
    this.nextPop -= frames;
    while (this.nextPop < 0) {
      starts.push({ at: Math.max(0, frames + Math.floor(this.nextPop)), kind: 1, vel: rng.range(0.4, 1) * (0.5 + 0.5 * amount) });
      this.nextPop += rng.exponential(popRate) * fs;
    }
    starts.sort((a, b) => a.at - b.at);
    let si = 0;

    for (let n = 0; n < frames; n++) {
      while (si < starts.length && starts[si].at <= n) { const s = starts[si++]; this.start(s.kind, s.vel, n); }
      // roar: two-pole low-pass of independent noise per side
      const nl = rng.next() * 2 - 1;
      const nr = rng.next() * 2 - 1;
      this.lpL[0] = (1 - c) * nl + c * this.lpL[0];
      this.lpL[1] = (1 - c) * this.lpL[0] + c * this.lpL[1];
      this.lpR[0] = (1 - c) * nr + c * this.lpR[0];
      this.lpR[1] = (1 - c) * this.lpR[0] + c * this.lpR[1];
      // hiss flickers fast
      this.flicker += (rng.next() - this.flicker) * 0.0008;
      const fl = this.flicker * this.flicker * 4;
      let l = this.lpL[1] * roarGain * 6 + this.hissL.run(nl) * hissGain * fl;
      let r = this.lpR[1] * roarGain * 6 + this.hissR.run(nr) * hissGain * fl;
      // rain sizzle: occasional swells of hiss
      if (sizzleGain > 0) {
        if (rng.next() < (wet * 6) / fs) this.sizzleEnv = rng.range(0.4, 1);
        this.sizzleEnv *= 0.99992;
        const sz = this.sizzle.run(rng.next() * 2 - 1) * this.sizzleEnv * sizzleGain;
        l += sz;
        r += sz;
      }
      // crackles and pops
      for (let v = 0; v < VOICES; v++) {
        if (!this.active[v]) continue;
        const ex = (rng.next() * 2 - 1) * this.env[v];
        let y = this.bq[v].run(ex) * this.gain[v];
        if (this.thump[v] > 0) {
          this.thumpPh[v] += (2 * Math.PI * 90) / fs;
          y += Math.sin(this.thumpPh[v]) * this.thump[v] * this.env[v];
        }
        this.env[v] *= this.envMul[v];
        if (this.env[v] < 1e-4) this.active[v] = 0;
        l += y * this.panL[v];
        r += y * this.panR[v];
      }
      outL[n] = l * 0.3;
      outR[n] = r * 0.3;
    }
    if (!Number.isFinite(this.lpL[1])) { this.lpL = [0, 0]; this.lpR = [0, 0]; this.active.fill(0); outL.fill(0, 0, frames); outR.fill(0, 0, frames); }
    this.frame += frames;
  }
}
