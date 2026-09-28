/**
 * Lookahead brick-wall limiter with a non-finite-sample guard.
 *
 * Guarantee: output sample peaks never exceed `ceiling` (sample-peak, not true-peak).
 *
 * How: the signal is delayed by L samples. For each incoming sample we compute the gain
 * needed to keep it under the ceiling, take the minimum over a window of L+1 samples,
 * then smooth that with an L-sample moving average. The average at the moment a peak
 * leaves the delay line only contains window-minimums that already include the peak, so
 * the applied gain is always low enough. Release is a slow exponential on top.
 *
 * NaN/Inf guard: any non-finite input mutes the output for `muteMs`, clears all state,
 * and increments `nanEvents`. One NaN in a filter can otherwise silence a whole graph.
 */

export interface LimiterOptions {
  sampleRate: number;
  /** Linear ceiling. Default −1 dBFS. */
  ceiling?: number;
  lookaheadMs?: number;
  releaseMs?: number;
  muteMs?: number;
}

export class Limiter {
  readonly ceiling: number;
  readonly lookahead: number;
  nanEvents = 0;
  /** Lowest gain applied since the last call to `takeMinGain`. */
  private minGain = 1;

  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private readonly minVal: Float64Array; // deque values
  private readonly minIdx: Float64Array; // deque sample indices
  private dqHead = 0;
  private dqTail = 0;
  private readonly box: Float64Array;
  private boxSum = 0;
  private boxPos = 0;
  private writePos = 0;
  private sampleIndex = 0;
  private gain = 1;
  private readonly releaseCoef: number;
  private muteLeft = 0;
  private readonly muteSamples: number;

  constructor(opts: LimiterOptions) {
    const fs = opts.sampleRate;
    this.ceiling = opts.ceiling ?? Math.pow(10, -1 / 20);
    this.lookahead = Math.max(1, Math.round(((opts.lookaheadMs ?? 5) / 1000) * fs));
    this.releaseCoef = 1 - Math.exp(-1 / (((opts.releaseMs ?? 250) / 1000) * fs));
    this.muteSamples = Math.round(((opts.muteMs ?? 50) / 1000) * fs);
    this.delayL = new Float32Array(this.lookahead);
    this.delayR = new Float32Array(this.lookahead);
    const dqSize = this.lookahead + 2;
    this.minVal = new Float64Array(dqSize);
    this.minIdx = new Float64Array(dqSize);
    this.box = new Float64Array(this.lookahead);
    this.reset();
  }

  reset(): void {
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.box.fill(1);
    this.boxSum = this.lookahead;
    this.boxPos = 0;
    this.writePos = 0;
    this.dqHead = 0;
    this.dqTail = 0;
    this.gain = 1;
  }

  /** Returns and resets the minimum gain applied since the previous call. */
  takeMinGain(): number {
    const g = this.minGain;
    this.minGain = 1;
    return g;
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames = inL.length): void {
    const L = this.lookahead;
    const dqCap = this.minVal.length;
    for (let n = 0; n < frames; n++) {
      let xl = inL[n];
      let xr = inR[n];
      if (!Number.isFinite(xl) || !Number.isFinite(xr)) {
        if (this.muteLeft === 0) this.nanEvents++;
        this.reset();
        this.muteLeft = this.muteSamples;
        xl = 0;
        xr = 0;
      }

      // Required gain for this incoming sample.
      const peak = Math.max(Math.abs(xl), Math.abs(xr));
      const req = peak > this.ceiling ? this.ceiling / peak : 1;

      // Sliding-window minimum over the last L+1 samples (monotonic deque).
      const i = this.sampleIndex++;
      while (this.dqTail !== this.dqHead) {
        const last = (this.dqTail - 1 + dqCap) % dqCap;
        if (this.minVal[last] >= req) this.dqTail = last;
        else break;
      }
      this.minVal[this.dqTail] = req;
      this.minIdx[this.dqTail] = i;
      this.dqTail = (this.dqTail + 1) % dqCap;
      while (this.minIdx[this.dqHead] < i - L) this.dqHead = (this.dqHead + 1) % dqCap;
      const windowMin = this.minVal[this.dqHead];

      // L-sample moving average of the window minimum.
      this.boxSum += windowMin - this.box[this.boxPos];
      this.box[this.boxPos] = windowMin;
      this.boxPos = (this.boxPos + 1) % L;
      const smoothed = Math.min(1, this.boxSum / L);

      // Attack follows the smoothed curve exactly; release creeps back up slowly.
      if (smoothed < this.gain) this.gain = smoothed;
      else this.gain += (smoothed - this.gain) * this.releaseCoef;
      if (this.gain < this.minGain) this.minGain = this.gain;

      // Delay line.
      const dl = this.delayL[this.writePos];
      const dr = this.delayR[this.writePos];
      this.delayL[this.writePos] = xl;
      this.delayR[this.writePos] = xr;
      this.writePos = (this.writePos + 1) % L;

      if (this.muteLeft > 0) {
        this.muteLeft--;
        outL[n] = 0;
        outR[n] = 0;
      } else {
        // Clamp guards against float rounding in the running sum.
        const c = this.ceiling;
        outL[n] = Math.max(-c, Math.min(c, dl * this.gain));
        outR[n] = Math.max(-c, Math.min(c, dr * this.gain));
      }
    }
  }
}
