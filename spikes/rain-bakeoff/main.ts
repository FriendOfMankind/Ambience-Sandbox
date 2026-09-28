import rainWorkletUrl from '../../src/audio/worklets/rain.worklet.ts?worker&url';
import limiterWorkletUrl from '../../src/audio/worklets/limiter.worklet.ts?worker&url';
import type { RainOutMessage } from '../../src/audio/worklets/rain.worklet';
import type { LimiterOutMessage } from '../../src/audio/worklets/limiter.worklet';
import { BedPlayer } from '../../src/audio/nature/BedPlayer';
import { DEFAULT_RAIN_PARAMS, RainSynth, type RainParams } from '../../src/audio/nature/rain/RainSynth';
import { SURFACE_IDS, SURFACES } from '../../src/audio/nature/rain/surfaces';
import { dbToGain, gainToDb, loudnessLufs } from '../../src/audio/dsp/loudness';
import { PRESETS, SCALES } from './presets';
import { RippleView } from './ripples';
import {
  CANDIDATE_NAMES,
  isComplete,
  LABELS,
  newSession,
  summarise,
  verdict,
  type BlindLabel,
  type BlindSession,
  type Candidate,
} from './blind';

// ------------------------------------------------------------------ state

const SEED = 'tarn-rain-bakeoff';
const TARGET_LUFS = -30;
const MAX_MATCH_GAIN_DB = 36;
/** Share of energy from the recording in the hybrid candidate. */
const HYBRID_BED_SHARE = 0.7;
const RESULTS_KEY = 'rain-bakeoff-results';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let params: RainParams = structuredClone(DEFAULT_RAIN_PARAMS);
let scaleKey: keyof typeof SCALES = 'off';
let candidate: Candidate = 'B';
let playing = false;
let autoMatch = true;
let fileName = '';
let bedBuffer: AudioBuffer | null = null;
let bedLufs: number | null = null;

/** Linear gains per candidate, set by loudness matching. */
const gains = { A: 1, B: 1, Cbed: 0.8, Csynth: 0.5 };
let lastMatch = '';

interface Engine {
  ctx: AudioContext;
  master: GainNode;
  limiter: AudioWorkletNode;
  rain: AudioWorkletNode;
  rainGain: GainNode;
  bed: BedPlayer;
  bedGain: GainNode;
}
let engine: Engine | null = null;
let ctxSingleton: AudioContext | null = null;
let rainStats: RainOutMessage['stats'] | null = null;
let meter: LimiterOutMessage | null = null;

let blind: BlindSession | null = null;
let blindActive: BlindLabel | null = null;
let mode: 'explore' | 'blind' = 'explore';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ------------------------------------------------------------------ audio

function getCtx(): AudioContext {
  if (ctxSingleton) return ctxSingleton;
  // iOS: without a 'playback' session, Web Audio is muted by the silent switch.
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (nav.audioSession) nav.audioSession.type = 'playback';
  ctxSingleton = new AudioContext({ latencyHint: 'playback' });
  return ctxSingleton;
}

async function ensureEngine(): Promise<Engine> {
  if (engine) return engine;
  const ctx = getCtx();
  await Promise.all([ctx.audioWorklet.addModule(rainWorkletUrl), ctx.audioWorklet.addModule(limiterWorkletUrl)]);

  const limiter = new AudioWorkletNode(ctx, 'limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  limiter.port.onmessage = (e: MessageEvent<LimiterOutMessage>) => (meter = e.data);
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(limiter).connect(ctx.destination);

  const rain = new AudioWorkletNode(ctx, 'rain', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { seed: SEED, params: paramsFor(candidate) },
  });
  rain.port.onmessage = (e: MessageEvent<RainOutMessage>) => {
    const msg = e.data;
    rainStats = msg.stats;
    for (const ev of msg.events) {
      ripples.push(ev, msg.time + (ev.frame - msg.frame) / ctx.sampleRate);
    }
  };
  const reportProcessorError = (name: string) => () => {
    $('file-info').textContent = `Audio engine error: the ${name} processor crashed. See the browser console.`;
    console.error(`${name} AudioWorkletProcessor error`);
  };
  rain.onprocessorerror = reportProcessorError('rain');
  limiter.onprocessorerror = reportProcessorError('limiter');
  const rainGain = ctx.createGain();
  rainGain.gain.value = 0;
  rain.connect(rainGain).connect(master);

  const bed = new BedPlayer(ctx, { seed: SEED });
  const bedGain = ctx.createGain();
  bedGain.gain.value = 0;
  bed.output.connect(bedGain).connect(master);
  if (bedBuffer) bed.setBuffer(bedBuffer);

  engine = { ctx, master, limiter, rain, rainGain, bed, bedGain };
  applyCandidate(true);
  return engine;
}

/** Params actually sent to the synth for a candidate. The hybrid drops the far wash (the recording covers it). */
function paramsFor(c: Candidate): RainParams {
  const p: RainParams = { ...params, scale: { ...SCALES[scaleKey] } };
  if (c === 'C') return { ...p, farLevel: 0, midLevel: p.midLevel * 0.6 };
  return p;
}

function candidateGains(c: Candidate): { bed: number; rain: number } {
  const hasBed = !!bedBuffer;
  switch (c) {
    case 'A':
      return { bed: hasBed ? gains.A : 0, rain: 0 };
    case 'B':
      return { bed: 0, rain: gains.B };
    case 'C':
      return { bed: hasBed ? gains.Cbed : 0, rain: gains.Csynth };
  }
}

function applyCandidate(immediate = false): void {
  if (!engine) return;
  const { ctx, rain, rainGain, bedGain } = engine;
  rain.port.postMessage({ type: 'params', params: paramsFor(candidate) });
  const g = candidateGains(candidate);
  const t = ctx.currentTime;
  const tau = immediate ? 0.005 : 0.08;
  rainGain.gain.setTargetAtTime(g.rain, t, tau);
  bedGain.gain.setTargetAtTime(g.bed, t, tau);
}

function setCandidate(c: Candidate): void {
  if ((c === 'A' || c === 'C') && !bedBuffer) return;
  candidate = c;
  document.querySelectorAll<HTMLButtonElement>('#cand-buttons button').forEach((b) => {
    b.classList.toggle('on', b.dataset.cand === c);
  });
  applyCandidate();
}

async function togglePlay(): Promise<void> {
  const btn = $<HTMLButtonElement>('play');
  const e = await ensureEngine();
  const t = e.ctx.currentTime;
  if (!playing) {
    await e.ctx.resume();
    playing = true;
    const vol = dbToGain(Number($<HTMLInputElement>('volume').value));
    e.master.gain.cancelScheduledValues(t);
    e.master.gain.setValueAtTime(e.master.gain.value, t);
    e.master.gain.linearRampToValueAtTime(vol, t + 2); // no cliffs: 2 s fade-in
    if (bedBuffer) e.bed.start();
    ripples.start();
    btn.textContent = '❚❚ Stop';
  } else {
    playing = false;
    e.master.gain.cancelScheduledValues(t);
    e.master.gain.setValueAtTime(e.master.gain.value, t);
    e.master.gain.linearRampToValueAtTime(0, t + 1);
    e.bed.stop(1);
    btn.textContent = '▶ Start';
    setTimeout(() => {
      if (!playing) void e.ctx.suspend();
    }, 1200);
  }
}

// ------------------------------------------------------------------ loudness matching

function measureSynthLufs(p: RainParams, fs: number, seconds = 6): number {
  const synth = new RainSynth(fs, `${SEED}-measure`, p);
  const total = Math.round(seconds * fs);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const block = 128;
  for (let i = 0; i < total; i += block) {
    const n = Math.min(block, total - i);
    synth.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return loudnessLufs([L, R], fs);
}

function measureBedLufs(buf: AudioBuffer): number {
  const n = Math.min(buf.length, Math.round(60 * buf.sampleRate));
  const chans: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(buf.getChannelData(c).subarray(0, n));
  // Mono files count once per ear, like the stereo synth.
  if (chans.length === 1) chans.push(chans[0]);
  return loudnessLufs(chans, buf.sampleRate);
}

const clampGain = (db: number) => dbToGain(Math.max(-60, Math.min(MAX_MATCH_GAIN_DB, db)));

function matchLoudness(): void {
  const fs = getCtx().sampleRate;
  const lB = measureSynthLufs(paramsFor('B'), fs);
  const lC = measureSynthLufs(paramsFor('C'), fs);
  gains.B = Number.isFinite(lB) ? clampGain(TARGET_LUFS - lB) : 0;
  const parts = [`B ${lB.toFixed(1)} LUFS`];
  if (bedBuffer && bedLufs !== null && Number.isFinite(bedLufs)) {
    gains.A = clampGain(TARGET_LUFS - bedLufs);
    gains.Cbed = clampGain(TARGET_LUFS + 10 * Math.log10(HYBRID_BED_SHARE) - bedLufs);
    gains.Csynth = Number.isFinite(lC)
      ? clampGain(TARGET_LUFS + 10 * Math.log10(1 - HYBRID_BED_SHARE) - lC)
      : 0;
    parts.unshift(`A ${bedLufs.toFixed(1)} LUFS`);
  }
  lastMatch = `matched to ${TARGET_LUFS} LUFS (${parts.join(', ')} before gain)`;
  $('match-info').textContent = lastMatch;
  applyCandidate();
}

let matchTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutoMatch(): void {
  if (!autoMatch) return;
  if (matchTimer) clearTimeout(matchTimer);
  matchTimer = setTimeout(matchLoudness, 700);
}

// ------------------------------------------------------------------ file loading

async function loadFile(file: File): Promise<void> {
  const info = $('file-info');
  info.textContent = `Decoding ${file.name}…`;
  try {
    const data = await file.arrayBuffer();
    const buf = await getCtx().decodeAudioData(data);
    bedBuffer = buf;
    bedLufs = measureBedLufs(buf);
    fileName = file.name;
    const mins = Math.floor(buf.duration / 60);
    const secs = Math.round(buf.duration % 60);
    const warn = buf.duration < 60 ? ' Short file: segments will be short and repeats more likely.' : '';
    info.textContent = `${file.name}: ${mins}:${String(secs).padStart(2, '0')}, ${buf.numberOfChannels === 1 ? 'mono' : 'stereo'}, ${buf.sampleRate} Hz, ${bedLufs.toFixed(1)} LUFS.${warn}`;
    if (engine) {
      engine.bed.stop(0.3);
      engine.bed.setBuffer(buf);
      if (playing) engine.bed.start();
    }
    document.querySelectorAll<HTMLButtonElement>('#cand-buttons button').forEach((b) => (b.disabled = false));
    matchLoudness();
  } catch (err) {
    info.textContent = `Couldn't decode ${file.name}: ${(err as Error).message}`;
  }
}

// ------------------------------------------------------------------ controls

interface Spec {
  label: string;
  min: number;
  max: number;
  step?: number;
  log?: boolean;
  get: () => number;
  set: (v: number) => void;
  fmt: (v: number) => string;
}

const controlUpdaters: (() => void)[] = [];

function onParamsChanged(): void {
  if (engine) engine.rain.port.postMessage({ type: 'params', params: paramsFor(candidate) });
  scheduleAutoMatch();
}

function slider(parent: HTMLElement, spec: Spec): void {
  const wrap = document.createElement('div');
  wrap.className = 'ctl';
  const id = `c-${spec.label.replace(/\W+/g, '-').toLowerCase()}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = spec.label;
  const out = document.createElement('output');
  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  const RES = 1000;
  const toSlider = (v: number) =>
    spec.log ? (Math.log(v / spec.min) / Math.log(spec.max / spec.min)) * RES : v;
  const fromSlider = (x: number) => (spec.log ? spec.min * Math.pow(spec.max / spec.min, x / RES) : x);
  if (spec.log) {
    input.min = '0';
    input.max = String(RES);
    input.step = '1';
  } else {
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step ?? (spec.max - spec.min) / 200);
  }
  const sync = () => {
    input.value = String(toSlider(spec.get()));
    out.textContent = spec.fmt(spec.get());
    input.setAttribute('aria-valuetext', spec.fmt(spec.get()));
  };
  input.addEventListener('input', () => {
    spec.set(fromSlider(Number(input.value)));
    out.textContent = spec.fmt(spec.get());
    input.setAttribute('aria-valuetext', spec.fmt(spec.get()));
    onParamsChanged();
  });
  controlUpdaters.push(sync);
  sync();
  wrap.append(label, out, input);
  parent.append(wrap);
}

function heading(parent: HTMLElement, text: string): void {
  const h = document.createElement('h3');
  h.textContent = text;
  parent.append(h);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const x = (v: number) => `${v.toFixed(2)}×`;

function rainDescription(r: number): string {
  if (r < 0.5) return 'mist';
  if (r < 2) return 'drizzle';
  if (r < 8) return 'steady';
  if (r < 25) return 'heavy';
  if (r < 80) return 'downpour';
  return 'impossible';
}

function buildControls(): void {
  const root = $('controls');
  root.innerHTML = '';
  controlUpdaters.length = 0;

  heading(root, 'Rain');
  slider(root, {
    label: 'Rain rate',
    min: 0.1,
    max: 500,
    log: true,
    get: () => params.rate,
    set: (v) => (params.rate = v),
    fmt: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} mm/h · ${rainDescription(v)}`,
  });
  slider(root, { label: 'Drop size', min: -2, max: 2, step: 0.05, get: () => params.sizeBias, set: (v) => (params.sizeBias = v), fmt: (v) => (v === 0 ? 'natural' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`) });
  slider(root, { label: 'Wind / gusts', min: 0, max: 1, step: 0.01, get: () => params.wind, set: (v) => (params.wind = v), fmt: pct });

  heading(root, 'Surfaces');
  for (const id of SURFACE_IDS) {
    slider(root, {
      label: SURFACES[id].label,
      min: 0,
      max: 1,
      step: 0.01,
      get: () => params.surfaceMix[id],
      set: (v) => (params.surfaceMix = { ...params.surfaceMix, [id]: v }),
      fmt: pct,
    });
  }

  heading(root, 'Distance tiers');
  slider(root, { label: 'Near level', min: 0, max: 2, step: 0.01, get: () => params.nearLevel, set: (v) => (params.nearLevel = v), fmt: x });
  slider(root, { label: 'Near density', min: 0, max: 4, step: 0.01, get: () => params.nearDensity, set: (v) => (params.nearDensity = v), fmt: x });
  slider(root, { label: 'Mid level', min: 0, max: 2, step: 0.01, get: () => params.midLevel, set: (v) => (params.midLevel = v), fmt: x });
  slider(root, { label: 'Mid density', min: 0, max: 4, step: 0.01, get: () => params.midDensity, set: (v) => (params.midDensity = v), fmt: x });
  slider(root, { label: 'Far wash', min: 0, max: 2, step: 0.01, get: () => params.farLevel, set: (v) => (params.farLevel = v), fmt: x });

  heading(root, 'Beyond physics');
  slider(root, { label: 'Bubble pitch', min: -3, max: 2, step: 0.05, get: () => params.bubblePitch, set: (v) => (params.bubblePitch = v), fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} oct` });
  slider(root, { label: 'Bubble glide', min: 0, max: 2, step: 0.01, get: () => params.bubbleGlide, set: (v) => (params.bubbleGlide = v), fmt: (v) => (Math.abs(v - 0.1) < 0.005 ? 'natural' : v.toFixed(2)) });
  slider(root, { label: 'Time stretch (ring)', min: 1, max: 20, log: true, get: () => params.stretch, set: (v) => (params.stretch = v), fmt: x });

  // Scale
  const scaleWrap = document.createElement('div');
  scaleWrap.className = 'ctl';
  const scaleLabel = document.createElement('label');
  scaleLabel.htmlFor = 'scale';
  scaleLabel.textContent = 'Rain in key';
  const scaleSel = document.createElement('select');
  scaleSel.id = 'scale';
  for (const [k, s] of Object.entries(SCALES)) scaleSel.add(new Option(s.label, k));
  scaleSel.addEventListener('change', () => {
    scaleKey = scaleSel.value as keyof typeof SCALES;
    onParamsChanged();
  });
  controlUpdaters.push(() => (scaleSel.value = scaleKey));
  scaleWrap.append(scaleLabel, document.createElement('span'), scaleSel);
  root.append(scaleWrap);

  // Grid
  const gridWrap = document.createElement('div');
  gridWrap.className = 'ctl';
  const gridLabel = document.createElement('label');
  const gridBox = document.createElement('input');
  gridBox.type = 'checkbox';
  gridBox.addEventListener('change', () => {
    params.grid = { ...params.grid, enabled: gridBox.checked };
    onParamsChanged();
  });
  gridLabel.append(gridBox, ' Rain on the grid (near drops)');
  const divSel = document.createElement('select');
  divSel.setAttribute('aria-label', 'Grid division');
  for (const [v, l] of [[1, 'quarters'], [2, 'eighths'], [3, 'triplets'], [4, 'sixteenths'], [6, 'sextuplets'], [8, '32nds']] as const) {
    divSel.add(new Option(`÷ ${l}`, String(v)));
  }
  divSel.addEventListener('change', () => {
    params.grid = { ...params.grid, division: Number(divSel.value) };
    onParamsChanged();
  });
  controlUpdaters.push(() => {
    gridBox.checked = params.grid.enabled;
    divSel.value = String(params.grid.division);
  });
  gridWrap.append(gridLabel, document.createElement('span'), divSel);
  root.append(gridWrap);
  slider(root, { label: 'Grid tempo', min: 30, max: 200, step: 1, get: () => params.grid.bpm, set: (v) => (params.grid = { ...params.grid, bpm: v }), fmt: (v) => `${Math.round(v)} BPM` });

  // Loudness matching toggle
  const amWrap = document.createElement('div');
  amWrap.className = 'ctl';
  const amLabel = document.createElement('label');
  const amBox = document.createElement('input');
  amBox.type = 'checkbox';
  amBox.checked = autoMatch;
  amBox.addEventListener('change', () => (autoMatch = amBox.checked));
  amLabel.append(amBox, ' Auto-match loudness after changes');
  amWrap.append(amLabel);
  root.append(amWrap);
}

function buildPresets(): void {
  const root = $('presets');
  for (const preset of PRESETS) {
    const b = document.createElement('button');
    b.textContent = preset.label;
    b.addEventListener('click', () => {
      params = { ...structuredClone(DEFAULT_RAIN_PARAMS), ...structuredClone(preset.params) };
      scaleKey = preset.scaleKey ?? 'off';
      controlUpdaters.forEach((u) => u());
      onParamsChanged();
      if (autoMatch) matchLoudness();
    });
    root.append(b);
  }
}

// ------------------------------------------------------------------ blind test

function setMode(m: 'explore' | 'blind'): void {
  mode = m;
  $('tab-explore').setAttribute('aria-selected', String(m === 'explore'));
  $('tab-blind').setAttribute('aria-selected', String(m === 'blind'));
  $('explore').hidden = m !== 'explore';
  $('blind').hidden = m !== 'blind';
  $('blind-cover').hidden = m !== 'blind';
  if (m === 'explore') setCandidate(candidate);
}

function startBlind(): void {
  if (!bedBuffer) {
    $('blind-status').textContent = 'Load a recorded rain file first: the test compares it against the synth.';
    return;
  }
  blind = newSession();
  blindActive = null;
  matchLoudness();
  $('blind-status').textContent = `Session ${blind.id}. Parameters are frozen to what you set in Explore.`;
  $('blind-panel').hidden = false;
  $('blind-reveal').innerHTML = '';
  renderBlind();
}

function selectBlind(label: BlindLabel): void {
  if (!blind) return;
  blindActive = label;
  candidate = blind.mapping[label];
  applyCandidate();
  renderBlind();
}

function renderBlind(): void {
  const grid = $('blind-grid');
  grid.innerHTML = '';
  if (!blind) return;
  for (const label of LABELS) {
    const r = blind.results[label];
    const card = document.createElement('div');
    card.className = `blind-card${blindActive === label ? ' on' : ''}`;
    const h = document.createElement('h3');
    h.textContent = label;
    const play = document.createElement('button');
    play.textContent = blindActive === label ? 'Playing' : `Listen to ${label}`;
    play.className = blindActive === label ? 'on' : '';
    play.addEventListener('click', () => selectBlind(label));
    card.append(h, play);
    for (const [key, text] of [['realism', 'Realism'], ['study', 'Study to it?']] as const) {
      const row = document.createElement('div');
      row.className = 'rating';
      row.append(`${text}: `);
      for (let v = 1; v <= 5; v++) {
        const b = document.createElement('button');
        b.textContent = String(v);
        b.className = r[key] === v ? 'on' : '';
        b.setAttribute('aria-pressed', String(r[key] === v));
        b.addEventListener('click', () => {
          r[key] = v;
          renderBlind();
        });
        row.append(b);
      }
      card.append(row);
    }
    const rep = document.createElement('button');
    rep.textContent = `Heard a repeat (${r.repeatPresses})`;
    rep.addEventListener('click', () => {
      r.repeatPresses++;
      renderBlind();
    });
    const time = document.createElement('div');
    time.className = 'muted';
    time.id = `blind-time-${label}`;
    time.textContent = `Listened ${Math.floor(r.listenedSeconds / 60)}:${String(Math.floor(r.listenedSeconds % 60)).padStart(2, '0')}`;
    card.append(rep, time);
    grid.append(card);
  }
}

function finishBlind(): void {
  if (!blind) return;
  if (!isComplete(blind)) {
    $('blind-reveal').textContent = 'Rate realism and study-ability for all three first.';
    return;
  }
  const rows = summarise(blind);
  const record = {
    session: blind,
    summary: rows,
    verdict: verdict(rows),
    params: paramsFor('B'),
    scaleKey,
    file: fileName,
    bedLufs,
    gains: { ...gains },
    userAgent: navigator.userAgent,
  };
  const all = loadResults();
  all.push(record);
  try {
    localStorage.setItem(RESULTS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable; the download still works
  }
  const table = document.createElement('table');
  table.innerHTML =
    '<tr><th>Label</th><th>Was</th><th>Realism</th><th>Study</th><th>Repeats / 10 min</th><th>Listened</th></tr>' +
    rows
      .map(
        (r) =>
          `<tr><td>${r.label}</td><td>${r.candidate} · ${r.name}</td><td>${r.realism}</td><td>${r.study}</td>` +
          `<td>${r.repeatsPer10Min === null ? 'n/a (under 30 s)' : r.repeatsPer10Min.toFixed(2)}</td>` +
          `<td>${r.listenedMinutes.toFixed(1)} min</td></tr>`,
      )
      .join('');
  const v = document.createElement('p');
  v.textContent = record.verdict;
  $('blind-reveal').replaceChildren(table, v);
  blind = null;
  blindActive = null;
}

function loadResults(): unknown[] {
  try {
    return JSON.parse(localStorage.getItem(RESULTS_KEY) ?? '[]') as unknown[];
  } catch {
    return [];
  }
}

function exportResults(): void {
  const blob = new Blob([JSON.stringify(loadResults(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rain-bakeoff-results-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ stats

function renderStats(): void {
  const lines: string[] = [];
  if (!engine) {
    $('stats').textContent = 'Not started.';
    return;
  }
  const { ctx } = engine;
  lines.push(
    `context ${ctx.state} · ${ctx.sampleRate} Hz · base latency ${(ctx.baseLatency * 1000).toFixed(1)} ms · output latency ${((ctx.outputLatency ?? 0) * 1000).toFixed(1)} ms`,
  );
  if (mode === 'explore') {
    const g = candidateGains(candidate);
    lines.push(
      `candidate ${candidate} (${CANDIDATE_NAMES[candidate]}) · bed ${gainToDb(g.bed).toFixed(1)} dB · synth ${gainToDb(g.rain).toFixed(1)} dB`,
    );
  } else {
    lines.push('candidate hidden (blind test)');
  }
  if (rainStats) {
    lines.push(
      `synth: ${rainStats.nearRate.toFixed(1)} near drops/s · ${Math.round(rainStats.midRate)} mid drops/s · ${rainStats.voices} voices · ${rainStats.dropped} dropped`,
    );
  }
  if (meter) {
    lines.push(
      `master: peak ${gainToDb(meter.peak).toFixed(1)} dBFS · limiter ${meter.minGain < 0.999 ? `−${(-gainToDb(meter.minGain)).toFixed(1)} dB` : 'idle'} · NaN events ${meter.nanEvents}`,
    );
  }
  if (bedBuffer && engine.bed.history.length > 0 && mode === 'explore') {
    const h = engine.bed.history[engine.bed.history.length - 1];
    lines.push(
      `bed: ${engine.bed.history.length} segments scheduled · last at ${h.offset.toFixed(1)} s for ${h.duration.toFixed(1)} s, crossfade ${h.crossfade.toFixed(1)} s, region ${h.region}`,
    );
  }
  if (lastMatch && mode === 'explore') lines.push(lastMatch);
  $('stats').textContent = lines.join('\n');
}

// ------------------------------------------------------------------ wiring

const ripples = new RippleView(
  $<HTMLCanvasElement>('lake'),
  () => {
    const ctx = ctxSingleton;
    if (!ctx) return 0;
    // The sample being heard right now, not the one being computed.
    const ts = ctx.getOutputTimestamp?.();
    return ts?.contextTime ?? ctx.currentTime - (ctx.outputLatency ?? 0);
  },
  () => reducedMotion.matches,
);

function init(): void {
  buildControls();
  buildPresets();
  $('play').addEventListener('click', () => void togglePlay());
  $<HTMLInputElement>('volume').addEventListener('input', (e) => {
    const db = Number((e.target as HTMLInputElement).value);
    $('volume-out').textContent = `${db <= -40 ? '−∞' : db.toFixed(1).replace('-', '−')} dB`;
    if (engine && playing) engine.master.gain.setTargetAtTime(dbToGain(db), engine.ctx.currentTime, 0.05);
  });
  $<HTMLInputElement>('file').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void loadFile(f);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f);
  });
  document.querySelectorAll<HTMLButtonElement>('#cand-buttons button').forEach((b) => {
    if (b.dataset.cand !== 'B') b.disabled = true;
    b.addEventListener('click', () => setCandidate(b.dataset.cand as Candidate));
  });
  $('match').addEventListener('click', matchLoudness);
  $('tab-explore').addEventListener('click', () => setMode('explore'));
  $('tab-blind').addEventListener('click', () => setMode('blind'));
  $('blind-start').addEventListener('click', startBlind);
  $('blind-finish').addEventListener('click', finishBlind);
  $('blind-export').addEventListener('click', exportResults);

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    if (e.key === ' ') {
      e.preventDefault();
      void togglePlay();
    } else if (mode === 'blind' && (e.key === 'r' || e.key === 'R') && blind && blindActive) {
      blind.results[blindActive].repeatPresses++;
      renderBlind();
    } else if (mode === 'explore' && ['1', '2', '3'].includes(e.key)) {
      setCandidate((['A', 'B', 'C'] as const)[Number(e.key) - 1]);
    }
  });

  // Listening-time accounting for the blind test.
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    if (blind && blindActive && playing && engine?.ctx.state === 'running') {
      const r = blind.results[blindActive];
      r.listenedSeconds += dt;
      const el = document.getElementById(`blind-time-${blindActive}`);
      if (el) el.textContent = `Listened ${Math.floor(r.listenedSeconds / 60)}:${String(Math.floor(r.listenedSeconds % 60)).padStart(2, '0')}`;
    }
    renderStats();
  }, 250);

  ripples.start();
}

init();
