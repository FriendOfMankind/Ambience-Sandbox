/**
 * Builds the rain bake-off as ONE self-contained HTML body for publishing as a claude.ai Artifact.
 * Artifacts only allow inline scripts, so the AudioWorklet modules are bundled to strings and
 * loaded from blob: URLs, and the page script and CSS are inlined.
 *
 *   node scripts/build-artifact.mjs  ->  dist-artifact/rain-bakeoff.html
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const spike = resolve(root, 'spikes/rain-bakeoff');

async function bundle(entry, format, name) {
  const out = await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry, formats: [format], name, fileName: 'out' },
    },
    plugins: [workletPlugin()],
  });
  const chunks = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
  return chunks.find((c) => c.type === 'chunk').code;
}

const worklets = {};
function workletPlugin() {
  return {
    name: 'inline-worklets',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id.endsWith('?worker&url')) return '\0wurl:' + resolve(dirname(importer), id.replace('?worker&url', ''));
    },
    load(id) {
      if (!id.startsWith('\0wurl:')) return;
      const code = worklets[id.slice(6)];
      if (!code) throw new Error(`worklet not prebuilt: ${id}`);
      return `export default URL.createObjectURL(new Blob([${JSON.stringify(code)}], { type: 'text/javascript' }));`;
    },
  };
}

for (const w of ['rain', 'limiter']) {
  const path = resolve(root, `src/audio/worklets/${w}.worklet.ts`);
  worklets[path] = await bundle(path, 'es');
}
const js = await bundle(resolve(spike, 'main.ts'), 'iife', 'RainBakeoff');
const css = readFileSync(resolve(spike, 'style.css'), 'utf8');
const html = readFileSync(resolve(spike, 'index.html'), 'utf8');
const title = html.match(/<title>[^<]*<\/title>/)[0];
const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script type="module"[^>]*><\/script>/, '')
  .replace('Throwaway UI; the engine underneath is real.', 'Your recording stays in your browser; nothing is uploaded.');

// A closing script tag inside the bundle would end the inline script early.
const safeJs = js.replace(/<\/script/gi, '<\\/script');
const out = `${title}\n<style>\n${css}\n</style>\n${body.trim()}\n<script>\n${safeJs}\n</script>\n`;
mkdirSync(resolve(root, 'dist-artifact'), { recursive: true });
writeFileSync(resolve(root, 'dist-artifact/rain-bakeoff.html'), out);
console.log(`dist-artifact/rain-bakeoff.html ${(out.length / 1024).toFixed(1)} KB`);
