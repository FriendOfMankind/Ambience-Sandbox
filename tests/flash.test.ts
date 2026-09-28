import { describe, expect, it } from 'vitest';
import { FlashMeter } from '../spikes/sandbox/flash';

const W = 32;
const H = 18;

/** A frame whose left third (x < W/3) has grey `a` and red `r` (0..255); the rest is black. */
function frame(a: number, r = 0): Uint8Array {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inside = x < W / 3;
      px[i] = inside ? Math.max(a, r) : 0;
      px[i + 1] = inside ? a : 0;
      px[i + 2] = inside ? a : 0;
      px[i + 3] = 255;
    }
  }
  return px;
}

function run(fps: number, seconds: number, value: (t: number) => [number, number?]): FlashMeter {
  const m = new FlashMeter(W, H);
  for (let k = 0; k < fps * seconds; k++) {
    const t = k / fps;
    const [a, r] = value(t);
    m.push(t, frame(a, r));
  }
  return m;
}

describe('FlashMeter', () => {
  it('flags a large 5 Hz black/white strobe', () => {
    const m = run(60, 3, (t) => [Math.floor(t * 10) % 2 ? 255 : 0]);
    expect(m.worst().generalPerSecond).toBeGreaterThan(3);
  });

  it('passes a 2 Hz strobe (at the limit, not over)', () => {
    const m = run(60, 3, (t) => [Math.floor(t * 4) % 2 ? 255 : 0]);
    expect(m.worst().generalPerSecond).toBeLessThanOrEqual(3);
  });

  it('ignores small luminance wobble', () => {
    // Grey 40 ↔ 60 is a change in relative luminance of about 0.02, far below 0.1.
    const m = run(60, 3, (t) => [Math.floor(t * 12) % 2 ? 60 : 40]);
    expect(m.worst().generalPerSecond).toBe(0);
  });

  it('ignores slow breathing', () => {
    const m = run(60, 6, (t) => [128 + 127 * Math.sin(t * 2 * Math.PI * 0.4)]);
    expect(m.worst().generalPerSecond).toBeLessThanOrEqual(1);
  });

  it('flags a fast saturated red flash even when it is dark', () => {
    const m = run(60, 3, (t) => [0, Math.floor(t * 10) % 2 ? 255 : 0]);
    expect(m.worst().redPerSecond).toBeGreaterThan(3);
  });

  it('reports pressure while a strobe is running', () => {
    const m = run(60, 1, (t) => [Math.floor(t * 10) % 2 ? 255 : 0]);
    expect(m.pressure()).toBe(1);
  });
});
