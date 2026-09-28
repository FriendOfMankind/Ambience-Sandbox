/**
 * Seeded, deterministic randomness.
 *
 * Every subsystem draws from its own named stream, derived from the world seed,
 * so adding a new layer never reshuffles the randomness of existing ones.
 * The generator is sfc32 (fast, small state, good statistical quality);
 * seeds are hashed with cyrb128.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Pick an index with probability proportional to its weight. Returns -1 if all weights are 0. */
  weightedIndex(weights: readonly number[]): number;
  /** Standard normal sample (Box-Muller). */
  gaussian(): number;
  /** Exponential sample with the given rate (mean 1/rate). */
  exponential(rate: number): number;
  /** Serialisable state, so a stream can be restored exactly. */
  state(): [number, number, number, number];
}

/** cyrb128: hashes a string to four 32-bit words. */
export function hash128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function rngFromState(s: readonly [number, number, number, number]): Rng {
  let [a, b, c, d] = s;
  let spareGaussian: number | null = null;

  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weightedIndex: (weights) => {
      let total = 0;
      for (const w of weights) total += Math.max(0, w);
      if (total <= 0) return -1;
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= Math.max(0, weights[i]);
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
    gaussian: () => {
      if (spareGaussian !== null) {
        const g = spareGaussian;
        spareGaussian = null;
        return g;
      }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const mag = Math.sqrt(-2 * Math.log(u));
      spareGaussian = mag * Math.sin(2 * Math.PI * v);
      return mag * Math.cos(2 * Math.PI * v);
    },
    exponential: (rate) => {
      let u = 0;
      while (u === 0) u = next();
      return -Math.log(u) / rate;
    },
    state: () => [a >>> 0, b >>> 0, c >>> 0, d >>> 0],
  };

  // Warm up: sfc32 recommends discarding the first outputs.
  for (let i = 0; i < 12; i++) next();
  return rng;
}

/** Create a named stream derived from a world seed. */
export function createRng(seed: string, stream = ''): Rng {
  return rngFromState(hash128(`${seed}::${stream}`));
}

/**
 * Shuffle bag: draws every item once in random order before any repeats,
 * and never returns the same item twice in a row across refills.
 */
export class ShuffleBag<T> {
  private bag: T[] = [];
  private last: T | undefined;

  constructor(
    private readonly items: readonly T[],
    private readonly rng: Rng,
  ) {
    if (items.length === 0) throw new Error('ShuffleBag needs at least one item');
  }

  next(): T {
    if (this.bag.length === 0) this.refill();
    const item = this.bag.pop() as T;
    this.last = item;
    return item;
  }

  private refill(): void {
    const b = [...this.items];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.next() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    // Items are popped from the end; avoid an immediate repeat across the refill boundary.
    if (b.length > 1 && b[b.length - 1] === this.last) {
      [b[0], b[b.length - 1]] = [b[b.length - 1], b[0]];
    }
    this.bag = b;
  }
}
