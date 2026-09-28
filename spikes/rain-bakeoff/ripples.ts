/**
 * Minimal visual: a dark lake where every near drop the synth plays appears as a ripple
 * (water) or a small splash (other surfaces), at the moment you hear it.
 * This is the "causality over reactivity" coupling from the plan, in its simplest form.
 */

import type { RainEvent } from '../../src/audio/nature/rain/RainSynth';

interface Ripple {
  x: number;
  y: number;
  born: number;
  size: number;
  water: boolean;
}

export class RippleView {
  private ripples: Ripple[] = [];
  private queue: { time: number; e: RainEvent }[] = [];
  private raf = 0;
  private readonly ctx2d: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly audioNow: () => number,
    private readonly reducedMotion: () => boolean,
  ) {
    this.ctx2d = canvas.getContext('2d')!;
  }

  /** Queue an event to appear when the audio clock reaches `time`. */
  push(e: RainEvent, time: number): void {
    this.queue.push({ time, e });
  }

  start(): void {
    const loop = () => {
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  }

  clear(): void {
    this.queue = [];
    this.ripples = [];
  }

  private frame(): void {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = this.ctx2d;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const now = this.audioNow();
    const due = this.queue.filter((q) => q.time <= now);
    this.queue = this.queue.filter((q) => q.time > now);
    for (const { e } of due) {
      // Deterministic depth from the event frame so the same seed draws the same picture.
      const depth = ((e.frame * 2654435761) >>> 0) / 4294967296;
      this.ripples.push({
        x: w * (0.5 + e.pan * 0.45),
        y: h * (0.35 + depth * 0.6),
        born: now,
        size: 6 + e.diameterMm * 7,
        water: e.surface === 'water',
      });
    }
    if (this.ripples.length > 400) this.ripples.splice(0, this.ripples.length - 400);

    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0b1620');
    grad.addColorStop(1, '#122634');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);

    const reduced = this.reducedMotion();
    const life = reduced ? 0.6 : 2.2;
    this.ripples = this.ripples.filter((r) => now - r.born < life);
    for (const r of this.ripples) {
      const age = (now - r.born) / life;
      const alpha = (1 - age) * 0.7;
      const perspective = 0.25 + ((r.y / h) - 0.35) * 0.6;
      if (r.water && !reduced) {
        const rad = r.size * (0.3 + age * 3);
        g.strokeStyle = `rgba(170, 205, 230, ${alpha})`;
        g.lineWidth = 1;
        g.beginPath();
        g.ellipse(r.x, r.y, rad, rad * perspective, 0, 0, Math.PI * 2);
        g.stroke();
        if (age < 0.5) {
          g.beginPath();
          g.ellipse(r.x, r.y, rad * 0.55, rad * 0.55 * perspective, 0, 0, Math.PI * 2);
          g.stroke();
        }
      } else {
        g.fillStyle = `rgba(200, 220, 235, ${alpha})`;
        g.beginPath();
        g.arc(r.x, r.y, 1.2 + r.size * 0.08, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}
