/**
 * Placeholder 2D scene. Each sound has its own visual, driven by the engine's events,
 * not by one mixed waveform:
 *  - rain drops  → ripples (water) or splashes, where and when you hear them
 *  - wind        → drifting streaks and swaying chime tubes
 *  - chime hits  → the struck tube glows, coloured by its pitch (pitch class → hue)
 *  - music notes → soft orbs, same pitch → hue mapping; chord changes shift the sky
 * The pitch → hue mapping is the seed of the planned synaesthetic 3D view.
 */

import type { WorldEvents, WorldFeatures } from '../../src/audio/world/WorldSynth';

interface Ripple { x: number; y: number; born: number; size: number; water: boolean }
interface Orb { x: number; y: number; born: number; hue: number; size: number }
interface Streak { x: number; y: number; len: number; speed: number }

/** Pitch class → hue: the same note always has the same colour, in any octave. */
export function pitchHue(hz: number): number {
  const pc = (((12 * Math.log2(hz / 261.63)) % 12) + 12) % 12;
  return (pc / 12) * 360;
}

export class SceneView {
  private ripples: Ripple[] = [];
  private orbs: Orb[] = [];
  private streaks: Streak[] = [];
  private queue: { time: number; draw: () => void }[] = [];
  private tubeGlow: number[] = [];
  private tubeHue: number[] = [];
  private tubeHz: number[] = [];
  private features: WorldFeatures | null = null;
  private skyHue = 215;
  private skyHueTarget = 215;
  private sway = 0;
  private swayVel = 0;
  private raf = 0;
  private readonly g: CanvasRenderingContext2D;
  private last = performance.now();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly audioNow: () => number,
    private readonly reducedMotion: () => boolean,
  ) {
    this.g = canvas.getContext('2d')!;
    for (let i = 0; i < 40; i++) this.streaks.push({ x: Math.random(), y: Math.random(), len: 0.03 + Math.random() * 0.08, speed: 0.5 + Math.random() });
  }

  setTubes(freqs: number[]): void {
    this.tubeHz = freqs;
    this.tubeHue = freqs.map(pitchHue);
    this.tubeGlow = freqs.map(() => 0);
  }

  /** Queue a batch of engine events; `timeOf(frame)` maps a sample frame to audio-clock time. */
  push(events: WorldEvents, features: WorldFeatures, timeOf: (frame: number) => number): void {
    this.features = features;
    const w = () => this.canvas.clientWidth;
    const h = () => this.canvas.clientHeight;
    for (const e of events.rain) {
      const depth = ((e.frame * 2654435761) >>> 0) / 4294967296;
      this.queue.push({
        time: timeOf(e.frame),
        draw: () => this.ripples.push({ x: w() * (0.5 + e.pan * 0.45), y: h() * (0.55 + depth * 0.42), born: this.audioNow(), size: 5 + e.diameterMm * 6, water: e.surface === 'water' }),
      });
    }
    for (const e of events.chimes) {
      this.queue.push({ time: timeOf(e.frame), draw: () => { if (e.tube < this.tubeGlow.length) this.tubeGlow[e.tube] = Math.max(this.tubeGlow[e.tube], e.velocity); } });
    }
    for (const e of events.music) {
      if (e.kind === 'chord') {
        this.queue.push({ time: timeOf(e.frame), draw: () => (this.skyHueTarget = pitchHue(e.hz)) });
      } else {
        const x = 0.15 + (((e.step * 0.618) % 1) + 1) % 1 * 0.6;
        this.queue.push({
          time: timeOf(e.frame),
          draw: () => this.orbs.push({ x: w() * x, y: h() * 0.52, born: this.audioNow(), hue: pitchHue(e.hz), size: 10 + e.velocity * 18 }),
        });
      }
    }
    if (this.queue.length > 1500) this.queue.splice(0, this.queue.length - 1500);
  }

  start(): void {
    cancelAnimationFrame(this.raf);
    const loop = () => {
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
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
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = this.audioNow();
    const t = performance.now();
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    const reduced = this.reducedMotion();

    const due = this.queue.filter((q) => q.time <= now);
    if (due.length) {
      this.queue = this.queue.filter((q) => q.time > now);
      for (const d of due) d.draw();
    }

    const f = this.features;
    const speed = f?.windSpeed ?? 0;

    // Sky and lake, tinted by the current chord.
    let dh = this.skyHueTarget - this.skyHue;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    this.skyHue = (this.skyHue + dh * Math.min(1, dt * 0.25) + 360) % 360;
    const sky = g.createLinearGradient(0, 0, 0, h * 0.5);
    sky.addColorStop(0, `hsl(${this.skyHue}, 18%, 9%)`);
    sky.addColorStop(1, `hsl(${this.skyHue}, 16%, 16%)`);
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h * 0.5);
    const lake = g.createLinearGradient(0, h * 0.5, 0, h);
    lake.addColorStop(0, `hsl(${this.skyHue}, 16%, 12%)`);
    lake.addColorStop(1, `hsl(${(this.skyHue + 10) % 360}, 20%, 6%)`);
    g.fillStyle = lake;
    g.fillRect(0, h * 0.5, w, h * 0.5);
    // Far shore
    g.fillStyle = `hsl(${this.skyHue}, 14%, 6%)`;
    g.beginPath();
    g.moveTo(0, h * 0.5);
    for (let i = 0; i <= 12; i++) g.lineTo((i / 12) * w, h * (0.5 - 0.04 - 0.05 * Math.abs(Math.sin(i * 1.7))));
    g.lineTo(w, h * 0.5);
    g.fill();

    // Wind streaks on the water.
    if (!reduced) {
      g.strokeStyle = `rgba(190, 210, 230, ${Math.min(0.18, speed * 0.2)})`;
      g.lineWidth = 1;
      for (const s of this.streaks) {
        s.x += dt * s.speed * speed * 0.12;
        if (s.x > 1.1) { s.x = -0.1; s.y = Math.random(); }
        const y = h * (0.55 + s.y * 0.43);
        g.beginPath();
        g.moveTo(s.x * w, y);
        g.lineTo((s.x + s.len * (0.5 + speed)) * w, y);
        g.stroke();
      }
    }

    // Ripples
    const rLife = reduced ? 0.6 : 2.2;
    this.ripples = this.ripples.filter((r) => now - r.born < rLife).slice(-400);
    for (const r of this.ripples) {
      const age = (now - r.born) / rLife;
      const alpha = (1 - age) * 0.65;
      const persp = 0.22 + ((r.y / h) - 0.55) * 0.5;
      if (r.water && !reduced) {
        const rad = r.size * (0.3 + age * 3);
        g.strokeStyle = `rgba(175, 205, 230, ${alpha})`;
        g.beginPath();
        g.ellipse(r.x, r.y, rad, rad * persp, 0, 0, Math.PI * 2);
        g.stroke();
      } else {
        g.fillStyle = `rgba(205, 220, 235, ${alpha})`;
        g.beginPath();
        g.arc(r.x, r.y, 1.2 + r.size * 0.07, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Music orbs: rise and fade; colour = pitch.
    const oLife = reduced ? 1.5 : 4;
    this.orbs = this.orbs.filter((o) => now - o.born < oLife);
    for (const o of this.orbs) {
      const age = (now - o.born) / oLife;
      const y = o.y - (reduced ? 0 : age * h * 0.25);
      const grad = g.createRadialGradient(o.x, y, 0, o.x, y, o.size * (1 + age));
      grad.addColorStop(0, `hsla(${o.hue}, 80%, 72%, ${0.55 * (1 - age)})`);
      grad.addColorStop(1, `hsla(${o.hue}, 80%, 60%, 0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(o.x, y, o.size * (1 + age), 0, Math.PI * 2);
      g.fill();
    }

    // Chimes: tubes hanging top-right, swaying with the wind, glowing when struck.
    const n = this.tubeHz.length;
    if (n > 0) {
      // A damped spring pushed by the gusts.
      const force = (f?.gust ?? 0) * speed * 0.6;
      this.swayVel += (force - this.sway * 4) * dt - this.swayVel * dt * 1.5;
      this.sway += this.swayVel * dt * 3;
      const angle = reduced ? 0 : Math.max(-0.35, Math.min(0.35, this.sway));
      const x0 = w * 0.78;
      const y0 = h * 0.06;
      const spacing = Math.min(18, w * 0.025);
      g.strokeStyle = 'rgba(160, 170, 180, 0.5)';
      g.beginPath();
      g.moveTo(x0 - spacing * (n / 2 + 0.5), y0);
      g.lineTo(x0 + spacing * (n / 2 + 0.5), y0);
      g.stroke();
      for (let i = 0; i < n; i++) {
        const len = h * (0.26 - (i / n) * 0.12);
        const x = x0 + (i - (n - 1) / 2) * spacing;
        const glow = this.tubeGlow[i];
        const sx = x + Math.sin(angle * (1 + i * 0.05)) * len;
        const ey = y0 + 8 + Math.cos(angle) * len;
        g.lineCap = 'round';
        g.lineWidth = 5;
        g.strokeStyle = glow > 0.02
          ? `hsla(${this.tubeHue[i]}, 85%, ${45 + glow * 30}%, ${0.5 + glow * 0.5})`
          : 'rgba(150, 165, 180, 0.55)';
        g.beginPath();
        g.moveTo(x, y0 + 8);
        g.lineTo(sx, ey);
        g.stroke();
        this.tubeGlow[i] *= Math.exp(-dt * 1.2);
      }
    }
  }
}
