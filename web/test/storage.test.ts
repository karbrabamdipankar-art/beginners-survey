import { describe, expect, it } from 'vitest';
import { clearDraft, draftKey, loadDraft, newDraft, saveDraft, type KeyValueStore } from '../src/storage';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe('drafts', () => {
  it('saves and resumes answers, keyed by context and instrument version', () => {
    const store = memoryStore();
    const key = draftKey('STU_7_10_V1.1', 'school-abc');
    const d = newDraft('STU_7_10_V1.1');
    d.answers = { 'STU-A01': { codes: [1] } };
    d.section_index = 2;
    expect(saveDraft(key, d, store)).toBe(true);
    const back = loadDraft(key, store)!;
    expect(back.answers).toEqual(d.answers);
    expect(back.section_index).toBe(2);
    expect(back.submission_id).toBe(d.submission_id);
    expect(loadDraft(draftKey('STU_7_10_V1.1', 'other'), store)).toBeNull();
    clearDraft(key, store);
    expect(loadDraft(key, store)).toBeNull();
  });

  it('ignores corrupt data and survives blocked storage', () => {
    const store = memoryStore();
    store.setItem('k', '{not json');
    expect(loadDraft('k', store)).toBeNull();
    const throwing: KeyValueStore = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('x'); } };
    expect(loadDraft('k', throwing)).toBeNull();
    expect(saveDraft('k', newDraft('X'), throwing)).toBe(false);
    expect(() => clearDraft('k', throwing)).not.toThrow();
    expect(loadDraft('k', null)).toBeNull();
  });

  it('gives each draft a v4 UUID submission id (idempotency key)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newDraft('X').submission_id));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
