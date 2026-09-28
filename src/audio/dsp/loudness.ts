/**
 * Ungated loudness in LUFS using ITU-R BS.1770 K-weighting.
 * Filter design follows the parametric form used by libebur128, so it works at any sample rate.
 * Ungated means it's fine for steady ambience; don't use it for programme material with silences.
 */

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function kWeightingFilters(fs: number): [Biquad, Biquad] {
  // Stage 1: high shelf (head acoustics).
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: high-pass (RLB weighting).
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  const K1 = Math.tan((Math.PI * f1) / fs);
  const d = 1 + K1 / Q1 + K1 * K1;
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K1 * K1 - 1)) / d,
    a2: (1 - K1 / Q1 + K1 * K1) / d,
  };
  return [shelf, hp];
}

function meanSquareK(x: Float32Array, fs: number): number {
  const [s1, s2] = kWeightingFilters(fs);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // stage 1 state
  let u1 = 0, u2 = 0, z1 = 0, z2 = 0; // stage 2 state
  let sum = 0;
  for (let n = 0; n < x.length; n++) {
    const xn = x[n];
    const y = s1.b0 * xn + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
    x2 = x1; x1 = xn; y2 = y1; y1 = y;
    const z = s2.b0 * y + s2.b1 * u1 + s2.b2 * u2 - s2.a1 * z1 - s2.a2 * z2;
    u2 = u1; u1 = y; z2 = z1; z1 = z;
    sum += z * z;
  }
  return x.length > 0 ? sum / x.length : 0;
}

/** Ungated integrated loudness (LUFS) of one or more channels. */
export function loudnessLufs(channels: Float32Array[], fs: number): number {
  let total = 0;
  for (const ch of channels) total += meanSquareK(ch, fs);
  if (total <= 0) return -Infinity;
  return -0.691 + 10 * Math.log10(total);
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(g, 1e-12));
