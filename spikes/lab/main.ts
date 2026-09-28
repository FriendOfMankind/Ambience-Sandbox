import worldWorkletUrl from '../../src/audio/worklets/world.worklet.ts?worker&url';
import limiterWorkletUrl from '../../src/audio/worklets/limiter.worklet.ts?worker&url';
import type { WorldOutMessage } from '../../src/audio/worklets/world.worklet';
import type { LimiterOutMessage } from '../../src/audio/worklets/limiter.worklet';
import { LAYERS, type LayerId } from '../../src/audio/world/WorldSynth';
import { dbToGain, gainToDb } from '../../src/audio/dsp/loudness';
import { sceneState, stateToPatch, type SceneState } from '../sandbox/scenes';
import { LAB_TESTS, type LabTest, type Tune } from './tests';
import { PROBLEM_TAGS, buildReport, emptyFeedback, getPath, hasFeedback, patchFor, setPath, tuneDiffers, type Feedback, type Nudge, type Session } from './feedback';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const STORE_KEY = 'tarn-lab-v1';

// ------------------------------------------------------------------ persistence (best effort)

interface Saved {
  feedback: Record<string, Feedback>;
  session: Session;
  current: string;
}

function load(): Saved {
  const fresh: Saved = { feedback: {}, session: { device: '', volumeDb: -14 }, current: LAB_TESTS[0].id };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fresh;
    const s = JSON.parse(raw) as Partial<Saved>;
    return { feedback: s.feedback ?? {}, session: { ...fresh.session, ...s.session }, current: s.current && LAB_TESTS.some((t) => t.id === s.current) ? s.current : fresh.current };
  } catch {
    return fresh;
  }
}

let saved = load();
let storageOk = true;
function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
  } catch {
    storageOk = false;
  }
  renderProgress();
}

const fb = (id: string): Feedback => (saved.feedback[id] ??= emptyFeedback());

// ------------------------------------------------------------------ audio

interface Voice {
  node: AudioWorkletNode;
  gain: GainNode;
}
interface Engine {
  ctx: AudioContext;
  master: GainNode;
}

let engine: Engine | null = null;
let voice: Voice | null = null;
let playing = false;
let startedAt = 0; // ctx time when the current voice started
let tick: WorldOutMessage | null = null;
let meter: LimiterOutMessage | null = null;

/** What we've heard of the current test this visit. Folded into the saved feedback as we go. */
const live = { powerSum: 0, samples: 0, peak: 0, minGain: 1 };

let test: LabTest = LAB_TESTS.find((t) => t.id === saved.current) ?? LAB_TESTS[0];
let state: SceneState = stateFor(test);

/** Scene state with the listener's earlier slider choices re-applied. */
function stateFor(t: LabTest): SceneState {
  const st = sceneState(t.scene);
  for (const [path, v] of Object.entries(fb(t.id).tuned)) setPath(st.world, path, v);
  return st;
}

const startValue = (t: LabTest, tune: Tune): number => getPath(sceneState(t.scene).world, tune.path);

async function ensureEngine(): Promise<Engine> {
  if (engine) return engine;
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (nav.audioSession) nav.audioSession.type = 'playback';
  const ctx = new AudioContext({ latencyHint: 'playback' });
  await Promise.all([ctx.audioWorklet.addModule(worldWorkletUrl), ctx.audioWorklet.addModule(limiterWorkletUrl)]);
  const limiter = new AudioWorkletNode(ctx, 'limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  limiter.port.onmessage = (e: MessageEvent<LimiterOutMessage>) => {
    meter = e.data;
    if (playing) {
      live.peak = Math.max(live.peak, meter.peak);
      live.minGain = Math.min(live.minGain, meter.minGain);
    }
  };
  limiter.onprocessorerror = () => showError('The safety limiter crashed. Reload the page.');
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(limiter).connect(ctx.destination);
  engine = { ctx, master };
  return engine;
}

/** Start the current test from the top, crossfading out whatever was playing. */
function startVoice(e: Engine): void {
  const { ctx, master } = e;
  const t = ctx.currentTime;
  if (voice) fadeOut(voice, t);
  const node = new AudioWorkletNode(ctx, 'world', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { seed: `lab-${test.id}`, patch: stateToPatch(state) },
  });
  node.port.onmessage = (m: MessageEvent<WorldOutMessage>) => (tick = m.data);
  node.onprocessorerror = () => showError('The sound engine crashed. Reload the page and tell Claude which test and what you changed.');
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(1, t + 0.5);
  node.connect(gain).connect(master);
  voice = { node, gain };
  startedAt = t;
  tick = null;
  live.powerSum = 0;
  live.samples = 0;
  live.peak = 0;
  live.minGain = 1;
}

function fadeOut(v: Voice, t: number): void {
  v.gain.gain.cancelScheduledValues(t);
  v.gain.gain.setValueAtTime(v.gain.gain.value, t);
  v.gain.gain.linearRampToValueAtTime(0, t + 0.5);
  setTimeout(() => {
    // Disconnecting alone leaves the synth rendering in the audio thread. Every switched-away
    // test would keep burning CPU until the audio starved and crackled.
    v.node.port.postMessage({ type: 'stop' });
    v.node.disconnect();
    v.gain.disconnect();
    v.node.port.close();
  }, 700);
}

function dropVoice(): void {
  if (voice && engine) fadeOut(voice, engine.ctx.currentTime);
  voice = null;
  tick = null;
}

async function play(): Promise<void> {
  let e: Engine;
  try {
    e = await ensureEngine();
    await e.ctx.resume();
  } catch (err) {
    showError(`Couldn't start the audio engine: ${(err as Error).message}`);
    return;
  }
  const t = e.ctx.currentTime;
  e.master.gain.cancelScheduledValues(t);
  e.master.gain.setValueAtTime(e.master.gain.value, t);
  e.master.gain.linearRampToValueAtTime(dbToGain(saved.session.volumeDb), t + 0.4);
  if (!voice) startVoice(e);
  playing = true;
  renderTransport();
}

function pause(): void {
  if (!engine) return;
  foldMeasurement();
  const { ctx, master } = engine;
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(master.gain.value, t);
  master.gain.linearRampToValueAtTime(0, t + 0.4);
  playing = false;
  setTimeout(() => {
    if (!playing) void ctx.suspend();
  }, 500);
  renderTransport();
}

function restart(): void {
  if (!engine) return void play();
  foldMeasurement();
  startVoice(engine);
  if (!playing) void play();
}

/** Merge what was heard this visit into the test's saved measurement. */
function foldMeasurement(): void {
  if (live.samples < 15) return; // under ~3 s says nothing
  const f = fb(test.id);
  const seconds = live.samples * 0.2;
  const power = live.powerSum / live.samples;
  const old = f.measured;
  const oldPower = old ? Math.pow(10, old.rmsDb / 10) : 0;
  const total = (old?.seconds ?? 0) + seconds;
  const mean = old ? (oldPower * old.seconds + power * seconds) / total : power;
  f.measured = {
    rmsDb: 10 * Math.log10(Math.max(mean, 1e-12)),
    peakDb: Math.max(old?.peakDb ?? -120, gainToDb(live.peak)),
    limiterDb: Math.max(old?.limiterDb ?? 0, -gainToDb(live.minGain)),
    seconds: total,
  };
  live.powerSum = 0;
  live.samples = 0;
  live.peak = 0;
  live.minGain = 1;
  save();
}

function send(patch: Record<string, unknown>): void {
  voice?.node.port.postMessage({ type: 'params', patch });
}

function showError(text: string): void {
  const el = $('error');
  el.textContent = text;
  el.hidden = false;
}

// ------------------------------------------------------------------ selecting a test

function select(id: string): void {
  const next = LAB_TESTS.find((t) => t.id === id);
  if (!next || next === test) return;
  foldMeasurement();
  test = next;
  state = stateFor(test);
  saved.current = id;
  save();
  if (playing && engine) startVoice(engine);
  else dropVoice();
  updateNav();
  renderPanel();
}

const step = (d: number) => {
  const i = LAB_TESTS.indexOf(test);
  const n = LAB_TESTS[(i + d + LAB_TESTS.length) % LAB_TESTS.length];
  select(n.id);
};

// ------------------------------------------------------------------ rendering

const STATUS_WORD = { rebuilt: 'rebuilt, not heard', unheard: 'not heard yet', heard: 'you\'ve heard this' } as const;
const RATE_WORDS = ['Nope', 'Meh', 'OK', 'Good', 'Great'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderNav(): void {
  const nav = $('nav');
  nav.innerHTML = '';
  let group = '';
  for (const t of LAB_TESTS) {
    if (t.group !== group) {
      group = t.group;
      nav.append(el('h2', 'label', group));
    }
    const b = el('button', 'nav-item');
    b.dataset.id = t.id;
    b.setAttribute('aria-current', String(t === test));
    const dot = el('span', 'dot');
    dot.classList.toggle('done', hasFeedback(saved.feedback[t.id]));
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', hasFeedback(saved.feedback[t.id]) ? 'has feedback' : 'no feedback yet');
    b.append(dot, el('span', undefined, t.title));
    b.addEventListener('click', () => select(t.id));
    nav.append(b);
  }
}

function updateNav(): void {
  document.querySelectorAll<HTMLElement>('#nav .nav-item').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === test.id)));
}

function renderProgress(): void {
  const n = LAB_TESTS.filter((t) => hasFeedback(saved.feedback[t.id])).length;
  $('progress').textContent = `${n} / ${LAB_TESTS.length} with feedback${storageOk ? '' : ' (not saved: storage blocked, use Report before leaving)'}`;
  document.querySelectorAll<HTMLElement>('#nav .nav-item').forEach((b) => {
    b.querySelector('.dot')?.classList.toggle('done', hasFeedback(saved.feedback[b.dataset.id!]));
  });
}

function group<T extends string | number>(
  label: string,
  options: { value: T; text: string }[],
  get: () => T | undefined,
  set: (v: T | undefined) => void,
  cls = 'seg',
): HTMLElement {
  const wrap = el('div', 'fgroup');
  const lab = el('div', 'flabel', label);
  const row = el('div', cls);
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', label);
  const refresh = () => {
    row.querySelectorAll('button').forEach((b, i) => {
      const on = get() === options[i].value;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
    });
  };
  options.forEach((o) => {
    const b = el('button', undefined, o.text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      set(get() === o.value ? undefined : o.value); // click again to clear
      refresh();
      save();
    });
    row.append(b);
  });
  refresh();
  wrap.append(lab, row);
  return wrap;
}

function renderPanel(): void {
  const p = $('panel');
  p.innerHTML = '';
  const f = fb(test.id);

  const head = el('div', 'panel-head');
  const h = el('h2', undefined, test.title);
  const badge = el('span', `badge ${test.status}`, STATUS_WORD[test.status]);
  head.append(h, badge);
  const listen = el('p', 'listen');
  listen.append(el('strong', undefined, 'Listen for: '), test.listenFor);
  p.append(head, listen);

  // Transport
  const tr = el('div', 'transport');
  const playBtn = el('button', 'primary');
  playBtn.id = 'play';
  playBtn.addEventListener('click', () => (playing ? pause() : void play()));
  const restartBtn = el('button', undefined, '↺ From the top');
  restartBtn.addEventListener('click', restart);
  const clock = el('span', 'clock');
  clock.id = 'clock';
  const vol = el('label', 'inline');
  const volIn = el('input');
  volIn.type = 'range';
  volIn.min = '-40';
  volIn.max = '0';
  volIn.step = '0.5';
  volIn.value = String(saved.session.volumeDb);
  const volOut = el('output');
  const showVol = () => (volOut.textContent = `${saved.session.volumeDb.toFixed(1).replace('-', '−')} dB`);
  showVol();
  volIn.addEventListener('input', () => {
    saved.session.volumeDb = Number(volIn.value);
    showVol();
    if (engine && playing) engine.master.gain.setTargetAtTime(dbToGain(saved.session.volumeDb), engine.ctx.currentTime, 0.05);
    save();
  });
  vol.append('Volume ', volIn, ' ', volOut);
  const nav2 = el('span', 'stepper');
  const prev = el('button', undefined, '←');
  prev.title = 'Previous test';
  prev.setAttribute('aria-label', 'Previous test');
  prev.addEventListener('click', () => step(-1));
  const next = el('button', undefined, '→');
  next.title = 'Next test';
  next.setAttribute('aria-label', 'Next test');
  next.addEventListener('click', () => step(1));
  nav2.append(prev, next);
  tr.append(playBtn, restartBtn, clock, vol, nav2);
  p.append(tr);

  const meters = el('div', 'meters');
  meters.id = 'meters';
  p.append(meters);

  // Tune
  const tune = el('section', 'card');
  const th = el('div', 'card-head');
  th.append(el('h3', undefined, 'Tweak it'));
  const reset = el('button', 'small', 'Reset to start');
  reset.addEventListener('click', () => {
    f.tuned = {};
    state = sceneState(test.scene);
    if (voice) send(stateToPatch(state) as Record<string, unknown>);
    save();
    renderPanel();
  });
  th.append(reset);
  tune.append(th, el('p', 'muted', 'Move these until it sounds right. What you land on goes in the report, so I can bake it in.'));
  const sliders = el('div', 'ctls');
  test.tune.forEach((t, i) => sliders.append(slider(t, `tune-${i}`)));
  tune.append(sliders);
  p.append(tune);

  // Feedback
  const card = el('section', 'card');
  card.append(el('h3', undefined, 'How is it?'));
  card.append(el('p', 'question', test.question));
  const rateOpts = RATE_WORDS.map((text, i) => ({ value: i + 1, text: `${i + 1} ${text}` }));
  card.append(group(test.realLabel, rateOpts, () => f.real, (v) => (f.real = v), 'seg five'));
  card.append(group('Pleasant to listen to', rateOpts, () => f.pleasant, (v) => (f.pleasant = v), 'seg five'));
  const nudges = el('div', 'nudges');
  const n3 = (kind: 'level' | 'bright' | 'busy', label: string, words: [string, string, string]) =>
    group<Nudge>(label, ([-1, 0, 1] as Nudge[]).map((v, i) => ({ value: v, text: words[i] })), () => f[kind], (v) => (f[kind] = v));
  nudges.append(n3('level', 'Level', ['too quiet', 'right', 'too loud']), n3('bright', 'Tone', ['too dull', 'right', 'too bright']), n3('busy', 'Density', ['too sparse', 'right', 'too busy']));
  card.append(nudges);

  const tagsWrap = el('div', 'fgroup');
  tagsWrap.append(el('div', 'flabel', 'Anything wrong? (pick any)'));
  const chips = el('div', 'chips');
  for (const tag of PROBLEM_TAGS) {
    const c = el('button', 'chip', tag);
    c.type = 'button';
    c.setAttribute('aria-pressed', String(f.tags.includes(tag)));
    c.classList.toggle('on', f.tags.includes(tag));
    c.addEventListener('click', () => {
      f.tags = f.tags.includes(tag) ? f.tags.filter((x) => x !== tag) : [...f.tags, tag];
      c.setAttribute('aria-pressed', String(f.tags.includes(tag)));
      c.classList.toggle('on', f.tags.includes(tag));
      save();
    });
    chips.append(c);
  }
  tagsWrap.append(chips);
  card.append(tagsWrap);

  const noteWrap = el('label', 'fgroup');
  noteWrap.append(el('span', 'flabel', 'In your words (what it reminds you of, when a problem happens, what you\'d change). The clock helps: "click at 0:42".'));
  const note = el('textarea');
  note.rows = 3;
  note.value = f.note;
  note.addEventListener('input', () => {
    f.note = note.value;
    save();
  });
  noteWrap.append(note);
  card.append(noteWrap);
  p.append(card);

  renderTransport();
  syncers.forEach((s) => s());
}

const syncers: (() => void)[] = [];

function slider(t: Tune, id: string): HTMLElement {
  const f = fb(test.id);
  const wrap = el('div', 'ctl');
  const label = el('label', undefined, t.label);
  label.htmlFor = id;
  const out = el('output');
  const input = el('input');
  input.type = 'range';
  input.id = id;
  const RES = 1000;
  const read = () => {
    const raw = getPath(state.world, t.path);
    return t.invert ? 1 - raw : raw;
  };
  const to = (v: number) => (t.log ? (Math.log(v / t.min) / Math.log(t.max / t.min)) * RES : v);
  const from = (x: number) => (t.log ? t.min * Math.pow(t.max / t.min, x / RES) : x);
  input.min = t.log ? '0' : String(t.min);
  input.max = t.log ? String(RES) : String(t.max);
  input.step = t.log ? '1' : String(t.step ?? (t.max - t.min) / 100);
  const show = () => {
    out.textContent = t.fmt(read());
    input.setAttribute('aria-valuetext', t.fmt(read()));
  };
  input.value = String(to(Math.min(t.max, Math.max(t.min, read()))));
  show();
  input.addEventListener('input', () => {
    const v = from(Number(input.value));
    const raw = t.invert ? 1 - v : v;
    setPath(state.world, t.path, raw);
    show();
    if (tuneDiffers(raw, startValue(test, t))) f.tuned[t.path] = raw;
    else delete f.tuned[t.path];
    send(patchFor(state.world as unknown as Record<string, unknown>, t.path));
    save();
  });
  wrap.append(label, out, input);
  return wrap;
}

function renderTransport(): void {
  const b = document.getElementById('play');
  if (b) {
    b.textContent = playing ? '❚❚ Pause' : '▶ Play';
    b.setAttribute('aria-pressed', String(playing));
  }
}

const layerName: Record<LayerId, string> = { rain: 'Rain', wind: 'Wind', chimes: 'Chimes', music: 'Music' };

function renderLive(): void {
  const clock = document.getElementById('clock');
  if (clock) {
    const s = engine && voice && playing ? Math.max(0, engine.ctx.currentTime - startedAt) : 0;
    clock.textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
  const m = document.getElementById('meters');
  if (!m) return;
  if (!m.firstChild) {
    for (const l of LAYERS) {
      const row = el('div', 'mrow');
      row.dataset.layer = l;
      row.append(el('span', undefined, layerName[l]), el('div', 'meter'), el('span', 'mval'));
      row.querySelector('.meter')!.append(el('span'));
      m.append(row);
    }
    m.append(el('div', 'limiter muted'));
  }
  const on = new Set(test.layers);
  m.querySelectorAll<HTMLElement>('.mrow').forEach((row) => {
    const l = row.dataset.layer as LayerId;
    const active = on.has(l) && state.world.mix[l].on;
    row.hidden = !active;
    const lvl = tick?.features.level[l] ?? 0;
    const db = gainToDb(lvl);
    (row.querySelector('.meter span') as HTMLElement).style.width = `${Math.max(0, Math.min(100, ((db + 60) / 50) * 100))}%`;
    row.querySelector('.mval')!.textContent = lvl > 1e-5 ? `${db.toFixed(0)} dB` : '';
  });
  const lim = m.querySelector('.limiter')!;
  lim.textContent = meter ? `output peak ${gainToDb(meter.peak).toFixed(1)} dBFS · limiter ${meter.minGain < 0.999 ? `−${(-gainToDb(meter.minGain)).toFixed(1)} dB (too hot!)` : 'idle'}${meter.nanEvents ? ` · ${meter.nanEvents} glitch(es) recovered` : ''}` : '';
}

/** 5 Hz: sample the level of the layers under test, and refresh the readouts. */
function sample(): void {
  if (playing && tick && engine && engine.ctx.currentTime - startedAt > 1) {
    let p = 0;
    for (const l of test.layers) p += tick.features.level[l] ** 2;
    live.powerSum += p;
    live.samples++;
  }
  renderLive();
}

// ------------------------------------------------------------------ report dialog

function openReport(): void {
  foldMeasurement();
  const text = buildReport(LAB_TESTS, saved.feedback, saved.session, startValue);
  $<HTMLTextAreaElement>('report-text').value = text;
  $('report-msg').textContent = '';
  $<HTMLDialogElement>('report').showModal();
}

async function copyReport(): Promise<void> {
  const ta = $<HTMLTextAreaElement>('report-text');
  try {
    await navigator.clipboard.writeText(ta.value);
    $('report-msg').textContent = 'Copied.';
  } catch {
    ta.select();
    $('report-msg').textContent = document.execCommand?.('copy') ? 'Copied.' : 'Copy blocked here: the text is selected, press Ctrl/Cmd+C.';
  }
}

let clearArmed = false;
function clearAll(): void {
  const btn = $('report-clear');
  if (!clearArmed) {
    clearArmed = true;
    btn.textContent = 'Really clear everything?';
    setTimeout(() => {
      clearArmed = false;
      btn.textContent = 'Clear all feedback';
    }, 4000);
    return;
  }
  clearArmed = false;
  btn.textContent = 'Clear all feedback';
  saved.feedback = {};
  state = stateFor(test);
  if (voice) send(stateToPatch(state) as Record<string, unknown>);
  save();
  renderPanel();
  $<HTMLDialogElement>('report').close();
}

// ------------------------------------------------------------------ wiring

function init(): void {
  const dev = $<HTMLSelectElement>('device');
  dev.value = saved.session.device;
  dev.addEventListener('change', () => {
    saved.session.device = dev.value;
    save();
  });
  $('report-open').addEventListener('click', openReport);
  $('report-copy').addEventListener('click', () => void copyReport());
  $('report-clear').addEventListener('click', clearAll);
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (playing) pause();
      else void play();
    } else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  });
  window.addEventListener('pagehide', foldMeasurement);
  renderNav();
  renderPanel();
  renderProgress();
  setInterval(sample, 200);
}

init();
