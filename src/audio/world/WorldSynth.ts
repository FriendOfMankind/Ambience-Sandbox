/**
 * WorldSynth: every layer of one world, rendered together so they can share state.
 *
 *   wind ──gust/speed──▶ rain (sheets of rain follow gusts)
 *        └────────────▶ chimes (the clapper swings with the wind)
 *   scale ────────────▶ rain-in-key, chimes, music
 *   chimes + music + a little rain ──▶ shared reverb (one space)
 *
 * Each layer has an on/off and level, smoothed so nothing clicks. The wind keeps blowing
 * (and keeps playing the chimes) even when the wind *sound* is switched off.
 *
 * Besides audio, it reports what happened (drops, chime strikes, notes, chord changes) and
 * per-layer levels, so visuals can respond to each sound separately rather than to one
 * mixed waveform.
 */

import { ChimeSynth, DEFAULT_CHIME_PARAMS, type ChimeEvent, type ChimeParams } from '../nature/chimes/ChimeSynth';
import { DEFAULT_RAIN_PARAMS, RainSynth, type RainEvent, type RainParams } from '../nature/rain/RainSynth';
import { DEFAULT_WIND_PARAMS, WindSynth, type WindParams } from '../nature/wind/WindSynth';
import { DEFAULT_FIRE_PARAMS, FireSynth, type FireEvent, type FireParams } from '../nature/fire/FireSynth';
import { DEFAULT_MUSIC_PARAMS, MusicSynth, type MusicEvent, type MusicParams } from '../music/MusicSynth';
import type { ScaleSnap } from '../music/scales';
import { DEFAULT_REVERB_PARAMS, Reverb, type ReverbParams } from '../dsp/Reverb';
import { Biquad } from '../music/voices';

export const LAYERS = ['rain', 'wind', 'chimes', 'fire', 'music'] as const;
export type LayerId = (typeof LAYERS)[number];

export interface LayerMix {
  on: boolean;
  /** Linear gain, 0..2. */
  level: number;
  /** Reverb send, 0..1. */
  send: number;
}

/** How music and ambience share the mix. */
export interface BusParams {
  /** 0 = ambience only … 0.5 = both at full … 1 = music only. */
  blend: number;
  /** 0..1: how far the ambience steps aside (a mid-range dip and slight duck) while music plays. */
  support: number;
}

export interface WorldParams {
  mix: Record<LayerId, LayerMix>;
  bus: BusParams;
  scale: ScaleSnap;
  rain: Partial<RainParams>;
  wind: Partial<WindParams>;
  chimes: Partial<ChimeParams>;
  fire: Partial<FireParams>;
  music: Partial<MusicParams>;
  reverb: Partial<ReverbParams>;
}

export interface WorldParamsPatch {
  mix?: Partial<Record<LayerId, Partial<LayerMix>>>;
  bus?: Partial<BusParams>;
  scale?: ScaleSnap;
  rain?: Partial<RainParams>;
  wind?: Partial<WindParams>;
  chimes?: Partial<ChimeParams>;
  fire?: Partial<FireParams>;
  music?: Partial<MusicParams>;
  reverb?: Partial<ReverbParams>;
}

export interface WorldFeatures {
  /** Smoothed output level per layer (linear RMS after the layer's gain). */
  level: Record<LayerId, number>;
  windSpeed: number;
  gust: number;
  /** Current chord root as a scale step. */
  chordStep: number;
}

export interface WorldEvents {
  rain: RainEvent[];
  chimes: ChimeEvent[];
  fire: FireEvent[];
  music: MusicEvent[];
}

export const DEFAULT_WORLD_PARAMS: WorldParams = {
  mix: {
    rain: { on: true, level: 1.4, send: 0.08 },
    wind: { on: true, level: 0.5, send: 0 },
    chimes: { on: true, level: 0.9, send: 0.35 },
    // Fire is opt-in.
    fire: { on: false, level: 0.8, send: 0.12 },
    music: { on: true, level: 0.6, send: 0.45 },
  },
  bus: { blend: 0.5, support: 0.6 },
  scale: DEFAULT_MUSIC_PARAMS.scale,
  rain: {},
  wind: {},
  chimes: {},
  fire: {},
  music: {},
  reverb: {},
};

const BLOCK_MAX = 1024;

export class WorldSynth {
  frame = 0;
  readonly rain: RainSynth;
  readonly wind: WindSynth;
  readonly chimes: ChimeSynth;
  readonly fire: FireSynth;
  readonly music: MusicSynth;
  readonly reverb: Reverb;
  private p: WorldParams;
  private readonly gainCur: Record<LayerId, number> = { rain: 0, wind: 0, chimes: 0, fire: 0, music: 0 };
  private readonly levelCur: Record<LayerId, number> = { rain: 0, wind: 0, chimes: 0, fire: 0, music: 0 };
  private chordStep = 0;
  private musicTrim = 1;
  private ambTrim = 1;
  private presence = 0;
  private readonly carveL = new Biquad();
  private readonly carveR = new Biquad();
  private events: WorldEvents = { rain: [], chimes: [], fire: [], music: [] };

  private readonly buf = {
    rainL: new Float32Array(BLOCK_MAX), rainR: new Float32Array(BLOCK_MAX),
    windL: new Float32Array(BLOCK_MAX), windR: new Float32Array(BLOCK_MAX),
    chimeL: new Float32Array(BLOCK_MAX), chimeR: new Float32Array(BLOCK_MAX),
    fireL: new Float32Array(BLOCK_MAX), fireR: new Float32Array(BLOCK_MAX),
    musicL: new Float32Array(BLOCK_MAX), musicR: new Float32Array(BLOCK_MAX),
    mSendL: new Float32Array(BLOCK_MAX), mSendR: new Float32Array(BLOCK_MAX),
    sendL: new Float32Array(BLOCK_MAX), sendR: new Float32Array(BLOCK_MAX),
    revL: new Float32Array(BLOCK_MAX), revR: new Float32Array(BLOCK_MAX),
  };

  constructor(
    private readonly fs: number,
    seed: string,
    params?: WorldParamsPatch,
  ) {
    this.p = mergeWorld(DEFAULT_WORLD_PARAMS, params ?? {});
    const scale = this.p.scale;
    this.rain = new RainSynth(fs, seed, { ...DEFAULT_RAIN_PARAMS, ...this.p.rain, scale: this.p.rain.scale ?? { ...scale, enabled: false } });
    this.wind = new WindSynth(fs, seed, { ...DEFAULT_WIND_PARAMS, ...this.p.wind });
    this.chimes = new ChimeSynth(fs, seed, { ...DEFAULT_CHIME_PARAMS, ...this.p.chimes, scale });
    this.fire = new FireSynth(fs, seed, { ...DEFAULT_FIRE_PARAMS, ...this.p.fire });
    this.music = new MusicSynth(fs, seed, { ...DEFAULT_MUSIC_PARAMS, ...this.p.music, scale });
    this.reverb = new Reverb(fs, { ...DEFAULT_REVERB_PARAMS, ...this.p.reverb });
    this.rain.setExternalGust(0);
    for (const id of LAYERS) this.gainCur[id] = this.targetGain(id);
  }

  get params(): Readonly<WorldParams> {
    return this.p;
  }

  setParams(patch: WorldParamsPatch): void {
    this.p = mergeWorld(this.p, patch);
    if (patch.scale) {
      // Rain follows the key only when "rain in key" is on; keep its enabled flag.
      const rainScale = { ...patch.scale, enabled: this.rain.params.scale.enabled };
      this.rain.setParams({ scale: rainScale });
      this.chimes.setParams({ scale: patch.scale });
      this.music.setParams({ scale: patch.scale });
    }
    if (patch.rain) {
      const r = { ...patch.rain };
      // "Rain in key" toggles use the world's scale.
      if (r.scale) r.scale = { ...this.p.scale, enabled: r.scale.enabled };
      this.rain.setParams(r);
    }
    if (patch.wind) this.wind.setParams(patch.wind);
    // The world owns the scale; per-layer scale fields are ignored.
    if (patch.chimes) this.chimes.setParams(withoutScale(patch.chimes));
    if (patch.music) this.music.setParams(withoutScale(patch.music));
    if (patch.fire) this.fire.setParams(patch.fire);
    if (patch.reverb) this.reverb.setParams(patch.reverb);
  }

  drainEvents(): WorldEvents {
    const e = this.events;
    this.events = { rain: [], chimes: [], fire: [], music: [] };
    return e;
  }

  features(): WorldFeatures {
    return {
      level: { ...this.levelCur },
      windSpeed: this.wind.speed,
      gust: this.wind.gust,
      chordStep: this.chordStep,
    };
  }

  private targetGain(id: LayerId): number {
    const m = this.p.mix[id];
    return m.on ? Math.max(0, Math.min(2, m.level)) : 0;
  }

  /** Render one block (≤ 1024 frames) into outL/outR (overwrites). */
  process(outL: Float32Array, outR: Float32Array, frames = outL.length): void {
    if (frames > BLOCK_MAX) {
      for (let i = 0; i < frames; i += BLOCK_MAX) {
        const n = Math.min(BLOCK_MAX, frames - i);
        this.process(outL.subarray(i, i + n), outR.subarray(i, i + n), n);
      }
      return;
    }
    const b = this.buf;
    const fs = this.fs;

    // 1. Wind first: it sets the gust for everyone else.
    this.wind.process(b.windL, b.windR, frames);
    this.rain.setExternalGust(this.wind.gust);
    const rainWind = Math.min(1, 0.3 + this.wind.params.amount);
    if (rainWind !== this.rain.params.wind) this.rain.setParams({ wind: rainWind });
    this.chimes.setWindSpeed(this.wind.speed);

    // 2. The rest.
    this.rain.process(b.rainL, b.rainR, frames);
    this.chimes.process(b.chimeL, b.chimeR, frames);
    // Fire: fanned by the gusts, sizzling when it rains.
    this.fire.setWind(this.wind.speed, this.wind.gust);
    this.fire.setRain(this.p.mix.rain.on ? this.rain.params.rate : 0);
    this.fire.process(b.fireL, b.fireR, frames);
    this.music.process(b.musicL, b.musicR, b.mSendL, b.mSendR, frames);

    // 3. Mix with smoothed gains; build the reverb send.
    const smooth = 1 - Math.exp(-1 / (0.15 * fs));
    const t = { rain: this.targetGain('rain'), wind: this.targetGain('wind'), chimes: this.targetGain('chimes'), fire: this.targetGain('fire'), music: this.targetGain('music') };
    const sRain = this.p.mix.rain.send;
    const sWind = this.p.mix.wind.send;
    const sChime = this.p.mix.chimes.send;
    const sFire = this.p.mix.fire.send;
    const sMusic = this.p.mix.music.send;
    const sq = { rain: 0, wind: 0, chimes: 0, fire: 0, music: 0 };
    let gR = this.gainCur.rain, gW = this.gainCur.wind, gC = this.gainCur.chimes, gF = this.gainCur.fire, gM = this.gainCur.music;

    // Blend and support: music and ambience trims, and a presence-driven dip in the ambience.
    const blend = Math.max(0, Math.min(1, this.p.bus.blend));
    const kb = 1 - Math.exp(-frames / (0.2 * fs));
    this.musicTrim += ((blend < 0.5 ? blend * 2 : 1) - this.musicTrim) * kb;
    this.ambTrim += ((blend > 0.5 ? (1 - blend) * 2 : 1) - this.ambTrim) * kb;
    const musicDb = 20 * Math.log10(this.levelCur.music + 1e-9);
    const target = Math.max(0, Math.min(1, (musicDb + 50) / 30)) * this.musicTrim;
    this.presence += (target - this.presence) * (1 - Math.exp(-frames / (0.8 * fs)));
    const support = Math.max(0, Math.min(1, this.p.bus.support)) * this.presence;
    this.carveL.peaking(fs, 900, 0.7, -6 * support);
    this.carveR.peaking(fs, 900, 0.7, -6 * support);
    const duck = Math.pow(10, (-2.5 * support) / 20) * this.ambTrim;
    const mt = this.musicTrim;

    for (let n = 0; n < frames; n++) {
      gR += (t.rain - gR) * smooth;
      gW += (t.wind - gW) * smooth;
      gC += (t.chimes - gC) * smooth;
      gF += (t.fire - gF) * smooth;
      gM += (t.music - gM) * smooth;
      const rl = b.rainL[n] * gR, rr = b.rainR[n] * gR;
      const wl = b.windL[n] * gW, wr = b.windR[n] * gW;
      const cl = b.chimeL[n] * gC, cr = b.chimeR[n] * gC;
      const fl = b.fireL[n] * gF, fr = b.fireR[n] * gF;
      const ml = b.musicL[n] * gM * mt, mr = b.musicR[n] * gM * mt;
      outL[n] = this.carveL.run(rl + wl + cl + fl) * duck + ml;
      outR[n] = this.carveR.run(rr + wr + cr + fr) * duck + mr;
      b.sendL[n] = (rl * sRain + wl * sWind + cl * sChime + fl * sFire) * this.ambTrim + b.mSendL[n] * gM * mt * sMusic;
      b.sendR[n] = (rr * sRain + wr * sWind + cr * sChime + fr * sFire) * this.ambTrim + b.mSendR[n] * gM * mt * sMusic;
      sq.rain += rl * rl + rr * rr;
      sq.wind += wl * wl + wr * wr;
      sq.chimes += cl * cl + cr * cr;
      sq.fire += fl * fl + fr * fr;
      sq.music += ml * ml + mr * mr;
    }
    this.gainCur.rain = gR;
    this.gainCur.wind = gW;
    this.gainCur.chimes = gC;
    this.gainCur.fire = gF;
    this.gainCur.music = gM;

    // 4. Shared space.
    this.reverb.process(b.sendL, b.sendR, b.revL, b.revR, frames);
    for (let n = 0; n < frames; n++) {
      outL[n] += b.revL[n];
      outR[n] += b.revR[n];
    }

    // 5. Features and events.
    const k = 1 - Math.exp(-frames / (0.1 * fs));
    for (const id of LAYERS) {
      const rms = Math.sqrt(sq[id] / (2 * frames));
      this.levelCur[id] += (rms - this.levelCur[id]) * k;
    }
    const ev = this.music.drainEvents();
    for (const e of ev) if (e.kind === 'chord') this.chordStep = e.step;
    this.events.music.push(...ev);
    this.events.rain.push(...this.rain.drainEvents());
    this.events.chimes.push(...this.chimes.drainEvents());
    this.events.fire.push(...this.fire.drainEvents());
    if (this.events.fire.length > 400) this.events.fire.splice(0, this.events.fire.length - 400);
    // Keep event queues bounded if nobody drains them.
    if (this.events.rain.length > 2000) this.events.rain.splice(0, this.events.rain.length - 2000);

    this.frame += frames;
  }
}

function withoutScale<T extends { scale?: unknown }>(p: T): Omit<T, 'scale'> {
  const { scale: _ignored, ...rest } = p;
  return rest;
}

export function mergeWorld(base: WorldParams, patch: WorldParamsPatch): WorldParams {
  const mix = { ...base.mix };
  for (const id of LAYERS) mix[id] = { ...base.mix[id], ...(patch.mix?.[id] ?? {}) };
  return {
    mix,
    bus: { ...base.bus, ...(patch.bus ?? {}) },
    scale: patch.scale ?? base.scale,
    rain: { ...base.rain, ...(patch.rain ?? {}) },
    wind: { ...base.wind, ...(patch.wind ?? {}) },
    chimes: { ...base.chimes, ...(patch.chimes ?? {}) },
    fire: { ...base.fire, ...(patch.fire ?? {}) },
    music: { ...base.music, ...(patch.music ?? {}) },
    reverb: { ...base.reverb, ...(patch.reverb ?? {}) },
  };
}
