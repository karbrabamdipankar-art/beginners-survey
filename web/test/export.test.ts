// Codebook and value labels (M4), checked against every deployable instrument.
import { describe, expect, it } from 'vitest';
import { buildCodebook, CODEBOOK_HEADERS, makeLabeller, SYSTEM_COLUMN_NOTES } from '../src/engine/export';
import { indexInstrument } from '../src/engine/logic';
import { wideColumns } from '../src/engine/record';
import { prepareSubmission } from '../src/engine/submission';
import { deployablePaths, fillEverything, loadInstrument } from './helpers';

describe.each(deployablePaths())('%s codebook', (rel) => {
  const inst = loadInstrument(rel);
  const idx = indexInstrument(inst);

  it('has one row per R_ column, in the same order, after the system columns', () => {
    const cb = buildCodebook(inst);
    expect(cb[0]).toEqual(CODEBOOK_HEADERS);
    const cols = cb.slice(1).map((r) => r[0]);
    expect(cols).toEqual([...SYSTEM_COLUMN_NOTES.map((c) => c[0]), ...wideColumns(idx)]);
    // Same columns the server writes.
    expect(cols.slice(SYSTEM_COLUMN_NOTES.length)).toEqual(prepareSubmission(inst, {}).columns);
    for (const r of cb) expect(r).toHaveLength(CODEBOOK_HEADERS.length);
  });

  it('documents every coded variable with its value labels and never lists contact requests', () => {
    const cb = buildCodebook(inst);
    const byCol = new Map(cb.slice(1).map((r) => [r[0], r]));
    for (const q of idx.questions) {
      if ((inst.settings.contact_request_questions ?? []).includes(q.id)) {
        expect(byCol.has(q.variable)).toBe(false);
        continue;
      }
      const vars = q.type === 'matrix' ? q.rows!.map((r) => r.variable) : [q.variable];
      for (const v of vars) {
        const row = byCol.get(v)!;
        expect(row[2]).toBe(q.id);
        if (q.type !== 'text' && q.type !== 'number' && !q.options_from) {
          for (const o of q.options ?? []) expect(row[12]).toContain(`${o.code}=${o.label}`);
        }
      }
    }
  });
});

describe('value labels', () => {
  const inst = loadInstrument('questionnaires/student_11_12/STU_11_12_V1.0.json');
  const idx = indexInstrument(inst);
  const prepared = prepareSubmission(inst, fillEverything(idx), {});
  const headers = prepared.columns;
  const row = headers.map((h) => prepared.row[h]);
  const label = makeLabeller(inst);
  const out = label(headers, row);
  const at = (v: string) => out[headers.indexOf(v)];

  it('turns codes into words and leaves tokens, text and numbers alone', () => {
    expect(at('current_class')).toBe('Class 11');
    expect(at('age_years')).toBe(prepared.row.age_years);
    const hidden = headers.find((h) => prepared.row[h] === '#NOT_DISPLAYED')!;
    expect(at(hidden)).toBe('#NOT_DISPLAYED');
  });

  it('labels multi-selects and dynamic options from their source question', () => {
    const l = makeLabeller(inst);
    const h = ['current_subjects', 'confident_subjects', 'difficult_subjects'];
    expect(l(h, ['1;3', '3', '0'])).toEqual(['English ; Mathematics', 'Mathematics', 'None of these']);
  });
});
