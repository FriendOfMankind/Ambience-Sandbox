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
