import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Answers, Condition, Instrument, Option, Question } from '../src/types';
import { computeVisibility, resolveOptions, type IndexedInstrument } from '../src/engine/logic';

export const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = resolve(webDir, '..');

export function deployablePaths(): string[] {
  return JSON.parse(readFileSync(join(webDir, 'instruments.deploy.json'), 'utf8')).instruments;
}

export function loadInstrument(rel: string): Instrument {
  return JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')) as Instrument;
}

/** Answers that make `cond` true (and make every question it depends on visible). */
export function satisfy(idx: IndexedInstrument, cond: Condition, answers: Answers = {}): Answers {
  if ('all' in cond) return cond.all.reduce((a, c) => satisfy(idx, c, a), answers);
  if ('any' in cond) return satisfy(idx, cond.any[0], answers);
  const trigger = idx.byId.get(cond.q)!;
  let out = trigger.show_if ? satisfy(idx, trigger.show_if, answers) : { ...answers };
  const prev = out[cond.q]?.codes ?? [];
  const code = cond.in[0];
  out = { ...out, [cond.q]: { codes: trigger.type === 'multi' ? [...prev, code] : [code] } };
  return out;
}

/** A plausible complete respondent: first substantive option / a short text / a mid number. */
export function fillEverything(idx: IndexedInstrument): Answers {
  let answers: Answers = {};
  for (const q of idx.questions) {
    const visible = computeVisibility(idx, answers);
    if (!visible.get(q.id)) continue;
    answers = { ...answers, [q.id]: answerFor(idx, q, answers) };
  }
  return answers;
}

function firstValue(options: Option[]): Option | undefined {
  return options.find((o) => o.role === 'VALUE') ?? options[0];
}

function answerFor(idx: IndexedInstrument, q: Question, answers: Answers) {
  switch (q.type) {
    case 'single':
    case 'multi': {
      const opts = resolveOptions(idx, q, answers);
      const o = firstValue(opts);
      return o ? { codes: [o.code] } : {};
    }
    case 'text':
      return { text: 'A short answer' };
    case 'number': {
      const v = q.validation ?? {};
      const lo = v.soft_min ?? v.min ?? 0;
      const hi = v.soft_max ?? v.max ?? lo + 10;
      return { num: String(Math.round((lo + hi) / 2)) };
    }
    case 'matrix':
      return { rows: Object.fromEntries((q.rows ?? []).map((r) => [r.variable, firstValue(q.options ?? [])!.code])) };
  }
}

export function conditionRefs(cond: Condition): { q: string; in: (string | number)[] }[] {
  if ('all' in cond) return cond.all.flatMap(conditionRefs);
  if ('any' in cond) return cond.any.flatMap(conditionRefs);
  return [cond];
}
