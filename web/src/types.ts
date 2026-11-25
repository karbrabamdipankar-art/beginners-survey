// Types for the `beginners.instrument/1` format (docs/21, schemas/instrument.schema.json).
// These describe the shape only; no questionnaire content lives in code.

export type Code = number | string;

export type OptionRole =
  | 'VALUE'
  | 'NOT_SURE'
  | 'PREFER_NOT_TO_ANSWER'
  | 'NOT_APPLICABLE'
  | 'OTHER'
  | 'VARIES_DEPENDS'
  | 'NONE_EXCLUSIVE';

export interface Option {
  code: Code;
  label: string;
  role: OptionRole;
  exclusive: boolean;
  specify: boolean;
}

export type Condition =
  | { q: string; in: Code[] }
  | { all: Condition[] }
  | { any: Condition[] };

export type QuestionType = 'single' | 'multi' | 'text' | 'number' | 'matrix';

export interface MatrixRow {
  variable: string;
  uid: string;
  label: string;
}

export interface NumberValidation {
  integer?: boolean;
  min?: number;
  max?: number;
  soft_min?: number;
  soft_max?: number;
  allow_blank?: boolean;
}

export interface Question {
  id: string;
  uid: string;
  variable: string;
  text: string;
  type: QuestionType;
  required: boolean;
  options?: Option[];
  options_from?: { q: string; use: 'selected' };
  rows?: MatrixRow[];
  max_select?: number;
  max_length?: number;
  ordinal?: boolean;
  validation?: NumberValidation;
  show_if?: Condition;
  sensitivity: 'STANDARD' | 'PERSONAL' | 'SENSITIVE' | 'HIGHLY_SENSITIVE';
  scoring_category: string;
  constructs?: string[];
}

export interface Section {
  code: string;
  title: string;
  notice?: string;
  questions: Question[];
}

export interface InstrumentSettings {
  consent_required: boolean;
  assent_required?: boolean;
  safeguarding_required: boolean;
  research_permission_gate?: string | null;
  contact_request_questions?: string[];
  answer_statuses: string[];
  estimated_minutes?: number | null;
}

export interface Instrument {
  format: 'beginners.instrument/1';
  kind: 'survey' | 'assessment';
  instrument_id: string;
  version: string;
  instrument_version_id: string;
  title: string;
  respondent_type: 'student' | 'teacher' | 'parent' | 'counsellor';
  class_range?: number[];
  language: string;
  status: string;
  settings: InstrumentSettings;
  sections: Section[];
}

/** What the respondent has entered for one question. Kept raw; encoding happens in record.ts. */
export interface Answer {
  /** single / multi: selected option codes (single holds at most one). */
  codes?: Code[];
  /** specify text keyed by option code (String(code)). */
  specify?: Record<string, string>;
  /** text questions. */
  text?: string;
  /** number questions: the raw input string, so partial input survives save/resume. */
  num?: string;
  /** matrix: option code per row variable. */
  rows?: Record<string, Code>;
}

export type Answers = Record<string, Answer>;

export type AnswerStatus =
  | 'ANSWERED'
  | 'SKIPPED'
  | 'NOT_DISPLAYED'
  | 'PREFER_NOT_TO_ANSWER'
  | 'NOT_SURE'
  | 'NOT_APPLICABLE'
  /** Filled by the server on submit (DEC-24); the respondent never sees the question. */
  | 'SYSTEM_FILLED';
