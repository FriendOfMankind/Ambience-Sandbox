/**
 * BedPlayer: turns a finite recording into an endless, non-repeating bed.
 *
 * Plays random segments of the recording back to back with long, randomised
 * equal-power crossfades. Segments are drawn from a shuffle bag of regions, so the
 * whole file gets used before any region repeats, and never the same region twice
 * in a row. Rain at different offsets is uncorrelated, which is what makes equal-power
 * crossfades sound seamless (no dip, no bump).
 *
 * Scheduling is done ahead on the audio clock from a coarse timer, so main-thread
 * jank or background-tab timer throttling doesn't cause gaps.
 */

import { createRng, ShuffleBag, type Rng } from '../../core/rng';

export interface BedPlayerOptions {
  seed: string;
  /** Segment length range in seconds (clamped for short files). */
  segmentSeconds?: [number, number];
  /** Crossfade length range in seconds (clamped to a third of the segment). */
  crossfadeSeconds?: [number, number];
  /** How far ahead to schedule, in seconds. */
  lookaheadSeconds?: number;
}

export interface BedSegmentInfo {
  offset: number;
  duration: number;
  crossfade: number;
  region: number;
}

const CURVE_POINTS = 256;

export class BedPlayer {
  readonly output: GainNode;
  /** Most recently scheduled segments (for debugging and loop analysis). */
  readonly history: BedSegmentInfo[] = [];

  private readonly rng: Rng;
  private bag: ShuffleBag<number> | null = null;
  private regionCount = 0;
  private buffer: AudioBuffer | null = null;
  private nextStart = 0;
  /** Fade-in length for the next segment: the crossfade chosen for the transition into it. */
  private nextFadeIn = 2;
  private timer: ReturnType<typeof setInterval> | null = null;
  private live: { src: AudioBufferSourceNode; gain: GainNode }[] = [];
  private readonly segRange: [number, number];
  private readonly xfRange: [number, number];
  private readonly lookahead: number;
  private readonly fadeIn: Float32Array;
  private readonly fadeOut: Float32Array;

  constructor(
    private readonly ctx: BaseAudioContext,
    opts: BedPlayerOptions,
  ) {
    this.rng = createRng(opts.seed, 'bed');
    this.segRange = opts.segmentSeconds ?? [15, 40];
    this.xfRange = opts.crossfadeSeconds ?? [4, 10];
    this.lookahead = opts.lookaheadSeconds ?? 3;
    this.output = ctx.createGain();
    this.fadeIn = new Float32Array(CURVE_POINTS);
    this.fadeOut = new Float32Array(CURVE_POINTS);
    for (let i = 0; i < CURVE_POINTS; i++) {
      const t = i / (CURVE_POINTS - 1);
      this.fadeIn[i] = Math.sin((t * Math.PI) / 2);
      this.fadeOut[i] = Math.cos((t * Math.PI) / 2);
    }
  }

  get loaded(): boolean {
    return this.buffer !== null;
  }

  get durationSeconds(): number {
    return this.buffer?.duration ?? 0;
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
    // Regions roughly 10 s wide; at least 3 so short files still shuffle.
    this.regionCount = Math.max(3, Math.floor(buffer.duration / 10));
    this.bag = new ShuffleBag(
      Array.from({ length: this.regionCount }, (_, i) => i),
      this.rng,
    );
  }

  start(): void {
    if (!this.buffer || this.timer !== null) return;
    const t = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(t);
    this.output.gain.setValueAtTime(1, t);
    this.nextStart = t + 0.05;
    this.nextFadeIn = 2; // gentle start from silence
    this.scheduleAhead();
    this.timer = setInterval(() => this.scheduleAhead(), 250);
  }

  /**
   * Stop with a short fade. The fade runs on the output gain, because the per-segment
   * gains carry value curves that can't be interrupted portably.
   */
  stop(fadeSeconds = 0.5): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const t = this.ctx.currentTime;
    const g = this.output.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fadeSeconds);
    for (const { src } of this.live) {
      try {
        src.stop(t + fadeSeconds + 0.05);
      } catch {
        // already stopped
      }
    }
    this.live = [];
  }

  private scheduleAhead(): void {
    while (this.buffer && this.nextStart < this.ctx.currentTime + this.lookahead) {
      this.scheduleSegment(this.nextStart);
    }
  }

  private scheduleSegment(when: number): void {
    const buf = this.buffer!;
    const dur = buf.duration;
    const rng = this.rng;

    // Clamp ranges for short recordings.
    const segMax = Math.min(this.segRange[1], dur * 0.7);
    const segMin = Math.min(this.segRange[0], segMax);
    // Long enough to hold the incoming fade (always true unless the file is very short).
    const seg = Math.max(rng.range(segMin, segMax), Math.min(3 * this.nextFadeIn, segMax));
    // The outgoing fade of this segment and the incoming fade of the next must be the same
    // length, or the equal-power sum dips/bumps at the seam. So the crossfade is chosen per
    // transition: this segment fades in over the previous choice and out over a new one.
    const fadeInSec = Math.min(this.nextFadeIn, seg / 3);
    const xfMax = Math.min(this.xfRange[1], seg / 3);
    const xfMin = Math.min(this.xfRange[0], xfMax);
    const xf = rng.range(xfMin, xfMax);

    // Pick a region, then a random offset such that the segment starts inside it.
    const region = this.bag!.next();
    const regionWidth = dur / this.regionCount;
    const maxOffset = Math.max(0, dur - seg);
    const offset = Math.min(maxOffset, region * regionWidth + rng.next() * regionWidth);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.output);

    gain.gain.setValueCurveAtTime(this.fadeIn, when, fadeInSec);
    gain.gain.setValueCurveAtTime(this.fadeOut, when + seg - xf, xf);
    src.start(when, offset, seg + 0.05);
    src.stop(when + seg + 0.1);

    const entry = { src, gain };
    this.live.push(entry);
    src.onended = () => {
      this.live = this.live.filter((e) => e !== entry);
      src.disconnect();
      gain.disconnect();
    };

    this.history.push({ offset, duration: seg, crossfade: xf, region });
    if (this.history.length > 200) this.history.shift();

    // The next segment starts as this one begins fading out, and fades in over the same time.
    this.nextStart = when + seg - xf;
    this.nextFadeIn = xf;
  }
}
