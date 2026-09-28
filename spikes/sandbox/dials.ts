/**
 * Floating dials. Each dial is a native range input (so Tab, arrows, Page Up/Down, Home/End,
 * labels and screen readers all work as usual) under a drawn ring. Pointer: drag up/down or
 * across; hold Shift for fine control; the wheel nudges a hovered dial.
 */

export interface SliderSpec {
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

const RES = 1000;
/** Value ↔ input units, shared with the strip sliders so both stay in step. */
export const toInput = (s: SliderSpec, v: number) => (s.log ? (Math.log(v / s.min) / Math.log(s.max / s.min)) * RES : v);
export const fromInput = (s: SliderSpec, x: number) => (s.log ? s.min * Math.pow(s.max / s.min, x / RES) : x);
export function inputRange(s: SliderSpec): { min: string; max: string; step: string } {
  return {
    min: s.log ? '0' : String(s.min),
    max: s.log ? String(RES) : String(s.max),
    step: s.log ? '1' : String(s.step ?? (s.max - s.min) / 100),
  };
}

const R = 24;
const C = 2 * Math.PI * R;
const SWEEP = 0.75;

/** Build one dial; returns a function that redraws it from the spec's current value. */
export function dial(parent: HTMLElement, s: SliderSpec, onInput: () => void): () => void {
  const wrap = document.createElement('div');
  wrap.className = 'dial';
  const id = `dial-${s.id}`;
  wrap.innerHTML = `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle class="track" cx="32" cy="32" r="${R}" stroke-dasharray="${C * SWEEP} ${C}" transform="rotate(135 32 32)"></circle>
      <circle class="arc" cx="32" cy="32" r="${R}" transform="rotate(135 32 32)"></circle>
      <line class="tick" x1="32" y1="14" x2="32" y2="21"></line>
    </svg>`;
  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  input.className = 'dial-input';
  Object.assign(input, inputRange(s));
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = s.label;
  const out = document.createElement('output');
  out.htmlFor = id;
  wrap.append(input, label, out);
  parent.append(wrap);

  const arc = wrap.querySelector<SVGCircleElement>('.arc')!;
  const tick = wrap.querySelector<SVGLineElement>('.tick')!;
  const frac = () => (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));

  const draw = () => {
    const f = Math.min(1, Math.max(0, frac()));
    arc.setAttribute('stroke-dasharray', `${Math.max(0.001, C * SWEEP * f)} ${C}`);
    tick.setAttribute('transform', `rotate(${-135 + 270 * f} 32 32)`);
    const text = s.fmt(s.get());
    out.textContent = text;
    input.setAttribute('aria-valuetext', `${s.label}: ${text}`);
  };
  const sync = () => {
    input.value = String(toInput(s, s.get()));
    draw();
  };
  input.addEventListener('input', () => {
    s.set(fromInput(s, Number(input.value)));
    draw();
    onInput();
  });

  const setFrac = (f: number) => {
    const min = Number(input.min);
    const max = Number(input.max);
    const before = input.value;
    input.value = String(min + Math.min(1, Math.max(0, f)) * (max - min));
    if (input.value !== before) input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  let drag: { x: number; y: number; f: number } | null = null;
  const svg = wrap.querySelector('svg')!;
  svg.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    input.focus({ preventScroll: true });
    svg.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, f: frac() };
    wrap.classList.add('active');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const span = e.shiftKey ? 700 : 170;
    setFrac(drag.f + (drag.y - e.clientY + (e.clientX - drag.x)) / span);
  });
  const end = () => { drag = null; wrap.classList.remove('active'); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    setFrac(frac() - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.02));
  }, { passive: false });
  svg.addEventListener('dblclick', () => input.focus());

  return sync;
}
