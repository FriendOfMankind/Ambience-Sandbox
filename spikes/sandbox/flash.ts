/**
 * Flash meter after WCAG 2.3.1 (three flashes or below threshold).
 *
 * It watches a small, downscaled copy of each rendered frame. The screen is covered by
 * overlapping windows, each about a ninth of the screen (a stand-in for WCAG's "25% of a
 * 10° visual field", which is 341 × 256 px on a 1024 × 768 screen, or 11% of it). For each
 * window it tracks the mean relative luminance over time and counts transitions: a change of
 * at least 0.1 between a peak and a valley where the darker side is below 0.8. A flash is a
 * pair of opposing transitions, so more than 6 transitions inside one second means more than
 * 3 flashes. Red flashes use the same idea on WCAG's saturated-red measure.
 *
 * The meter serves two roles: the live view uses `pressure()` as a safety net to dim event
 * visuals before a limit is reached, and tests read `worst()` to check the design itself.
 */

export interface FlashReport {
  /** Most general flashes seen in any one-second window, in any screen region. */
  generalPerSecond: number;
  /** Same for red flashes. */
  redPerSecond: number;
  frames: number;
}

interface Track {
  /** Last extreme value and the direction we are moving away from it (1 up, -1 down, 0 unknown). */
  extreme: number;
  dir: number;
  /** Times of confirmed transitions. */
  transitions: number[];
}

/** sRGB 0..255 → linear 0..1. */
function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export class FlashMeter {
  private tracks: Track[] = [];
  private redTracks: Track[] = [];
  private worstGeneral = 0;
  private worstRed = 0;
  private frames = 0;
  private windows: { x0: number; y0: number; x1: number; y1: number }[] = [];

  constructor(
    private readonly w: number,
    private readonly h: number,
    /** Window positions per axis; windows overlap so a flash can't hide on a boundary. */
    steps = 7,
  ) {
    const ww = Math.ceil(w / 3);
    const wh = Math.ceil(h / 3);
    for (let j = 0; j < steps; j++) {
      for (let i = 0; i < steps; i++) {
        const x0 = Math.round((i / (steps - 1)) * (w - ww));
        const y0 = Math.round((j / (steps - 1)) * (h - wh));
        this.windows.push({ x0, y0, x1: x0 + ww, y1: y0 + wh });
      }
    }
    const blank = (): Track => ({ extreme: NaN, dir: 0, transitions: [] });
    this.tracks = this.windows.map(blank);
    this.redTracks = this.windows.map(blank);
  }

  /** Feed one RGBA8 frame (sRGB, row order irrelevant) captured at time `t` seconds. */
  push(t: number, rgba: Uint8Array | Uint8ClampedArray): void {
    const { w } = this;
    // Per-pixel luminance and red measure, then a summed-area table for fast window means.
    const n = w * this.h;
    const lum = new Float32Array(n);
    const red = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const r = rgba[p * 4];
      const g = rgba[p * 4 + 1];
      const b = rgba[p * 4 + 2];
      const R = lin(r);
      const G = lin(g);
      const B = lin(b);
      lum[p] = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      // WCAG: saturated red where R/(R+G+B) >= 0.8; measured as (R-G-B)*320 (0..320 scale).
      const sum = r + g + b;
      red[p] = sum > 0 && r / sum >= 0.8 ? Math.max(0, R - G - B) * 320 : 0;
    }
    this.windows.forEach((win, k) => {
      let sl = 0;
      let sr = 0;
      for (let y = win.y0; y < win.y1; y++) {
        for (let x = win.x0; x < win.x1; x++) {
          sl += lum[y * w + x];
          sr += red[y * w + x];
        }
      }
      const area = (win.x1 - win.x0) * (win.y1 - win.y0);
      this.step(this.tracks[k], t, sl / area, 0.1, true);
      this.step(this.redTracks[k], t, sr / area, 20, false);
    });
    this.frames++;
  }

  private step(tr: Track, t: number, v: number, delta: number, general: boolean): void {
    if (Number.isNaN(tr.extreme)) {
      tr.extreme = v;
      return;
    }
    // Follow the current run to its extreme; with no direction yet, the first value is the reference.
    if (tr.dir > 0 && v > tr.extreme) tr.extreme = v;
    else if (tr.dir < 0 && v < tr.extreme) tr.extreme = v;
    // A reversal large enough to count as a transition.
    const moved = v - tr.extreme;
    if (Math.abs(moved) >= delta && Math.sign(moved) !== tr.dir) {
      const darker = Math.min(v, tr.extreme);
      if (!general || darker < 0.8) tr.transitions.push(t);
      tr.dir = Math.sign(moved);
      tr.extreme = v;
    }
    while (tr.transitions.length && tr.transitions[0] < t - 1) tr.transitions.shift();
    const flashes = Math.floor(tr.transitions.length / 2);
    if (general) this.worstGeneral = Math.max(this.worstGeneral, flashes);
    else this.worstRed = Math.max(this.worstRed, flashes);
  }

  /** 0..1: how close the busiest region is to the limit right now (1 = at 3 flashes/s). */
  pressure(): number {
    let most = 0;
    for (const tr of this.tracks) most = Math.max(most, tr.transitions.length);
    for (const tr of this.redTracks) most = Math.max(most, tr.transitions.length);
    return Math.min(1, most / 6);
  }

  worst(): FlashReport {
    return { generalPerSecond: this.worstGeneral, redPerSecond: this.worstRed, frames: this.frames };
  }
}
