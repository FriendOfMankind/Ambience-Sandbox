/**
 * The listening tests. Each one isolates a sound (other layers off), says what to listen for,
 * and names the few parameters worth touching. Order matters: "Start here" is what has never
 * been heard, then baselines per layer, then whole scenes.
 */
import { SCENES, sceneState, surfaces, type Scene } from '../sandbox/scenes';
import { LAYERS, type LayerId } from '../../src/audio/world/WorldSynth';

export interface Tune {
  /** Dot path into WorldParams, e.g. `rain.rate` or `mix.wind.level`. */
  path: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  log?: boolean;
  /** Show and edit as 1 − value (a "threshold" presented as "sensitivity"). */
  invert?: boolean;
  fmt: (v: number) => string;
}

export type Status = 'rebuilt' | 'unheard' | 'heard';

export interface LabTest {
  id: string;
  group: string;
  title: string;
  status: Status;
  /** Layers whose level is measured while this test plays. */
  layers: LayerId[];
  listenFor: string;
  /** One pointed question, shown above the ratings. */
  question: string;
  /** Label for the first rating (the second is always "Pleasant"). */
  realLabel: string;
  scene: Scene;
  tune: Tune[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const times = (v: number) => `${v.toFixed(2)}×`;
const db = (v: number) => (v < 0.005 ? '−∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`);
const mmh = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} mm/h`;

const LEVEL = (layer: LayerId): Tune => ({ path: `mix.${layer}.level`, label: 'Level', min: 0, max: 2, step: 0.01, fmt: db });

/** Only the named layers sound; the rest are off. Wind still blows (it is the gust source), just silently. */
const only = (...on: LayerId[]): Scene['mix'] => ({
  rain: { on: on.includes('rain') },
  wind: { on: on.includes('wind') },
  chimes: { on: on.includes('chimes') },
  music: { on: on.includes('music') },
});

const rainScene = (over: Scene['rain'], extra: Partial<Scene> = {}): Scene => ({
  label: 'rain',
  scale: 'dPent',
  mix: only('rain'),
  wind: { amount: 0.2 },
  ...extra,
  rain: over,
});

const RATE: Tune = { path: 'rain.rate', label: 'Rain', min: 0.1, max: 200, log: true, fmt: mmh };
const SIZE: Tune = { path: 'rain.sizeBias', label: 'Drop size', min: -2, max: 2, step: 0.05, fmt: (v) => (Math.abs(v) < 0.01 ? 'natural' : v.toFixed(2)) };
const STRETCH: Tune = { path: 'rain.stretch', label: 'Ring time', min: 1, max: 20, log: true, fmt: times };

export const LAB_TESTS: LabTest[] = [
  // ---------------------------------------------------------------- start here
  {
    id: 'tin',
    group: 'Start here: rebuilt, never heard',
    title: 'Rain on a tin roof',
    status: 'rebuilt',
    layers: ['rain'],
    listenFor: 'A short metallic clatter and ticks, like rain on a corrugated roof or a car bonnet. The old version rang like fast wind chimes or a xylophone.',
    question: 'Does it read as rain on tin, or does it still ring musically?',
    realLabel: 'Sounds like tin',
    scene: rainScene({ rate: 10, surfaceMix: surfaces({ tin: 1 }) }),
    tune: [LEVEL('rain'), RATE, SIZE, STRETCH],
  },
  {
    id: 'glass',
    group: 'Start here: rebuilt, never heard',
    title: 'Rain on a window',
    status: 'rebuilt',
    layers: ['rain'],
    listenFor: 'Light, sharp ticks against a pane. Same failure as the tin before: chime-like ringing.',
    question: 'Ticks on glass, or a glass xylophone?',
    realLabel: 'Sounds like glass',
    scene: rainScene({ rate: 6, surfaceMix: surfaces({ glass: 1 }) }),
    tune: [LEVEL('rain'), RATE, SIZE, STRETCH],
  },
  {
    id: 'wind-leaves',
    group: 'Start here: rebuilt, never heard',
    title: 'Wind in leaves',
    status: 'rebuilt',
    layers: ['wind'],
    listenFor: 'A canopy swelling and fading with the gusts, with individual leaves fluttering on top. The old version sounded like static or shuffling sand.',
    question: 'Leaves and canopy, or static?',
    realLabel: 'Sounds like leaves',
    scene: { label: 'leaves', scale: 'dPent', mix: only('wind'), wind: { amount: 0.45, gustiness: 0.6, rustle: 1, whistle: 0 } },
    tune: [LEVEL('wind'), { path: 'wind.rustle', label: 'Leaves', min: 0, max: 1, step: 0.01, fmt: pct }, { path: 'wind.amount', label: 'Strength', min: 0, max: 1, step: 0.01, fmt: pct }, { path: 'wind.gustiness', label: 'Gustiness', min: 0, max: 1, step: 0.01, fmt: pct }, { path: 'wind.tone', label: 'Tone', min: -1, max: 1, step: 0.01, fmt: (v) => (Math.abs(v) < 0.02 ? 'natural' : v < 0 ? 'darker' : 'brighter') }],
  },

  // ---------------------------------------------------------------- rain
  {
    id: 'rain-water',
    group: 'Rain',
    title: 'Steady rain on water',
    status: 'heard',
    layers: ['rain'],
    listenFor: 'You said the rain "sounds good". Now the details: individual plinks, bubble variety, and whether the wash behind them is smooth or grainy.',
    question: 'Anything that bothers you when you listen closely for a few minutes?',
    realLabel: 'Sounds like rain',
    scene: rainScene({ rate: 5, surfaceMix: surfaces({ water: 1 }) }),
    tune: [LEVEL('rain'), RATE, SIZE, { path: 'rain.nearDensity', label: 'Close drops', min: 0, max: 4, step: 0.01, fmt: times }, { path: 'rain.farLevel', label: 'Distant wash', min: 0, max: 2, step: 0.01, fmt: times }],
  },
  {
    id: 'rain-drizzle',
    group: 'Rain',
    title: 'Drizzle',
    status: 'unheard',
    layers: ['rain'],
    listenFor: 'Sparse, individual drops with silence between. Nowhere to hide: every drop is exposed.',
    question: 'Do single drops sound natural, or samey and synthetic?',
    realLabel: 'Sounds like rain',
    scene: rainScene({ rate: 0.8, surfaceMix: surfaces({ water: 0.7, leaves: 0.3 }) }),
    tune: [LEVEL('rain'), RATE, SIZE],
  },
  {
    id: 'rain-downpour',
    group: 'Rain',
    title: 'Downpour',
    status: 'unheard',
    layers: ['rain'],
    listenFor: 'A dense roar with detail inside it. The risk is harsh hiss or a flat wall of noise.',
    question: 'Roar with texture, or noise?',
    realLabel: 'Sounds like rain',
    scene: rainScene({ rate: 45, surfaceMix: surfaces({ water: 0.5, leaves: 0.5, grass: 0.3 }) }),
    tune: [LEVEL('rain'), RATE, SIZE, { path: 'rain.farLevel', label: 'Distant wash', min: 0, max: 2, step: 0.01, fmt: times }],
  },
  {
    id: 'rain-leaves',
    group: 'Rain',
    title: 'Rain on leaves',
    status: 'unheard',
    layers: ['rain'],
    listenFor: 'Soft, damp pats and patters, duller than water.',
    question: 'Soft foliage patter, or papery and crackly?',
    realLabel: 'Sounds like leaves',
    scene: rainScene({ rate: 6, surfaceMix: surfaces({ leaves: 1 }) }),
    tune: [LEVEL('rain'), RATE, SIZE],
  },
  {
    id: 'rain-grass',
    group: 'Rain',
    title: 'Rain on grass',
    status: 'unheard',
    layers: ['rain'],
    listenFor: 'A fine, soft hush with tiny ticks.',
    question: 'Does it sound different from leaves and water, or the same?',
    realLabel: 'Sounds like grass',
    scene: rainScene({ rate: 6, surfaceMix: surfaces({ grass: 1 }) }),
    tune: [LEVEL('rain'), RATE, SIZE],
  },
  {
    id: 'rain-stone',
    group: 'Rain',
    title: 'Rain on stone',
    status: 'unheard',
    layers: ['rain'],
    listenFor: 'Hard, dry taps: paving or a stone step.',
    question: 'Hard and dry, or vaguely metallic?',
    realLabel: 'Sounds like stone',
    scene: rainScene({ rate: 6, surfaceMix: surfaces({ stone: 1 }) }),
    tune: [LEVEL('rain'), RATE, SIZE],
  },
  {
    id: 'rain-key',
    group: 'Rain',
    title: 'Rain in key',
    status: 'unheard',
    layers: ['rain'],
    listenFor: 'Every bubble snapped to D minor pentatonic, so the rain plays a scale by accident.',
    question: 'Pretty and natural, or obviously tuned and cute?',
    realLabel: 'Sounds natural',
    scene: rainScene({ rate: 3, nearDensity: 2, midLevel: 0.4, farLevel: 0.3, stretch: 2, surfaceMix: surfaces({ water: 1 }) }, { rainInKey: true }),
    tune: [LEVEL('rain'), RATE, { path: 'rain.bubblePitch', label: 'Bubble pitch', min: -3, max: 2, step: 0.05, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} oct` }, STRETCH],
  },
  {
    id: 'rain-bells',
    group: 'Rain',
    title: 'Bells (unreal, kept on purpose)',
    status: 'heard',
    layers: ['rain'],
    listenFor: 'The old tin/glass sound, kept as an unrealistic option: rain falling on tuned bells.',
    question: 'Would you actually use this in a scene? Beautiful, or novelty?',
    realLabel: 'Interesting as a sound',
    scene: rainScene({ rate: 4, surfaceMix: surfaces({ bells: 1 }) }, { rainInKey: true }),
    tune: [LEVEL('rain'), RATE, STRETCH],
  },

  // ---------------------------------------------------------------- wind
  {
    id: 'wind-breeze',
    group: 'Wind',
    title: 'Light breeze',
    status: 'unheard',
    layers: ['wind'],
    listenFor: 'The body of the wind: a soft, moving air. Listen to how gusts build and fall away.',
    question: 'Air that breathes, or filtered noise?',
    realLabel: 'Sounds like wind',
    scene: { label: 'breeze', scale: 'dPent', mix: only('wind'), wind: { amount: 0.3, gustiness: 0.5, rustle: 0.2, whistle: 0 } },
    tune: [LEVEL('wind'), { path: 'wind.amount', label: 'Strength', min: 0, max: 1, step: 0.01, fmt: pct }, { path: 'wind.gustiness', label: 'Gustiness', min: 0, max: 1, step: 0.01, fmt: pct }, { path: 'wind.tone', label: 'Tone', min: -1, max: 1, step: 0.01, fmt: (v) => (Math.abs(v) < 0.02 ? 'natural' : v < 0 ? 'darker' : 'brighter') }],
  },
  {
    id: 'wind-gale',
    group: 'Wind',
    title: 'Gale',
    status: 'unheard',
    layers: ['wind'],
    listenFor: 'Big gusts, with whistling in the peaks.',
    question: 'Powerful, or just loud?',
    realLabel: 'Sounds like wind',
    scene: { label: 'gale', scale: 'dPent', mix: only('wind'), wind: { amount: 0.85, gustiness: 0.9, whistle: 0.6, rustle: 0.6 } },
    tune: [LEVEL('wind'), { path: 'wind.amount', label: 'Strength', min: 0, max: 1, step: 0.01, fmt: pct }, { path: 'wind.whistle', label: 'Whistle', min: 0, max: 1, step: 0.01, fmt: pct }, { path: 'wind.tone', label: 'Tone', min: -1, max: 1, step: 0.01, fmt: (v) => (Math.abs(v) < 0.02 ? 'natural' : v < 0 ? 'darker' : 'brighter') }],
  },
  {
    id: 'wind-whistle',
    group: 'Wind',
    title: 'Whistling wind',
    status: 'unheard',
    layers: ['wind'],
    listenFor: 'Wind through gaps: tonal, wandering whistles over the body.',
    question: 'Eerie and lovely, or a synth whine?',
    realLabel: 'Sounds like wind',
    scene: { label: 'whistle', scale: 'dPent', mix: only('wind'), wind: { amount: 0.6, gustiness: 0.7, whistle: 1, rustle: 0 } },
    tune: [LEVEL('wind'), { path: 'wind.whistle', label: 'Whistle', min: 0, max: 1, step: 0.01, fmt: pct }, { path: 'wind.amount', label: 'Strength', min: 0, max: 1, step: 0.01, fmt: pct }],
  },

  // ---------------------------------------------------------------- chimes
  {
    id: 'chimes-bronze',
    group: 'Chimes',
    title: 'Wind chimes, bronze',
    status: 'unheard',
    layers: ['chimes'],
    listenFor: 'Six tuned tubes struck by a wind you can\'t hear. Notice strike timing: clumps, gaps and how they bunch with gusts.',
    question: 'Real chimes in a breeze, or a random note generator?',
    realLabel: 'Sounds like chimes',
    scene: { label: 'chimes', scale: 'aMajPent', mix: { ...only('chimes'), chimes: { on: true, send: 0.2 } }, wind: { amount: 0.5, gustiness: 0.7 }, chimes: { brightness: 0.5 } },
    tune: [LEVEL('chimes'), { path: 'chimes.sustain', label: 'Ring', min: 0.3, max: 4, step: 0.01, fmt: times }, { path: 'chimes.activity', label: 'Clapper energy', min: 0.2, max: 4, step: 0.01, fmt: times }, { path: 'chimes.threshold', label: 'Sensitivity', min: 0, max: 1, step: 0.01, invert: true, fmt: pct }, { path: 'wind.amount', label: 'Wind strength', min: 0, max: 1, step: 0.01, fmt: pct }],
  },
  {
    id: 'chimes-wood',
    group: 'Chimes',
    title: 'Wood-like chimes',
    status: 'unheard',
    layers: ['chimes'],
    listenFor: 'Mellow, dry and short. Bamboo more than bronze.',
    question: 'Does the material change feel real, or just a filter?',
    realLabel: 'Sounds like wood',
    scene: { label: 'wood', scale: 'dPent', mix: only('chimes'), wind: { amount: 0.5, gustiness: 0.7 }, chimes: { brightness: 0.05, sustain: 0.5 } },
    tune: [LEVEL('chimes'), { path: 'chimes.brightness', label: 'Material', min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.3 ? 'wood-like' : v < 0.7 ? 'bronze' : 'aluminium') }, { path: 'chimes.sustain', label: 'Ring', min: 0.3, max: 4, step: 0.01, fmt: times }],
  },
  {
    id: 'chimes-bright',
    group: 'Chimes',
    title: 'Bright aluminium chimes',
    status: 'unheard',
    layers: ['chimes'],
    listenFor: 'Long, shimmering, glassy rings with lots of upper partials.',
    question: 'Shimmering, or piercing?',
    realLabel: 'Sounds like metal chimes',
    scene: { label: 'bright', scale: 'aMajPent', mix: only('chimes'), wind: { amount: 0.5, gustiness: 0.7 }, chimes: { brightness: 1, sustain: 2 } },
    tune: [LEVEL('chimes'), { path: 'chimes.brightness', label: 'Material', min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.3 ? 'wood-like' : v < 0.7 ? 'bronze' : 'aluminium') }, { path: 'chimes.sustain', label: 'Ring', min: 0.3, max: 4, step: 0.01, fmt: times }],
  },
  {
    id: 'chimes-light',
    group: 'Chimes',
    title: 'Chimes in light air',
    status: 'unheard',
    layers: ['chimes'],
    listenFor: 'Barely any wind, so expect long silences: about 8 strikes a minute, in bunches. Give it a full minute. A few stray touches would be right; a constant tinkle would be wrong.',
    question: 'Is the quiet-wind behaviour believable?',
    realLabel: 'Sounds like chimes',
    scene: { label: 'light', scale: 'dPent', mix: only('chimes'), wind: { amount: 0.25, gustiness: 0.6 } },
    tune: [LEVEL('chimes'), { path: 'wind.amount', label: 'Wind strength', min: 0, max: 1, step: 0.01, fmt: pct }, { path: 'chimes.threshold', label: 'Sensitivity', min: 0, max: 1, step: 0.01, invert: true, fmt: pct }],
  },

  // ---------------------------------------------------------------- music
  {
    id: 'music-pad',
    group: 'Music',
    title: 'Pad only',
    status: 'unheard',
    listenFor: 'Slow gliding chords that change every half minute or so. Give it a couple of minutes.',
    layers: ['music'],
    question: 'Warm and calming, or buzzy and synthetic?',
    realLabel: 'Musical',
    scene: { label: 'pad', scale: 'dPent', mix: only('music'), music: { keysLevel: 0, density: 0, brightness: 0.35 } },
    tune: [LEVEL('music'), { path: 'music.brightness', label: 'Brightness', min: 0, max: 1, step: 0.01, fmt: pct }, { path: 'music.detune', label: 'Detune', min: 0, max: 60, step: 0.5, fmt: (v) => `${v.toFixed(1)} cents` }, { path: 'music.chordSeconds', label: 'Chord change', min: 8, max: 120, step: 1, fmt: (v) => `~${Math.round(v)} s` }],
  },
  {
    id: 'music-keys',
    group: 'Music',
    title: 'Keys only',
    status: 'unheard',
    layers: ['music'],
    listenFor: 'Sparse FM keys with a slow breath: clusters of notes, then rests.',
    question: 'Pleasing phrases, or random plinking?',
    realLabel: 'Musical',
    scene: { label: 'keys', scale: 'dPent', mix: only('music'), music: { padLevel: 0, density: 12 } },
    tune: [LEVEL('music'), { path: 'music.density', label: 'Notes', min: 0, max: 40, step: 0.5, fmt: (v) => `${v.toFixed(1)} / min` }, { path: 'music.keysRatio', label: 'Keys timbre', min: 0.5, max: 7, step: 0.01, fmt: (v) => `FM ${v.toFixed(2)}` }, { path: 'music.keysOctave', label: 'Register', min: 1, max: 4, step: 1, fmt: (v) => `+${Math.round(v)} oct` }],
  },
  {
    id: 'music-both',
    group: 'Music',
    title: 'Pad and keys together',
    status: 'unheard',
    layers: ['music'],
    listenFor: 'The music layer as it ships. Do the keys sit inside the pad or on top of it?',
    question: 'Would you put this on for an hour?',
    realLabel: 'Musical',
    scene: { label: 'music', scale: 'dPent', mix: only('music'), music: { density: 8, brightness: 0.35 } },
    tune: [LEVEL('music'), { path: 'music.padLevel', label: 'Pad', min: 0, max: 2, step: 0.01, fmt: times }, { path: 'music.keysLevel', label: 'Keys', min: 0, max: 2, step: 0.01, fmt: times }, { path: 'music.density', label: 'Notes', min: 0, max: 40, step: 0.5, fmt: (v) => `${v.toFixed(1)} / min` }],
  },
  {
    id: 'music-lydian',
    group: 'Music',
    title: 'Keys in F Lydian',
    status: 'unheard',
    layers: ['music'],
    listenFor: 'The same engine in a brighter, more open key.',
    question: 'Is the key doing what you expect, or do all keys sound alike?',
    realLabel: 'Musical',
    scene: { label: 'lydian', scale: 'fLydian', mix: only('music'), music: { density: 10, brightness: 0.45 } },
    tune: [LEVEL('music'), { path: 'music.density', label: 'Notes', min: 0, max: 40, step: 0.5, fmt: (v) => `${v.toFixed(1)} / min` }, { path: 'music.brightness', label: 'Pad brightness', min: 0, max: 1, step: 0.01, fmt: pct }],
  },
];

// ---------------------------------------------------------------- whole scenes
const SCENE_NOTES: string[] = [
  'The default. Are all four layers audible, and does anything mask something else?',
  'Rain leading, music underneath.',
  'The loudest scene. Is it big without being fatiguing?',
  'Just wind and chimes. Do the chimes follow the gusts you can hear?',
  'Tin roof plus quiet music: the "late night in a shed" scene.',
  'Rain bubbles in key over a hush.',
  'Deliberately odd. Does it work as strange, or just as broken?',
  'Almost nothing. Is it still alive, or is it dead air?',
];

SCENES.forEach((scene, i) => {
  // Only the layers the scene actually plays: no point measuring or tweaking a muted one.
  const audible = LAYERS.filter((l) => sceneState(scene).world.mix[l].on);
  LAB_TESTS.push({
    id: `scene-${i}`,
    group: 'Whole scenes',
    title: scene.label,
    status: 'unheard',
    layers: audible,
    listenFor: scene.blurb ?? SCENE_NOTES[i] ?? '',
    question: 'Is the balance between layers right? Say which one should move.',
    realLabel: 'Sounds coherent',
    scene,
    tune: audible.map((l) => ({ path: `mix.${l}.level`, label: `${l[0].toUpperCase()}${l.slice(1)} level`, min: 0, max: 2, step: 0.01, fmt: db })),
  });
});

export const byId = (id: string): LabTest | undefined => LAB_TESTS.find((t) => t.id === id);
