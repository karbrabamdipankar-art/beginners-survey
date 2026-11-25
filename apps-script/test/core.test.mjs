// Tests for Core.js with an in-memory stand-in for the spreadsheet. Run: node --test apps-script/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const core = require('../Core.js');
const { makeRegistry, schoolInfo, newToken, nextSchoolCode, validateSchoolForm, TOKEN_PATTERN, DEFAULT_CONFIG, HEADERS, TAB } = core;

function memoryDb() {
  const tabs = Object.fromEntries(Object.keys(HEADERS).map((t) => [t, []]));
  tabs.Config = DEFAULT_CONFIG.map((r) => ({ ...r }));
  return {
    tabs,
    read: (t) => tabs[t].map((r) => ({ ...r })),
    append: (t, obj) => { tabs[t].push(Object.fromEntries(HEADERS[t].map((h) => [h, obj[h] ?? '']))); },
    update: (t, k, v, patch) => {
      const row = tabs[t].find((r) => String(r[k]) === String(v));
      if (!row) return false;
      for (const [key, val] of Object.entries(patch)) if (HEADERS[t].includes(key)) row[key] = val;
      return true;
    },
  };
}

let clock = new Date('2027-01-10T06:00:00Z');
const deps = () => ({ now: () => clock, uuid: randomUUID, actor: 'staff@example.org', siteUrl: 'https://example.github.io/survey' });

const form = (over = {}) => ({
  name: 'Test Higher Secondary School', udise_code: '17010100101', district: 'East Khasi Hills', block_locality: 'Mylliem',
  is_shillong_city: 'Yes', area_type: 'Urban', management: 'Government', classes_offered: ['9', '10', '11', '12'], streams: ['Science', 'Arts'],
  survey_opens: '', survey_closes: '', contact_person: 'Head teacher', contact_phone: '9000000000', contact_email: '',
  safeguarding_lead_name: 'Counsellor', safeguarding_lead_phone: '9000000001', referral_name: 'District helpline', referral_phone: '9000000002',
  ...over,
});

const info = (db, token) => schoolInfo(token, {
  findSchoolByToken: (t) => db.read(TAB.SCHOOLS).find((s) => s.school_token === t) ?? null,
  readConfig: () => db.read(TAB.CONFIG),
  now: () => clock,
});

test('tokens are 256-bit base64url and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const t = newToken(randomUUID);
    assert.match(t, TOKEN_PATTERN);
    seen.add(t);
  }
  assert.equal(seen.size, 500);
});

test('school codes are sequential per district', () => {
  assert.equal(nextSchoolCode([], 'EKH'), 'ML-EKH-0001');
  assert.equal(nextSchoolCode(['ML-EKH-0041', 'ML-EKH-0007', 'ML-WGH-0090'], 'EKH'), 'ML-EKH-0042');
});

test('form validation', () => {
  const bad = validateSchoolForm(form({ name: '', udise_code: '123', district: 'Shillong', classes_offered: [], survey_opens: '2027-02-01', survey_closes: '2027-01-01', contact_phone: '' }));
  assert.deepEqual(Object.keys(bad.errors).sort(), ['classes_offered', 'contact_phone', 'district', 'name', 'survey_closes', 'udise_code'].sort());
  const noStreams = validateSchoolForm(form({ streams: [] }));
  assert.ok(noStreams.errors.streams, 'Classes 11–12 need streams');
  const junior = validateSchoolForm(form({ classes_offered: ['7', '8'], streams: ['Science'] }));
  assert.deepEqual(junior.errors, {});
  assert.equal(junior.school.streams, '', 'streams are dropped without Classes 11–12');
  assert.equal(junior.school.classes_offered, '7;8');
});

test('registration with safeguarding contacts makes an ACTIVE school with a link', () => {
  const db = memoryDb();
  const r = makeRegistry(db, deps()).register(form());
  assert.equal(r.ok, true);
  assert.equal(r.school.school_code, 'ML-EKH-0001');
  assert.equal(r.school.status, 'ACTIVE');
  const token = db.tabs.Schools[0].school_token;
  assert.equal(r.school.link, `https://example.github.io/survey/?s=${token}`);
  assert.deepEqual(db.tabs.Audit.map((a) => a.event), ['register', 'activate']);
  // Contacts live only in the restricted tab.
  assert.equal(db.tabs.Schools[0].contact_person, undefined);
  assert.equal(db.tabs.School_Contacts[0].safeguarding_lead_name, 'Counsellor');
});

test('a school cannot become ACTIVE without a safeguarding lead and referral contact', () => {
  const db = memoryDb();
  const reg = makeRegistry(db, deps());
  const r = reg.register(form({ referral_phone: '' }));
  assert.equal(r.school.status, 'REGISTERED');
  assert.deepEqual(r.school.missing_for_activation, ['referral_phone']);
  assert.equal(r.school.link, '');
  const act = reg.setStatus('ML-EKH-0001', 'ACTIVE');
  assert.equal(act.ok, false);
  assert.equal(info(db, db.tabs.Schools[0].school_token).status, 'unavailable');
  // Fill it in, then activation works.
  assert.equal(reg.update('ML-EKH-0001', form()).ok, true);
  assert.equal(reg.setStatus('ML-EKH-0001', 'ACTIVE').ok, true);
  assert.equal(info(db, db.tabs.Schools[0].school_token).status, 'active');
  // Removing the contacts later takes the school out of ACTIVE.
  const u = reg.update('ML-EKH-0001', form({ safeguarding_lead_name: '' }));
  assert.equal(u.school.status, 'REGISTERED');
});

test('duplicate UDISE codes are refused; the district cannot change', () => {
  const db = memoryDb();
  const reg = makeRegistry(db, deps());
  reg.register(form());
  const dup = reg.register(form({ name: 'Another' }));
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.udise_code);
  assert.equal(reg.register(form({ udise_code: '', name: 'No UDISE' })).school.school_code, 'ML-EKH-0002');
  assert.equal(reg.update('ML-EKH-0001', form({ district: 'Ri-Bhoi' })).ok, false);
});

test('school_info never reveals school details (DEC-23)', () => {
  const db = memoryDb();
  makeRegistry(db, deps()).register(form());
  const token = db.tabs.Schools[0].school_token;
  const out = info(db, token);
  assert.deepEqual(out, { ok: true, status: 'active', classes: [9, 10, 11, 12], instruments: ['STU_7_10_V1.1', 'TCH_7_10_V1.1', 'STU_11_12_V1.0', 'TCH_11_12_V1.1'] });
  const text = JSON.stringify(out);
  for (const secret of ['Test Higher', 'ML-EKH', 'East Khasi', 'Mylliem', '17010100101', 'Counsellor', token]) {
    assert.ok(!text.includes(secret), `school_info leaked ${secret}`);
  }
});

test('unknown, malformed, paused and closed tokens all look the same', () => {
  const db = memoryDb();
  const reg = makeRegistry(db, deps());
  reg.register(form());
  const token = db.tabs.Schools[0].school_token;
  assert.equal(info(db, 'nope').status, 'unavailable');
  assert.equal(info(db, newToken(randomUUID)).status, 'unavailable');
  reg.setStatus('ML-EKH-0001', 'PAUSED');
  assert.deepEqual(info(db, token), { ok: true, status: 'unavailable' });
  reg.setStatus('ML-EKH-0001', 'CLOSED');
  assert.deepEqual(info(db, token), { ok: true, status: 'unavailable' });
});

test('regenerating the token kills the old link at once', () => {
  const db = memoryDb();
  const reg = makeRegistry(db, deps());
  reg.register(form());
  const old = db.tabs.Schools[0].school_token;
  const r = reg.regenerateToken('ML-EKH-0001');
  const fresh = db.tabs.Schools[0].school_token;
  assert.notEqual(old, fresh);
  assert.equal(info(db, old).status, 'unavailable');
  assert.equal(info(db, fresh).status, 'active');
  assert.ok(r.school.link.endsWith(fresh));
  assert.equal(db.tabs.Audit.at(-1).event, 'token_regenerated');
});

test('survey window is checked in India time', () => {
  const db = memoryDb();
  makeRegistry(db, deps()).register(form({ survey_opens: '2027-01-11', survey_closes: '2027-01-20' }));
  const token = db.tabs.Schools[0].school_token;
  clock = new Date('2027-01-10T18:00:00Z'); // 23:30 IST on the 10th
  assert.equal(info(db, token).status, 'not_yet_open');
  clock = new Date('2027-01-10T18:31:00Z'); // 00:01 IST on the 11th
  assert.equal(info(db, token).status, 'active');
  clock = new Date('2027-01-20T18:29:00Z'); // 23:59 IST on the 20th
  assert.equal(info(db, token).status, 'active');
  clock = new Date('2027-01-20T18:31:00Z'); // 00:01 IST on the 21st
  assert.equal(info(db, token).status, 'closed');
  // Sheets may hand dates back as Date objects.
  db.tabs.Schools[0].survey_closes = new Date('2027-01-20T00:00:00+05:30');
  assert.equal(info(db, token).status, 'closed');
  clock = new Date('2027-01-10T06:00:00Z');
});

test('only instruments active in Config and matching the school classes are offered', () => {
  const db = memoryDb();
  makeRegistry(db, deps()).register(form({ classes_offered: ['7', '8'], streams: [], udise_code: '' }));
  const token = db.tabs.Schools[0].school_token;
  assert.deepEqual(info(db, token).instruments, ['STU_7_10_V1.1', 'TCH_7_10_V1.1']);
  db.tabs.Config[0].status = 'PAUSED';
  assert.deepEqual(info(db, token).instruments, ['TCH_7_10_V1.1']);
  // Sheets reads a lone class number back as a number.
  db.tabs.Schools[0].classes_offered = 8;
  assert.deepEqual(info(db, token).classes, [8]);
});
