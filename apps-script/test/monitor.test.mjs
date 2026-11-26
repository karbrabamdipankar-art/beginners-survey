// Tests for Monitor.js (response summary, research export). Needs `npm run apps-script` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({ console });
for (const f of ['Core.js', 'Engine.js', 'Instruments.js', 'Submit.js', 'Monitor.js']) vm.runInContext(readFileSync(join(dir, f), 'utf8'), ctx, { filename: f });
const plain = (x) => JSON.parse(JSON.stringify(x));

test('summary counts responses per school and instrument, and spots unknown schools', () => {
  const schools = [
    { school_code: 'ML-EKH-0002', name: 'B', district: 'East Khasi Hills', status: 'ACTIVE' },
    { school_code: 'ML-EKH-0001', name: 'A', district: 'East Khasi Hills', status: 'CLOSED' },
    { school_code: 'ML-RB-0001', name: 'C', district: 'Ri-Bhoi', status: 'ACTIVE' },
  ];
  const s = plain(ctx.summarizeResponses(schools, {
    'STU_7_10_V1.1': [
      { school_code: 'ML-EKH-0001', received_at: '2027-01-02T00:00:00.000Z', flags: '' },
      { school_code: 'ML-EKH-0001', received_at: '2027-01-05T00:00:00.000Z', flags: 'LATE_SYNC' },
      { school_code: 'ML-XX-0009', received_at: '2027-01-05T00:00:00.000Z', flags: '' },
    ],
    'TCH_7_10_V1.1': [{ school_code: 'ML-EKH-0002', received_at: '2027-01-03T00:00:00.000Z', flags: '' }],
  }));
  assert.deepEqual(s.versions, ['STU_7_10_V1.1', 'TCH_7_10_V1.1']);
  assert.deepEqual(s.totals, { 'STU_7_10_V1.1': 3, 'TCH_7_10_V1.1': 1 });
  assert.equal(s.total, 4);
  assert.equal(s.unknown_school_rows, 1);
  assert.deepEqual(s.schools.map((x) => x.school_code), ['ML-EKH-0001', 'ML-EKH-0002', 'ML-RB-0001']);
  const a = s.schools[0];
  assert.deepEqual([a.counts['STU_7_10_V1.1'], a.total, a.flagged, a.last_received], [2, 2, 1, '2027-01-05T00:00:00.000Z']);
  assert.equal(s.schools[2].total, 0);
});

test('export keeps only responses with research permission (DEC-30) and re-protects formula text', () => {
  const entry = ctx.INSTRUMENT_REGISTRY['STU_11_12_V1.0'];
  const prepared = ctx.BeginnersEngine.prepareSubmission(entry.instrument, {}, { systemFilled: ['STU_A05'] });
  const headers = ctx.SYSTEM_COLUMNS.concat(prepared.columns);
  const perm = headers.indexOf('research_permission');
  const make = (id, p, text) => headers.map((h, i) => (i === 0 ? id : i === perm ? p : h === 'school_name' ? 'ML-EKH-0001' : h === 'current_class' ? 1 : h === 'flags' ? '' : text ?? '#SKIPPED'));
  // Sheets hands back '=…' text without its protecting apostrophe.
  const rows = [make('a', 1, '=HYPERLINK("x")'), make('b', 2), make('c', 3), make('d', '#SKIPPED'), make('e', 1)];
  const ex = plain(ctx.prepareExport('STU_11_12_V1.0', headers, rows, entry, ctx.BeginnersEngine));
  assert.equal(ex.included, 2);
  assert.equal(ex.excluded_no_permission, 3);
  assert.deepEqual(ex.data_codes.slice(1).map((r) => r[0]), ['a', 'e']);
  assert.ok(ex.data_codes[1].includes('\'=HYPERLINK("x")'));
  assert.ok(!ex.data_codes[1].includes('=HYPERLINK("x")'));
  const cls = headers.indexOf('current_class');
  assert.equal(ex.data_codes[1][cls], 1);
  assert.equal(ex.data_labels[1][cls], 'Class 11');
  assert.equal(ex.codebook[0][0], 'column');
  assert.equal(ex.codebook.length - 1, headers.length);
  assert.ok(ex.status_tokens.some((t) => t[0] === '#NOT_DISPLAYED'));
});

test('instruments without a research-use question export every row', () => {
  const entry = ctx.INSTRUMENT_REGISTRY['TCH_7_10_V1.1'];
  assert.equal(entry.research_permission_yes, null);
  const headers = ctx.SYSTEM_COLUMNS.concat(ctx.BeginnersEngine.prepareSubmission(entry.instrument, {}).columns);
  const rows = [headers.map((h) => (h === 'research_permission' ? '#NOT_APPLICABLE' : 'x')), headers.map(() => 'y')];
  const ex = plain(ctx.prepareExport('TCH_7_10_V1.1', headers, rows, entry, ctx.BeginnersEngine));
  assert.equal(ex.included, 2);
  assert.equal(ex.excluded_no_permission, 0);
});
