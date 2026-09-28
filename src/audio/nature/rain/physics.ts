/**
 * Rain physics helpers.
 *
 * Drop sizes follow the Marshall–Palmer distribution, N(D) = N0·exp(−ΛD),
 * N0 = 8000 m⁻³mm⁻¹, Λ = 4.1·R^−0.21 mm⁻¹ (R = rain rate in mm/h).
 * Terminal velocity uses the Atlas et al. (1973) fit, v = 9.65 − 10.3·exp(−0.6D) m/s.
 * These are real meteorology; everything downstream of them (loudness per drop,
 * audible areas) is an initial guess awaiting listening tests.
 */

import type { Rng } from '../../../core/rng';

export const MP_N0 = 8000; // m⁻³ mm⁻¹

/** Smallest and largest drop diameters we synthesise (mm). Smaller drops are inaudible. */
export const D_MIN = 0.3;
export const D_MAX = 6;

/** Marshall–Palmer slope Λ (mm⁻¹). `sizeBias` > 0 favours larger drops (sandbox control). */
export function mpLambda(rateMmH: number, sizeBias = 0): number {
  const r = Math.max(rateMmH, 0.01);
  return 4.1 * Math.pow(r, -0.21) * Math.pow(2, -sizeBias);
}

/** Terminal fall speed in m/s for diameter D in mm. */
export function terminalVelocity(dMm: number): number {
  return Math.max(0.1, 9.65 - 10.3 * Math.exp(-0.6 * dMm));
}

/**
 * Number of drops hitting 1 m² of ground per second, for drops within [D_MIN, D_MAX].
 * flux = ∫ N(D)·v(D) dD, integrated numerically.
 */
export function dropFlux(rateMmH: number, sizeBias = 0): number {
  if (rateMmH <= 0) return 0;
  const lambda = mpLambda(rateMmH, sizeBias);
  const steps = 200;
  const dD = (D_MAX - D_MIN) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const d = D_MIN + (i + 0.5) * dD;
    sum += MP_N0 * Math.exp(-lambda * d) * terminalVelocity(d) * dD;
  }
  return sum;
}

/**
 * Sample the diameter of a drop *arriving at the ground*. Arrivals are weighted by
 * fall speed (fast drops arrive more often), so we sample N(D) then accept with v(D)/vmax.
 */
export function sampleDropDiameter(rng: Rng, lambda: number): number {
  const span = 1 - Math.exp(-lambda * (D_MAX - D_MIN));
  const vMax = terminalVelocity(D_MAX);
  for (let tries = 0; tries < 16; tries++) {
    const d = D_MIN - Math.log(1 - rng.next() * span) / lambda;
    if (rng.next() * vMax <= terminalVelocity(d)) return d;
  }
  return D_MIN;
}

/**
 * Relative loudness of a single drop. Impact energy scales with D³·v²,
 * so amplitude ∝ D^1.5·v. Normalised so a 2 mm drop is 1.
 */
export function dropAmplitude(dMm: number): number {
  return Math.pow(dMm / 2, 1.5) * (terminalVelocity(dMm) / terminalVelocity(2));
}

/** Minnaert resonance of a gas bubble in water: f ≈ 3.26 / r Hz, r in metres. */
export function minnaertFrequency(radiusMm: number): number {
  return 3.26 / (radiusMm / 1000);
}

/**
 * Snap a frequency to the nearest pitch in a scale.
 * `cents` are scale degrees relative to `rootHz` within one period (usually 1200).
 */
export function snapToScale(freq: number, rootHz: number, cents: readonly number[], periodCents = 1200): number {
  if (cents.length === 0 || freq <= 0) return freq;
  const c = 1200 * Math.log2(freq / rootHz);
  const oct = Math.floor(c / periodCents);
  const rem = c - oct * periodCents;
  let best = cents[0];
  let bestDist = Infinity;
  for (const deg of cents) {
    // Consider the degree in this period and the next (wrap-around).
    for (const cand of [deg, deg + periodCents, deg - periodCents]) {
      const dist = Math.abs(cand - rem);
      if (dist < bestDist) {
        bestDist = dist;
        best = cand;
      }
    }
  }
  return rootHz * Math.pow(2, (oct * periodCents + best) / 1200);
}
