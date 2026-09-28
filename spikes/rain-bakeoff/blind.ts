/** Blind A/B/C session bookkeeping. Pure logic, no DOM. */

import { createRng } from '../../src/core/rng';

export type Candidate = 'A' | 'B' | 'C';
export type BlindLabel = 'X' | 'Y' | 'Z';

export const CANDIDATE_NAMES: Record<Candidate, string> = {
  A: 'Recorded (your file, segmented + crossfaded)',
  B: 'Fully synthetic',
  C: 'Hybrid (recording + synthetic near drops)',
};

export interface LabelResult {
  realism: number | null;
  study: number | null;
  repeatPresses: number;
  listenedSeconds: number;
}

export interface BlindSession {
  id: string;
  startedAt: string;
  mapping: Record<BlindLabel, Candidate>;
  results: Record<BlindLabel, LabelResult>;
}

export const LABELS: BlindLabel[] = ['X', 'Y', 'Z'];

export function newSession(): BlindSession {
  const id = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const rng = createRng(id, 'blind');
  const order: Candidate[] = ['A', 'B', 'C'];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const empty = (): LabelResult => ({ realism: null, study: null, repeatPresses: 0, listenedSeconds: 0 });
  return {
    id,
    startedAt: new Date().toISOString(),
    mapping: { X: order[0], Y: order[1], Z: order[2] },
    results: { X: empty(), Y: empty(), Z: empty() },
  };
}

export function isComplete(s: BlindSession): boolean {
  return LABELS.every((l) => s.results[l].realism !== null && s.results[l].study !== null);
}

export interface Summary {
  candidate: Candidate;
  name: string;
  label: BlindLabel;
  realism: number | null;
  study: number | null;
  repeatsPer10Min: number | null;
  listenedMinutes: number;
}

export function summarise(s: BlindSession): Summary[] {
  return LABELS.map((label) => {
    const r = s.results[label];
    const c = s.mapping[label];
    return {
      candidate: c,
      name: CANDIDATE_NAMES[c],
      label,
      realism: r.realism,
      study: r.study,
      repeatsPer10Min: r.listenedSeconds > 30 ? (r.repeatPresses / r.listenedSeconds) * 600 : null,
      listenedMinutes: r.listenedSeconds / 60,
    };
  }).sort((a, b) => a.candidate.localeCompare(b.candidate));
}

/** The plan's decision rule: synthetic ships as default if its realism is within 0.5 of recorded. */
export function verdict(rows: { candidate: Candidate; realism: number | null }[]): string {
  const get = (c: Candidate) => rows.find((r) => r.candidate === c)?.realism ?? null;
  const a = get('A');
  const b = get('B');
  const c = get('C');
  if (a === null || b === null || c === null) return 'Incomplete: rate all three first.';
  if (b >= a - 0.5) return 'Synthetic is within 0.5 of recorded on realism → synthetic rain becomes the default.';
  if (c >= a - 0.5) return 'Synthetic falls short, hybrid holds up → hybrid is the default; synthetic ships as a sandbox option.';
  return 'Recording wins clearly → recorded bed is the default; synthetic ships as a sandbox option. Tune the synth against the recording and retest.';
}
