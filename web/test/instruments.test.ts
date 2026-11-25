// Loads every deployable instrument and exercises every show_if, exclusive option,
// max_select, options_from, specify and required rule defined in it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import {
  checkQuestion,
  computeVisibility,
  findOption,
  indexInstrument,
  normalizeAnswers,
  resolveOptions,
  toggleOption,
  validateSection,
  visibleSections,
} from '../src/engine/logic';
import { buildRecord, cell, encodeQuestion, otherTextColumn, wideColumns, wideRow } from '../src/engine/record';
import type { Answers, Option, Question } from '../src/types';
import { conditionRefs, deployablePaths, fillEverything, loadInstrument, repoRoot, satisfy } from './helpers';

const schema = JSON.parse(readFileSync(join(repoRoot, 'schemas', 'instrument.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

const paths = deployablePaths();

it('deploys exactly the four approved instruments', () => {
  expect(paths).toHaveLength(4);
});

describe.each(paths)('%s', (rel) => {
  const inst = loadInstrument(rel);
  const idx = indexInstrument(inst);
  const choiceQs = idx.questions.filter((q) => q.type === 'single' || q.type === 'multi');

  it('validates against schemas/instrument.schema.json and is deployable', () => {
    const ok = validateSchema(inst);
    expect(validateSchema.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(['APPROVED_FOR_PILOT', 'APPROVED_FOR_FIELDWORK']).toContain(inst.status);
    expect(inst.kind).toBe('survey');
  });

  it('has unique ids, uids, variables and wide columns', () => {
    const ids = idx.questions.map((q) => q.id);
    const uids = idx.questions.flatMap((q) => [q.uid, ...(q.rows ?? []).map((r) => r.uid)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(uids).size).toBe(uids.length);
    const cols = wideColumns(idx);
    expect(new Set(cols).size).toBe(cols.length);
    for (const q of idx.questions) {
      const codes = (q.options ?? []).map((o) => String(o.code));
      expect(new Set(codes).size, `${q.id} option codes`).toBe(codes.length);
    }
  });

  it('every show_if points to an earlier choice question and real option codes', () => {
    const order = new Map(idx.questions.map((q, i) => [q.id, i]));
    for (const q of idx.questions.filter((x) => x.show_if)) {
      for (const ref of conditionRefs(q.show_if!)) {
        const trigger = idx.byId.get(ref.q);
        expect(trigger, `${q.id} → ${ref.q}`).toBeDefined();
        expect(order.get(ref.q)!).toBeLessThan(order.get(q.id)!);
        expect(['single', 'multi']).toContain(trigger!.type);
        for (const c of ref.in) expect(findOption(trigger!.options ?? [], c), `${q.id}: code ${c} in ${ref.q}`).toBeDefined();
      }
    }
  });

  const showIfQs = idx.questions.filter((q) => q.show_if);
  if (showIfQs.length > 0) {
    describe('show_if', () => {
      it.each(showIfQs.map((q) => [q.id, q] as const))('%s is shown when its condition holds and hidden otherwise', (_id, q) => {
        // Hidden before anything is answered, stored as #NOT_DISPLAYED (never 0 / No / blank).
        const none = computeVisibility(idx, {});
        expect(none.get(q.id)).toBe(false);
        expect(encodeQuestion(idx, q, {}, none).every((v) => cell(v) === '#NOT_DISPLAYED')).toBe(true);

        const yes = satisfy(idx, q.show_if!);
        expect(computeVisibility(idx, yes).get(q.id)).toBe(true);

        // Every other option of the trigger hides it, even when an answer is still stored.
        for (const ref of conditionRefs(q.show_if!)) {
          const trigger = idx.byId.get(ref.q)!;
          for (const o of trigger.options ?? []) {
            if (ref.in.some((c) => String(c) === String(o.code))) continue;
            const no: Answers = { ...yes, [ref.q]: { codes: [o.code] }, [q.id]: stubAnswer(idx, q, yes) };
            const vis = computeVisibility(idx, no);
            expect(vis.get(q.id), `${q.id} with ${ref.q}=${o.code}`).toBe(false);
            expect(encodeQuestion(idx, q, no, vis).every((v) => v.status === 'NOT_DISPLAYED')).toBe(true);
            // Hidden questions never block moving on.
            expect(validateSection(idx, idx.sectionOf.get(q.id)!, no).has(q.id)).toBe(false);
          }
        }
      });
    });
  }

  const exclusiveCases = choiceQs.flatMap((q) => (q.options ?? []).filter((o) => o.exclusive).map((o) => [`${q.id} / ${o.code} ${o.label}`, q, o] as const));
  if (exclusiveCases.length > 0) {
    describe('exclusive options', () => {
      it.each(exclusiveCases)('%s clears and blocks other selections', (_name, q, ex) => {
        expect(q.type).toBe('multi');
        const answers = q.options_from ? satisfyOptionsFrom(idx, q) : {};
        const opts = resolveOptions(idx, q, answers);
        const others = opts.filter((o) => !o.exclusive);
        let codes = pickUpTo(q, others).map((o) => o.code);
        // Choosing the exclusive option clears everything else.
        codes = toggleOption(q, opts, codes, ex.code, true).codes;
        expect(codes).toEqual([ex.code]);
        // Choosing a normal option afterwards removes the exclusive one.
        if (others.length > 0) {
          codes = toggleOption(q, opts, codes, others[0].code, true).codes;
          expect(codes).toEqual([others[0].code]);
          // The engine rejects a stored combination that breaks exclusivity.
          const bad = { ...answers, [q.id]: { codes: [ex.code, others[0].code] } };
          expect(checkQuestion(idx, q, bad).error?.key).toBe('invalid_option');
        }
      });
    });
  }

  const maxQs = choiceQs.filter((q) => q.max_select !== undefined);
  if (maxQs.length > 0) {
    describe('max_select', () => {
      it.each(maxQs.map((q) => [q.id, q] as const))('%s refuses a selection past the maximum', (_id, q) => {
        const answers = q.options_from ? satisfyOptionsFrom(idx, q, q.max_select! + 2) : {};
        const opts = resolveOptions(idx, q, answers).filter((o) => !o.exclusive);
        expect(opts.length, `${q.id} needs more options than its maximum to test`).toBeGreaterThan(q.max_select!);
        let codes: (string | number)[] = [];
        for (const o of opts.slice(0, q.max_select)) codes = toggleOption(q, opts, codes, o.code, true).codes;
        expect(codes).toHaveLength(q.max_select!);
        const res = toggleOption(q, opts, codes, opts[q.max_select!].code, true);
        expect(res.refused).toBe('max_select');
        expect(res.codes).toEqual(codes);
        const over = { ...answers, [q.id]: { codes: opts.slice(0, q.max_select! + 1).map((o) => o.code) } };
        expect(checkQuestion(idx, q, over).error?.key).toBe('too_many');
      });
    });
  }

  const multiNoMax = choiceQs.filter((q) => q.type === 'multi' && q.max_select === undefined);
  if (multiNoMax.length > 0) {
    it('multi-selects without max_select accept every non-exclusive option', () => {
      for (const q of multiNoMax) {
        const answers = q.options_from ? satisfyOptionsFrom(idx, q) : {};
        const opts = resolveOptions(idx, q, answers).filter((o) => !o.exclusive);
        let codes: (string | number)[] = [];
        for (const o of opts) codes = toggleOption(q, opts, codes, o.code, true).codes;
        expect(codes, q.id).toHaveLength(opts.length);
      }
    });
  }

  const fromQs = idx.questions.filter((q) => q.options_from);
  if (fromQs.length > 0) {
    describe('options_from', () => {
      it.each(fromQs.map((q) => [q.id, q] as const))('%s offers only what was selected in its source, and drops stale choices', (_id, q) => {
        const src = idx.byId.get(q.options_from!.q)!;
        expect(src.type).toBe('multi');
        const statics = q.options ?? [];
        for (const s of statics) expect(findOption((src.options ?? []).filter((o) => !o.exclusive), s.code), `${q.id} static code ${s.code} collides`).toBeUndefined();

        // Nothing chosen in the source: only the static options.
        expect(resolveOptions(idx, q, {}).map((o) => o.code)).toEqual(statics.map((o) => o.code));

        const srcOpts = (src.options ?? []).filter((o) => !o.exclusive);
        const chosen = [srcOpts[0], srcOpts[2], ...srcOpts.filter((o) => o.specify).slice(0, 1)];
        const specify = Object.fromEntries(chosen.filter((o) => o.specify).map((o) => [String(o.code), 'Agriculture']));
        let answers: Answers = { [src.id]: { codes: chosen.map((o) => o.code), specify } };
        const opts = resolveOptions(idx, q, answers);
        expect(opts.map((o) => String(o.code))).toEqual([...srcOpts.filter((o) => chosen.includes(o)).map((o) => String(o.code)), ...statics.map((o) => String(o.code))]);
        for (const o of opts.filter((x) => specify[String(x.code)])) expect(o.label).toContain('Agriculture');
        expect(opts.every((o) => !o.specify || statics.includes(o))).toBe(true);

        // Choose the first dynamic option, then remove it from the source: it is pruned.
        answers = { ...answers, [q.id]: { codes: [srcOpts[0].code] } };
        expect(checkQuestion(idx, q, answers).error).toBeUndefined();
        answers = normalizeAnswers(idx, { ...answers, [src.id]: { codes: [srcOpts[2].code] } });
        expect(answers[q.id].codes).toEqual([]);
        // A code that is not offered is rejected.
        expect(checkQuestion(idx, q, { ...answers, [q.id]: { codes: [srcOpts[0].code] } }).error?.key).toBe('invalid_option');
      });
    });
  }

  const specifyCases = choiceQs.flatMap((q) => (q.options ?? []).filter((o) => o.specify).map((o) => [`${q.id} / ${o.code}`, q, o] as const));
  if (specifyCases.length > 0) {
    describe('specify', () => {
      it.each(specifyCases)('%s stores its text in its own other-text column, only while selected', (_name, q, o) => {
        const base = prerequisites(idx, q);
        const col = otherTextColumn(q, o.code);
        expect(wideColumns(idx)).toContain(col);
        const with_ = { ...base, [q.id]: { codes: [o.code], specify: { [String(o.code)]: '  My own words ' } } };
        const rec = buildRecord(idx, with_);
        expect(rec.other_texts.find((x) => x.column === col)?.text).toBe('My own words');
        // Not selected: no other text, even if some is left over in the draft.
        const other = (q.options ?? []).find((x) => !x.specify && !x.exclusive)!;
        const without = normalizeAnswers(idx, { ...base, [q.id]: { codes: [other.code], specify: { [String(o.code)]: 'left over' } } });
        expect(buildRecord(idx, without).other_texts.find((x) => x.column === col)).toBeUndefined();
      });
    });
  }

  it('required questions block moving on when empty; optional ones are stored as #SKIPPED', () => {
    for (const q of idx.questions) {
      const base = prerequisites(idx, q);
      const vis = computeVisibility(idx, base);
      expect(vis.get(q.id), q.id).toBe(true);
      const check = checkQuestion(idx, q, base, vis);
      if (q.required) expect(check.error?.key, q.id).toBe('required');
      else {
        expect(check.error, q.id).toBeUndefined();
        expect(encodeQuestion(idx, q, base, vis).every((v) => cell(v) === '#SKIPPED'), q.id).toBe(true);
      }
    }
  });

  it('special options are stored as their status token, never as a blank or 0', () => {
    for (const q of choiceQs.filter((x) => !x.options_from)) {
      const base = prerequisites(idx, q);
      for (const o of q.options ?? []) {
        const vis = computeVisibility(idx, { ...base, [q.id]: { codes: [o.code] } });
        const [v] = encodeQuestion(idx, q, { ...base, [q.id]: { codes: [o.code] } }, vis);
        const expected = { NOT_SURE: '#NOT_SURE', PREFER_NOT_TO_ANSWER: '#PREFER_NOT_TO_ANSWER', NOT_APPLICABLE: '#NOT_APPLICABLE' }[o.role as string];
        expect(cell(v), `${q.id}=${o.code}`).toBe(expected ?? (q.type === 'single' ? o.code : String(o.code)));
      }
    }
  });

  it('a complete respondent passes every section and produces a full wide row', () => {
    const answers = fillEverything(idx);
    for (const s of visibleSections(idx, answers)) {
      expect([...validateSection(idx, s, answers).keys()], s.code).toEqual([]);
    }
    const rec = buildRecord(idx, answers);
    const row = wideRow(idx, rec);
    const vars = new Set(rec.values.map((v) => v.variable));
    for (const col of wideColumns(idx)) {
      expect(col in row).toBe(true);
      if (vars.has(col)) expect(row[col], col).not.toBe('');
    }
    // Contact requests never reach the research row (docs/21 rule 4).
    const restrictedIds = inst.settings.contact_request_questions ?? [];
    for (const id of restrictedIds) {
      const q = idx.byId.get(id)!;
      expect(row[q.variable]).toBeUndefined();
      expect(rec.restricted.some((v) => v.question_id === id)).toBe(true);
    }
    if (inst.settings.research_permission_gate) expect(rec.research_permission).not.toBeNull();
  });

  it('an empty submission stores every variable as a status token', () => {
    const row = wideRow(idx, buildRecord(idx, {}));
    const values = buildRecord(idx, {}).values;
    for (const v of values) expect(String(row[v.variable]).startsWith('#'), v.variable).toBe(true);
  });
});

describe('number validation (STU_11_12)', () => {
  const idx = indexInstrument(loadInstrument('questionnaires/student_11_12/STU_11_12_V1.0.json'));
  const age = idx.byId.get('STU_A02')!;
  const pct = idx.byId.get('STU_B05')!;
  const check = (q: Question, num: string) => checkQuestion(idx, q, { [q.id]: { num } });

  it('rejects non-numbers and decimals for integer items', () => {
    expect(check(age, 'abc').error?.key).toBe('not_a_number');
    expect(check(age, '15.5').error?.key).toBe('not_integer');
  });
  it('flags but accepts ages outside the suggested range', () => {
    expect(check(age, '13')).toEqual({ softWarning: true });
    expect(check(age, '16')).toEqual({});
    expect(buildRecord(idx, { STU_A02: { num: '25' } }).flags).toContain('SOFT_RANGE:age_years');
  });
  it('enforces the hard 0–100 range and allows blank', () => {
    expect(check(pct, '101').error?.key).toBe('above_max');
    expect(check(pct, '-1').error?.key).toBe('below_min');
    expect(check(pct, '')).toEqual({});
    expect(cell(encodeQuestion(idx, pct, {}, computeVisibility(idx, {}))[0])).toBe('#SKIPPED');
  });
});

describe('matrix (TCH_11_12)', () => {
  const idx = indexInstrument(loadInstrument('questionnaires/teacher_11_12/TCH_11_12_V1.1.json'));
  const mats = idx.questions.filter((q) => q.type === 'matrix');
  it.each(mats.map((q) => [q.id, q] as const))('%s needs every row and stores each row as its own variable', (_id, q) => {
    const rows = q.rows!;
    const opts = q.options!;
    const partial = { [q.id]: { rows: { [rows[0].variable]: opts[0].code } } };
    expect(checkQuestion(idx, q, partial).error?.key).toBe(q.required ? 'required_rows' : undefined);
    const na = opts.find((o) => o.role === 'NOT_APPLICABLE');
    const full = { [q.id]: { rows: Object.fromEntries(rows.map((r, i) => [r.variable, i === 0 && na ? na.code : opts[0].code])) } };
    expect(checkQuestion(idx, q, full).error).toBeUndefined();
    const enc = encodeQuestion(idx, q, full, computeVisibility(idx, full));
    expect(enc.map((v) => v.variable)).toEqual(rows.map((r) => r.variable));
    if (na) expect(cell(enc[0])).toBe('#NOT_APPLICABLE');
    expect(cell(enc[1])).toBe(opts[0].code);
  });
});

describe('other-text column names', () => {
  it('gives each specify option its own column when a question has several (DEC-25)', () => {
    const q = indexInstrument(loadInstrument('questionnaires/student_7_10/STU_7_10_V1.1.json')).byId.get('STU-A06')!;
    expect(otherTextColumn(q, 96)).toBe(`${q.variable}_other_text`);
    expect(otherTextColumn(q, 196)).toBe(`${q.variable}_other_text_196`);
  });
});

// ---------- helpers ----------

/** Answers that make q visible (and its dynamic options non-empty). */
function prerequisites(idx: ReturnType<typeof indexInstrument>, q: Question): Answers {
  let a: Answers = q.show_if ? satisfy(idx, q.show_if) : {};
  if (q.options_from) a = { ...a, ...satisfyOptionsFrom(idx, q) };
  return a;
}

/** Selects n source options so that options_from questions have something to offer. */
function satisfyOptionsFrom(idx: ReturnType<typeof indexInstrument>, q: Question, n = 4): Answers {
  const src = idx.byId.get(q.options_from!.q)!;
  const codes = (src.options ?? []).filter((o) => !o.exclusive).slice(0, n).map((o) => o.code);
  return { [src.id]: { codes } };
}

function pickUpTo(q: Question, opts: Option[]): Option[] {
  return opts.slice(0, q.max_select ?? opts.length);
}

function stubAnswer(idx: ReturnType<typeof indexInstrument>, q: Question, answers: Answers) {
  if (q.type === 'single' || q.type === 'multi') {
    const o = resolveOptions(idx, q, answers)[0];
    return o ? { codes: [o.code] } : {};
  }
  if (q.type === 'number') return { num: '1' };
  if (q.type === 'matrix') return { rows: { [q.rows![0].variable]: q.options![0].code } };
  return { text: 'x' };
}
