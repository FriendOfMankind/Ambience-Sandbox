import type { RainParams, ScaleSnap } from '../../src/audio/nature/rain/RainSynth';
import type { SurfaceId } from '../../src/audio/nature/rain/surfaces';

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const edo = (n: number, steps: number[]) => steps.map((s) => (s * 1200) / n);

export const SCALES: Record<string, ScaleSnap & { label: string }> = {
  off: { label: 'Off (physical pitches)', enabled: false, rootHz: hz(62), cents: [0], periodCents: 1200 },
  dPent: { label: 'D minor pentatonic', enabled: true, rootHz: hz(62), cents: [0, 300, 500, 700, 1000], periodCents: 1200 },
  dDorian: { label: 'D Dorian', enabled: true, rootHz: hz(62), cents: [0, 200, 300, 500, 700, 900, 1000], periodCents: 1200 },
  fLydian: { label: 'F Lydian', enabled: true, rootHz: hz(65), cents: [0, 200, 400, 600, 700, 900, 1100], periodCents: 1200 },
  wholeTone: { label: 'Whole tone', enabled: true, rootHz: hz(60), cents: [0, 200, 400, 600, 800, 1000], periodCents: 1200 },
  just: {
    label: 'Just intonation (harmonics 8–15)',
    enabled: true,
    rootHz: hz(57),
    cents: [8, 9, 10, 11, 12, 13, 14, 15].map((h) => 1200 * Math.log2(h / 8)),
    periodCents: 1200,
  },
  edo19: { label: '19-EDO (strange)', enabled: true, rootHz: hz(62), cents: edo(19, [0, 3, 5, 8, 11, 14, 16]), periodCents: 1200 },
  cluster: { label: 'Microtonal cluster (eerie)', enabled: true, rootHz: hz(62), cents: [0, 35, 70, 105, 700, 735], periodCents: 1200 },
};

const mix = (m: Partial<Record<SurfaceId, number>>): Record<SurfaceId, number> => ({
  water: 0,
  leaves: 0,
  grass: 0,
  stone: 0,
  metal: 0,
  glass: 0,
  ...m,
});

type Preset = { label: string; params: Partial<RainParams>; scaleKey?: keyof typeof SCALES };

const natural: Partial<RainParams> = {
  sizeBias: 0,
  nearLevel: 1,
  midLevel: 1,
  farLevel: 1,
  nearDensity: 1,
  midDensity: 1,
  bubblePitch: 0,
  bubbleGlide: 0.1,
  stretch: 1,
  grid: { enabled: false, bpm: 72, division: 4 },
};

export const PRESETS: Preset[] = [
  { label: 'Lake drizzle', params: { ...natural, rate: 0.8, wind: 0.2, surfaceMix: mix({ water: 1, leaves: 0.2 }) }, scaleKey: 'off' },
  { label: 'Steady on the lake', params: { ...natural, rate: 5, wind: 0.3, surfaceMix: mix({ water: 0.6, leaves: 0.3, grass: 0.1, stone: 0.05 }) }, scaleKey: 'off' },
  { label: 'Forest downpour', params: { ...natural, rate: 40, wind: 0.6, surfaceMix: mix({ leaves: 1, water: 0.2, grass: 0.4 }) }, scaleKey: 'off' },
  { label: 'Tin roof', params: { ...natural, rate: 12, wind: 0.3, surfaceMix: mix({ metal: 1, stone: 0.2 }) }, scaleKey: 'off' },
  { label: 'Rainy window', params: { ...natural, rate: 6, wind: 0.4, farLevel: 0.6, surfaceMix: mix({ glass: 1, metal: 0.15 }) }, scaleKey: 'off' },
  {
    label: 'Rain in key',
    params: { ...natural, rate: 3, wind: 0.2, nearDensity: 2, midLevel: 0.4, farLevel: 0.3, stretch: 2, surfaceMix: mix({ water: 1 }) },
    scaleKey: 'dPent',
  },
  {
    label: 'Rain on the grid',
    params: {
      ...natural,
      rate: 6,
      wind: 0.1,
      nearLevel: 1.3,
      midLevel: 0.5,
      surfaceMix: mix({ water: 0.5, metal: 0.5 }),
      grid: { enabled: true, bpm: 84, division: 4 },
    },
    scaleKey: 'fLydian',
  },
  {
    label: 'Giant slow drops',
    params: { ...natural, rate: 2, sizeBias: 2, stretch: 8, bubblePitch: -1.5, nearDensity: 0.6, surfaceMix: mix({ water: 1 }) },
    scaleKey: 'off',
  },
  {
    label: 'Haunted gutter',
    params: { ...natural, rate: 4, bubbleGlide: 1.5, bubblePitch: -1, stretch: 5, midLevel: 0.3, surfaceMix: mix({ water: 0.7, glass: 0.4 }) },
    scaleKey: 'cluster',
  },
  { label: 'Wall of water', params: { ...natural, rate: 300, wind: 0.9, surfaceMix: mix({ water: 0.5, leaves: 0.5, stone: 0.3 }) }, scaleKey: 'off' },
];
