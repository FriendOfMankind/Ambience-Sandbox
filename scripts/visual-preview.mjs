/**
 * Renders deterministic stills of the 3D view on a fixed clock with synthetic events, so looks
 * can be compared without real-time GPU speed.
 *
 *   node scripts/visual-preview.mjs outDir [trip] [width] [height] [ui]
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? 'shots');
const trip = Number(process.argv[3] ?? 0.6);
const W = Number(process.argv[4] ?? 1280);
const H = Number(process.argv[5] ?? 720);
const showUi = process.argv[6] === 'ui';
mkdirSync(out, { recursive: true });
const body = readFileSync(resolve(root, 'dist-artifact/sandbox.html'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text()); });
await page.route('http://localhost:4173/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
await page.goto('http://localhost:4173/');
await page.waitForFunction(() => window.__tarnVisual);
await page.evaluate(({ trip, showUi, hide, scale, theta }) => {
  const v = window.__tarnVisual;
  v.pinScale(Number(scale));
  v.setTrip(trip);
  if (hide) v.hide(hide.split(','));
  if (theta) v.teleport(Number(theta));
  v.setWorld({ rainRate: 12, windAmount: 0.5, sustain: 1.2, chordSeconds: 20 });
  if (!showUi) document.querySelectorAll('#top, #dials, .status').forEach((e) => (e.style.visibility = 'hidden'));
}, { trip, showUi, hide: process.env.HIDE ?? '', scale: process.env.SCALE ?? 1, theta: process.env.THETA ?? '' });

/** A plausible 8 s of the world: a chord, notes every ~0.7 s, chimes, light rain. */
const shots = (process.env.SHOTS ?? '40,90,160').split(',').map(Number);
const DT = 1 / 20;
let j = 0;
for (const until of shots) {
  await page.evaluate(({ from, until, DT }) => {
    const v = window.__tarnVisual;
    const SR = 48000;
    for (let j = from; j < until; j++) {
      const t = v.clock;
      const f = Math.round(t * SR);
      const ev = { rain: [], chimes: [], music: [] };
      if (j % 80 === 0) ev.music.push({ kind: 'chord', frame: f, hz: 146.8 * Math.pow(2, [0, 5, 3, 7][(j / 80) % 4] / 12), velocity: 1, step: j / 80 });
      if (j % 14 === 3) ev.music.push({ kind: 'note', frame: f, hz: 293.7 * Math.pow(2, [0, 3, 5, 7, 10, 12][(j * 7) % 6] / 12), velocity: 0.8, step: j });
      if (j % 9 === 4) ev.chimes.push({ frame: f, tube: (j * 3) % 6, velocity: 0.7 });
      if (j % 23 === 7) ev.music.push({ kind: 'note', voice: 'bowl', frame: f, hz: 146.8 * Math.pow(2, [0, 7, 3][(j / 23 | 0) % 3] / 12), velocity: 0.9, step: j });
      if (j % 18 === 0) ev.music.push({ kind: 'beat', frame: f, hz: 0, velocity: 0.8, step: 0 });
      for (let i = 0; i < 3; i++) ev.rain.push({ frame: f + i * 500, pan: Math.sin(j * 12.9898 + i * 78.233), diameterMm: 1 + ((j + i) % 4), surface: 'water', bubbleHz: 0 });
      v.push(ev, { level: { rain: 0.05, wind: 0.03, chimes: 0.05, music: 0.12 }, windSpeed: 0.6, gust: Math.sin(j * 0.05), chordStep: 0 }, (x) => x / SR);
      v.step(DT);
    }
  }, { from: j, until, DT });
  j = until;
  await page.screenshot({ path: `${out}/preview-t${trip}-${until}${process.env.TAG ?? ''}.png`, timeout: 600000 });
}
await browser.close();
