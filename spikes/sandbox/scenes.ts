import type { ChimeParams } from '../../src/audio/nature/chimes/ChimeSynth';
import type { MusicParams } from '../../src/audio/music/MusicSynth';
import type { RainParams } from '../../src/audio/nature/rain/RainSynth';
import type { ReverbParams } from '../../src/audio/dsp/Reverb';
import type { WindParams } from '../../src/audio/nature/wind/WindSynth';
import { DEFAULT_WORLD_PARAMS, mergeWorld, type BusParams, type LayerId, type LayerMix, type WorldParams, type WorldParamsPatch } from '../../src/audio/world/WorldSynth';
import { DEFAULT_RAIN_PARAMS } from '../../src/audio/nature/rain/RainSynth';
import { DEFAULT_WIND_PARAMS } from '../../src/audio/nature/wind/WindSynth';
import { DEFAULT_CHIME_PARAMS } from '../../src/audio/nature/chimes/ChimeSynth';
import { DEFAULT_MUSIC_PARAMS } from '../../src/audio/music/MusicSynth';
import { DEFAULT_REVERB_PARAMS } from '../../src/audio/dsp/Reverb';
import { buildScale, DEFAULT_KEY, SCALES, type KeySettings, type ScaleKey, type ScaleSnap } from '../../src/audio/music/scales';
import type { SurfaceId } from '../../src/audio/nature/rain/surfaces';

export interface Scene {
  label: string;
  /** Legacy fixed scale (the Lab). Vibes use `key` instead. */
  scale?: ScaleKey;
  /** Mood-driven key: root, family, Light, Purity, tuning. */
  key?: Partial<KeySettings>;
  /** The Space macro, 0..1 (reverb length and size, music send, shimmer). */
  space?: number;
  rainInKey?: boolean;
  mix?: Partial<Record<LayerId, Partial<LayerMix>>>;
  bus?: Partial<BusParams>;
  rain?: Partial<RainParams>;
  wind?: Partial<WindParams>;
  chimes?: Partial<ChimeParams>;
  music?: Partial<MusicParams>;
  reverb?: Partial<ReverbParams>;
}

/** Everything the UI edits for one scene: the full parameter set for every layer. */
export interface SceneState {
  scaleKey: ScaleKey;
  /** When set, the world's scale is built from these mood settings instead of `scaleKey`. */
  key: KeySettings | null;
  space: number;
  rainInKey: boolean;
  world: WorldParams;
}

/** Purity → detune of the pad and choir: pure is still, low purity drifts and beats. */
export function purityDetune(purity: number): number {
  return purity >= 0.5 ? 3 + 10 * (1 - purity) : 8 + (0.5 - purity) * 2 * 40;
}

/** Space → reverb and send settings. */
export function spacePatch(space: number): { reverb: Partial<ReverbParams>; send: number; shimmer: number } {
  return {
    reverb: { t60: 1.5 + 14 * space * space, size: 0.7 + 1.0 * space },
    send: 0.15 + 0.65 * space,
    shimmer: Math.max(0, (space - 0.45) / 0.55) * 0.8,
  };
}

/** The scale a state plays in. */
export function stateScale(st: Pick<SceneState, 'key' | 'scaleKey'>): ScaleSnap {
  return st.key ? buildScale(st.key) : SCALES[st.scaleKey];
}

/** Scene → full parameter state. Layers a scene doesn't mention are on, at their defaults. */
export function sceneState(scene: Scene): SceneState {
  const { scale: _r, ...rainDefaults } = DEFAULT_RAIN_PARAMS;
  const { scale: _c, ...chimeDefaults } = DEFAULT_CHIME_PARAMS;
  const { scale: _m, ...musicDefaults } = DEFAULT_MUSIC_PARAMS;
  const key = scene.key ? { ...DEFAULT_KEY, ...scene.key } : null;
  const space = scene.space ?? 0.5;
  const sp = spacePatch(space);
  const scaleKey = scene.scale ?? 'dPent';
  const mood: Partial<MusicParams> = key ? { detune: purityDetune(key.purity), shimmer: sp.shimmer } : {};
  const world = mergeWorld(DEFAULT_WORLD_PARAMS, {
    mix: key ? { ...scene.mix, music: { send: sp.send, ...scene.mix?.music } } : scene.mix,
    bus: scene.bus,
    scale: key ? buildScale(key) : SCALES[scaleKey],
    rain: { ...rainDefaults, ...scene.rain },
    wind: { ...DEFAULT_WIND_PARAMS, ...scene.wind },
    chimes: { ...chimeDefaults, ...scene.chimes },
    music: { ...musicDefaults, ...mood, ...scene.music },
    reverb: { ...DEFAULT_REVERB_PARAMS, ...(key ? sp.reverb : {}), ...scene.reverb },
  });
  return { scaleKey, key, space, rainInKey: !!scene.rainInKey, world };
}

/** Full state → the patch the world worklet takes. */
export function stateToPatch(st: SceneState): WorldParamsPatch {
  const w = st.world;
  const scale = stateScale(st);
  return {
    mix: w.mix,
    bus: w.bus,
    scale,
    rain: { ...w.rain, scale: { ...scale, enabled: st.rainInKey } },
    wind: w.wind,
    chimes: w.chimes,
    music: w.music,
    reverb: w.reverb,
  };
}

export const surfaces = (m: Partial<Record<SurfaceId, number>>): Record<SurfaceId, number> => ({
  water: 0, leaves: 0, grass: 0, stone: 0, tin: 0, glass: 0, bells: 0, ...m,
});

const on = (level?: number) => ({ on: true, ...(level !== undefined ? { level } : {}) });
const off = { on: false };

/** Vibes: each sets the music's mood and the ambience under it. */
export const SCENES: Scene[] = [
  {
    label: 'Deep rest',
    key: { root: 2, family: 'modes', light: 0.25, purity: 1 },
    space: 0.8,
    mix: { rain: on(), wind: on(0.35), chimes: off, music: on() },
    bus: { blend: 0.55 },
    rain: { rate: 1.5, surfaceMix: surfaces({ water: 0.9, leaves: 0.2 }) },
    wind: { amount: 0.2 },
    music: { droneLevel: 1, padLevel: 0.7, pianoLevel: 0.7, bowlsLevel: 0.5, keysLevel: 0, plucksLevel: 0, choirLevel: 0.25, density: 4, breath: 0.8, brightness: 0.25, rhythm: 'free', beat: 0, chordSeconds: 60, ring: 1.4, voicing: 'open', layers: 0.45, decay: 0.45, age: 0.15, texture: 0.1, swell: 0.25, orbit: 0.5 },
  },
  {
    label: 'Temple',
    key: { root: 9, family: 'harmonic', purity: 1 },
    space: 0.9,
    mix: { rain: off, wind: on(0.4), chimes: on(0.8), music: on() },
    wind: { amount: 0.35, gustiness: 0.5 },
    chimes: { tubes: 6, sustain: 2 },
    music: { droneLevel: 1, bowlsLevel: 1, choirLevel: 0.6, padLevel: 0.3, keysLevel: 0, plucksLevel: 0.2, density: 6, breath: 0.7, brightness: 0.35, rhythm: 'loops', beat: 0, ring: 1.6, voicing: 'quartal', texture: 0.3, orbit: 0.7, layers: 0.3 },
  },
  {
    label: 'Morning light',
    key: { root: 5, family: 'modes', light: 0.95, purity: 0.8 },
    space: 0.5,
    mix: { rain: off, wind: on(0.5), chimes: on(0.7), music: on() },
    wind: { amount: 0.4 },
    music: { plucksLevel: 0.9, keysLevel: 0.5, pianoLevel: 0.5, padLevel: 0.6, droneLevel: 0.4, choirLevel: 0, bowlsLevel: 0.3, density: 12, breath: 0.4, brightness: 0.6, rhythm: 'loops', beat: 0, voicing: 'add9', layers: 0.35, decay: 0.3, texture: 0.25 },
  },
  {
    label: 'Rain study (lo-fi)',
    key: { root: 7, family: 'modes', light: 0.45, purity: 0.5 },
    space: 0.4,
    mix: { rain: on(1.2), wind: on(0.3), chimes: off, music: on() },
    rain: { rate: 6, surfaceMix: surfaces({ glass: 0.6, leaves: 0.5, water: 0.2 }) },
    wind: { amount: 0.25 },
    music: { keysLevel: 0.9, keysRatio: 2, pianoLevel: 0.6, padLevel: 0.7, plucksLevel: 0.3, droneLevel: 0.2, choirLevel: 0, bowlsLevel: 0, beat: 0.75, tempo: 72, swing: 0.6, rhythm: 'pulse', density: 10, breath: 0.45, brightness: 0.35, voicing: 'add9', age: 0.5, layers: 0.2 },
  },
  {
    label: 'Night drift',
    key: { root: 4, family: 'modes', light: 0.25, purity: 0.8 },
    space: 0.7,
    mix: { rain: on(0.8), wind: on(0.45), chimes: off, music: on() },
    rain: { rate: 2, surfaceMix: surfaces({ tin: 0.5, leaves: 0.5 }) },
    wind: { amount: 0.45 },
    music: { choirLevel: 0.7, padLevel: 1, droneLevel: 0.6, keysLevel: 0.3, plucksLevel: 0.3, bowlsLevel: 0.2, beat: 0.2, tempo: 56, rhythm: 'free', density: 5, breath: 0.7, brightness: 0.2, voicing: 'sus2', layers: 0.55, decay: 0.6, age: 0.3, swell: 0.5 },
  },
  {
    label: 'Floating',
    key: { root: 0, family: 'wholeTone' },
    space: 1,
    mix: { rain: off, wind: on(0.35), chimes: off, music: on() },
    wind: { amount: 0.2 },
    music: { padLevel: 0.8, choirLevel: 0.5, bowlsLevel: 0.6, keysLevel: 0.4, droneLevel: 0.5, plucksLevel: 0.2, density: 6, breath: 0.6, brightness: 0.4, rhythm: 'loops', beat: 0, layers: 0.6, decay: 0.35, texture: 0.6, orbit: 0.9, swell: 0.6 },
  },
  {
    label: 'Storm shelter',
    key: { root: 1, family: 'modes', light: 0.05, purity: 0.7 },
    space: 0.6,
    // Storms are big but not blasting: levels are pulled down so the scene lands near the others.
    mix: { rain: on(0.55), wind: on(0.35), chimes: on(0.5), music: on() },
    bus: { blend: 0.45 },
    rain: { rate: 45, surfaceMix: surfaces({ leaves: 1, water: 0.5, tin: 0.3, grass: 0.3 }) },
    wind: { amount: 0.85, gustiness: 0.9, whistle: 0.6, rustle: 0.7 },
    chimes: { activity: 1.5 },
    music: { droneLevel: 1, padLevel: 0.9, choirLevel: 0.3, keysLevel: 0, plucksLevel: 0.2, pianoLevel: 0.4, bowlsLevel: 0.4, density: 3, breath: 0.8, brightness: 0.2, chordSeconds: 50, beat: 0, voicing: 'sus4', pedal: true, age: 0.15, layers: 0.3 },
  },
  {
    label: 'Strange weather',
    key: { root: 2, family: 'cluster', purity: 0.2 },
    space: 0.85,
    rainInKey: true,
    mix: { rain: on(), wind: on(), chimes: on(), music: on(0.7) },
    rain: { rate: 4, surfaceMix: surfaces({ bells: 0.6, water: 0.5 }), grid: { enabled: true, bpm: 70, division: 3 }, bubbleGlide: 1.2 },
    wind: { amount: 0.6, tone: -0.7, whistle: 1 },
    chimes: { sustain: 3, brightness: 1 },
    music: { keysRatio: 3.7, density: 14, bowlsLevel: 0.8, plucksLevel: 0.5, choirLevel: 0.4, rhythm: 'loops', texture: 0.5, age: 0.5, layers: 0.45, decay: 0.7, orbit: 0.6 },
    reverb: { damping: 0.3 },
  },
  {
    label: 'Near silence (ambience only)',
    key: { root: 2, family: 'pentatonic', light: 0.1 },
    mix: { rain: on(0.5), wind: on(0.4), chimes: off, music: off },
    rain: { rate: 0.3, surfaceMix: surfaces({ water: 1 }) },
    wind: { amount: 0.15, gustiness: 0.3 },
  },
];
