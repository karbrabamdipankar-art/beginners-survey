// Local save/resume. One draft per instrument version and context (e.g. school link),
// kept only on this device. Every access is guarded: storage can be missing or blocked.
import type { Answers } from './types';

export interface Draft {
  v: 1;
  submission_id: string;
  instrument_version_id: string;
  started_at: string;
  updated_at: string;
  consent: 'yes' | null;
  section_index: number;
  answers: Answers;
  finished_at?: string;
  /** Landing choices on a school link (docs/22 §3): system fields, not instrument variables. */
  route_role?: 'student' | 'teacher';
  route_class?: string;
}

const PREFIX = 'beginners.draft.';

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function draftKey(instrumentVersionId: string, context = 'default'): string {
  return `${PREFIX}${context}.${instrumentVersionId}`;
}

export function newSubmissionId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for old browsers: RFC 4122 v4 from getRandomValues.
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function newDraft(instrumentVersionId: string, now = new Date()): Draft {
  const ts = now.toISOString();
  return {
    v: 1,
    submission_id: newSubmissionId(),
    instrument_version_id: instrumentVersionId,
    started_at: ts,
    updated_at: ts,
    consent: null,
    section_index: 0,
    answers: {},
  };
}

export function loadDraft(key: string, store: KeyValueStore | null = defaultStore()): Draft | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (d?.v !== 1 || typeof d.answers !== 'object' || !d.submission_id) return null;
    return d;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, draft: Draft, store: KeyValueStore | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify({ ...draft, updated_at: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(key: string, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ---------- outbox: finished responses waiting to be sent (see outbox.ts) ---------- */

export const OUTBOX_PREFIX = 'beginners.outbox.';

/** A finished response plus what is needed to send it later, possibly offline for days. */
export interface OutboxEntry extends Draft {
  /** The school link token. Needed to submit; stored in the value, never in a key (DEC-27). */
  s: string;
  attempts?: number;
  /** ISO time before which no new attempt is made (backoff). */
  next_at?: string;
  last_error?: string;
  /** Set when the server refused it for good; it stays on the device and is not retried. */
  rejected?: string;
}

export type OutboxStore = KeyValueStore & { length: number; key(i: number): string | null };

/**
 * Moves a finished draft out of the way so the next person on a shared school device starts
 * fresh, while the response is kept until it has been sent.
 */
export function moveToOutbox(key: string, draft: Draft, token: string, store: KeyValueStore | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    const entry: OutboxEntry = { ...draft, s: token, attempts: 0 };
    store.setItem(OUTBOX_PREFIX + draft.submission_id, JSON.stringify(entry));
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function outboxIds(store: OutboxStore | null = defaultStore() as OutboxStore | null): string[] {
  if (!store) return [];
  const ids: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(OUTBOX_PREFIX)) ids.push(k.slice(OUTBOX_PREFIX.length));
    }
  } catch {
    /* ignore */
  }
  return ids;
}

export function readOutbox(id: string, store: KeyValueStore | null = defaultStore()): OutboxEntry | null {
  try {
    const raw = store?.getItem(OUTBOX_PREFIX + id);
    return raw ? (JSON.parse(raw) as OutboxEntry) : null;
  } catch {
    return null;
  }
}

export function writeOutbox(entry: OutboxEntry, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(OUTBOX_PREFIX + entry.submission_id, JSON.stringify(entry));
  } catch {
    /* storage full: the entry keeps its previous state */
  }
}

export function removeOutbox(id: string, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.removeItem(OUTBOX_PREFIX + id);
  } catch {
    /* ignore */
  }
}
