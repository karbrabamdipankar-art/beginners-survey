// Server-side preparation of one submission (M3). Runs inside Apps Script (bundled by
// scripts/build-apps-script.mjs) so the server re-checks every answer with exactly the same
// rules the app used, and never trusts the client's own encoding.
//
// Answer-level problems do not lose the response (DEC-29): an invalid answer is stored as
// #INVALID and a required question left empty keeps #SKIPPED; both add a flag for data review.
import type { Answer, Answers, Code, Instrument } from '../types';
import { checkQuestion, computeVisibility, indexInstrument, SPECIFY_MAX_LENGTH } from './logic';
import { buildRecord, wideColumns, wideRow, type VariableValue } from './record';

/** Where a student instrument asks the class, and which code means which class. */
export interface RouteCheck {
  question: string;
  codes: Record<string, number>;
}

export interface PrepareOptions {
  systemFilled?: string[];
  routeCheck?: RouteCheck;
  /** The class chosen on the landing page (students: "9"; teachers: a band such as "7-10"). */
  routeClass?: string;
}

export interface PreparedSubmission {
  columns: string[];
  row: Record<string, string | number>;
  /** Contact-request answers: restricted spreadsheet only. */
  restricted: { question_id: string; variable: string; status: string; code: string | number | null; label: string }[];
  research_permission: string | number | null;
  /** Variables the server fills from the school record (#SYSTEM_FILLED). */
  system_filled: string[];
  flags: string[];
}

const MAX_TEXT = 4000;
const MAX_CODES = 60;

function isCode(v: unknown): v is Code {
  return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 20);
}

/** Keeps only well-formed parts of a client answer; anything else is dropped and flagged. */
function cleanAnswer(raw: unknown): { answer: Answer; malformed: boolean } {
  let malformed = false;
  const out: Answer = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { answer: out, malformed: true };
  const a = raw as Record<string, unknown>;
  if (a.codes !== undefined) {
    if (Array.isArray(a.codes) && a.codes.length <= MAX_CODES && a.codes.every(isCode)) out.codes = a.codes as Code[];
    else malformed = true;
  }
  if (a.specify !== undefined) {
    if (a.specify && typeof a.specify === 'object' && !Array.isArray(a.specify)) {
      const s: Record<string, string> = {};
      for (const [k, v] of Object.entries(a.specify as Record<string, unknown>)) {
        if (typeof v === 'string') s[k] = v.slice(0, SPECIFY_MAX_LENGTH);
        else malformed = true;
      }
      out.specify = s;
    } else malformed = true;
  }
  if (a.text !== undefined) {
    if (typeof a.text === 'string') out.text = a.text.slice(0, MAX_TEXT);
    else malformed = true;
  }
  if (a.num !== undefined) {
    if (typeof a.num === 'string' && a.num.length <= 30) out.num = a.num;
    else malformed = true;
  }
  if (a.rows !== undefined) {
    if (a.rows && typeof a.rows === 'object' && !Array.isArray(a.rows)) {
      const r: Record<string, Code> = {};
      for (const [k, v] of Object.entries(a.rows as Record<string, unknown>)) {
        if (isCode(v)) r[k] = v;
        else malformed = true;
      }
      out.rows = r;
    } else malformed = true;
  }
  return { answer: out, malformed };
}

export function prepareSubmission(instrument: Instrument, rawAnswers: unknown, opts: PrepareOptions = {}): PreparedSubmission {
  const idx = indexInstrument(instrument, { systemFilled: opts.systemFilled });
  const flags: string[] = [];
  const answers: Answers = {};

  if (rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
    for (const [id, raw] of Object.entries(rawAnswers as Record<string, unknown>)) {
      if (!idx.byId.has(id)) {
        flags.push(`UNKNOWN_QUESTION:${id.slice(0, 40)}`);
        continue;
      }
      const { answer, malformed } = cleanAnswer(raw);
      if (malformed) flags.push(`MALFORMED:${idx.byId.get(id)!.variable}`);
      answers[id] = answer;
    }
  } else if (rawAnswers !== undefined) {
    flags.push('MALFORMED_ANSWERS');
  }

  const visible = computeVisibility(idx, answers);
  const invalid = new Set<string>();
  for (const q of idx.questions) {
    if (!visible.get(q.id)) continue;
    const check = checkQuestion(idx, q, answers, visible);
    if (!check.error) continue;
    if (check.error.key === 'required' || check.error.key === 'required_rows') flags.push(`MISSING_REQUIRED:${q.variable}`);
    else {
      invalid.add(q.id);
      flags.push(`INVALID:${q.variable}`);
    }
  }

  const record = buildRecord(idx, answers);
  const row = wideRow(idx, record);
  for (const id of invalid) {
    const q = idx.byId.get(id)!;
    const vars = q.type === 'matrix' ? (q.rows ?? []).map((r) => r.variable) : [q.variable];
    for (const v of vars) if (v in row) row[v] = '#INVALID';
    for (const col of Object.keys(row)) if (col.startsWith(`${q.variable}_other_text`)) row[col] = '';
  }
  flags.push(...record.flags);

  // Route check (students): the class chosen on the landing page vs the instrument's own question.
  if (opts.routeCheck && opts.routeClass !== undefined) {
    const q = idx.byId.get(opts.routeCheck.question);
    const v = q ? record.values.find((x) => x.question_id === q.id) : undefined;
    if (v && v.status === 'ANSWERED' && v.codes?.length === 1) {
      const cls = opts.routeCheck.codes[String(v.codes[0])];
      if (cls !== undefined && String(cls) !== String(opts.routeClass)) flags.push('ROUTE_CLASS_MISMATCH');
    }
  }

  const restricted = record.restricted.map((v: VariableValue) => {
    const q = idx.byId.get(v.question_id)!;
    const opt = v.codes?.length === 1 ? (q.options ?? []).find((o) => String(o.code) === String(v.codes![0])) : undefined;
    return { question_id: v.question_id, variable: v.variable, status: v.status, code: v.codes?.length ? v.codes.join(';') : null, label: opt?.label ?? '' };
  });

  return {
    columns: wideColumns(idx),
    row,
    restricted,
    research_permission: record.research_permission,
    system_filled: record.system_filled,
    flags,
  };
}

