import type { ChimeParams } from '../../src/audio/nature/chimes/ChimeSynth';
import type { MusicParams } from '../../src/audio/music/MusicSynth';
import type { RainParams } from '../../src/audio/nature/rain/RainSynth';
import type { ReverbParams } from '../../src/audio/dsp/Reverb';
import type { WindParams } from '../../src/audio/nature/wind/WindSynth';
import { DEFAULT_WORLD_PARAMS, mergeWorld, type LayerId, type LayerMix, type WorldParams, type WorldParamsPatch } from '../../src/audio/world/WorldSynth';
import { DEFAULT_RAIN_PARAMS } from '../../src/audio/nature/rain/RainSynth';
import { DEFAULT_WIND_PARAMS } from '../../src/audio/nature/wind/WindSynth';
import { DEFAULT_CHIME_PARAMS } from '../../src/audio/nature/chimes/ChimeSynth';
import { DEFAULT_MUSIC_PARAMS } from '../../src/audio/music/MusicSynth';
import { DEFAULT_REVERB_PARAMS } from '../../src/audio/dsp/Reverb';
import { SCALES, type ScaleKey } from '../../src/audio/music/scales';
import type { SurfaceId } from '../../src/audio/nature/rain/surfaces';

export interface Scene {
  label: string;
  scale: ScaleKey;
  rainInKey?: boolean;
  mix?: Partial<Record<LayerId, Partial<LayerMix>>>;
  rain?: Partial<RainParams>;
  wind?: Partial<WindParams>;
  chimes?: Partial<ChimeParams>;
  music?: Partial<MusicParams>;
  reverb?: Partial<ReverbParams>;
}

/** Everything the UI edits for one scene: the full parameter set for every layer. */
export interface SceneState {
  scaleKey: ScaleKey;
  rainInKey: boolean;
  world: WorldParams;
}

/** Scene → full parameter state. Layers a scene doesn't mention are on, at their defaults. */
export function sceneState(scene: Scene): SceneState {
  const { scale: _r, ...rainDefaults } = DEFAULT_RAIN_PARAMS;
  const { scale: _c, ...chimeDefaults } = DEFAULT_CHIME_PARAMS;
  const { scale: _m, ...musicDefaults } = DEFAULT_MUSIC_PARAMS;
  const world = mergeWorld(DEFAULT_WORLD_PARAMS, {
    mix: scene.mix,
    scale: SCALES[scene.scale],
    rain: { ...rainDefaults, ...scene.rain },
    wind: { ...DEFAULT_WIND_PARAMS, ...scene.wind },
    chimes: { ...chimeDefaults, ...scene.chimes },
    music: { ...musicDefaults, ...scene.music },
    reverb: { ...DEFAULT_REVERB_PARAMS, ...scene.reverb },
  });
  return { scaleKey: scene.scale, rainInKey: !!scene.rainInKey, world };
}

/** Full state → the patch the world worklet takes. */
export function stateToPatch(st: SceneState): WorldParamsPatch {
  const w = st.world;
  return {
    mix: w.mix,
    scale: SCALES[st.scaleKey],
    rain: { ...w.rain, scale: { ...SCALES[st.scaleKey], enabled: st.rainInKey } },
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

export const SCENES: Scene[] = [
  {
    label: 'Calm lake at dusk',
    scale: 'dPent',
    mix: { rain: on(), wind: on(), chimes: on(), music: on() },
    rain: { rate: 1.2, surfaceMix: surfaces({ water: 0.8, leaves: 0.3, grass: 0.1 }) },
    wind: { amount: 0.3 },
    music: { density: 6, brightness: 0.35 },
  },
  {
    label: 'Steady rain, soft keys',
    scale: 'fLydian',
    mix: { rain: on(), wind: on(0.35), chimes: off, music: on() },
    rain: { rate: 6, surfaceMix: surfaces({ water: 0.5, leaves: 0.6, grass: 0.2 }) },
    wind: { amount: 0.25 },
    music: { density: 10, brightness: 0.45 },
  },
  {
    label: 'Storm',
    scale: 'dDorian',
    // Storms are big but not blasting: levels are pulled down so the scene lands near the others.
    mix: { rain: on(0.55), wind: on(0.35), chimes: on(0.6), music: on(0.5) },
    rain: { rate: 45, surfaceMix: surfaces({ leaves: 1, water: 0.5, tin: 0.3, grass: 0.3 }) },
    wind: { amount: 0.85, gustiness: 0.9, whistle: 0.6, rustle: 0.7 },
    chimes: { activity: 1.5 },
    music: { keysLevel: 0, brightness: 0.2, chordSeconds: 50 },
  },
  {
    label: 'Breeze and chimes',
    scale: 'aMajPent',
    mix: { rain: off, wind: on(), chimes: on(1.1), music: off },
    wind: { amount: 0.5, gustiness: 0.7 },
    chimes: { tubes: 8, sustain: 1.5 },
  },
  {
    label: 'Tin roof, late',
    scale: 'dDorian',
    mix: { rain: on(), wind: on(0.3), chimes: off, music: on(0.5) },
    rain: { rate: 10, surfaceMix: surfaces({ tin: 1, water: 0.2 }) },
    wind: { amount: 0.3 },
    music: { density: 5, brightness: 0.3 },
  },
  {
    label: 'Rain in key',
    scale: 'dPent',
    rainInKey: true,
    mix: { rain: on(1.6), wind: on(0.3), chimes: off, music: on(0.5) },
    rain: { rate: 3, nearDensity: 2, midLevel: 0.4, farLevel: 0.3, stretch: 2, surfaceMix: surfaces({ water: 1 }) },
    wind: { amount: 0.2 },
    music: { keysLevel: 0, brightness: 0.3 },
  },
  {
    label: 'Strange weather',
    scale: 'cluster',
    rainInKey: true,
    mix: { rain: on(), wind: on(), chimes: on(), music: on(0.7) },
    rain: { rate: 4, surfaceMix: surfaces({ bells: 0.6, water: 0.5 }), grid: { enabled: true, bpm: 70, division: 3 }, bubbleGlide: 1.2 },
    wind: { amount: 0.6, tone: -0.7, whistle: 1 },
    chimes: { sustain: 3, brightness: 1 },
    music: { detune: 45, keysRatio: 3.7, density: 14 },
    reverb: { t60: 12, damping: 0.3 },
  },
  {
    label: 'Near silence',
    scale: 'dPent',
    mix: { rain: on(0.5), wind: on(0.4), chimes: off, music: off },
    rain: { rate: 0.3, surfaceMix: surfaces({ water: 1 }) },
    wind: { amount: 0.15, gustiness: 0.3 },
  },
];
