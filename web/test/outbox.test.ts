// @vitest-environment jsdom
// The outbox sender (M3): retries with backoff, stops on a permanent refusal, never loses a
// response, and the finish screen tells the person what happened.
import { beforeEach, describe, expect, it } from 'vitest';
import { backoffMs, flushOutbox, payloadFor, pendingCount, sendOne, type Poster } from '../src/outbox';
import { moveToOutbox, newDraft, outboxIds, readOutbox, saveDraft, type OutboxStore } from '../src/storage';
import { Survey } from '../src/ui/survey';
import { fillEverything, loadInstrument } from './helpers';
import { indexInstrument } from '../src/engine/logic';

const TOKEN = 'T'.repeat(43);
const store = () => localStorage as unknown as OutboxStore;

function queue(): string {
  const d = newDraft('STU_7_10_V1.1');
  d.consent = 'yes';
  d.route_role = 'student';
  d.route_class = '8';
  d.finished_at = new Date().toISOString();
  d.answers = { 'STU-A01': { codes: [2] } };
  saveDraft('k', d);
  moveToOutbox('k', d, TOKEN);
  return d.submission_id;
}

const answer = (body: unknown, status = 200): Poster => async () => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => localStorage.clear());

describe('outbox sender', () => {
  it('posts everything the server needs, with the token in the value and never in a key', () => {
    const id = queue();
    const p = JSON.parse(payloadFor(readOutbox(id)!));
    expect(p).toMatchObject({ action: 'submit', s: TOKEN, submission_id: id, instrument_version_id: 'STU_7_10_V1.1', consent: 'yes', route_role: 'student', route_class: '8' });
    expect(p.answers).toEqual({ 'STU-A01': { codes: [2] } });
    expect(typeof p.client_app_version).toBe('string');
    expect(Object.keys(localStorage).some((k) => k.includes(TOKEN))).toBe(false);
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('removes a response once the server has it (also when it was a duplicate)', async () => {
    const a = queue();
    expect(await sendOne(a, { apiUrl: 'u', post: answer({ ok: true, submission_id: a }) })).toBe('sent');
    const b = queue();
    expect(await sendOne(b, { apiUrl: 'u', post: answer({ ok: true, submission_id: b, duplicate: true }) })).toBe('sent');
    expect(outboxIds(store())).toEqual([]);
  });

  it('keeps a refused response on the device and stops retrying it', async () => {
    const id = queue();
    expect(await sendOne(id, { apiUrl: 'u', post: answer({ ok: false, error: 'unavailable', retry: false }) })).toBe('rejected');
    expect(readOutbox(id)!.rejected).toBe('unavailable');
    let calls = 0;
    await flushOutbox({ apiUrl: 'u', post: async (...a) => { calls++; return answer({ ok: true })(...a); } });
    expect(calls).toBe(0);
    expect(pendingCount(store())).toBe(0);
    expect(outboxIds(store())).toEqual([id]);
  });

  it('retries after network errors and busy answers, waiting longer each time', async () => {
    const id = queue();
    let t = 1_000_000;
    const opts = { apiUrl: 'u', now: () => t, random: () => 0.5 };
    expect(await sendOne(id, { ...opts, post: async () => { throw new Error('offline'); } })).toBe('queued');
    let e = readOutbox(id)!;
    expect([e.attempts, e.last_error, Date.parse(e.next_at!) - t]).toEqual([1, 'network', 2000]);
    // Not due yet: flush leaves it alone.
    let calls = 0;
    const busy: Poster = async (...a) => { calls++; return answer({ ok: false, error: 'busy', retry: true })(...a); };
    await flushOutbox({ ...opts, post: busy });
    expect(calls).toBe(0);
    t += 2001;
    await flushOutbox({ ...opts, post: busy });
    e = readOutbox(id)!;
    expect([calls, e.attempts, e.last_error, Date.parse(e.next_at!) - t]).toEqual([1, 2, 'busy', 4000]);
    // An HTTP error page (not JSON) also just waits.
    t += 4001;
    await flushOutbox({ ...opts, post: async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }) });
    expect(readOutbox(id)!.attempts).toBe(3);
    t += 10_000;
    await flushOutbox({ ...opts, post: answer({ ok: true, submission_id: id }) });
    expect(outboxIds(store())).toEqual([]);
  });

  it('backoff grows to a 5-minute cap, with jitter so a class does not retry in step', () => {
    expect(backoffMs(1, () => 0.5)).toBe(2000);
    expect(backoffMs(5, () => 0.5)).toBe(32000);
    expect(backoffMs(30, () => 0.5)).toBe(300000);
    expect(backoffMs(3, () => 0)).toBe(4000);
    expect(backoffMs(3, () => 0.999)).toBeCloseTo(11992, -1);
  });
});

describe('finish screen', () => {
  const inst = loadInstrument('questionnaires/student_7_10/STU_7_10_V1.1.json');

  async function finishWith(outcome: 'sent' | 'queued' | 'rejected') {
    document.body.innerHTML = '<div id="app"></div>';
    window.scrollTo = () => {};
    const root = document.getElementById('app')!;
    const sent: string[] = [];
    const s = new Survey({ root, instrument: inst, context: 'c', preview: false, submit: { token: TOKEN, send: async (id) => { sent.push(id); return outcome; } } });
    const internal = s as unknown as { draft: { consent: string; section_index: number; answers: unknown }; screen: string };
    internal.draft.consent = 'yes';
    internal.draft.answers = fillEverything(indexInstrument(inst));
    internal.draft.section_index = inst.sections.length - 1;
    internal.screen = 'section';
    s.render();
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Finish')!.click();
    const during = root.querySelector('.send-status')!.textContent;
    await new Promise((r) => setTimeout(r, 0));
    return { during, after: root.querySelector('.send-status')!.textContent, sent };
  }

  it('says "sending", then "sent"', async () => {
    const r = await finishWith('sent');
    expect(r.during).toBe('Sending your answers…');
    expect(r.after).toContain('have been sent');
    expect(r.sent).toHaveLength(1);
    expect(readOutbox(r.sent[0])!.s).toBe(TOKEN);
  });
  it('says the answers are safe on the device when offline', async () => {
    expect((await finishWith('queued')).after).toContain('saved on this device');
  });
  it('asks the person to tell their teacher when the server refuses', async () => {
    expect((await finishWith('rejected')).after).toContain('Please tell the teacher');
  });
});
