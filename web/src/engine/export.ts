// Codebook and value labels for exports (M4). Built only from the instrument JSON, so any
// uploaded instrument gets a correct codebook without code changes. Bundled into Apps Script.
import type { Instrument, Option, Question } from '../types';
import { indexInstrument } from './logic';
import { otherTextColumn, wideColumns } from './record';

/** Status tokens that can appear in any variable cell (docs/22 §5). */
export const STATUS_TOKENS: [string, string][] = [
  ['#SKIPPED', 'Shown but not answered (optional question, or required question flagged MISSING_REQUIRED).'],
  ['#NOT_DISPLAYED', 'Not shown to this respondent because of the question logic (show_if).'],
  ['#PREFER_NOT_TO_ANSWER', 'Respondent chose "Prefer not to say" (or similar).'],
  ['#NOT_SURE', 'Respondent chose "Not sure" (or similar).'],
  ['#NOT_APPLICABLE', 'Respondent chose "Not applicable", or the column does not apply to this row.'],
  ['#INVALID', 'The answer failed the server re-check; see flags (INVALID:<variable>).'],
  ['#SYSTEM_FILLED', 'Filled by the platform, never shown to the respondent (e.g. school code, DEC-24).'],
];

/** System columns at the start of every R_ tab, with descriptions for the codebook. */
export const SYSTEM_COLUMN_NOTES: [string, string][] = [
  ['submission_id', 'Random ID made on the device; one row per submission (duplicates are stored once).'],
  ['school_code', 'School code from the registry (ML-<district>-<NNNN>). Links to the Schools tab.'],
  ['instrument_version_id', 'Exact questionnaire version answered.'],
  ['respondent_type', 'student / teacher, from the instrument.'],
  ['route_class', 'Class (students) or class band (teachers) chosen on the landing page. Not an instrument variable.'],
  ['consent', 'yes = agreed on the consent screen before the first question.'],
  ['assent', 'yes when the instrument needs student assent; otherwise #NOT_APPLICABLE.'],
  ['research_permission', 'Answer to the research-use question, if the instrument has one; else #NOT_APPLICABLE.'],
  ['started_at', 'When the respondent started (device clock, UTC).'],
  ['submitted_at', 'When the respondent finished (device clock, UTC).'],
  ['received_at', 'When the server stored the row (UTC).'],
  ['client_app_version', 'Version of the survey app.'],
  ['duration_sec', 'submitted_at − started_at in seconds (blank if implausible; see flags).'],
  ['flags', 'Space-separated data-review flags, e.g. INVALID:x, MISSING_REQUIRED:x, ROUTE_CLASS_MISMATCH, LATE_SYNC, SOFT_RANGE:x.'],
];

export const CODEBOOK_HEADERS = ['column', 'kind', 'question_id', 'uid', 'section', 'question', 'row_label', 'type', 'required',
  'sensitivity', 'scoring_category', 'constructs', 'value_labels', 'notes'];

/** The options a variable's codes can come from (dynamic options use the source question's list). */
function optionsFor(byId: Map<string, Question>, q: Question): Option[] {
  const statics = q.options ?? [];
  if (!q.options_from) return statics;
  const src = byId.get(q.options_from.q);
  const dynamic = (src?.options ?? []).filter((o) => !o.exclusive && !statics.some((s) => String(s.code) === String(o.code)));
  return [...dynamic, ...statics];
}

const labelsText = (opts: Option[]) => opts.map((o) => `${o.code}=${o.label}`).join('; ');

export interface CodebookOptions {
  systemFilled?: string[];
}

/** Codebook rows (with header row) for one instrument version, in R_ column order. */
export function buildCodebook(instrument: Instrument, opts: CodebookOptions = {}): string[][] {
  const idx = indexInstrument(instrument, { systemFilled: opts.systemFilled });
  const restricted = new Set(instrument.settings.contact_request_questions ?? []);
  const rows: string[][] = [CODEBOOK_HEADERS];
  for (const [col, note] of SYSTEM_COLUMN_NOTES) rows.push([col, 'system', '', '', '', '', '', '', '', '', '', '', '', note]);

  const byColumn = new Map<string, string[]>();
  for (const q of idx.questions) {
    if (restricted.has(q.id)) continue;
    const section = idx.sectionOf.get(q.id)!;
    const base = (variable: string, uid: string, rowLabel: string, options: Option[]) => [
      variable, 'variable', q.id, uid, `${section.code}. ${section.title}`, q.text, rowLabel, q.type, q.required ? 'yes' : 'no',
      q.sensitivity, q.scoring_category, (q.constructs ?? []).join(' '), labelsText(options),
      [
        q.type === 'multi' ? 'Several codes joined with ";" in option order.' : '',
        q.max_select ? `At most ${q.max_select}.` : '',
        q.show_if ? `Shown only if ${JSON.stringify(q.show_if)}.` : '',
        q.options_from ? `Options are the answers given to ${q.options_from.q}.` : '',
        idx.systemFilled.has(q.id) ? 'Not shown on school links; filled with the school code (DEC-24).' : '',
        q.scoring_category === 'NOT_SCORABLE' || q.sensitivity === 'HIGHLY_SENSITIVE' ? 'Never use in a computed score.' : '',
      ].filter(Boolean).join(' '),
    ];
    if (q.type === 'matrix') {
      for (const r of q.rows ?? []) byColumn.set(r.variable, base(r.variable, r.uid, r.label, q.options ?? []));
    } else {
      byColumn.set(q.variable, base(q.variable, q.uid, '', q.type === 'single' || q.type === 'multi' ? optionsFor(idx.byId, q) : []));
    }
    for (const o of q.options ?? []) {
      if (!o.specify) continue;
      const col = otherTextColumn(q, o.code);
      byColumn.set(col, [col, 'other_text', q.id, q.uid, `${section.code}. ${section.title}`, q.text, '', 'text', 'no', q.sensitivity,
        'NOT_SCORABLE', '', '', `Text written when "${o.label}" (code ${o.code}) was chosen. Blank otherwise.`]);
    }
  }
  for (const col of wideColumns(idx)) rows.push(byColumn.get(col) ?? [col, 'variable', '', '', '', '', '', '', '', '', '', '', '', '']);
  return rows;
}

/**
 * Replaces codes with their labels in one data row (headers = R_ tab header row). Status
 * tokens, text, numbers and system columns are left as they are.
 */
export function makeLabeller(instrument: Instrument): (headers: string[], row: (string | number)[]) => (string | number)[] {
  const idx = indexInstrument(instrument);
  const labels = new Map<string, Map<string, string>>();
  for (const q of idx.questions) {
    if (q.type === 'matrix') {
      const m = new Map((q.options ?? []).map((o) => [String(o.code), o.label]));
      for (const r of q.rows ?? []) labels.set(r.variable, m);
    } else if (q.type === 'single' || q.type === 'multi') {
      labels.set(q.variable, new Map(optionsFor(idx.byId, q).map((o) => [String(o.code), o.label])));
    }
  }
  return (headers, row) =>
    row.map((v, i) => {
      const m = labels.get(headers[i]);
      if (!m || v === '' || (typeof v === 'string' && v.startsWith('#'))) return v;
      return String(v).split(';').map((c) => m.get(c.trim()) ?? c).join(' ; ');
    });
}
