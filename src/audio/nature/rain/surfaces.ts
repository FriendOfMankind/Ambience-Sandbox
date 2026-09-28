/**
 * Surface models for drop impacts. Values are tuned by ear, not measured.
 *
 * - impact*: a short noise burst through a band-pass (the "tick" of the hit)
 * - modes: resonances excited by the impact (a sill ringing, glass ticking)
 * - bubbleProb: chance that a drop entrains a ringing bubble (water only)
 */

export interface Mode {
  /** Frequency in Hz. */
  f: number;
  /** Decay time constant in ms. */
  tauMs: number;
  /** Relative amplitude. */
  amp: number;
}

export interface Surface {
  id: SurfaceId;
  label: string;
  impactHz: number;
  impactQ: number;
  impactDecayMs: number;
  impactGain: number;
  modes: readonly Mode[];
  /** Per-drop random detune of modes (fraction). Different spots on a surface ring differently. */
  modeJitter: number;
  bubbleProb: number;
  /**
   * If set, the surface is a fixed set of ringing objects shared by all drops (see ResonatorBank),
   * each transposed by up to ± this many octaves. Used for long-ringing surfaces.
   */
  bankSpreadOct?: number;
}

export const SURFACE_IDS = ['water', 'leaves', 'grass', 'stone', 'metal', 'glass'] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

export const SURFACES: Record<SurfaceId, Surface> = {
  water: {
    id: 'water',
    label: 'Water',
    impactHz: 900,
    impactQ: 0.8,
    impactDecayMs: 0.9,
    impactGain: 0.7,
    modes: [],
    modeJitter: 0,
    bubbleProb: 0.65,
  },
  leaves: {
    id: 'leaves',
    label: 'Leaves',
    impactHz: 3200,
    impactQ: 0.7,
    impactDecayMs: 1.6,
    impactGain: 1.0,
    modes: [
      { f: 1150, tauMs: 5, amp: 0.35 },
      { f: 2480, tauMs: 3.5, amp: 0.25 },
    ],
    modeJitter: 0.25,
    bubbleProb: 0,
  },
  grass: {
    id: 'grass',
    label: 'Grass',
    impactHz: 2400,
    impactQ: 0.5,
    impactDecayMs: 0.7,
    impactGain: 0.45,
    modes: [],
    modeJitter: 0,
    bubbleProb: 0,
  },
  stone: {
    id: 'stone',
    label: 'Stone',
    impactHz: 5200,
    impactQ: 0.6,
    impactDecayMs: 0.35,
    impactGain: 1.1,
    modes: [{ f: 3100, tauMs: 2.5, amp: 0.3 }],
    modeJitter: 0.2,
    bubbleProb: 0,
  },
  metal: {
    id: 'metal',
    label: 'Metal sill',
    impactHz: 4000,
    impactQ: 1.2,
    impactDecayMs: 0.5,
    impactGain: 0.8,
    modes: [
      { f: 523, tauMs: 160, amp: 0.5 },
      { f: 1371, tauMs: 110, amp: 0.4 },
      { f: 2712, tauMs: 70, amp: 0.3 },
      { f: 4410, tauMs: 45, amp: 0.2 },
    ],
    modeJitter: 0.03,
    bubbleProb: 0,
    bankSpreadOct: 0.4,
  },
  glass: {
    id: 'glass',
    label: 'Glass',
    impactHz: 6000,
    impactQ: 1.0,
    impactDecayMs: 0.3,
    impactGain: 0.7,
    modes: [
      { f: 2210, tauMs: 35, amp: 0.35 },
      { f: 5430, tauMs: 22, amp: 0.25 },
      { f: 8690, tauMs: 14, amp: 0.15 },
    ],
    modeJitter: 0.08,
    bubbleProb: 0,
    bankSpreadOct: 0.3,
  },
};
