// @vitest-environment jsdom
// M2: routing by role and class, the school_info client, the system-filled school question
// (DEC-24) and the landing screens.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classChoices, rolesFor, type IndexEntry, type SchoolInfo } from '../src/routing';
import { getSchoolInfo, isTokenShaped, tokenContext, type Fetcher } from '../src/school';
import { computeVisibility, indexInstrument, validateSection } from '../src/engine/logic';
import { buildRecord, wideRow } from '../src/engine/record';
import { Landing, SCHOOL_RESUME_MAX_HOURS } from '../src/ui/landing';
import { draftKey, loadDraft, outboxIds, saveDraft, newDraft } from '../src/storage';
import type { Instrument } from '../src/types';
import { fillEverything, loadInstrument } from './helpers';

let index: IndexEntry[];
let files: Record<string, Instrument>;
beforeAll(async () => {
  // @ts-expect-error plain .mjs build script without type declarations
  const { buildRegistry } = await import('../scripts/copy-instruments.mjs');
  ({ index, files } = buildRegistry());
});

const ALL = ['STU_7_10_V1.1', 'TCH_7_10_V1.1', 'STU_11_12_V1.0', 'TCH_11_12_V1.1'];
const active = (classes: number[], instruments = ALL): SchoolInfo => ({ ok: true, status: 'active', classes, instruments });
const TOKEN = 'A'.repeat(43);

describe('routing', () => {
  it('students pick a class and land on the instrument for that class', () => {
    const c = classChoices(index, active([7, 8, 9, 10, 11, 12]), 'student');
    expect(c.map((x) => [x.value, x.instrument.instrument_version_id])).toEqual([
      ['7', 'STU_7_10_V1.1'], ['8', 'STU_7_10_V1.1'], ['9', 'STU_7_10_V1.1'], ['10', 'STU_7_10_V1.1'],
      ['11', 'STU_11_12_V1.0'], ['12', 'STU_11_12_V1.0'],
    ]);
  });
  it('teachers pick a band, limited to the classes the school offers', () => {
    const c = classChoices(index, active([9, 10, 11]), 'teacher');
    expect(c.map((x) => [x.value, x.classes, x.instrument.instrument_version_id])).toEqual([
      ['7-10', [9, 10], 'TCH_7_10_V1.1'], ['11-12', [11], 'TCH_11_12_V1.1'],
    ]);
  });
  it('only offers classes and roles the link allows', () => {
    expect(classChoices(index, active([7, 8]), 'student').map((x) => x.value)).toEqual(['7', '8']);
    expect(rolesFor(index, active([11, 12], ['STU_11_12_V1.0']))).toEqual(['student']);
    expect(rolesFor(index, active([7, 8], ['STU_11_12_V1.0']))).toEqual([]);
    expect(rolesFor(index, { ok: true, status: 'active' })).toEqual([]);
  });
});

describe('school_info client', () => {
  beforeEach(() => localStorage.clear());
  const ok = (info: SchoolInfo): Fetcher => async () => ({ ok: true, json: async () => info });
  const down: Fetcher = async () => { throw new Error('offline'); };

  it('never calls the API for a malformed token', async () => {
    let called = false;
    const r = await getSchoolInfo('https://api', 'short', 'ctx', async () => { called = true; return { ok: true, json: async () => ({}) }; });
    expect(called).toBe(false);
    expect(r.info.status).toBe('unavailable');
    expect(isTokenShaped(TOKEN)).toBe(true);
  });

  it('builds the URL, retries on failure, then uses the saved answer offline', async () => {
    const urls: string[] = [];
    const first = await getSchoolInfo('https://api/exec', TOKEN, 'ctx', async (u) => { urls.push(u); return ok(active([7]))(u); }, 0);
    expect(urls).toEqual([`https://api/exec?action=school_info&s=${TOKEN}`]);
    expect(first.fromCache).toBe(false);
    let attempts = 0;
    const second = await getSchoolInfo('https://api/exec', TOKEN, 'ctx', async (u) => { attempts++; return down(u); }, 0);
    expect(attempts).toBe(3);
    expect(second).toEqual({ info: active([7]), fromCache: true });
  });

  it('fails when offline with nothing saved, and forgets a link that stopped being active', async () => {
    await expect(getSchoolInfo('https://api', TOKEN, 'ctx2', down, 0)).rejects.toThrow();
    await getSchoolInfo('https://api', TOKEN, 'ctx3', ok(active([7])), 0);
    await getSchoolInfo('https://api', TOKEN, 'ctx3', ok({ ok: true, status: 'unavailable' }), 0);
    await expect(getSchoolInfo('https://api', TOKEN, 'ctx3', down, 0)).rejects.toThrow();
  });

  it('storage keys use a hash, never the token', async () => {
    const ctx = await tokenContext(TOKEN);
    expect(ctx).not.toContain(TOKEN.slice(0, 10));
    expect(ctx).toBe(await tokenContext(TOKEN));
    expect(ctx).not.toBe(await tokenContext('B'.repeat(43)));
  });
});

describe('STU_A05 is system-filled on school links (DEC-24)', () => {
  const inst = loadInstrument('questionnaires/student_11_12/STU_11_12_V1.0.json');
  it('is configured for deployment', () => {
    expect(index.find((e) => e.instrument_version_id === 'STU_11_12_V1.0')!.system_fill).toEqual({ STU_A05: 'school_code' });
  });
  it('is hidden, never required, and stored as #SYSTEM_FILLED', () => {
    const idx = indexInstrument(inst, { systemFilled: ['STU_A05'] });
    expect(computeVisibility(idx, {}).get('STU_A05')).toBe(false);
    expect(validateSection(idx, idx.sectionOf.get('STU_A05')!, {}).has('STU_A05')).toBe(false);
    const answers = fillEverything(idx);
    const rec = buildRecord(idx, answers);
    expect(wideRow(idx, rec).school_name).toBe('#SYSTEM_FILLED');
    expect(rec.system_filled).toEqual(['school_name']);
  });
  it('is asked as written in preview (no system fill)', () => {
    const idx = indexInstrument(inst);
    expect(computeVisibility(idx, {}).get('STU_A05')).toBe(true);
  });
});

describe('landing screens', () => {
  const root = () => document.getElementById('app')!;
  const buttons = () => [...root().querySelectorAll('button')];
  const click = (text: string) => {
    const b = buttons().find((x) => x.textContent === text);
    if (!b) throw new Error(`No button "${text}" in: ${buttons().map((x) => x.textContent).join(' | ')}`);
    b.click();
  };
  const loadInst = async (e: IndexEntry) => structuredClone(files[e.file]);
  const landing = (info: SchoolInfo, offline = false) => new Landing({ root: root(), index, info, context: 'sTEST', offline, loadInstrument: loadInst });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
    window.scrollTo = () => {};
  });

  it('student → class 11 → consent → Class 11–12 survey, without the school-name question', async () => {
    landing(active([9, 10, 11, 12])).start();
    expect(root().textContent).toContain('Are you a student or a teacher?');
    click('I am a student');
    expect(buttons().map((b) => b.textContent)).toEqual(['Class 9', 'Class 10', 'Class 11', 'Class 12', 'Back']);
    click('Class 11');
    await settle();
    expect(root().textContent).toContain('Before you begin');
    click('Yes, I agree');
    expect(root().querySelector('.instrument-title')!.textContent).toContain('11');
    const qids = [...root().querySelectorAll('fieldset.question')].map((e) => e.getAttribute('data-qid'));
    expect(qids).toContain('STU_A01');
    expect(qids).not.toContain('STU_A05');
    const draft = loadDraft(draftKey('STU_11_12_V1.0', 'sTEST.student.11'))!;
    expect([draft.route_role, draft.route_class]).toEqual(['student', '11']);
  });

  it('teacher → band; Back returns to the class question', async () => {
    landing(active([7, 8, 9, 10, 11, 12])).start();
    click('I am a teacher');
    expect(root().textContent).toContain('Which classes do you mainly teach?');
    click('Classes 7–10');
    await settle();
    click('Back');
    expect(root().textContent).toContain('Which classes do you mainly teach?');
  });

  it('a link with one role skips the role question', () => {
    landing(active([11, 12], ['STU_11_12_V1.0'])).start();
    expect(root().textContent).toContain('Which class are you in?');
    expect(buttons().map((b) => b.textContent)).toEqual(['Class 11', 'Class 12']);
  });

  it.each([
    ['unavailable', 'This link is not open'],
    ['not_yet_open', 'Not open yet'],
    ['closed', 'This survey has closed'],
  ] as const)('status %s shows a closed page with no survey', (status, title) => {
    landing({ ok: true, status }).start();
    expect(root().querySelector('h1')!.textContent).toBe(title);
    expect(root().querySelector('button')).toBeNull();
  });

  it('says when it is working from saved data offline', () => {
    landing(active([7]), true).start();
    expect(root().textContent).toContain('You are offline');
  });

  it('a finished response goes to the outbox and the next person starts at the role question', async () => {
    landing(active([7, 8, 9, 10])).start();
    click('I am a student');
    click('Class 8');
    await settle();
    click('Yes, I agree');
    // Fill every section through the real screens' state, then finish.
    const inst = await loadInst(index.find((e) => e.instrument_version_id === 'STU_7_10_V1.1')!);
    const key = draftKey('STU_7_10_V1.1', 'sTEST.student.8');
    const d = loadDraft(key)!;
    d.answers = fillEverything(indexInstrument(inst));
    d.section_index = inst.sections.length - 1;
    saveDraft(key, d);
    // Reopen as the same person resuming, go to the last section and finish.
    landing(active([7, 8, 9, 10])).start();
    click('I am a student');
    click('Class 8');
    await settle();
    click('Continue where I left off');
    click('Finish');
    expect(root().querySelector('h1')!.textContent).toBe('Thank you');
    expect(outboxIds(localStorage as never)).toEqual([d.submission_id]);
    expect(loadDraft(key)).toBeNull();
    click('Next person: start a new survey');
    expect(root().textContent).toContain('Are you a student or a teacher?');
  });

  it(`unfinished answers older than ${SCHOOL_RESUME_MAX_HOURS} hours are not offered to the next person`, async () => {
    const key = draftKey('STU_7_10_V1.1', 'sTEST.student.8');
    const old = newDraft('STU_7_10_V1.1');
    old.answers = { 'STU-A01': { codes: [1] } };
    old.consent = 'yes';
    localStorage.setItem(key, JSON.stringify({ ...old, updated_at: new Date(Date.now() - (SCHOOL_RESUME_MAX_HOURS + 1) * 3600_000).toISOString() }));
    landing(active([8])).start();
    click('I am a student');
    click('Class 8');
    await settle();
    expect(root().textContent).not.toContain('Welcome back');
    expect(root().textContent).toContain('Before you begin');
    expect(loadDraft(key)).toBeNull();
  });
});
