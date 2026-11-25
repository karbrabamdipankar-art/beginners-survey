// Logic engine: visibility (show_if), dynamic options (options_from), selection rules
// (exclusive, max_select) and validation. Pure functions over the instrument JSON and
// the respondent's answers, so they can be unit-tested without a browser.

import type { Answer, Answers, Code, Condition, Instrument, Option, Question, Section } from '../types';

/** Upper bound for "please specify" text when the instrument sets none. Keeps Sheets cells sane. */
export const SPECIFY_MAX_LENGTH = 500;

export interface IndexedInstrument {
  instrument: Instrument;
  /** Every question in display order. */
  questions: Question[];
  byId: Map<string, Question>;
  sectionOf: Map<string, Section>;
  /**
   * Questions the platform answers instead of the respondent (DEC-24: STU_A05 on a school
   * link). Never shown; stored as #SYSTEM_FILLED and filled by the server on submit.
   */
  systemFilled: Set<string>;
}

export interface IndexOptions {
  systemFilled?: string[];
}

export function indexInstrument(instrument: Instrument, opts: IndexOptions = {}): IndexedInstrument {
  const questions: Question[] = [];
  const byId = new Map<string, Question>();
  const sectionOf = new Map<string, Section>();
  for (const section of instrument.sections) {
    for (const q of section.questions) {
      if (byId.has(q.id)) throw new Error(`Duplicate question id ${q.id}`);
      questions.push(q);
      byId.set(q.id, q);
      sectionOf.set(q.id, section);
    }
  }
  const systemFilled = new Set(opts.systemFilled ?? []);
  for (const id of systemFilled) if (!byId.has(id)) throw new Error(`system fill: unknown question ${id}`);
  return { instrument, questions, byId, sectionOf, systemFilled };
}

export const sameCode = (a: Code, b: Code): boolean => String(a) === String(b);

export function isEmpty(q: Question, a: Answer | undefined): boolean {
  if (!a) return true;
  switch (q.type) {
    case 'single':
    case 'multi':
      return !a.codes || a.codes.length === 0;
    case 'text':
      return !a.text || a.text.trim() === '';
    case 'number':
      return a.num === undefined || a.num.trim() === '';
    case 'matrix':
      return !a.rows || Object.keys(a.rows).length === 0;
  }
}

/** Evaluates a show_if condition. Answers of hidden questions count as absent. */
export function evaluateCondition(cond: Condition, answers: Answers, visible: Map<string, boolean>): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, answers, visible));
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, answers, visible));
  if (visible.get(cond.q) === false) return false;
  const codes = answers[cond.q]?.codes ?? [];
  return codes.some((c) => cond.in.some((v) => sameCode(c, v)));
}

/**
 * Visibility of every question, computed in display order. show_if may only point to
 * earlier questions (checked by tests), so one pass is enough and cascades correctly.
 */
export function computeVisibility(idx: IndexedInstrument, answers: Answers): Map<string, boolean> {
  const visible = new Map<string, boolean>();
  for (const q of idx.questions) {
    if (idx.systemFilled.has(q.id)) visible.set(q.id, false);
    else visible.set(q.id, q.show_if ? evaluateCondition(q.show_if, answers, visible) : true);
  }
  return visible;
}

/**
 * The options shown for a question. For options_from, they are the options the respondent
 * selected in the source question (in the source's order), followed by the static options.
 */
export function resolveOptions(
  idx: IndexedInstrument,
  q: Question,
  answers: Answers,
  visible?: Map<string, boolean>,
): Option[] {
  const statics = q.options ?? [];
  if (!q.options_from) return statics;
  const src = idx.byId.get(q.options_from.q);
  if (!src) throw new Error(`${q.id}: options_from points to unknown question ${q.options_from.q}`);
  const vis = visible ?? computeVisibility(idx, answers);
  if (vis.get(src.id) === false) return statics;
  const srcAnswer = answers[src.id];
  const selected = srcAnswer?.codes ?? [];
  const dynamic: Option[] = [];
  for (const o of src.options ?? []) {
    if (o.exclusive) continue; // "None"/"Not sure" in the source are not subjects to choose from
    if (!selected.some((c) => sameCode(c, o.code))) continue;
    if (statics.some((s) => sameCode(s.code, o.code))) continue;
    const typed = o.specify ? srcAnswer?.specify?.[String(o.code)]?.trim() : '';
    // A dynamic option never asks for its own specify text; it repeats what was typed in the source.
    dynamic.push({ ...o, label: typed ? `${o.label}: ${typed}` : o.label, specify: false });
  }
  return [...dynamic, ...statics];
}

export function findOption(options: Option[], code: Code): Option | undefined {
  return options.find((o) => sameCode(o.code, code));
}

export interface ToggleResult {
  codes: Code[];
  /** Set when the change was refused because it would exceed max_select. */
  refused?: 'max_select';
}

/**
 * Applies one click on an option.
 * - single: the clicked option becomes the answer.
 * - multi, exclusive option checked: it clears every other selection.
 * - multi, normal option checked: clears any exclusive selection; refused past max_select.
 */
export function toggleOption(q: Question, options: Option[], current: Code[], code: Code, checked: boolean): ToggleResult {
  const opt = findOption(options, code);
  if (!opt) return { codes: current };
  if (q.type === 'single') return { codes: checked ? [opt.code] : [] };

  if (!checked) return { codes: current.filter((c) => !sameCode(c, code)) };
  if (current.some((c) => sameCode(c, code))) return { codes: current };
  if (opt.exclusive) return { codes: [opt.code] };

  const kept = current.filter((c) => !findOption(options, c)?.exclusive);
  if (q.max_select !== undefined && kept.length >= q.max_select) return { codes: current, refused: 'max_select' };
  return { codes: [...kept, opt.code] };
}

/**
 * Removes answers that are no longer possible: codes not among the (possibly dynamic)
 * options, and specify text for options that are not selected. Returns the same object
 * when nothing changed.
 */
export function normalizeAnswers(idx: IndexedInstrument, answers: Answers): Answers {
  let out = answers;
  const visible = computeVisibility(idx, answers);
  for (const q of idx.questions) {
    const a = out[q.id];
    if (!a || (q.type !== 'single' && q.type !== 'multi')) continue;
    const options = resolveOptions(idx, q, out, visible);
    const codes = (a.codes ?? []).filter((c) => findOption(options, c));
    const specify: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.specify ?? {})) {
      if (codes.some((c) => String(c) === k)) specify[k] = v;
    }
    const codesChanged = codes.length !== (a.codes ?? []).length;
    const specifyChanged = Object.keys(specify).length !== Object.keys(a.specify ?? {}).length;
    if (codesChanged || specifyChanged) {
      if (out === answers) out = { ...answers };
      out[q.id] = { ...a, codes, specify };
    }
  }
  return out;
}

export type ErrorKey =
  | 'required'
  | 'required_rows'
  | 'not_a_number'
  | 'not_integer'
  | 'below_min'
  | 'above_max'
  | 'too_long'
  | 'too_many'
  | 'invalid_option';

export interface QuestionCheck {
  error?: { key: ErrorKey; params?: Record<string, string | number> };
  /** Soft range: shown as a gentle note, never blocks (STU_11_12: "flag, do not auto-reject"). */
  softWarning?: boolean;
}

export function parseNumber(raw: string): number | null {
  const s = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Checks one visible question. */
export function checkQuestion(idx: IndexedInstrument, q: Question, answers: Answers, visible?: Map<string, boolean>): QuestionCheck {
  const a = answers[q.id];
  if (isEmpty(q, a)) return q.required ? { error: { key: 'required' } } : {};

  switch (q.type) {
    case 'single':
    case 'multi': {
      const options = resolveOptions(idx, q, answers, visible);
      const codes = a!.codes!;
      if (codes.some((c) => !findOption(options, c))) return { error: { key: 'invalid_option' } };
      if (q.type === 'single' && codes.length > 1) return { error: { key: 'invalid_option' } };
      if (q.type === 'multi') {
        const hasExclusive = codes.some((c) => findOption(options, c)!.exclusive);
        if (hasExclusive && codes.length > 1) return { error: { key: 'invalid_option' } };
        if (q.max_select !== undefined && codes.length > q.max_select) return { error: { key: 'too_many', params: { max: q.max_select } } };
      }
      for (const [, text] of Object.entries(a!.specify ?? {})) {
        if (text.length > SPECIFY_MAX_LENGTH) return { error: { key: 'too_long', params: { max: SPECIFY_MAX_LENGTH } } };
      }
      return {};
    }
    case 'text': {
      const max = q.max_length;
      if (max !== undefined && a!.text!.length > max) return { error: { key: 'too_long', params: { max } } };
      return {};
    }
    case 'number': {
      const n = parseNumber(a!.num!);
      const v = q.validation ?? {};
      if (n === null) return { error: { key: 'not_a_number' } };
      if (v.integer && !Number.isInteger(n)) return { error: { key: 'not_integer' } };
      if (v.min !== undefined && n < v.min) return { error: { key: 'below_min', params: { min: v.min } } };
      if (v.max !== undefined && n > v.max) return { error: { key: 'above_max', params: { max: v.max } } };
      const soft = (v.soft_min !== undefined && n < v.soft_min) || (v.soft_max !== undefined && n > v.soft_max);
      return soft ? { softWarning: true } : {};
    }
    case 'matrix': {
      const rows = q.rows ?? [];
      const options = q.options ?? [];
      for (const r of rows) {
        const c = a!.rows![r.variable];
        if (c !== undefined && !findOption(options, c)) return { error: { key: 'invalid_option' } };
      }
      if (q.required && rows.some((r) => a!.rows![r.variable] === undefined)) return { error: { key: 'required_rows' } };
      return {};
    }
  }
}

/** Errors for the visible questions of one section, keyed by question id. */
export function validateSection(idx: IndexedInstrument, section: Section, answers: Answers): Map<string, QuestionCheck> {
  const visible = computeVisibility(idx, answers);
  const out = new Map<string, QuestionCheck>();
  for (const q of section.questions) {
    if (!visible.get(q.id)) continue;
    const check = checkQuestion(idx, q, answers, visible);
    if (check.error) out.set(q.id, check);
  }
  return out;
}

/** Sections with at least one visible question, so a fully hidden section is never shown empty. */
export function visibleSections(idx: IndexedInstrument, answers: Answers): Section[] {
  const visible = computeVisibility(idx, answers);
  return idx.instrument.sections.filter((s) => s.questions.some((q) => visible.get(q.id)));
}
