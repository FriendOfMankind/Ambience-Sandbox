/**
 * Stereo reverb: an 8-line feedback delay network (FDN) with a Hadamard mixing matrix,
 * per-line damping and slow delay-length modulation (to avoid metallic ringing).
 * Decay is set as T60, the time for the tail to fall by 60 dB.
 * One shared instance is the world's "space"; layers send into it.
 */

const LINES = 8;
/** Delay lengths in ms: mutually prime-ish so echoes don't pile up. */
const LENGTHS_MS = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.1, 73.3];
const MOD_DEPTH_MS = 0.6;

export interface ReverbParams {
  /** Seconds to decay by 60 dB. */
  t60: number;
  /** High-frequency damping 0..1 (1 = dark). */
  damping: number;
  /** Room size multiplier on delay lengths (0.5..2). */
  size: number;
  predelayMs: number;
}

export const DEFAULT_REVERB_PARAMS: ReverbParams = { t60: 4.5, damping: 0.45, size: 1.2, predelayMs: 25 };

export class Reverb {
  private p: ReverbParams = { ...DEFAULT_REVERB_PARAMS };
  private readonly buf: Float32Array[];
  private readonly mask: number;
  private pos = 0;
  private readonly lenSamples = new Float64Array(LINES);
  private readonly fb = new Float64Array(LINES);
  private readonly lp = new Float64Array(LINES);
  private lpCoef = 0;
  private readonly pre: Float32Array;
  private readonly preMask: number;
  private preDelay = 0;
  private lfoPhase = 0;
  private readonly tmp = new Float64Array(LINES);

  constructor(
    private readonly fs: number,
    params?: Partial<ReverbParams>,
  ) {
    const maxLen = Math.ceil(((Math.max(...LENGTHS_MS) * 2 + MOD_DEPTH_MS * 2) / 1000) * fs) + 4;
    let size = 1;
    while (size < maxLen) size <<= 1;
    this.mask = size - 1;
    this.buf = Array.from({ length: LINES }, () => new Float32Array(size));
    let preSize = 1;
    while (preSize < fs * 0.2) preSize <<= 1;
    this.pre = new Float32Array(preSize * 2); // stereo interleaved
    this.preMask = preSize - 1;
    this.setParams(params ?? {});
  }

  setParams(patch: Partial<ReverbParams>): void {
    this.p = { ...this.p, ...patch };
    const p = this.p;
    const size = Math.max(0.5, Math.min(2, p.size));
    for (let i = 0; i < LINES; i++) {
      this.lenSamples[i] = (LENGTHS_MS[i] * size * this.fs) / 1000;
      // Gain per pass so the loop decays by 60 dB in t60 seconds.
      this.fb[i] = Math.pow(10, (-3 * this.lenSamples[i]) / (Math.max(0.1, p.t60) * this.fs));
    }
    const cutoff = 12000 * Math.pow(0.08, Math.max(0, Math.min(1, p.damping)));
    this.lpCoef = Math.exp((-2 * Math.PI * cutoff) / this.fs);
    this.preDelay = Math.min(this.preMask, Math.round((p.predelayMs / 1000) * this.fs));
  }

  /** Process a block: reads inL/inR, writes the wet signal only into outL/outR. */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number): void {
    const lfoInc = (2 * Math.PI * 0.13) / this.fs;
    const modDepth = (MOD_DEPTH_MS / 1000) * this.fs;
    const x = this.tmp;
    for (let n = 0; n < frames; n++) {
      // Predelay (stereo).
      const w = (this.pos & this.preMask) * 2;
      this.pre[w] = inL[n];
      this.pre[w + 1] = inR[n];
      const r = ((this.pos - this.preDelay) & this.preMask) * 2;
      const dl = this.pre[r];
      const dr = this.pre[r + 1];

      this.lfoPhase += lfoInc;
      if (this.lfoPhase > 2 * Math.PI) this.lfoPhase -= 2 * Math.PI;

      // Read each line (fractional, modulated), damp, apply feedback gain.
      for (let i = 0; i < LINES; i++) {
        const mod = Math.sin(this.lfoPhase + i * 0.785) * modDepth;
        const d = this.lenSamples[i] + mod;
        const di = Math.floor(d);
        const frac = d - di;
        const b = this.buf[i];
        const a0 = b[(this.pos - di) & this.mask];
        const a1 = b[(this.pos - di - 1) & this.mask];
        let v = a0 + (a1 - a0) * frac;
        this.lp[i] = (1 - this.lpCoef) * v + this.lpCoef * this.lp[i];
        v = this.lp[i] * this.fb[i];
        x[i] = v;
      }

      // Output taps before mixing: even lines left, odd lines right.
      outL[n] = (x[0] + x[2] + x[4] + x[6]) * 0.35;
      outR[n] = (x[1] + x[3] + x[5] + x[7]) * 0.35;

      // Fast Walsh–Hadamard transform (orthogonal mixing), normalised by 1/√8.
      for (let h = 1; h < LINES; h <<= 1) {
        for (let i = 0; i < LINES; i += h << 1) {
          for (let j = i; j < i + h; j++) {
            const a = x[j];
            const c = x[j + h];
            x[j] = a + c;
            x[j + h] = a - c;
          }
        }
      }
      const norm = 1 / Math.sqrt(LINES);
      for (let i = 0; i < LINES; i++) {
        const input = i % 2 === 0 ? dl : dr;
        this.buf[i][this.pos & this.mask] = x[i] * norm + input * 0.5;
      }
      this.pos++;
    }
    if (!Number.isFinite(this.lp[0])) this.clear();
  }

  clear(): void {
    for (const b of this.buf) b.fill(0);
    this.lp.fill(0);
    this.pre.fill(0);
  }
}
