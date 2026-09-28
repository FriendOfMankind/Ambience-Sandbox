/**
 * Flash-safety stress test for the 3D view (WCAG 2.3.1). Runs the real renderer in Chromium on
 * a fixed clock and feeds it synthetic worst-case event bursts, far denser than the engine
 * makes, then reads the view's FlashMeter (which sees every frame at 64×36).
 *
 *   node scripts/flash-check.mjs            (needs `npm run build:artifact` first)
 *
 * Fixed steps mean software GL's low frame rate doesn't matter: each step is 1/20 s of view
 * time, which resolves flicker up to 10 Hz, well above the 3 Hz limit.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const body = readFileSync(resolve(root, 'dist-artifact/sandbox.html'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const SECONDS = Number(process.env.SECONDS ?? 12);
const DT = 1 / 20;

const scenarios = [
  { name: 'CONTROL: deliberate 5 Hz strobe (must fail)', trip: 0.6, strobe: true, expectFail: true },
  { name: 'chime storm (12 strikes/s, all tubes, full velocity)', trip: 0.6, chimes: 12 },
  { name: 'note spam (8 notes/s) + chord every 1.5 s', trip: 0.6, notes: 8, chord: 1.5 },
  { name: 'downpour (40 near drops per step)', trip: 0.6, rain: 40 },
  { name: 'everything at once, Trip 100 (kaleidoscope on)', trip: 1, chimes: 12, notes: 8, chord: 1.5, rain: 40 },
  { name: 'everything at once, reduced motion', trip: 0.6, chimes: 12, notes: 8, chord: 1.5, rain: 40, reduced: true },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const results = [];
for (const sc of scenarios) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://localhost:4173/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://localhost:4173/');
  await page.waitForFunction(() => window.__tarnVisual);
  await page.evaluate(({ sc, DT }) => {
    const v = window.__tarnVisual;
    v.pinScale(0.6);
    v.debugStrobe(!!sc.strobe);
    document.querySelectorAll('#top, #dials, .status').forEach((e) => (e.style.visibility = 'hidden'));
    v.measureEveryProbe(true);
    v.setTrip(sc.trip);
    v.setReduced(!!sc.reduced);
    v.setWorld({ rainRate: sc.rain ? 80 : 2, windAmount: 0.8, sustain: 1, chordSeconds: 10 });
    v.step(DT);
  }, { sc, DT });
  const steps = Math.round(SECONDS / DT);
  for (let k = 0; k < steps; k += 20) {
    await page.evaluate(({ sc, DT, k }) => {
      const v = window.__tarnVisual;
      const SR = 48000;
      for (let j = k; j < k + 20; j++) {
        const t0 = v.clock;
        const ev = { rain: [], chimes: [], music: [] };
        const at = (i, n) => Math.round((t0 + (DT * i) / n) * SR);
        const count = (rate) => Math.floor((j + 1) * DT * rate) - Math.floor(j * DT * rate);
        if (sc.chimes) for (let i = 0, n = count(sc.chimes); i < n; i++) ev.chimes.push({ frame: at(i, n), tube: (j * 5 + i) % 6, velocity: 1 });
        if (sc.notes) for (let i = 0, n = count(sc.notes); i < n; i++) ev.music.push({ kind: 'note', frame: at(i, n), hz: 220 * Math.pow(2, ((j * 7 + i * 5) % 24) / 12), velocity: 1, step: j });
        if (sc.chord && count(1 / sc.chord) > 0) ev.music.push({ kind: 'chord', frame: at(0, 1), hz: 110 * Math.pow(2, (j % 12) / 12), velocity: 1, step: j });
        if (sc.rain) for (let i = 0; i < sc.rain; i++) ev.rain.push({ frame: at(i, sc.rain), pan: Math.sin(j * 12.9898 + i * 78.233) , diameterMm: 1 + (i % 5), surface: ['water', 'tin', 'leaves', 'bells'][i % 4], bubbleHz: 800 });
        const features = { level: { rain: sc.rain ? 0.2 : 0, wind: 0.1, chimes: sc.chimes ? 0.2 : 0, music: sc.notes ? 0.25 : 0 }, windSpeed: 1.2, gust: Math.sin(j * 0.3), chordStep: j };
        v.push(ev, features, (f) => f / SR);
        v.step(DT);
      }
    }, { sc, DT, k });
  }
  const stats = await page.evaluate(() => window.__tarnVisual.stats());
  await page.screenshot({ path: resolve(process.env.OUT ?? '.', `flash-${results.length}.png`) });
  results.push({ scenario: sc.name, flashesPerSecond: stats.flash.generalPerSecond, redFlashesPerSecond: stats.flash.redPerSecond, frames: stats.flash.frames, pass: (stats.flash.generalPerSecond <= 3 && stats.flash.redPerSecond <= 3) !== !!sc.expectFail, errors });
  await page.close();
}
await browser.close();
console.table(results.map(({ errors, ...r }) => r));
if (results.some((r) => r.errors.length)) console.log(results.map((r) => r.errors));
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
