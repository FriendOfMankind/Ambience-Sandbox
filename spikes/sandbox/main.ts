import worldWorkletUrl from '../../src/audio/worklets/world.worklet.ts?worker&url';
import limiterWorkletUrl from '../../src/audio/worklets/limiter.worklet.ts?worker&url';
import type { WorldOutMessage } from '../../src/audio/worklets/world.worklet';
import type { LimiterOutMessage } from '../../src/audio/worklets/limiter.worklet';
import { LAYERS, type LayerId, type WorldParamsPatch } from '../../src/audio/world/WorldSynth';
import { ChimeSynth } from '../../src/audio/nature/chimes/ChimeSynth';
import { DEFAULT_KEY, FAMILIES, lightName, ROOT_NAMES, type ScaleFamily } from '../../src/audio/music/scales';
import { DEFAULT_MUSIC_PARAMS, VOICING_ORDER } from '../../src/audio/music/MusicSynth';
import { SURFACE_IDS, SURFACES } from '../../src/audio/nature/rain/surfaces';
import { dbToGain, gainToDb } from '../../src/audio/dsp/loudness';
import { purityDetune, randomVibe, SCENES, sceneState, spacePatch, stateScale, stateToPatch, type Scene, type SceneState } from './scenes';
import { SceneView } from './view';
import { SceneView3D } from './view3d';
import { dial, fromInput, inputRange, toInput, type SliderSpec } from './dials';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ state

let state: SceneState = sceneState(SCENES[0]);
let seed = 'tarn';
let playing = false;
let activeScene: number | 'surprise' = 0;

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
  pushWorld();
}

/** World state the visuals need beyond the engine's events (rain rate, chime ring time…). */
function pushWorld(): void {
  const w = state.world;
  view3d?.setWorld({ rainRate: w.rain.rate ?? 5, windAmount: w.wind.amount ?? 0.3, sustain: w.chimes.sustain ?? 1, chordSeconds: w.music.chordSeconds ?? 35, layers: w.music.layers ?? 0, age: w.music.age ?? 0, texture: w.music.texture ?? 0, freeze: !!w.music.freeze, fire: w.mix.fire.on ? w.fire.amount ?? 0.5 : 0 });
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
  setTimeout(() => { old.port.postMessage({ type: 'stop' }); old.disconnect(); fade.disconnect(); old.port.close(); }, 3200);
}

function showError(text: string): void {
  const el = $('error');
  el.textContent = text;
  el.hidden = false;
}

// ------------------------------------------------------------------ controls

/** Every control's spec by id, with its layer, so dials and strip sliders share one source. */
const specs = new Map<string, { spec: SliderSpec; layer: LayerId | null; onChange: () => void }>();
const syncers: (() => void)[] = [];
const syncById = new Map<string, (() => void)[]>();
let currentLayer: LayerId | null = null;

function addSync(id: string, fn: () => void): void {
  syncers.push(fn);
  syncById.set(id, [...(syncById.get(id) ?? []), fn]);
}
/** A control changed: redraw every widget bound to it and tell the view which layer moved. */
function changed(id: string): void {
  syncById.get(id)?.forEach((f) => f());
  const layer = specs.get(id)?.layer;
  if (layer) view3d?.poke(layer);
}

function slider(parent: HTMLElement, s: SliderSpec, onChange: () => void): void {
  specs.set(s.id, { spec: s, layer: currentLayer, onChange });
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
  Object.assign(input, inputRange(s));
  addSync(s.id, () => {
    input.value = String(toInput(s, s.get()));
    out.textContent = s.fmt(s.get());
    input.setAttribute('aria-valuetext', s.fmt(s.get()));
  });
  input.addEventListener('input', () => {
    s.set(fromInput(s, Number(input.value)));
    onChange();
    changed(s.id);
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
  addSync(id, () => (box.checked = get()));
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
  fire: { title: 'Fire', blurb: 'A crackling wood fire. Gusts fan it; rain makes the embers sizzle.' },
  music: { title: 'Music', blurb: 'A generative ensemble; it shapes and colours the object.' },
};

const m = () => w().music;
const key = () => (state.key ??= { ...DEFAULT_KEY });
const musicChange = () => send({ music: w().music });

/** Send the scale built from the mood settings to everything pitched. */
function sendScale(): void {
  const scale = stateScale(state);
  w().scale = scale;
  send({ scale, rain: { scale: { ...scale, enabled: state.rainInKey } } });
  updateTubes();
}

const RHYTHMS = ['free', 'loops', 'pulse'] as const;
const VOICING_LABEL = { triad: 'triads', sus2: 'sus2 (open, unresolved)', sus4: 'sus4 (suspended)', add9: 'add9 (root, fifth, ninth)', quartal: 'quartal (stacked fourths)', open: 'open fifths + tenth' };

/** The live processors, after how ambient artists perform (docs/AMBIENT-RESEARCH.md). */
const PERFORM: SliderSpec[] = [
  { id: 'perf-layers', label: 'Layers', min: 0, max: 1, step: 0.01, get: () => m().layers ?? 0, set: (v) => (m().layers = v), fmt: (v) => (v < 0.01 ? 'off' : v < 0.4 ? 'echoes' : v < 0.8 ? 'layers build' : 'near-endless') },
  { id: 'perf-decay', label: 'Decay', min: 0, max: 1, step: 0.01, get: () => m().decay ?? 0.4, set: (v) => (m().decay = v), fmt: (v) => (v < 0.25 ? 'clean passes' : v < 0.6 ? 'darkening' : 'disintegrating') },
  { id: 'perf-age', label: 'Age', min: 0, max: 1, step: 0.01, get: () => m().age ?? 0, set: (v) => (m().age = v), fmt: (v) => (v < 0.01 ? 'new' : v < 0.35 ? 'warm tape' : v < 0.7 ? 'worn cassette' : 'old reel') },
  { id: 'perf-texture', label: 'Texture', min: 0, max: 1, step: 0.01, get: () => m().texture ?? 0, set: (v) => (m().texture = v), fmt: (v) => (v < 0.01 ? 'off' : v < 0.4 ? 'sparkle' : v < 0.75 ? 'grain cloud' : 'dense cloud') },
  { id: 'perf-swell', label: 'Swell', min: 0, max: 1, step: 0.01, get: () => m().swell ?? 0, set: (v) => (m().swell = v), fmt: (v) => (v < 0.01 ? 'struck' : `fade-in ${(0.05 + v * v * 1.6).toFixed(1)} s`) },
];
const RHYTHM_LABEL = { free: 'free (no grid)', loops: 'loops (Eno-style)', pulse: 'pulse (on the beat)' };

function purityWord(v: number): string {
  if (v > 0.95) return 'just · beat-free';
  if (v > 0.6) return 'nearly just';
  if (v > 0.4) return 'equal temperament';
  if (v > 0.2) return 'detuned';
  return 'eerie';
}
function beatWord(v: number): string {
  if (v < 0.02) return 'off';
  if (v < 0.35) return 'heartbeat';
  if (v < 0.6) return 'brushes';
  return 'soft lo-fi kit';
}

/** The music's mood and movement macros, each a get/set over the state. */
const MACROS: SliderSpec[] = [
  { id: 'mood-light', label: 'Light', min: 0, max: 0.999, step: 0.001, get: () => key().light, set: (v) => { key().light = v; sendScale(); }, fmt: () => lightName(key()) },
  { id: 'mood-purity', label: 'Purity', min: 0, max: 1, step: 0.01, get: () => key().purity, set: (v) => { key().purity = v; m().detune = purityDetune(v); sendScale(); }, fmt: purityWord },
  { id: 'mood-voicing', label: 'Voicing', min: 0, max: VOICING_ORDER.length - 1, step: 1, get: () => VOICING_ORDER.indexOf(m().voicing ?? 'triad'), set: (v) => (m().voicing = VOICING_ORDER[Math.round(v)]), fmt: (v) => VOICING_LABEL[VOICING_ORDER[Math.round(v)]] },
  { id: 'mood-warmth', label: 'Warmth', min: 0, max: 1, step: 0.01, get: () => 1 - (m().brightness ?? 0.4), set: (v) => (m().brightness = 1 - v), fmt: (v) => (v > 0.75 ? 'dark & warm' : v > 0.5 ? 'warm' : v > 0.25 ? 'clear' : 'bright') },
  { id: 'mood-space', label: 'Space', min: 0, max: 1, step: 0.01, get: () => state.space, set: (v) => { state.space = v; const sp = spacePatch(v); Object.assign(w().reverb, sp.reverb); w().mix.music.send = sp.send; m().shimmer = sp.shimmer; send({ reverb: w().reverb, mix: { music: { send: sp.send } } }); }, fmt: (v) => (v < 0.25 ? 'close' : v < 0.55 ? 'room' : v < 0.8 ? 'hall' : 'cathedral + shimmer') },
  { id: 'move-motion', label: 'Motion', min: 0, max: 30, step: 0.5, get: () => m().density ?? 8, set: (v) => (m().density = v), fmt: (v) => (v < 0.5 ? 'still' : `${v.toFixed(v < 10 ? 1 : 0)} notes/min`) },
  { id: 'move-breath', label: 'Breath', min: 0, max: 1, step: 0.01, get: () => m().breath ?? 0.5, set: (v) => (m().breath = v), fmt: (v) => `rests ${(0.15 + 2.6 * v).toFixed(1)}× phrases` },
  { id: 'move-rhythm', label: 'Rhythm', min: 0, max: 2, step: 1, get: () => RHYTHMS.indexOf(m().rhythm ?? 'free'), set: (v) => (m().rhythm = RHYTHMS[Math.round(v)]), fmt: (v) => RHYTHM_LABEL[RHYTHMS[Math.round(v)]] },
  { id: 'move-tempo', label: 'Tempo', min: 40, max: 100, step: 1, get: () => m().tempo ?? 66, set: (v) => (m().tempo = v), fmt: (v) => `${Math.round(v)} BPM` },
  { id: 'move-beat', label: 'Beat', min: 0, max: 1, step: 0.01, get: () => m().beat ?? 0, set: (v) => (m().beat = v), fmt: beatWord },
  { id: 'move-evolve', label: 'Evolve', min: 0, max: 1, step: 0.01, get: () => Math.log(120 / (m().chordSeconds ?? 35)) / Math.log(12), set: (v) => (m().chordSeconds = 120 * Math.pow(12, -v)), fmt: () => `chords every ~${Math.round(m().chordSeconds ?? 35)} s` },
];

const VOICES: [string, string, keyof typeof DEFAULT_MUSIC_PARAMS, string][] = [
  ['voice-drone', 'Drone', 'droneLevel', 'Harmonic series on the root. Only overtones that fit the key sound.'],
  ['voice-pad', 'Pad', 'padLevel', 'Detuned saws through a slowly breathing filter.'],
  ['voice-piano', 'Piano', 'pianoLevel', 'Soft felt piano (after Harold Budd): quiet, dark, long.'],
  ['voice-bowls', 'Bowls', 'bowlsLevel', 'Singing bowls: each partial is a beating pair.'],
  ['voice-keys', 'Keys', 'keysLevel', 'FM e-piano / bell, wandering the scale.'],
  ['voice-plucks', 'Plucks', 'plucksLevel', 'Plucked strings (Karplus–Strong) arpeggiating the chord.'],
  ['voice-choir', 'Choir', 'choirLevel', 'Voices through moving vowel formants.'],
];

interface Strip { card: HTMLElement; main: HTMLElement; more: HTMLElement }
function strip(parent: HTMLElement, title: string, blurb: string, power: LayerId | null): Strip {
  const card = document.createElement('section');
  card.className = 'strip';
  const head = document.createElement('div');
  head.className = 'strip-head';
  const h = document.createElement('h2');
  h.textContent = title;
  head.append(h);
  if (power) {
    const onBtn = document.createElement('button');
    onBtn.className = 'power';
    onBtn.id = `on-${power}`;
    onBtn.addEventListener('click', () => togglePower(power));
    addSync(`on-${power}`, () => {
      const isOn = w().mix[power].on;
      onBtn.textContent = isOn ? 'On' : 'Off';
      onBtn.setAttribute('aria-pressed', String(isOn));
      card.classList.toggle('off', !isOn);
    });
    const meterEl = document.createElement('div');
    meterEl.className = 'meter';
    meterEl.innerHTML = `<span id="meter-${power}"></span>`;
    head.append(meterEl, onBtn);
  }
  const p = document.createElement('p');
  p.className = 'blurb';
  p.textContent = blurb;
  const main = document.createElement('div');
  main.className = 'ctls';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'More';
  const more = document.createElement('div');
  more.className = 'ctls';
  details.append(summary, more);
  card.append(head, p, main, details);
  parent.append(card);
  return { card, main, more };
}

const levelFmt = (v: number) => (v < 0.005 ? '−∞ dB' : `${gainToDb(v).toFixed(1)} dB`);

function buildStrips(): void {
  const musicRoot = $('music-strips');
  const ambRoot = $('ambience-strips');
  musicRoot.innerHTML = '';
  ambRoot.innerHTML = '';

  // ---------------------------------------------------------------- music
  currentLayer = 'music';
  const mixChange = (id: LayerId) => () => send({ mix: { [id]: w().mix[id] } });
  const mood = strip(musicRoot, 'Music', LAYER_INFO.music.blurb, 'music');
  slider(mood.main, { id: 'music-level', label: 'Level', min: 0, max: 2, step: 0.01, get: () => w().mix.music.level, set: (v) => (w().mix.music.level = v), fmt: levelFmt }, mixChange('music'));
  for (const spec of MACROS) slider(mood.main, spec, musicChange);
  slider(mood.more, { id: 'music-swing', label: 'Swing', min: 0.5, max: 0.7, step: 0.005, get: () => m().swing ?? 0.58, set: (v) => (m().swing = v), fmt: (v) => (v < 0.52 ? 'straight' : v > 0.64 ? 'triplet' : `${Math.round(v * 100)}%`) }, musicChange);
  slider(mood.more, { id: 'music-send', label: 'Reverb send', min: 0, max: 1, step: 0.01, get: () => w().mix.music.send, set: (v) => (w().mix.music.send = v), fmt: pct }, mixChange('music'));
  slider(mood.more, { id: 'music-shimmer', label: 'Shimmer', min: 0, max: 1, step: 0.01, get: () => m().shimmer ?? 0, set: (v) => (m().shimmer = v), fmt: pct }, musicChange);
  slider(mood.more, { id: 'music-detune', label: 'Detune', min: 0, max: 60, step: 0.5, get: () => m().detune!, set: (v) => (m().detune = v), fmt: (v) => `${v.toFixed(1)} cents${v > 30 ? ' (seasick)' : ''}` }, musicChange);

  const perf = strip(musicRoot, 'Perform', 'Live processors on the music: a sound-on-sound looper, tape age, a grain cloud and fade-in attacks. The beat stays out of the looper.', null);
  for (const spec of PERFORM) slider(perf.main, spec, musicChange);
  toggle(perf.main, 'music-freeze', 'Freeze: hold the loop forever (key F)', () => !!m().freeze, (v) => (m().freeze = v), () => { musicChange(); changed('music-freeze'); });
  slider(perf.more, { id: 'music-loop', label: 'Loop length', min: 2, max: 24, step: 0.1, get: () => m().loopSeconds ?? 11.3, set: (v) => (m().loopSeconds = v), fmt: (v) => `${v.toFixed(1)} s` }, musicChange);
  slider(perf.more, { id: 'music-orbit', label: 'Orbit (drone and bowls circle in stereo)', min: 0, max: 1, step: 0.01, get: () => m().orbit ?? 0, set: (v) => (m().orbit = v), fmt: (v) => (v < 0.01 ? 'still' : pct(v)) }, musicChange);
  toggle(perf.more, 'music-pedal', 'Pedal: hold the bass on the root while chords move', () => !!m().pedal, (v) => (m().pedal = v), musicChange);

  const inst = strip(musicRoot, 'Instruments', 'Mix the ensemble. Set a voice to zero to take it out.', null);
  for (const [id, label, prop, blurb] of VOICES) {
    slider(inst.main, { id, label, min: 0, max: 2, step: 0.01, get: () => (m()[prop] as number) ?? 0, set: (v) => ((m() as Record<string, unknown>)[prop] = v), fmt: times }, musicChange);
    void blurb;
  }
  slider(inst.more, { id: 'music-ring', label: 'Ring (bowls, plucks, keys)', min: 0.4, max: 2.5, step: 0.01, get: () => m().ring ?? 1, set: (v) => (m().ring = v), fmt: times }, musicChange);
  slider(inst.more, { id: 'music-ratio', label: 'Keys timbre', min: 0.5, max: 7, step: 0.01, get: () => m().keysRatio!, set: (v) => (m().keysRatio = v), fmt: (v) => `FM ${v.toFixed(2)} · ${Math.abs(v - Math.round(v)) < 0.03 ? 'harmonic' : 'clangy'}` }, musicChange);
  slider(inst.more, { id: 'music-octave', label: 'Keys register', min: 1, max: 4, step: 1, get: () => m().keysOctave!, set: (v) => (m().keysOctave = v), fmt: (v) => `+${Math.round(v)} oct` }, musicChange);
  slider(inst.more, { id: 'music-beat-level', label: 'Beat level', min: 0, max: 2, step: 0.01, get: () => m().beatLevel ?? 1, set: (v) => (m().beatLevel = v), fmt: times }, musicChange);

  const extra = strip(musicRoot, 'Tuning extras', 'Optional. Neither has strong evidence behind health claims; they are here because some people like them.', null);
  toggle(extra.main, 'tune-432', 'Concert pitch A = 432 Hz (instead of 440)', () => key().a4 === 432, (v) => (key().a4 = v ? 432 : 440), () => sendScale());
  slider(extra.main, { id: 'music-binaural', label: 'Binaural beat (headphones only)', min: 0, max: 1, step: 0.01, get: () => m().binaural ?? 0, set: (v) => (m().binaural = v), fmt: (v) => (v < 0.01 ? 'off' : pct(v)) }, musicChange);
  slider(extra.main, { id: 'music-binaural-hz', label: 'Beat frequency', min: 2, max: 12, step: 0.1, get: () => m().binauralHz ?? 6, set: (v) => (m().binauralHz = v), fmt: (v) => `${v.toFixed(1)} Hz · ${v < 4 ? 'delta' : v < 8 ? 'theta' : 'alpha'}` }, musicChange);

  // ---------------------------------------------------------------- ambience
  currentLayer = 'rain';
  const bus = strip(ambRoot, 'Blend', 'How the music and the natural ambience share the mix.', null);
  slider(bus.main, { id: 'bus-blend', label: 'Blend', min: 0, max: 1, step: 0.01, get: () => w().bus.blend, set: (v) => (w().bus.blend = v), fmt: blendWord }, () => send({ bus: w().bus }));
  slider(bus.main, { id: 'bus-support', label: 'Ambience steps aside for music', min: 0, max: 1, step: 0.01, get: () => w().bus.support, set: (v) => (w().bus.support = v), fmt: pct }, () => send({ bus: w().bus }));

  for (const id of ['rain', 'wind', 'chimes', 'fire'] as const) {
    currentLayer = id;
    const { main, more } = strip(ambRoot, LAYER_INFO[id].title, LAYER_INFO[id].blurb, id);
    slider(main, { id: `${id}-level`, label: 'Level', min: 0, max: 2, step: 0.01, get: () => w().mix[id].level, set: (v) => (w().mix[id].level = v), fmt: levelFmt }, mixChange(id));

    if (id === 'rain') {
      const ch = () => send({ rain: w().rain });
      const r = () => w().rain;
      slider(main, { id: 'rain-rate', label: 'Rain', min: 0.1, max: 500, log: true, get: () => r().rate!, set: (v) => (r().rate = v), fmt: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} mm/h · ${rainWord(v)}` }, ch);
      for (const s of ['water', 'leaves', 'tin'] as const) {
        slider(main, { id: `rain-${s}`, label: `On ${SURFACES[s].label.toLowerCase()}`, min: 0, max: 1, step: 0.01, get: () => r().surfaceMix![s], set: (v) => (r().surfaceMix = { ...r().surfaceMix!, [s]: v }), fmt: pct }, ch);
      }
      for (const s of SURFACE_IDS.filter((x) => !['water', 'leaves', 'tin'].includes(x))) {
        slider(more, { id: `rain-${s}`, label: `On ${SURFACES[s].label.toLowerCase()}`, min: 0, max: 1, step: 0.01, get: () => r().surfaceMix![s], set: (v) => (r().surfaceMix = { ...r().surfaceMix!, [s]: v }), fmt: pct }, ch);
      }
      slider(more, { id: 'rain-size', label: 'Drop size', min: -2, max: 2, step: 0.05, get: () => r().sizeBias!, set: (v) => (r().sizeBias = v), fmt: (v) => (Math.abs(v) < 0.01 ? 'natural' : v.toFixed(2)) }, ch);
      slider(more, { id: 'rain-near', label: 'Close drops', min: 0, max: 4, step: 0.01, get: () => r().nearDensity!, set: (v) => (r().nearDensity = v), fmt: times }, ch);
      slider(more, { id: 'rain-far', label: 'Distant wash', min: 0, max: 2, step: 0.01, get: () => r().farLevel!, set: (v) => (r().farLevel = v), fmt: times }, ch);
      slider(more, { id: 'rain-pitch', label: 'Bubble pitch', min: -3, max: 2, step: 0.05, get: () => r().bubblePitch!, set: (v) => (r().bubblePitch = v), fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} oct` }, ch);
      slider(more, { id: 'rain-glide', label: 'Bubble glide', min: 0, max: 2, step: 0.01, get: () => r().bubbleGlide!, set: (v) => (r().bubbleGlide = v), fmt: (v) => (Math.abs(v - 0.1) < 0.006 ? 'natural' : v.toFixed(2)) }, ch);
      slider(more, { id: 'rain-stretch', label: 'Time stretch', min: 1, max: 20, log: true, get: () => r().stretch!, set: (v) => (r().stretch = v), fmt: times }, ch);
      toggle(more, 'rain-key', 'Rain in key (bubbles and bells snap to the key)', () => state.rainInKey, (v) => (state.rainInKey = v), () => send({ rain: { scale: { ...stateScale(state), enabled: state.rainInKey } } }));
      toggle(more, 'rain-grid', 'Rain on the grid (close drops land on a beat)', () => !!r().grid?.enabled, (v) => (r().grid = { ...r().grid!, enabled: v }), ch);
      slider(more, { id: 'rain-bpm', label: 'Grid tempo', min: 30, max: 200, step: 1, get: () => r().grid!.bpm, set: (v) => (r().grid = { ...r().grid!, bpm: v }), fmt: (v) => `${Math.round(v)} BPM` }, ch);
    }

    if (id === 'wind') {
      const ch = () => send({ wind: w().wind });
      const x = () => w().wind;
      slider(main, { id: 'wind-amount', label: 'Strength', min: 0, max: 1, step: 0.01, get: () => x().amount!, set: (v) => (x().amount = v), fmt: (v) => (v < 0.1 ? 'still' : v < 0.3 ? 'light air' : v < 0.55 ? 'breeze' : v < 0.8 ? 'windy' : 'gale') }, ch);
      slider(main, { id: 'wind-gust', label: 'Gustiness', min: 0, max: 1, step: 0.01, get: () => x().gustiness!, set: (v) => (x().gustiness = v), fmt: pct }, ch);
      slider(main, { id: 'wind-rustle', label: 'Leaves', min: 0, max: 1, step: 0.01, get: () => x().rustle!, set: (v) => (x().rustle = v), fmt: pct }, ch);
      slider(more, { id: 'wind-whistle', label: 'Whistle', min: 0, max: 1, step: 0.01, get: () => x().whistle!, set: (v) => (x().whistle = v), fmt: pct }, ch);
      slider(more, { id: 'wind-tone', label: 'Tone', min: -1, max: 1, step: 0.01, get: () => x().tone!, set: (v) => (x().tone = v), fmt: (v) => (Math.abs(v) < 0.02 ? 'natural' : v < 0 ? 'darker' : 'brighter') }, ch);
    }

    if (id === 'fire') {
      const f = () => w().fire;
      // The Fire dial doubles as its on switch: above zero lights it, zero puts it out.
      const lit = () => { send({ fire: w().fire, mix: { fire: { on: w().mix.fire.on } } }); changed('on-fire'); };
      slider(main, { id: 'fire-amount', label: 'Fire', min: 0, max: 1, step: 0.01, get: () => (w().mix.fire.on ? f().amount ?? 0.5 : 0), set: (v) => { f().amount = Math.max(0.02, v); w().mix.fire.on = v > 0.01; }, fmt: (v) => (v < 0.01 ? 'out' : v < 0.3 ? 'embers' : v < 0.65 ? 'campfire' : 'roaring hearth') }, lit);
      const ch = () => send({ fire: w().fire });
      slider(main, { id: 'fire-crackle', label: 'Crackle', min: 0, max: 1, step: 0.01, get: () => f().crackle ?? 0.5, set: (v) => (f().crackle = v), fmt: pct }, ch);
      slider(main, { id: 'fire-roar', label: 'Roar', min: 0, max: 1, step: 0.01, get: () => f().roar ?? 0.5, set: (v) => (f().roar = v), fmt: pct }, ch);
      slider(more, { id: 'fire-tone', label: 'Tone', min: -1, max: 1, step: 0.01, get: () => f().tone ?? 0, set: (v) => (f().tone = v), fmt: (v) => (Math.abs(v) < 0.02 ? 'natural' : v < 0 ? 'darker' : 'brighter') }, ch);
    }

    if (id === 'chimes') {
      const ch = () => { send({ chimes: w().chimes }); updateTubes(); };
      const c = () => w().chimes;
      slider(main, { id: 'chime-tubes', label: 'Tubes', min: 3, max: 8, step: 1, get: () => c().tubes!, set: (v) => (c().tubes = v), fmt: (v) => String(Math.round(v)) }, ch);
      slider(main, { id: 'chime-sustain', label: 'Ring', min: 0.3, max: 4, step: 0.01, get: () => c().sustain!, set: (v) => (c().sustain = v), fmt: times }, ch);
      slider(main, { id: 'chime-sens', label: 'Sensitivity', min: 0, max: 1, step: 0.01, get: () => 1 - c().threshold!, set: (v) => (c().threshold = 1 - v), fmt: pct }, ch);
      slider(more, { id: 'chime-activity', label: 'Clapper energy', min: 0.2, max: 4, step: 0.01, get: () => c().activity!, set: (v) => (c().activity = v), fmt: times }, ch);
      slider(more, { id: 'chime-bright', label: 'Material', min: 0, max: 1, step: 0.01, get: () => c().brightness!, set: (v) => (c().brightness = v), fmt: (v) => (v < 0.3 ? 'wood-like' : v < 0.7 ? 'bronze' : 'aluminium') }, ch);
      slider(more, { id: 'chime-pitch', label: 'Register', min: 150, max: 1600, log: true, get: () => c().lowestHz!, set: (v) => (c().lowestHz = v), fmt: (v) => `from ${Math.round(v)} Hz` }, ch);
    }
    slider(more, { id: `${id}-send`, label: 'Reverb send', min: 0, max: 1, step: 0.01, get: () => w().mix[id].send, set: (v) => (w().mix[id].send = v), fmt: pct }, mixChange(id));
  }

  currentLayer = null;
  // Space (reverb)
  const space = $('space');
  space.innerHTML = '';
  const ch = () => send({ reverb: w().reverb });
  slider(space, { id: 'rev-t60', label: 'Reverb length', min: 0.5, max: 20, log: true, get: () => w().reverb.t60!, set: (v) => (w().reverb.t60 = v), fmt: (v) => `${v.toFixed(1)} s` }, ch);
  slider(space, { id: 'rev-damp', label: 'Reverb darkness', min: 0, max: 1, step: 0.01, get: () => w().reverb.damping!, set: (v) => (w().reverb.damping = v), fmt: pct }, ch);
  slider(space, { id: 'rev-size', label: 'Space size', min: 0.5, max: 2, step: 0.01, get: () => w().reverb.size!, set: (v) => (w().reverb.size = v), fmt: times }, ch);
}

function toggleFreeze(): void {
  m().freeze = !m().freeze;
  musicChange();
  changed('music-freeze');
}

function blendWord(v: number): string {
  if (v < 0.05) return 'ambience only';
  if (v < 0.4) return 'nature forward';
  if (v <= 0.6) return 'balanced';
  if (v < 0.95) return 'music forward';
  return 'music only';
}

function togglePower(id: LayerId): void {
  w().mix[id].on = !w().mix[id].on;
  send({ mix: { [id]: { on: w().mix[id].on } } });
  changed(`on-${id}`);
}

function buildScenes(): void {
  const scenes = $<HTMLSelectElement>('scene-pick');
  const groups = new Map<string, HTMLOptGroupElement>();
  SCENES.forEach((scene, i) => {
    const name = scene.group ?? 'More';
    let g = groups.get(name);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = name;
      groups.set(name, g);
      scenes.append(g);
    }
    const o = new Option(scene.label, String(i));
    if (scene.blurb) o.title = scene.blurb;
    g.append(o);
  });
  // Shown only while a Surprise roll is playing.
  const surprise = new Option('Surprise roll', 'surprise');
  surprise.hidden = true;
  scenes.prepend(surprise);
  scenes.addEventListener('change', () => { if (scenes.value !== 'surprise') applyScene(Number(scenes.value)); });
  $('surprise').addEventListener('click', () => loadVibe(randomVibe(), 'surprise'));
  const root = $<HTMLSelectElement>('root');
  ROOT_NAMES.forEach((n, i) => root.add(new Option(n, String(i))));
  root.addEventListener('change', () => { key().root = Number(root.value); sendScale(); syncAll(); });
  const fam = $<HTMLSelectElement>('family');
  for (const [k, label] of Object.entries(FAMILIES)) fam.add(new Option(label, k));
  fam.addEventListener('change', () => { key().family = fam.value as ScaleFamily; sendScale(); syncAll(); });
}

function applyScene(i: number): void {
  loadVibe(SCENES[i], i);
}

/** Load a vibe: its full state, its suggested Trip, and its description. */
function loadVibe(scene: Scene, id: number | 'surprise'): void {
  activeScene = id;
  state = sceneState(scene);
  $('vibe-blurb').textContent = scene.blurb ?? '';
  const surprise = $<HTMLSelectElement>('scene-pick').querySelector<HTMLOptionElement>('option[value="surprise"]');
  if (surprise) surprise.hidden = id !== 'surprise';
  if (scene.trip !== undefined) {
    const trip = $<HTMLInputElement>('trip');
    trip.value = String(scene.trip);
    trip.dispatchEvent(new Event('input'));
  }
  // Layers the scene doesn't mention fall back to their defaults, which are "on".
  send(statePatch());
  syncAll();
  updateTubes();
}

function syncAll(): void {
  syncers.forEach((s) => s());
  $<HTMLSelectElement>('root').value = String(key().root);
  $<HTMLSelectElement>('family').value = key().family;
  $<HTMLSelectElement>('scene-pick').value = String(activeScene);
  pushWorld();
}

function updateTubes(): void {
  const c = new ChimeSynth(44100, 'probe', { ...state.world.chimes, scale: stateScale(state) });
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
  for (const id of LAYERS) {
    const el = document.getElementById(`cmeter-${id}`);
    if (el) el.style.transform = `scaleX(${Math.max(0, Math.min(1, (gainToDb(tick?.features.level[id] ?? 0) + 60) / 50))})`;
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
const audioNow = () => {
  const ctx = ctxSingleton;
  if (!ctx) return performance.now() / 1000;
  const ts = ctx.getOutputTimestamp?.();
  return ts?.contextTime ?? ctx.currentTime - (ctx.outputLatency ?? 0);
};

/** The 3D view where WebGL2 works; the 2D placeholder otherwise. */
let view3d: SceneView3D | null = null;
let view: { push: SceneView['push']; setTubes: SceneView['setTubes']; start: () => void };
try {
  if (!SceneView3D.supported()) throw new Error('no WebGL2');
  view3d = new SceneView3D($<HTMLCanvasElement>('scene'), audioNow);
  view = view3d;
} catch {
  document.body.classList.add('flat');
  view = new SceneView($<HTMLCanvasElement>('scene'), audioNow, () => motionReduced());
}

// ------------------------------------------------------------------ dials

/** Dial clusters floating in the scene. Music clusters sit around the object; ambience below it. */
const CLUSTERS: { id: string; title: string; layer: LayerId; hue: number; power?: LayerId; freeze?: boolean; small?: boolean; dials: string[]; labels?: Record<string, string> }[] = [
  { id: 'mood', title: 'Mood', layer: 'music', hue: 318, power: 'music', dials: ['mood-light', 'mood-purity', 'mood-voicing', 'mood-warmth', 'mood-space'] },
  { id: 'perf', title: 'Perform', layer: 'music', hue: 38, freeze: true, dials: ['perf-layers', 'perf-decay', 'perf-age', 'perf-texture', 'perf-swell'] },
  { id: 'move', title: 'Movement', layer: 'music', hue: 285, dials: ['move-motion', 'move-breath', 'move-rhythm', 'move-tempo', 'move-beat'] },
  { id: 'inst', title: 'Instruments', layer: 'music', hue: 340, small: true, dials: ['voice-drone', 'voice-pad', 'voice-piano', 'voice-bowls', 'voice-keys', 'voice-plucks', 'voice-choir'] },
  { id: 'amb', title: 'Ambience', layer: 'rain', hue: 172, dials: ['bus-blend', 'rain-rate', 'wind-amount', 'chimes-level', 'fire-amount'], labels: { 'wind-amount': 'Wind', 'chimes-level': 'Chimes' } },
];
const clusters: { id: string; el: HTMLElement }[] = [];

function buildDials(): void {
  const root = $('dials');
  for (const cl of CLUSTERS) {
    const el = document.createElement('section');
    el.className = `cluster${cl.small ? ' small' : ''}`;
    el.dataset.cluster = cl.id;
    el.style.setProperty('--hue', String(cl.hue));
    el.setAttribute('role', 'group');
    el.setAttribute('aria-labelledby', `cl-${cl.id}`);
    const head = document.createElement('header');
    const h = document.createElement('h2');
    h.id = `cl-${cl.id}`;
    h.textContent = cl.title;
    const meterEl = document.createElement('div');
    meterEl.className = 'cmeter';
    meterEl.setAttribute('aria-hidden', 'true');
    meterEl.innerHTML = cl.power ? `<span id="cmeter-${cl.power}"></span>` : '<span></span>';
    head.append(h, meterEl);
    if (cl.power) {
      const layer = cl.power;
      const power = document.createElement('button');
      power.className = 'cpower';
      power.id = `con-${layer}`;
      power.setAttribute('aria-label', `${LAYER_INFO[layer].title} on or off`);
      power.addEventListener('click', () => togglePower(layer));
      addSync(`on-${layer}`, () => {
        const on = w().mix[layer].on;
        power.setAttribute('aria-pressed', String(on));
        power.textContent = on ? 'On' : 'Off';
        el.classList.toggle('off', !on);
      });
      head.append(power);
    }
    if (cl.freeze) {
      const fz = document.createElement('button');
      fz.className = 'cpower freeze';
      fz.id = 'freeze-btn';
      fz.title = 'Hold the loop forever (F)';
      fz.addEventListener('click', toggleFreeze);
      addSync('music-freeze', () => {
        const on = !!m().freeze;
        fz.setAttribute('aria-pressed', String(on));
        fz.textContent = on ? 'Frozen' : 'Freeze';
      });
      head.append(fz);
    }
    const row = document.createElement('div');
    row.className = 'dial-row';
    for (const id of cl.dials) {
      const entry = specs.get(id);
      if (!entry) continue;
      const sync = dial(row, { ...entry.spec, label: cl.labels?.[id] ?? entry.spec.label }, () => {
        entry.onChange();
        changed(id);
      });
      addSync(id, sync);
    }
    el.append(head, row);
    el.addEventListener('pointerenter', () => view3d?.setFocus(cl.layer));
    el.addEventListener('pointerleave', () => { if (!el.contains(document.activeElement)) view3d?.setFocus(null); });
    el.addEventListener('focusin', () => view3d?.setFocus(cl.layer));
    el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget as Node)) view3d?.setFocus(null); });
    root.append(el);
    clusters.push({ id: cl.id, el });
  }
}

/** Float each cluster at its anchor in the scene, kept inside the viewport and clear of the top bar. */
function placeDials(): void {
  requestAnimationFrame(placeDials);
  // Five clusters need room to float; below that they dock into a sheet.
  const docked = !view3d || window.innerWidth < 1100 || window.innerHeight < 600;
  document.body.classList.toggle('docked', docked);
  if (docked || !view3d) {
    clusters.forEach(({ el }) => (el.style.transform = ''));
    return;
  }
  const top = $('top').getBoundingClientRect().bottom + 12;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const hits = (r: { x: number; y: number; w: number; h: number }) =>
    placed.find((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h);
  for (const { id, el } of clusters) {
    const a = view3d.anchor(id);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const r = { x: Math.min(W - 16 - w, Math.max(16, a.x - w / 2)), y: Math.min(H - 40 - h, Math.max(top, a.y - h / 2)), w, h };
    // If it lands on a cluster already placed, lift it clear (the scene has room above).
    for (let k = 0, o = hits(r); o && k < 4; k++, o = hits(r)) r.y = Math.max(top, o.y - h - 8);
    placed.push(r);
    el.style.transform = `translate3d(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px, 0)`;
  }
}

// ------------------------------------------------------------------ trip, motion, advanced

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let motionChoice: boolean | null = store.get('tarn.reduced') === null ? null : store.get('tarn.reduced') === '1';
const motionReduced = () => motionChoice ?? reducedMotion.matches;

function syncMotion(): void {
  const on = motionReduced();
  const b = $('motion');
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? 'Motion: reduced' : 'Motion: full';
  view3d?.setReduced(on);
  document.body.classList.toggle('calm', on);
}

function initChrome(): void {
  const trip = $<HTMLInputElement>('trip');
  const saved = Number(store.get('tarn.trip'));
  trip.value = String(Number.isFinite(saved) && store.get('tarn.trip') !== null ? saved : 0.6);
  const showTrip = () => {
    const v = Number(trip.value);
    const word = v < 0.25 ? 'still' : v < 0.5 ? 'drifting' : v < 0.8 ? 'trippy' : 'folded';
    $('trip-out').textContent = `${Math.round(v * 100)} · ${word}`;
    trip.setAttribute('aria-valuetext', `${Math.round(v * 100)} percent, ${word}`);
    view3d?.setTrip(v);
  };
  trip.addEventListener('input', () => { showTrip(); store.set('tarn.trip', trip.value); });
  showTrip();

  $('motion').addEventListener('click', () => {
    motionChoice = !motionReduced();
    store.set('tarn.reduced', motionChoice ? '1' : '0');
    syncMotion();
  });
  reducedMotion.addEventListener('change', syncMotion);
  syncMotion();

  const adv = $('advanced');
  const advBtn = $('adv-toggle');
  const setAdv = (open: boolean) => {
    adv.hidden = !open;
    advBtn.setAttribute('aria-expanded', String(open));
    if (open) $('adv-close').focus();
    else advBtn.focus();
  };
  advBtn.addEventListener('click', () => setAdv(adv.hidden === true));
  $('adv-close').addEventListener('click', () => setAdv(false));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !adv.hidden) setAdv(false); });
  initSaver();
}

function init(): void {
  buildScenes();
  buildStrips();
  buildDials();
  syncAll();
  updateTubes();
  initChrome();
  $('seed').textContent = seed;
  $('vibe-blurb').textContent = SCENES[0].blurb ?? '';
  $('play').addEventListener('click', () => void togglePlay());
  $('reseed').addEventListener('click', () => void reseed());
  $<HTMLInputElement>('volume').addEventListener('input', (e) => {
    const db = Number((e.target as HTMLInputElement).value);
    $('volume-out').textContent = db <= -40 ? '−∞ dB' : `${db.toFixed(1).replace('-', '−')} dB`;
    if (engine && playing) engine.master.gain.setTargetAtTime(dbToGain(db), engine.ctx.currentTime, 0.05);
  });
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    // F freezes from anywhere except text entry (dials are range inputs, so it works there too).
    const typing = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox');
    if ((e.key === 'f' || e.key === 'F') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { toggleFreeze(); return; }
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(t.tagName)) return;
    if (e.key === ' ') {
      e.preventDefault();
      void togglePlay();
    }
  });
  setInterval(renderStatus, 200);
  renderStatus();
  view.start();
  placeDials();
}

// ------------------------------------------------------------------ screensaver

/**
 * Screensaver: all controls hide and only the world remains (fullscreen where the browser
 * allows it; inside some frames it can't, and the page still clears its own chrome).
 * Esc, the exit pill or H leave it. It can also start by itself after a few idle minutes
 * while sound is playing.
 */
const SAVER_IDLE_MS = 3 * 60 * 1000;
let saverOn = false;
let saverFullscreen = false;
let lastInput = performance.now();
let hintTimer = 0;

function setSaver(on: boolean): void {
  if (on === saverOn) return;
  saverOn = on;
  document.body.classList.toggle('saver', on);
  $('saver-toggle').setAttribute('aria-pressed', String(on));
  $('saver-live').textContent = on ? 'Screensaver on. Press Escape or H to exit.' : 'Screensaver off.';
  view3d?.setFocus(null);
  if (on) {
    $('advanced').hidden = true;
    $('adv-toggle').setAttribute('aria-expanded', 'false');
    showSaverHint();
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().then(() => (saverFullscreen = true)).catch(() => (saverFullscreen = false));
    }
  } else {
    if (saverFullscreen && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    saverFullscreen = false;
    $('saver-toggle').focus({ preventScroll: true });
  }
}

/** A small exit pill that appears when the pointer moves, then fades. */
function showSaverHint(): void {
  const hint = $('saver-hint');
  hint.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hint.classList.remove('show'), 2500);
}

function initSaver(): void {
  $('saver-toggle').addEventListener('click', () => setSaver(!saverOn));
  $('saver-exit').addEventListener('click', () => setSaver(false));
  const auto = $<HTMLInputElement>('saver-auto');
  auto.checked = store.get('tarn.saverAuto') !== '0';
  auto.addEventListener('change', () => store.set('tarn.saverAuto', auto.checked ? '1' : '0'));
  const activity = () => {
    lastInput = performance.now();
    if (saverOn) showSaverHint();
  };
  window.addEventListener('pointermove', activity, { passive: true });
  window.addEventListener('pointerdown', activity, { passive: true });
  window.addEventListener('keydown', (e) => {
    lastInput = performance.now();
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text');
    if (saverOn && (e.key === 'Escape' || e.key === 'h' || e.key === 'H')) { e.preventDefault(); setSaver(false); return; }
    if (!saverOn && !typing && (e.key === 'h' || e.key === 'H') && !e.metaKey && !e.ctrlKey && !e.altKey) setSaver(true);
  });
  // Leaving browser fullscreen (its own Esc) also leaves the screensaver.
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && saverOn && saverFullscreen) setSaver(false); });
  // Auto-start after idle, only while music or ambience is playing and no panel is open.
  window.setInterval(() => {
    if (!saverOn && auto.checked && playing && $('advanced').hidden && performance.now() - lastInput > SAVER_IDLE_MS) setSaver(true);
  }, 5000);
}

init();
