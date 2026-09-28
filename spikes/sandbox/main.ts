import worldWorkletUrl from '../../src/audio/worklets/world.worklet.ts?worker&url';
import limiterWorkletUrl from '../../src/audio/worklets/limiter.worklet.ts?worker&url';
import type { WorldOutMessage } from '../../src/audio/worklets/world.worklet';
import type { LimiterOutMessage } from '../../src/audio/worklets/limiter.worklet';
import { LAYERS, type LayerId, type WorldParamsPatch } from '../../src/audio/world/WorldSynth';
import { ChimeSynth } from '../../src/audio/nature/chimes/ChimeSynth';
import { SCALES, type ScaleKey } from '../../src/audio/music/scales';
import { SURFACE_IDS, SURFACES } from '../../src/audio/nature/rain/surfaces';
import { dbToGain, gainToDb } from '../../src/audio/dsp/loudness';
import { SCENES, sceneState, stateToPatch, type SceneState } from './scenes';
import { SceneView } from './view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ state

let state: SceneState = sceneState(SCENES[0]);
let seed = 'tarn';
let playing = false;
let activeScene = 0;

const statePatch = () => stateToPatch(state);

// ------------------------------------------------------------------ audio

interface Engine {
  ctx: AudioContext;
  master: GainNode;
  world: AudioWorkletNode;
}
let engine: Engine | null = null;
let ctxSingleton: AudioContext | null = null;
let tick: WorldOutMessage | null = null;
let meter: LimiterOutMessage | null = null;

function getCtx(): AudioContext {
  if (ctxSingleton) return ctxSingleton;
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (nav.audioSession) nav.audioSession.type = 'playback';
  ctxSingleton = new AudioContext({ latencyHint: 'playback' });
  return ctxSingleton;
}

function createWorldNode(ctx: AudioContext): AudioWorkletNode {
  const node = new AudioWorkletNode(ctx, 'world', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { seed, patch: statePatch() },
  });
  node.port.onmessage = (e: MessageEvent<WorldOutMessage>) => {
    const msg = e.data;
    tick = msg;
    const sr = ctx.sampleRate;
    view.push(msg.events, msg.features, (frame) => msg.time + (frame - msg.frame) / sr);
  };
  node.onprocessorerror = () => showError('The sound engine crashed. Reload the page; if it keeps happening, tell Claude what you changed.');
  return node;
}

async function ensureEngine(): Promise<Engine> {
  if (engine) return engine;
  const ctx = getCtx();
  await Promise.all([ctx.audioWorklet.addModule(worldWorkletUrl), ctx.audioWorklet.addModule(limiterWorkletUrl)]);
  const limiter = new AudioWorkletNode(ctx, 'limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  limiter.port.onmessage = (e: MessageEvent<LimiterOutMessage>) => (meter = e.data);
  limiter.onprocessorerror = () => showError('The safety limiter crashed. Reload the page.');
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(limiter).connect(ctx.destination);
  const world = createWorldNode(ctx);
  world.connect(master);
  engine = { ctx, master, world };
  return engine;
}

function send(patch: WorldParamsPatch): void {
  engine?.world.port.postMessage({ type: 'params', patch });
}

async function togglePlay(): Promise<void> {
  let e: Engine;
  try {
    e = await ensureEngine();
  } catch (err) {
    showError(`Couldn't start the audio engine: ${(err as Error).message}`);
    return;
  }
  const t = e.ctx.currentTime;
  const g = e.master.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  if (!playing) {
    await e.ctx.resume();
    playing = true;
    g.linearRampToValueAtTime(dbToGain(Number($<HTMLInputElement>('volume').value)), t + 3);
    $('play').textContent = '❚❚ Pause';
  } else {
    playing = false;
    g.linearRampToValueAtTime(0, t + 1.5);
    $('play').textContent = '▶ Play';
    setTimeout(() => { if (!playing) void e.ctx.suspend(); }, 1600);
  }
}

/** New seed: a different but equally valid version of the same world. Crossfades old → new. */
async function reseed(): Promise<void> {
  seed = Math.random().toString(36).slice(2, 8);
  $('seed').textContent = seed;
  if (!engine) return;
  const { ctx, master } = engine;
  const old = engine.world;
  const fade = ctx.createGain();
  old.disconnect();
  old.connect(fade).connect(master);
  const t = ctx.currentTime;
  fade.gain.setValueAtTime(1, t);
  fade.gain.linearRampToValueAtTime(0, t + 3);
  const next = createWorldNode(ctx);
  const inGain = ctx.createGain();
  inGain.gain.setValueAtTime(0, t);
  inGain.gain.linearRampToValueAtTime(1, t + 3);
  next.connect(inGain).connect(master);
  engine.world = next;
  setTimeout(() => { old.disconnect(); fade.disconnect(); old.port.close(); }, 3200);
}

function showError(text: string): void {
  const el = $('error');
  el.textContent = text;
  el.hidden = false;
}

// ------------------------------------------------------------------ controls

interface SliderSpec {
  id: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  log?: boolean;
  get: () => number;
  set: (v: number) => void;
  fmt: (v: number) => string;
}

const syncers: (() => void)[] = [];

function slider(parent: HTMLElement, s: SliderSpec, onChange: () => void): void {
  const wrap = document.createElement('div');
  wrap.className = 'ctl';
  const label = document.createElement('label');
  label.htmlFor = s.id;
  label.textContent = s.label;
  const out = document.createElement('output');
  out.htmlFor = s.id;
  const input = document.createElement('input');
  input.type = 'range';
  input.id = s.id;
  const RES = 1000;
  const to = (v: number) => (s.log ? (Math.log(v / s.min) / Math.log(s.max / s.min)) * RES : v);
  const from = (x: number) => (s.log ? s.min * Math.pow(s.max / s.min, x / RES) : x);
  input.min = s.log ? '0' : String(s.min);
  input.max = s.log ? String(RES) : String(s.max);
  input.step = s.log ? '1' : String(s.step ?? (s.max - s.min) / 100);
  const show = () => {
    out.textContent = s.fmt(s.get());
    input.setAttribute('aria-valuetext', s.fmt(s.get()));
  };
  syncers.push(() => {
    input.value = String(to(s.get()));
    show();
  });
  input.addEventListener('input', () => {
    s.set(from(Number(input.value)));
    show();
    onChange();
  });
  wrap.append(label, out, input);
  parent.append(wrap);
}

function toggle(parent: HTMLElement, id: string, text: string, get: () => boolean, set: (v: boolean) => void, onChange: () => void): void {
  const label = document.createElement('label');
  label.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = id;
  box.addEventListener('change', () => { set(box.checked); onChange(); });
  syncers.push(() => (box.checked = get()));
  label.append(box, ` ${text}`);
  parent.append(label);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const times = (v: number) => `${v.toFixed(2)}×`;
const w = () => state.world;

function rainWord(r: number): string {
  if (r < 0.5) return 'mist';
  if (r < 2) return 'drizzle';
  if (r < 8) return 'steady';
  if (r < 25) return 'heavy';
  if (r < 80) return 'downpour';
  return 'impossible';
}

const LAYER_INFO: Record<LayerId, { title: string; blurb: string }> = {
  rain: { title: 'Rain', blurb: 'Every drop synthesised: size, surface, distance.' },
  wind: { title: 'Wind', blurb: 'Also moves the rain and swings the chimes.' },
  chimes: { title: 'Wind chimes', blurb: 'Tuned to the key. Only ring when the wind reaches them.' },
  music: { title: 'Music', blurb: 'Pad and sparse keys, wandering the key.' },
};

function buildStrips(): void {
  const root = $('strips');
  root.innerHTML = '';
  syncers.length = 0;

  for (const id of LAYERS) {
    const card = document.createElement('section');
    card.className = 'strip';
    card.dataset.layer = id;
    const head = document.createElement('div');
    head.className = 'strip-head';
    const h = document.createElement('h2');
    h.textContent = LAYER_INFO[id].title;
    const onBtn = document.createElement('button');
    onBtn.className = 'power';
    onBtn.id = `on-${id}`;
    const syncOn = () => {
      const isOn = w().mix[id].on;
      onBtn.textContent = isOn ? 'On' : 'Off';
      onBtn.setAttribute('aria-pressed', String(isOn));
      card.classList.toggle('off', !isOn);
    };
    onBtn.addEventListener('click', () => {
      w().mix[id].on = !w().mix[id].on;
      syncOn();
      send({ mix: { [id]: { on: w().mix[id].on } } });
    });
    syncers.push(syncOn);
    const meterEl = document.createElement('div');
    meterEl.className = 'meter';
    meterEl.innerHTML = `<span id="meter-${id}"></span>`;
    head.append(h, meterEl, onBtn);
    const blurb = document.createElement('p');
    blurb.className = 'blurb';
    blurb.textContent = LAYER_INFO[id].blurb;
    card.append(head, blurb);

    const main = document.createElement('div');
    main.className = 'ctls';
    const more = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'More';
    const moreBody = document.createElement('div');
    moreBody.className = 'ctls';
    more.append(summary, moreBody);

    const mixChange = () => send({ mix: { [id]: w().mix[id] } });
    slider(main, { id: `${id}-level`, label: 'Level', min: 0, max: 2, step: 0.01, get: () => w().mix[id].level, set: (v) => (w().mix[id].level = v), fmt: (v) => (v < 0.005 ? '−∞ dB' : `${gainToDb(v).toFixed(1)} dB`) }, mixChange);

    if (id === 'rain') {
      const ch = () => send({ rain: w().rain });
      const r = () => w().rain;
      slider(main, { id: 'rain-rate', label: 'Rain', min: 0.1, max: 500, log: true, get: () => r().rate!, set: (v) => (r().rate = v), fmt: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} mm/h · ${rainWord(v)}` }, ch);
      for (const s of ['water', 'leaves', 'tin'] as const) {
        slider(main, { id: `rain-${s}`, label: `On ${SURFACES[s].label.toLowerCase()}`, min: 0, max: 1, step: 0.01, get: () => r().surfaceMix![s], set: (v) => (r().surfaceMix = { ...r().surfaceMix!, [s]: v }), fmt: pct }, ch);
      }
      for (const s of SURFACE_IDS.filter((x) => !['water', 'leaves', 'tin'].includes(x))) {
        slider(moreBody, { id: `rain-${s}`, label: `On ${SURFACES[s].label.toLowerCase()}`, min: 0, max: 1, step: 0.01, get: () => r().surfaceMix![s], set: (v) => (r().surfaceMix = { ...r().surfaceMix!, [s]: v }), fmt: pct }, ch);
      }
      slider(moreBody, { id: 'rain-size', label: 'Drop size', min: -2, max: 2, step: 0.05, get: () => r().sizeBias!, set: (v) => (r().sizeBias = v), fmt: (v) => (Math.abs(v) < 0.01 ? 'natural' : v.toFixed(2)) }, ch);
      slider(moreBody, { id: 'rain-near', label: 'Close drops', min: 0, max: 4, step: 0.01, get: () => r().nearDensity!, set: (v) => (r().nearDensity = v), fmt: times }, ch);
      slider(moreBody, { id: 'rain-far', label: 'Distant wash', min: 0, max: 2, step: 0.01, get: () => r().farLevel!, set: (v) => (r().farLevel = v), fmt: times }, ch);
      slider(moreBody, { id: 'rain-pitch', label: 'Bubble pitch', min: -3, max: 2, step: 0.05, get: () => r().bubblePitch!, set: (v) => (r().bubblePitch = v), fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} oct` }, ch);
      slider(moreBody, { id: 'rain-glide', label: 'Bubble glide', min: 0, max: 2, step: 0.01, get: () => r().bubbleGlide!, set: (v) => (r().bubbleGlide = v), fmt: (v) => (Math.abs(v - 0.1) < 0.006 ? 'natural' : v.toFixed(2)) }, ch);
      slider(moreBody, { id: 'rain-stretch', label: 'Time stretch', min: 1, max: 20, log: true, get: () => r().stretch!, set: (v) => (r().stretch = v), fmt: times }, ch);
      toggle(moreBody, 'rain-key', 'Rain in key (bubbles and bells snap to the key)', () => state.rainInKey, (v) => (state.rainInKey = v), () => send({ rain: { scale: { ...SCALES[state.scaleKey], enabled: state.rainInKey } } }));
      toggle(moreBody, 'rain-grid', 'Rain on the grid (close drops land on a beat)', () => !!r().grid?.enabled, (v) => (r().grid = { ...r().grid!, enabled: v }), ch);
      slider(moreBody, { id: 'rain-bpm', label: 'Grid tempo', min: 30, max: 200, step: 1, get: () => r().grid!.bpm, set: (v) => (r().grid = { ...r().grid!, bpm: v }), fmt: (v) => `${Math.round(v)} BPM` }, ch);
    }

    if (id === 'wind') {
      const ch = () => send({ wind: w().wind });
      const x = () => w().wind;
      slider(main, { id: 'wind-amount', label: 'Strength', min: 0, max: 1, step: 0.01, get: () => x().amount!, set: (v) => (x().amount = v), fmt: (v) => (v < 0.1 ? 'still' : v < 0.3 ? 'light air' : v < 0.55 ? 'breeze' : v < 0.8 ? 'windy' : 'gale') }, ch);
      slider(main, { id: 'wind-gust', label: 'Gustiness', min: 0, max: 1, step: 0.01, get: () => x().gustiness!, set: (v) => (x().gustiness = v), fmt: pct }, ch);
      slider(main, { id: 'wind-rustle', label: 'Leaves', min: 0, max: 1, step: 0.01, get: () => x().rustle!, set: (v) => (x().rustle = v), fmt: pct }, ch);
      slider(moreBody, { id: 'wind-whistle', label: 'Whistle', min: 0, max: 1, step: 0.01, get: () => x().whistle!, set: (v) => (x().whistle = v), fmt: pct }, ch);
      slider(moreBody, { id: 'wind-tone', label: 'Tone', min: -1, max: 1, step: 0.01, get: () => x().tone!, set: (v) => (x().tone = v), fmt: (v) => (Math.abs(v) < 0.02 ? 'natural' : v < 0 ? 'darker' : 'brighter') }, ch);
    }

    if (id === 'chimes') {
      const ch = () => { send({ chimes: w().chimes }); updateTubes(); };
      const c = () => w().chimes;
      slider(main, { id: 'chime-tubes', label: 'Tubes', min: 3, max: 8, step: 1, get: () => c().tubes!, set: (v) => (c().tubes = v), fmt: (v) => String(Math.round(v)) }, ch);
      slider(main, { id: 'chime-sustain', label: 'Ring', min: 0.3, max: 4, step: 0.01, get: () => c().sustain!, set: (v) => (c().sustain = v), fmt: times }, ch);
      slider(main, { id: 'chime-sens', label: 'Sensitivity', min: 0, max: 1, step: 0.01, get: () => 1 - c().threshold!, set: (v) => (c().threshold = 1 - v), fmt: pct }, ch);
      slider(moreBody, { id: 'chime-activity', label: 'Clapper energy', min: 0.2, max: 4, step: 0.01, get: () => c().activity!, set: (v) => (c().activity = v), fmt: times }, ch);
      slider(moreBody, { id: 'chime-bright', label: 'Material', min: 0, max: 1, step: 0.01, get: () => c().brightness!, set: (v) => (c().brightness = v), fmt: (v) => (v < 0.3 ? 'wood-like' : v < 0.7 ? 'bronze' : 'aluminium') }, ch);
      slider(moreBody, { id: 'chime-pitch', label: 'Register', min: 150, max: 1600, log: true, get: () => c().lowestHz!, set: (v) => (c().lowestHz = v), fmt: (v) => `from ${Math.round(v)} Hz` }, ch);
    }

    if (id === 'music') {
      const ch = () => send({ music: w().music });
      const m = () => w().music;
      slider(main, { id: 'music-pad', label: 'Pad', min: 0, max: 2, step: 0.01, get: () => m().padLevel!, set: (v) => (m().padLevel = v), fmt: times }, ch);
      slider(main, { id: 'music-keys', label: 'Keys', min: 0, max: 2, step: 0.01, get: () => m().keysLevel!, set: (v) => (m().keysLevel = v), fmt: times }, ch);
      slider(main, { id: 'music-density', label: 'Notes', min: 0, max: 40, step: 0.5, get: () => m().density!, set: (v) => (m().density = v), fmt: (v) => `${v.toFixed(1)} / min` }, ch);
      slider(moreBody, { id: 'music-bright', label: 'Pad brightness', min: 0, max: 1, step: 0.01, get: () => m().brightness!, set: (v) => (m().brightness = v), fmt: pct }, ch);
      slider(moreBody, { id: 'music-chords', label: 'Chord change', min: 8, max: 120, step: 1, get: () => m().chordSeconds!, set: (v) => (m().chordSeconds = v), fmt: (v) => `~${Math.round(v)} s` }, ch);
      slider(moreBody, { id: 'music-detune', label: 'Detune', min: 0, max: 60, step: 0.5, get: () => m().detune!, set: (v) => (m().detune = v), fmt: (v) => `${v.toFixed(1)} cents${v > 30 ? ' (seasick)' : ''}` }, ch);
      slider(moreBody, { id: 'music-ratio', label: 'Keys timbre', min: 0.5, max: 7, step: 0.01, get: () => m().keysRatio!, set: (v) => (m().keysRatio = v), fmt: (v) => `FM ${v.toFixed(2)} · ${Math.abs(v - Math.round(v)) < 0.03 ? 'harmonic' : 'clangy'}` }, ch);
      slider(moreBody, { id: 'music-octave', label: 'Keys register', min: 1, max: 4, step: 1, get: () => m().keysOctave!, set: (v) => (m().keysOctave = v), fmt: (v) => `+${Math.round(v)} oct` }, ch);
    }

    slider(moreBody, { id: `${id}-send`, label: 'Reverb send', min: 0, max: 1, step: 0.01, get: () => w().mix[id].send, set: (v) => (w().mix[id].send = v), fmt: pct }, mixChange);
    card.append(main, more);
    root.append(card);
  }

  // Space (reverb)
  const space = $('space');
  space.innerHTML = '';
  const ch = () => send({ reverb: w().reverb });
  slider(space, { id: 'rev-t60', label: 'Reverb length', min: 0.5, max: 20, log: true, get: () => w().reverb.t60!, set: (v) => (w().reverb.t60 = v), fmt: (v) => `${v.toFixed(1)} s` }, ch);
  slider(space, { id: 'rev-damp', label: 'Reverb darkness', min: 0, max: 1, step: 0.01, get: () => w().reverb.damping!, set: (v) => (w().reverb.damping = v), fmt: pct }, ch);
  slider(space, { id: 'rev-size', label: 'Space size', min: 0.5, max: 2, step: 0.01, get: () => w().reverb.size!, set: (v) => (w().reverb.size = v), fmt: times }, ch);
}

function buildScenes(): void {
  const root = $('scenes');
  SCENES.forEach((scene, i) => {
    const b = document.createElement('button');
    b.textContent = scene.label;
    b.addEventListener('click', () => applyScene(i));
    root.append(b);
  });
  const sel = $<HTMLSelectElement>('scale');
  for (const [k, s] of Object.entries(SCALES)) sel.add(new Option(s.label, k));
  sel.addEventListener('change', () => {
    state.scaleKey = sel.value as ScaleKey;
    send({ scale: SCALES[state.scaleKey], rain: { scale: { ...SCALES[state.scaleKey], enabled: state.rainInKey } } });
    updateTubes();
  });
}

function applyScene(i: number): void {
  activeScene = i;
  state = sceneState(SCENES[i]);
  // Layers the scene doesn't mention fall back to their defaults, which are "on".
  send(statePatch());
  syncAll();
  updateTubes();
}

function syncAll(): void {
  syncers.forEach((s) => s());
  $<HTMLSelectElement>('scale').value = state.scaleKey;
  document.querySelectorAll<HTMLButtonElement>('#scenes button').forEach((b, i) => b.classList.toggle('on', i === activeScene));
}

function updateTubes(): void {
  const c = new ChimeSynth(44100, 'probe', { ...state.world.chimes, scale: SCALES[state.scaleKey] });
  view.setTubes(c.tubeFrequencies);
}

// ------------------------------------------------------------------ status

function renderStatus(): void {
  for (const id of LAYERS) {
    const el = document.getElementById(`meter-${id}`);
    if (!el) continue;
    const lvl = tick?.features.level[id] ?? 0;
    const db = gainToDb(lvl);
    el.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 50) * 100))}%`;
  }
  const lines: string[] = [];
  if (engine) {
    const { ctx } = engine;
    lines.push(`${ctx.state} · ${ctx.sampleRate} Hz · seed ${seed}`);
    if (tick) {
      lines.push(`wind ${tick.features.windSpeed.toFixed(2)} (gust ${tick.features.gust >= 0 ? '+' : ''}${tick.features.gust.toFixed(2)}) · rain voices ${tick.rainStats.voices}`);
    }
    if (meter) {
      lines.push(`output peak ${gainToDb(meter.peak).toFixed(1)} dBFS · limiter ${meter.minGain < 0.999 ? `−${(-gainToDb(meter.minGain)).toFixed(1)} dB` : 'idle'}${meter.nanEvents ? ` · recovered from ${meter.nanEvents} glitch(es)` : ''}`);
    }
  } else {
    lines.push('Press Play. Sound fades in over 3 seconds.');
  }
  $('status').textContent = lines.join('\n');
}

// ------------------------------------------------------------------ wiring

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const view = new SceneView(
  $<HTMLCanvasElement>('scene'),
  () => {
    const ctx = ctxSingleton;
    if (!ctx) return performance.now() / 1000;
    const ts = ctx.getOutputTimestamp?.();
    return ts?.contextTime ?? ctx.currentTime - (ctx.outputLatency ?? 0);
  },
  () => reducedMotion.matches,
);

function init(): void {
  buildScenes();
  buildStrips();
  syncAll();
  updateTubes();
  $('seed').textContent = seed;
  $('play').addEventListener('click', () => void togglePlay());
  $('reseed').addEventListener('click', () => void reseed());
  $<HTMLInputElement>('volume').addEventListener('input', (e) => {
    const db = Number((e.target as HTMLInputElement).value);
    $('volume-out').textContent = db <= -40 ? '−∞ dB' : `${db.toFixed(1).replace('-', '−')} dB`;
    if (engine && playing) engine.master.gain.setTargetAtTime(dbToGain(db), engine.ctx.currentTime, 0.05);
  });
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(t.tagName)) return;
    if (e.key === ' ') {
      e.preventDefault();
      void togglePlay();
    }
  });
  setInterval(renderStatus, 200);
  renderStatus();
  view.start();
}

init();
