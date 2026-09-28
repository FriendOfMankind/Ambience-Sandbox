/** Scales shared by everything pitched in the world: rain-in-key, chimes, music. */

export interface ScaleSnap {
  enabled: boolean;
  rootHz: number;
  /** Scale degrees in cents within one period. */
  cents: number[];
  periodCents: number;
}

export interface ScaleDef extends ScaleSnap {
  label: string;
}

export const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
const edo = (n: number, steps: number[]) => steps.map((s) => (s * 1200) / n);

export const SCALES = {
  dPent: { label: 'D minor pentatonic', enabled: true, rootHz: hz(50), cents: [0, 300, 500, 700, 1000], periodCents: 1200 },
  dDorian: { label: 'D Dorian', enabled: true, rootHz: hz(50), cents: [0, 200, 300, 500, 700, 900, 1000], periodCents: 1200 },
  fLydian: { label: 'F Lydian', enabled: true, rootHz: hz(53), cents: [0, 200, 400, 600, 700, 900, 1100], periodCents: 1200 },
  aMajPent: { label: 'A major pentatonic', enabled: true, rootHz: hz(45), cents: [0, 200, 400, 700, 900], periodCents: 1200 },
  wholeTone: { label: 'Whole tone (dreamy)', enabled: true, rootHz: hz(48), cents: [0, 200, 400, 600, 800, 1000], periodCents: 1200 },
  just: {
    label: 'Harmonic series (just)',
    enabled: true,
    rootHz: hz(45),
    cents: [8, 9, 10, 11, 12, 13, 14, 15].map((h) => 1200 * Math.log2(h / 8)),
    periodCents: 1200,
  },
  edo19: { label: '19-EDO (strange)', enabled: true, rootHz: hz(50), cents: edo(19, [0, 3, 5, 8, 11, 14, 16]), periodCents: 1200 },
  cluster: { label: 'Microtonal cluster (eerie)', enabled: true, rootHz: hz(50), cents: [0, 35, 70, 105, 700, 735], periodCents: 1200 },
} satisfies Record<string, ScaleDef>;

export type ScaleKey = keyof typeof SCALES;

/** Frequency of scale step `step` (0 = root; negative and > length wrap into other octaves). */
export function scaleStepHz(scale: ScaleSnap, step: number): number {
  const n = scale.cents.length;
  const oct = Math.floor(step / n);
  const deg = ((step % n) + n) % n;
  return scale.rootHz * Math.pow(2, (oct * scale.periodCents + scale.cents[deg]) / 1200);
}

// ------------------------------------------------------------------ mood → scale

/** Modes on one root, darkest to brightest (each step raises one degree by a semitone). */
export const MODES = [
  { name: 'Phrygian', semis: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'Aeolian', semis: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Dorian', semis: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Mixolydian', semis: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'Ionian', semis: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'Lydian', semis: [0, 2, 4, 6, 7, 9, 11] },
] as const;

const PENTS = [
  { name: 'minor pentatonic', semis: [0, 3, 5, 7, 10] },
  { name: 'suspended pentatonic', semis: [0, 2, 5, 7, 10] },
  { name: 'major pentatonic', semis: [0, 2, 4, 7, 9] },
] as const;

/** 5-limit just ratios for each semitone above the root: beat-free thirds, fifths and sixths. */
const JUST = [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8];
const justCents = JUST.map((r) => 1200 * Math.log2(r));

export type ScaleFamily = 'modes' | 'pentatonic' | 'harmonic' | 'wholeTone' | 'edo19' | 'cluster';

export const FAMILIES: Record<ScaleFamily, string> = {
  modes: 'Modes (Light picks one)',
  pentatonic: 'Pentatonic',
  harmonic: 'Harmonic series',
  wholeTone: 'Whole tone (dreamy)',
  edo19: '19-EDO (strange)',
  cluster: 'Microtonal cluster (eerie)',
};

export const ROOT_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export interface KeySettings {
  /** Pitch class of the root, 0 = C. */
  root: number;
  family: ScaleFamily;
  /** 0..1, dark → bright: picks the mode (or pentatonic flavour). */
  light: number;
  /** 0..1: 0.5 = equal temperament, 1 = just intonation (no beating), below 0.5 = tempered further. */
  purity: number;
  /** Concert A: 440 (standard) or 432. */
  a4: 440 | 432;
}

export const DEFAULT_KEY: KeySettings = { root: 2, family: 'modes', light: 0.35, purity: 0.8, a4: 440 };

/** The mode (or flavour) name Light selects, for labels. */
export function lightName(k: Pick<KeySettings, 'family' | 'light'>): string {
  if (k.family === 'modes') return MODES[Math.min(MODES.length - 1, Math.floor(k.light * MODES.length))].name;
  if (k.family === 'pentatonic') return PENTS[Math.min(PENTS.length - 1, Math.floor(k.light * PENTS.length))].name;
  return FAMILIES[k.family];
}

/**
 * Build the world's scale from the mood settings. Diatonic and pentatonic degrees slide
 * between equal temperament (purity 0.5) and 5-limit just intonation (purity 1). Below 0.5
 * nothing changes here; the music layer detunes its voices instead.
 */
export function buildScale(k: KeySettings): ScaleSnap {
  // Root in the octave from about 65 to 130 Hz (C2..B2).
  const rootHz = (k.a4 / 440) * hz(36 + (((k.root % 12) + 12) % 12));
  const pure = Math.max(0, Math.min(1, (k.purity - 0.5) * 2));
  const fromSemis = (semis: readonly number[]) => semis.map((s) => s * 100 + (justCents[s] - s * 100) * pure);
  let cents: number[];
  switch (k.family) {
    case 'modes':
      cents = fromSemis(MODES[Math.min(MODES.length - 1, Math.floor(k.light * MODES.length))].semis);
      break;
    case 'pentatonic':
      cents = fromSemis(PENTS[Math.min(PENTS.length - 1, Math.floor(k.light * PENTS.length))].semis);
      break;
    case 'harmonic':
      cents = SCALES.just.cents;
      break;
    case 'wholeTone':
      cents = SCALES.wholeTone.cents;
      break;
    case 'edo19':
      cents = SCALES.edo19.cents;
      break;
    default:
      cents = SCALES.cluster.cents;
  }
  return { enabled: true, rootHz, cents: [...cents], periodCents: 1200 };
}
