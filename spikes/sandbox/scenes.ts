import type { ChimeParams } from '../../src/audio/nature/chimes/ChimeSynth';
import { VOICING_ORDER, type MusicParams } from '../../src/audio/music/MusicSynth';
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

export type VibeGroup = 'Calm' | 'Moody' | 'Playful' | 'Strange' | 'Ambience only';

export interface Scene {
  label: string;
  /** Which list the vibe sits under. */
  group?: VibeGroup;
  /** One line on what to listen for and what to try. */
  blurb?: string;
  /** The visual Trip this vibe suggests (0..1). */
  trip?: number;
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
  // ---------------------------------------------------------------- calm
  {
    label: 'Deep rest',
    group: 'Calm',
    blurb: 'A just-tuned drone, soft piano and slow bowls over light rain. Try Breath all the way up.',
    key: { root: 2, family: 'modes', light: 0.25, purity: 1 },
    space: 0.8,
    trip: 0.4,
    mix: { rain: on(), wind: on(0.35), chimes: off, music: on() },
    bus: { blend: 0.55 },
    rain: { rate: 1.5, surfaceMix: surfaces({ water: 0.9, leaves: 0.2 }) },
    wind: { amount: 0.2 },
    music: { droneLevel: 1, padLevel: 0.7, pianoLevel: 0.7, bowlsLevel: 0.5, keysLevel: 0, plucksLevel: 0, choirLevel: 0.25, density: 4, breath: 0.8, brightness: 0.25, rhythm: 'free', beat: 0, chordSeconds: 60, ring: 1.4, voicing: 'open', layers: 0.45, decay: 0.45, age: 0.15, texture: 0.1, swell: 0.25, orbit: 0.5 },
  },
  {
    label: 'Airport at dawn',
    group: 'Calm',
    blurb: 'After Eno: piano and choir on loops of different lengths that never line up the same way twice.',
    key: { root: 5, family: 'modes', light: 0.75, purity: 0.9 },
    space: 0.75,
    trip: 0.45,
    mix: { rain: off, wind: on(0.25), chimes: off, music: on() },
    wind: { amount: 0.15, gustiness: 0.3 },
    music: { pianoLevel: 0.9, choirLevel: 0.6, padLevel: 0.4, droneLevel: 0.3, keysLevel: 0, plucksLevel: 0, bowlsLevel: 0, rhythm: 'loops', density: 6, breath: 0.7, brightness: 0.4, voicing: 'add9', layers: 0.3, decay: 0.3, swell: 0.15, chordSeconds: 70 },
  },
  {
    label: 'Plateaux (soft piano)',
    group: 'Calm',
    blurb: 'After Harold Budd: slow, quiet piano notes left hanging in a huge room. Try Swell.',
    key: { root: 7, family: 'modes', light: 0.95, purity: 0.8 },
    space: 0.9,
    trip: 0.35,
    mix: { rain: off, wind: on(0.2), chimes: off, music: on() },
    wind: { amount: 0.1 },
    music: { pianoLevel: 1, padLevel: 0.35, droneLevel: 0.35, choirLevel: 0, keysLevel: 0, plucksLevel: 0, bowlsLevel: 0, density: 5, breath: 0.75, brightness: 0.3, rhythm: 'free', voicing: 'open', layers: 0.35, decay: 0.35, swell: 0.2, orbit: 0.3, ring: 1.6 },
  },
  {
    label: 'Temple',
    group: 'Calm',
    blurb: 'Harmonic-series drone, singing bowls and choir; chimes in the breeze. Everything beat-free.',
    key: { root: 9, family: 'harmonic', purity: 1 },
    space: 0.9,
    trip: 0.55,
    mix: { rain: off, wind: on(0.4), chimes: on(0.8), music: on() },
    wind: { amount: 0.35, gustiness: 0.5 },
    chimes: { tubes: 6, sustain: 2 },
    music: { droneLevel: 1, bowlsLevel: 1, choirLevel: 0.6, padLevel: 0.3, keysLevel: 0, plucksLevel: 0.2, density: 6, breath: 0.7, brightness: 0.35, rhythm: 'loops', beat: 0, ring: 1.6, voicing: 'quartal', texture: 0.3, orbit: 0.7, layers: 0.3 },
  },
  {
    label: 'Morning light',
    group: 'Calm',
    blurb: 'Bright Lydian plucks and piano, a breeze in the chimes. Turn Light down and watch the mood darken.',
    key: { root: 5, family: 'modes', light: 0.95, purity: 0.8 },
    space: 0.5,
    trip: 0.6,
    mix: { rain: off, wind: on(0.5), chimes: on(0.7), music: on() },
    wind: { amount: 0.4 },
    music: { plucksLevel: 0.9, keysLevel: 0.5, pianoLevel: 0.5, padLevel: 0.6, droneLevel: 0.4, choirLevel: 0, bowlsLevel: 0.3, density: 12, breath: 0.4, brightness: 0.6, rhythm: 'loops', beat: 0, voicing: 'add9', layers: 0.35, decay: 0.3, texture: 0.25 },
  },

  // ---------------------------------------------------------------- moody
  {
    label: 'Rain study (lo-fi)',
    group: 'Moody',
    blurb: 'A soft swung beat, e-piano and worn tape under rain on the window. Try Age and Swing.',
    key: { root: 7, family: 'modes', light: 0.45, purity: 0.5 },
    space: 0.4,
    trip: 0.5,
    mix: { rain: on(1.2), wind: on(0.3), chimes: off, music: on() },
    rain: { rate: 6, surfaceMix: surfaces({ glass: 0.6, leaves: 0.5, water: 0.2 }) },
    wind: { amount: 0.25 },
    music: { keysLevel: 0.9, keysRatio: 2, pianoLevel: 0.6, padLevel: 0.7, plucksLevel: 0.3, droneLevel: 0.2, choirLevel: 0, bowlsLevel: 0, beat: 0.75, tempo: 72, swing: 0.6, rhythm: 'pulse', density: 10, breath: 0.45, brightness: 0.35, voicing: 'add9', age: 0.5, layers: 0.2 },
  },
  {
    label: 'Tape-deck jazz',
    group: 'Moody',
    blurb: 'Late-night Dorian chords, brushed kit, a heavy triplet swing and an old cassette.',
    key: { root: 10, family: 'modes', light: 0.45, purity: 0.5 },
    space: 0.35,
    trip: 0.55,
    mix: { rain: on(0.6), wind: off, chimes: off, music: on() },
    rain: { rate: 3, surfaceMix: surfaces({ tin: 0.4, glass: 0.4 }) },
    music: { pianoLevel: 0.9, keysLevel: 0.6, keysRatio: 1, padLevel: 0.5, plucksLevel: 0, droneLevel: 0, choirLevel: 0, bowlsLevel: 0, beat: 0.6, tempo: 78, swing: 0.66, rhythm: 'pulse', density: 14, breath: 0.35, brightness: 0.4, voicing: 'add9', age: 0.6, chordSeconds: 12 },
  },
  {
    label: 'Cassette memories',
    group: 'Moody',
    blurb: 'After Basinski: loops that decay a little more on every pass. Stop the playing (Motion to 0) and let it disintegrate.',
    key: { root: 4, family: 'modes', light: 0.3, purity: 0.7 },
    space: 0.6,
    trip: 0.5,
    mix: { rain: on(0.5), wind: on(0.2), chimes: off, music: on() },
    rain: { rate: 1, surfaceMix: surfaces({ glass: 1 }) },
    wind: { amount: 0.1 },
    music: { padLevel: 0.8, pianoLevel: 0.6, choirLevel: 0.3, droneLevel: 0.3, keysLevel: 0, plucksLevel: 0, bowlsLevel: 0, density: 5, breath: 0.6, brightness: 0.3, rhythm: 'loops', voicing: 'sus2', layers: 0.85, decay: 0.75, age: 0.7, loopSeconds: 9.7 },
  },
  {
    label: 'Night drift',
    group: 'Moody',
    blurb: 'Choir and pad over a slow heartbeat; rain on a tin roof, wind in the trees.',
    key: { root: 4, family: 'modes', light: 0.25, purity: 0.8 },
    space: 0.7,
    trip: 0.5,
    mix: { rain: on(0.8), wind: on(0.45), chimes: off, music: on() },
    rain: { rate: 2, surfaceMix: surfaces({ tin: 0.5, leaves: 0.5 }) },
    wind: { amount: 0.45 },
    music: { choirLevel: 0.7, padLevel: 1, droneLevel: 0.6, keysLevel: 0.3, plucksLevel: 0.3, bowlsLevel: 0.2, beat: 0.2, tempo: 56, rhythm: 'free', density: 5, breath: 0.7, brightness: 0.2, voicing: 'sus2', layers: 0.55, decay: 0.6, age: 0.3, swell: 0.5 },
  },
  {
    label: 'Storm shelter',
    group: 'Moody',
    blurb: 'Dark Phrygian drone held on a pedal note while a storm goes over. Pull Blend toward music for shelter.',
    key: { root: 1, family: 'modes', light: 0.05, purity: 0.7 },
    space: 0.6,
    trip: 0.65,
    // Storms are big but not blasting: levels are pulled down so the scene lands near the others.
    mix: { rain: on(0.55), wind: on(0.35), chimes: on(0.5), music: on() },
    bus: { blend: 0.45 },
    rain: { rate: 45, surfaceMix: surfaces({ leaves: 1, water: 0.5, tin: 0.3, grass: 0.3 }) },
    wind: { amount: 0.85, gustiness: 0.9, whistle: 0.6, rustle: 0.7 },
    chimes: { activity: 1.5 },
    music: { droneLevel: 1, padLevel: 0.9, choirLevel: 0.3, keysLevel: 0, plucksLevel: 0.2, pianoLevel: 0.4, bowlsLevel: 0.4, density: 3, breath: 0.8, brightness: 0.2, chordSeconds: 50, beat: 0, voicing: 'sus4', pedal: true, age: 0.15, layers: 0.3 },
  },

  // ---------------------------------------------------------------- playful
  {
    label: 'Glass garden',
    group: 'Playful',
    blurb: 'Bell-like keys and plucks sparkling through a grain cloud, aluminium chimes. Try Texture.',
    key: { root: 9, family: 'pentatonic', light: 0.9, purity: 0.9 },
    space: 0.65,
    trip: 0.75,
    mix: { rain: off, wind: on(0.35), chimes: on(0.9), music: on() },
    wind: { amount: 0.5, gustiness: 0.7 },
    chimes: { tubes: 8, brightness: 0.9, sustain: 1.4 },
    music: { keysLevel: 0.8, keysRatio: 3.5, plucksLevel: 0.9, bowlsLevel: 0.5, padLevel: 0.3, droneLevel: 0.2, pianoLevel: 0, choirLevel: 0, density: 18, breath: 0.35, brightness: 0.75, rhythm: 'loops', texture: 0.45, layers: 0.3, decay: 0.2, orbit: 0.6 },
  },
  {
    label: 'Heartbeat',
    group: 'Playful',
    blurb: 'A felt heartbeat at 58 BPM, notes landing on the pulse. Raise Tempo and Beat to wake it up.',
    key: { root: 0, family: 'modes', light: 0.3, purity: 0.8 },
    space: 0.55,
    trip: 0.6,
    mix: { rain: on(0.4), wind: on(0.2), chimes: off, music: on() },
    rain: { rate: 1, surfaceMix: surfaces({ water: 1 }) },
    music: { droneLevel: 0.6, padLevel: 0.8, plucksLevel: 0.6, pianoLevel: 0.4, keysLevel: 0, choirLevel: 0.2, bowlsLevel: 0, beat: 0.25, tempo: 58, rhythm: 'pulse', density: 10, breath: 0.4, brightness: 0.3, voicing: 'sus2', layers: 0.25 },
  },
  {
    label: 'Arcade after hours',
    group: 'Playful',
    blurb: 'Lo-fi kit at 84 BPM, clangy FM keys, fast plucks and a grain cloud. The most awake vibe here.',
    key: { root: 3, family: 'modes', light: 0.6, purity: 0.5 },
    space: 0.45,
    trip: 0.85,
    mix: { rain: on(0.6), wind: off, chimes: off, music: on() },
    rain: { rate: 4, surfaceMix: surfaces({ glass: 1 }) },
    music: { keysLevel: 0.8, keysRatio: 3.01, plucksLevel: 0.8, padLevel: 0.5, pianoLevel: 0, droneLevel: 0, choirLevel: 0, bowlsLevel: 0, beat: 0.9, tempo: 84, swing: 0.56, rhythm: 'pulse', density: 22, breath: 0.25, brightness: 0.6, voicing: 'quartal', texture: 0.35, age: 0.35, layers: 0.2 },
  },
  {
    label: 'Frozen lake',
    group: 'Playful',
    blurb: 'Sparse bowls and piano with long, clean loops; icy wind and chimes. Press F (Freeze) mid-phrase.',
    key: { root: 11, family: 'modes', light: 0.85, purity: 1 },
    space: 1,
    trip: 0.5,
    mix: { rain: off, wind: on(0.5), chimes: on(0.7), music: on() },
    wind: { amount: 0.6, gustiness: 0.6, whistle: 0.5, tone: 0.3 },
    chimes: { brightness: 1, sustain: 3, tubes: 5 },
    music: { bowlsLevel: 0.9, pianoLevel: 0.7, droneLevel: 0.5, padLevel: 0.2, keysLevel: 0, plucksLevel: 0, choirLevel: 0, density: 5, breath: 0.6, brightness: 0.7, rhythm: 'free', voicing: 'quartal', layers: 0.9, decay: 0.1, loopSeconds: 14, orbit: 0.4 },
  },

  // ---------------------------------------------------------------- strange
  {
    label: 'Underwater cathedral',
    group: 'Strange',
    blurb: 'A dark, muffled choir and bowls as if heard through water. Warmth all the way up.',
    key: { root: 2, family: 'modes', light: 0.15, purity: 0.9 },
    space: 1,
    trip: 0.7,
    mix: { rain: on(0.7), wind: off, chimes: off, music: on() },
    rain: { rate: 3, surfaceMix: surfaces({ water: 1 }), bubblePitch: -1.2, nearDensity: 1.5 },
    music: { choirLevel: 0.9, bowlsLevel: 0.7, droneLevel: 0.8, padLevel: 0.5, pianoLevel: 0, keysLevel: 0, plucksLevel: 0, density: 4, breath: 0.6, brightness: 0.05, rhythm: 'loops', voicing: 'quartal', texture: 0.4, layers: 0.5, decay: 0.55, age: 0.25, orbit: 0.8, swell: 0.6 },
  },
  {
    label: 'Floating',
    group: 'Strange',
    blurb: 'Whole-tone harmony with no gravity, a grain cloud and circling bowls. Nothing ever resolves.',
    key: { root: 0, family: 'wholeTone' },
    space: 1,
    trip: 0.8,
    mix: { rain: off, wind: on(0.35), chimes: off, music: on() },
    wind: { amount: 0.2 },
    music: { padLevel: 0.8, choirLevel: 0.5, bowlsLevel: 0.6, keysLevel: 0.4, droneLevel: 0.5, plucksLevel: 0.2, density: 6, breath: 0.6, brightness: 0.4, rhythm: 'loops', beat: 0, layers: 0.6, decay: 0.35, texture: 0.6, orbit: 0.9, swell: 0.6 },
  },
  {
    label: 'Deep space',
    group: 'Strange',
    blurb: 'Harmonic drone and choir drifting in stereo, grains like distant stars, almost no ground.',
    key: { root: 5, family: 'harmonic', purity: 1 },
    space: 1,
    trip: 0.9,
    mix: { rain: off, wind: on(0.25), chimes: off, music: on() },
    wind: { amount: 0.15, tone: -0.6 },
    music: { droneLevel: 1, choirLevel: 0.7, bowlsLevel: 0.4, padLevel: 0.4, pianoLevel: 0, keysLevel: 0.2, keysRatio: 3.5, plucksLevel: 0, density: 3, breath: 0.8, brightness: 0.35, rhythm: 'loops', texture: 0.7, layers: 0.6, decay: 0.4, orbit: 1, swell: 0.7 },
  },
  {
    label: 'Fever dream',
    group: 'Strange',
    blurb: 'A microtonal cluster through grains, decaying loops and old tape. Trip at 100 for the full effect.',
    key: { root: 2, family: 'cluster', purity: 0.15 },
    space: 0.9,
    trip: 1,
    mix: { rain: on(0.5), wind: on(0.4), chimes: on(0.4), music: on(0.8) },
    rain: { rate: 2, surfaceMix: surfaces({ bells: 1 }), bubbleGlide: 1.4 },
    wind: { amount: 0.5, tone: -0.5, whistle: 0.8 },
    music: { padLevel: 0.7, choirLevel: 0.5, bowlsLevel: 0.6, keysLevel: 0.5, keysRatio: 3.7, plucksLevel: 0.4, droneLevel: 0.4, density: 10, breath: 0.4, rhythm: 'loops', texture: 0.8, age: 0.6, layers: 0.7, decay: 0.8, orbit: 1, swell: 0.4 },
  },
  {
    label: 'Strange weather',
    group: 'Strange',
    blurb: 'Rain that plays bells in key on a triplet grid, a whistling wind and clangy keys.',
    key: { root: 2, family: 'cluster', purity: 0.2 },
    space: 0.85,
    trip: 0.8,
    rainInKey: true,
    mix: { rain: on(), wind: on(), chimes: on(), music: on(0.7) },
    rain: { rate: 4, surfaceMix: surfaces({ bells: 0.6, water: 0.5 }), grid: { enabled: true, bpm: 70, division: 3 }, bubbleGlide: 1.2 },
    wind: { amount: 0.6, tone: -0.7, whistle: 1 },
    chimes: { sustain: 3, brightness: 1 },
    music: { keysRatio: 3.7, density: 14, bowlsLevel: 0.8, plucksLevel: 0.5, choirLevel: 0.4, rhythm: 'loops', texture: 0.5, age: 0.5, layers: 0.45, decay: 0.7, orbit: 0.6 },
    reverb: { damping: 0.3 },
  },

  // ---------------------------------------------------------------- ambience only
  {
    label: 'Summer storm',
    group: 'Ambience only',
    blurb: 'Just the weather: a full storm on leaves and a tin roof, with gusts in the chimes.',
    key: { root: 2, family: 'pentatonic', light: 0.1 },
    trip: 0.7,
    mix: { rain: on(0.55), wind: on(0.4), chimes: on(0.5), music: off },
    rain: { rate: 40, surfaceMix: surfaces({ leaves: 1, tin: 0.4, water: 0.4 }) },
    wind: { amount: 0.8, gustiness: 0.9, rustle: 0.8 },
    chimes: { activity: 1.5 },
  },
  {
    label: 'Breeze and chimes',
    group: 'Ambience only',
    blurb: 'A warm breeze and a set of chimes, nothing else.',
    key: { root: 9, family: 'pentatonic', light: 0.9 },
    trip: 0.4,
    mix: { rain: off, wind: on(), chimes: on(1.1), music: off },
    wind: { amount: 0.5, gustiness: 0.7 },
    chimes: { tubes: 8, sustain: 1.5 },
  },
  {
    label: 'Near silence',
    group: 'Ambience only',
    blurb: 'Almost nothing: a few drops on still water.',
    key: { root: 2, family: 'pentatonic', light: 0.1 },
    trip: 0.2,
    mix: { rain: on(0.5), wind: on(0.4), chimes: off, music: off },
    rain: { rate: 0.3, surfaceMix: surfaces({ water: 1 }) },
    wind: { amount: 0.15, gustiness: 0.3 },
  },
];

/**
 * A random but tasteful vibe: a key and mode, two to four voices, a plausible rhythm, gentle
 * processors and some weather. The beat is usually off; extremes are rare.
 */
export function randomVibe(rnd: () => number = Math.random): Scene {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const between = (a: number, b: number) => a + (b - a) * rnd();
  const chance = (p: number) => rnd() < p;
  const families = ['modes', 'modes', 'modes', 'pentatonic', 'pentatonic', 'harmonic', 'wholeTone', 'cluster'] as const;
  const family = pick(families);
  const voices = ['droneLevel', 'padLevel', 'pianoLevel', 'bowlsLevel', 'keysLevel', 'plucksLevel', 'choirLevel'] as const;
  const music: Partial<MusicParams> = {};
  for (const v of voices) music[v] = 0;
  const chosen = [...voices].sort(() => rnd() - 0.5).slice(0, 2 + Math.floor(rnd() * 3));
  for (const v of chosen) music[v] = +between(0.4, 1).toFixed(2);
  if (!chosen.includes('droneLevel') && !chosen.includes('padLevel')) music.padLevel = 0.4; // always a floor
  const rhythm = pick(['free', 'loops', 'loops', 'pulse'] as const);
  const beat = rhythm === 'pulse' && chance(0.6) ? +between(0.15, 0.85).toFixed(2) : 0;
  Object.assign(music, {
    rhythm,
    beat,
    tempo: Math.round(between(52, 86)),
    swing: +between(0.5, 0.64).toFixed(2),
    density: +between(3, 18).toFixed(1),
    breath: +between(0.25, 0.85).toFixed(2),
    brightness: +between(0.1, 0.7).toFixed(2),
    voicing: pick(VOICING_ORDER),
    pedal: chance(0.2),
    keysRatio: pick([1, 2, 2, 3.5, 3.01]),
    layers: chance(0.7) ? +between(0.15, 0.8).toFixed(2) : 0,
    decay: +between(0.15, 0.8).toFixed(2),
    age: chance(0.5) ? +between(0.1, 0.6).toFixed(2) : 0,
    texture: chance(0.5) ? +between(0.1, 0.7).toFixed(2) : 0,
    swell: chance(0.4) ? +between(0.1, 0.7).toFixed(2) : 0,
    orbit: +between(0, 0.9).toFixed(2),
    chordSeconds: Math.round(between(15, 80)),
  });
  const rain = chance(0.55);
  const surface = pick(['water', 'leaves', 'glass', 'tin', 'grass'] as const);
  return {
    label: 'Surprise',
    blurb: 'A random roll. Keep what you like, or press Surprise me again.',
    key: { root: Math.floor(rnd() * 12), family, light: +rnd().toFixed(2), purity: family === 'cluster' ? 0.2 : +between(0.5, 1).toFixed(2) },
    space: +between(0.35, 1).toFixed(2),
    trip: +between(0.35, 0.9).toFixed(2),
    mix: { rain: rain ? on(+between(0.4, 1.2).toFixed(2)) : off, wind: on(+between(0.2, 0.6).toFixed(2)), chimes: chance(0.35) ? on(0.7) : off, music: on() },
    rain: { rate: +between(0.5, 10).toFixed(1), surfaceMix: surfaces({ [surface]: 1, water: 0.3 }) },
    wind: { amount: +between(0.1, 0.6).toFixed(2), gustiness: +between(0.3, 0.8).toFixed(2) },
    music,
  };
}
