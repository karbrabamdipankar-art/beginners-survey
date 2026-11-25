// Turns answers into the stored response record (docs/21 platform rule 1, docs/22 §5).
// A blank answer is never "No" or 0: every variable gets an explicit answer_status, and a
// non-answer cell is a status token such as #SKIPPED or #NOT_DISPLAYED.

import type { Answer, AnswerStatus, Answers, Code, Option, Question } from '../types';
import {
  checkQuestion,
  computeVisibility,
  findOption,
  isEmpty,
  parseNumber,
  resolveOptions,
  type IndexedInstrument,
} from './logic';

const ROLE_STATUS: Partial<Record<Option['role'], AnswerStatus>> = {
  NOT_SURE: 'NOT_SURE',
  PREFER_NOT_TO_ANSWER: 'PREFER_NOT_TO_ANSWER',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
};

export interface VariableValue {
  question_id: string;
  uid: string;
  variable: string;
  status: AnswerStatus;
  /** Code, ';'-joined codes, text or number. null when status is not ANSWERED and nothing was selected. */
  value: string | number | null;
  /** Selected codes as given, for single/multi/matrix rows. */
  codes?: Code[];
}

export interface OtherText {
  question_id: string;
  column: string;
  text: string;
}

export interface ResponseRecord {
  instrument_version_id: string;
  values: VariableValue[];
  other_texts: OtherText[];
  /** Contact-request answers (settings.contact_request_questions): restricted contacts spreadsheet only. */
  restricted: VariableValue[];
  research_permission: string | number | null;
  flags: string[];
  /** Variables the server must fill on submit (#SYSTEM_FILLED, DEC-24). */
  system_filled: string[];
}

/**
 * Column for the "please specify" text of an OTHER option (docs/21: `<variable>_other_text`).
 * When a question has more than one specify option, code 96 keeps the plain name and every
 * other specify option gets `_other_text_<code>` (DEC-25).
 */
export function otherTextColumn(q: Question, code: Code): string {
  const specifyOptions = (q.options ?? []).filter((o) => o.specify);
  if (specifyOptions.length <= 1 || String(code) === '96') return `${q.variable}_other_text`;
  return `${q.variable}_other_text_${code}`;
}

/** Status implied by the chosen options: a lone special-role choice carries its own status. */
function statusFromOptions(selected: Option[]): AnswerStatus {
  if (selected.length === 0) return 'SKIPPED';
  const roles = new Set(selected.map((o) => ROLE_STATUS[o.role] ?? 'ANSWERED'));
  if (roles.size === 1) return [...roles][0];
  return 'ANSWERED';
}

function orderedCodes(options: Option[], codes: Code[]): Code[] {
  return options.filter((o) => codes.some((c) => String(c) === String(o.code))).map((o) => o.code);
}

export function encodeQuestion(
  idx: IndexedInstrument,
  q: Question,
  answers: Answers,
  visible: Map<string, boolean>,
): VariableValue[] {
  const base = { question_id: q.id };
  const a: Answer | undefined = answers[q.id];
  const shown = visible.get(q.id) !== false;
  if (idx.systemFilled.has(q.id)) {
    const rows = q.type === 'matrix' ? (q.rows ?? []).map((r) => ({ uid: r.uid, variable: r.variable })) : [{ uid: q.uid, variable: q.variable }];
    return rows.map((r) => ({ ...base, ...r, status: 'SYSTEM_FILLED' as const, value: null }));
  }

  if (q.type === 'matrix') {
    return (q.rows ?? []).map((r) => {
      const row = { ...base, uid: r.uid, variable: r.variable };
      if (!shown) return { ...row, status: 'NOT_DISPLAYED' as const, value: null };
      const c = a?.rows?.[r.variable];
      const opt = c === undefined ? undefined : findOption(q.options ?? [], c);
      if (!opt) return { ...row, status: 'SKIPPED' as const, value: null };
      return { ...row, status: statusFromOptions([opt]), value: opt.code, codes: [opt.code] };
    });
  }

  const one = { ...base, uid: q.uid, variable: q.variable };
  if (!shown) return [{ ...one, status: 'NOT_DISPLAYED', value: null }];
  if (isEmpty(q, a)) return [{ ...one, status: 'SKIPPED', value: null }];

  switch (q.type) {
    case 'single':
    case 'multi': {
      const options = resolveOptions(idx, q, answers, visible);
      const codes = orderedCodes(options, a!.codes!);
      const selected = codes.map((c) => findOption(options, c)!);
      // single = the code as defined; multi = codes in option order joined with ';' (docs/22 §5).
      const value = q.type === 'single' ? codes[0] : codes.join(';');
      return [{ ...one, status: statusFromOptions(selected), value, codes }];
    }
    case 'text':
      return [{ ...one, status: 'ANSWERED', value: a!.text!.trim() }];
    case 'number': {
      const n = parseNumber(a!.num!);
      return [{ ...one, status: 'ANSWERED', value: n }];
    }
  }
}

/** The stored cell for a value: the encoded answer, or a status token for a non-answer. */
export function cell(v: VariableValue): string | number {
  if (v.status === 'ANSWERED') return v.value ?? '';
  return `#${v.status}`;
}

export function buildRecord(idx: IndexedInstrument, answers: Answers): ResponseRecord {
  const visible = computeVisibility(idx, answers);
  const restrictedIds = new Set(idx.instrument.settings.contact_request_questions ?? []);
  const values: VariableValue[] = [];
  const restricted: VariableValue[] = [];
  const other_texts: OtherText[] = [];
  const flags: string[] = [];

  for (const q of idx.questions) {
    const encoded = encodeQuestion(idx, q, answers, visible);
    (restrictedIds.has(q.id) ? restricted : values).push(...encoded);

    if (visible.get(q.id) === false) continue;
    const a = answers[q.id];
    if ((q.type === 'single' || q.type === 'multi') && a?.specify && !restrictedIds.has(q.id)) {
      for (const o of q.options ?? []) {
        if (!o.specify) continue;
        if (!(a.codes ?? []).some((c) => String(c) === String(o.code))) continue;
        const text = a.specify[String(o.code)]?.trim();
        if (text) other_texts.push({ question_id: q.id, column: otherTextColumn(q, o.code), text });
      }
    }
    if (q.type === 'number' && checkQuestion(idx, q, answers, visible).softWarning) {
      flags.push(`SOFT_RANGE:${q.variable}`);
    }
  }

  const gate = idx.instrument.settings.research_permission_gate;
  let research_permission: string | number | null = null;
  if (gate) {
    const g = values.find((v) => v.question_id === gate) ?? restricted.find((v) => v.question_id === gate);
    research_permission = g ? cell(g) : null;
  }

  const system_filled = values.filter((v) => v.status === 'SYSTEM_FILLED').map((v) => v.variable);
  return { instrument_version_id: idx.instrument.instrument_version_id, values, other_texts, restricted, research_permission, flags, system_filled };
}

/** Column order for the wide `R_<instrument_version_id>` tab (variables, then other-text columns). */
export function wideColumns(idx: IndexedInstrument): string[] {
  const restrictedIds = new Set(idx.instrument.settings.contact_request_questions ?? []);
  const vars: string[] = [];
  const others: string[] = [];
  for (const q of idx.questions) {
    if (restrictedIds.has(q.id)) continue;
    if (q.type === 'matrix') vars.push(...(q.rows ?? []).map((r) => r.variable));
    else vars.push(q.variable);
    for (const o of q.options ?? []) if (o.specify) others.push(otherTextColumn(q, o.code));
  }
  return [...vars, ...others];
}

/** One wide row: every column present, other-text columns blank when not used. */
export function wideRow(idx: IndexedInstrument, record: ResponseRecord): Record<string, string | number> {
  const row: Record<string, string | number> = {};
  for (const c of wideColumns(idx)) row[c] = '';
  for (const v of record.values) row[v.variable] = cell(v);
  for (const o of record.other_texts) row[o.column] = o.text;
  return row;
}
