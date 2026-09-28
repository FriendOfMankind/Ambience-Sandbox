/** Feedback data, parameter paths, and the report that gets pasted back to Claude. Pure: no DOM. */
import type { LabTest, Tune } from './tests';

export const PROBLEM_TAGS = [
  'static / hiss', 'clicks / pops', 'harsh / piercing', 'metallic', 'thin', 'muddy', 'too regular',
  'repetitive', 'robotic / artificial', 'distracting', 'fatiguing', 'jumpy / sudden changes',
] as const;

export type Nudge = -1 | 0 | 1;

export interface Measured {
  /** Mean RMS of the layers under test while playing, in dBFS (power average). */
  rmsDb: number;
  /** Highest output peak seen, dBFS. */
  peakDb: number;
  /** Deepest limiter reduction seen, dB (0 = never touched). */
  limiterDb: number;
  seconds: number;
}

export interface Feedback {
  real?: number;
  pleasant?: number;
  level?: Nudge;
  bright?: Nudge;
  busy?: Nudge;
  tags: string[];
  note: string;
  /** Slider values the listener settled on, by param path (only those that differ from the start). */
  tuned: Record<string, number>;
  measured?: Measured;
}

export interface Session {
  device: string;
  volumeDb: number;
}

export const emptyFeedback = (): Feedback => ({ tags: [], note: '', tuned: {} });

export const hasFeedback = (f: Feedback | undefined): boolean =>
  !!f && (f.real !== undefined || f.pleasant !== undefined || f.level !== undefined || f.bright !== undefined || f.busy !== undefined || f.tags.length > 0 || f.note.trim() !== '' || Object.keys(f.tuned).length > 0);

// ------------------------------------------------------------------ paths

export function getPath(obj: unknown, path: string): number {
  let cur = obj as Record<string, unknown>;
  for (const k of path.split('.')) cur = cur?.[k] as Record<string, unknown>;
  return cur as unknown as number;
}

export function setPath(obj: unknown, path: string, value: number): void {
  const keys = path.split('.');
  let cur = obj as Record<string, Record<string, unknown>>;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, Record<string, unknown>>;
  (cur as unknown as Record<string, number>)[keys[keys.length - 1]] = value;
}

/** Which top-level WorldParams key a path belongs to, and the sub-key for `mix`. */
export function patchFor(world: Record<string, unknown>, path: string): Record<string, unknown> {
  const [top, layer] = path.split('.');
  if (top === 'mix') return { mix: { [layer]: (world.mix as Record<string, unknown>)[layer] } };
  return { [top]: world[top] };
}

export const tuneDiffers = (a: number, b: number): boolean => Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a));

// ------------------------------------------------------------------ report

const STARS = ['', '1 (bad)', '2', '3 (ok)', '4', '5 (great)'];
const NUDGE_WORDS: Record<'level' | 'bright' | 'busy', [string, string, string]> = {
  level: ['too quiet', 'about right', 'too loud'],
  bright: ['too dull', 'about right', 'too bright / harsh'],
  busy: ['too sparse', 'about right', 'too busy'],
};

const nudge = (kind: keyof typeof NUDGE_WORDS, v: Nudge): string => NUDGE_WORDS[kind][v + 1];

function tuneLine(t: Tune, to: number, from: number): string {
  const shown = (v: number) => t.fmt(t.invert ? 1 - v : v);
  return `${t.label} (\`${t.path}\`): ${shown(from)} → ${shown(to)}`;
}

export function buildReport(tests: LabTest[], store: Record<string, Feedback>, session: Session, startValues: (test: LabTest, t: Tune) => number, date = new Date()): string {
  const done = tests.filter((t) => hasFeedback(store[t.id]));
  const lines: string[] = [];
  lines.push(`# Tarn Lab feedback, ${date.toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`Listening on: ${session.device || '(not said)'} · master volume ${session.volumeDb.toFixed(1)} dB · ${done.length} of ${tests.length} tests have feedback`);
  lines.push('');
  for (const t of done) {
    const f = store[t.id];
    lines.push(`## ${t.group.startsWith('Start here') ? 'Rebuilt' : t.group} / ${t.title} \`${t.id}\``);
    const ratings: string[] = [];
    if (f.real) ratings.push(`${t.realLabel}: ${STARS[f.real]}`);
    if (f.pleasant) ratings.push(`Pleasant: ${STARS[f.pleasant]}`);
    if (ratings.length) lines.push(`- ${ratings.join(' · ')}`);
    const nudges: string[] = [];
    if (f.level !== undefined) nudges.push(`level ${nudge('level', f.level)}`);
    if (f.bright !== undefined) nudges.push(`tone ${nudge('bright', f.bright)}`);
    if (f.busy !== undefined) nudges.push(`density ${nudge('busy', f.busy)}`);
    if (nudges.length) lines.push(`- ${nudges.join(' · ')}`);
    if (f.tags.length) lines.push(`- problems: ${f.tags.join(', ')}`);
    for (const t2 of t.tune) {
      const to = f.tuned[t2.path];
      if (to !== undefined) lines.push(`- tuned: ${tuneLine(t2, to, startValues(t, t2))}`);
    }
    if (f.measured && f.measured.seconds >= 3) {
      const m = f.measured;
      lines.push(`- measured: layer RMS ${m.rmsDb.toFixed(1)} dBFS (before master) · peak ${m.peakDb.toFixed(1)} dBFS · limiter ${m.limiterDb > 0.05 ? `−${m.limiterDb.toFixed(1)} dB` : 'idle'} · heard for ${Math.round(m.seconds)} s`);
    }
    if (f.note.trim()) lines.push(`- note: ${f.note.trim().replace(/\n+/g, ' ')}`);
    lines.push('');
  }
  const skipped = tests.filter((t) => !hasFeedback(store[t.id]));
  if (skipped.length) lines.push(`Not heard yet: ${skipped.map((t) => t.id).join(', ')}`);
  return lines.join('\n').trimEnd() + '\n';
}
