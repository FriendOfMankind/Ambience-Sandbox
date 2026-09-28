/**
 * Drives the built sandbox in Chromium: plays each listed scene, takes screenshots, reports
 * console errors, frame rate and the flash meter's worst case.
 *
 *   node scripts/visual-check.mjs [outDir] [seconds per scene]
 *
 * Needs `npm run build:artifact` first. Headless Chromium renders WebGL in software, so frame
 * rates here are far below a real GPU; the flash numbers are still meaningful per frame.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? 'shots');
const secs = Number(process.argv[3] ?? 12);
mkdirSync(out, { recursive: true });
const body = readFileSync(resolve(root, 'dist-artifact/sandbox.html'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${body}</body></html>`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.route('http://localhost:4173/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
await page.goto('http://localhost:4173/');
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__tarnVisual?.pinScale(1); window.__tarnVisual?.measureEveryProbe(true); });
await page.screenshot({ path: `${out}/0-idle.png` });

await page.click('#play');
const scenes = (process.env.SCENES ?? '0,2,3,5').split(',').map(Number);
for (const i of scenes) {
  await page.selectOption('#scene-pick', String(i));
  await page.waitForTimeout(secs * 1000);
  const label = await page.$eval('#scene-pick', (s) => s.selectedOptions[0].textContent);
  await page.screenshot({ path: `${out}/${i + 1}-${label.replace(/\W+/g, '-').toLowerCase()}.png` });
}

// Focus a dial with the keyboard and nudge it: camera should frame the layer, object should react.
await page.focus('#dial-rain-rate');
for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/9-dial-focus-rain.png` });

const stats = await page.evaluate(() => window.__tarnVisual?.stats());
const status = await page.$eval('#status', (e) => e.textContent);
console.log(JSON.stringify({ stats, status, errors: errors.slice(0, 20) }, null, 2));
await browser.close();
