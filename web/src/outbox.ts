// Sends finished responses from the on-device outbox to the Apps Script `submit` action.
// Works through bad connections: each response is retried with exponential backoff and
// jitter (Apps Script allows 30 simultaneous executions, so a whole class must not retry in
// step), again when the device comes back online, and again on the next page load.
// The server is idempotent on submission_id, so sending twice is harmless.
import {
  outboxIds,
  readOutbox,
  removeOutbox,
  writeOutbox,
  type OutboxEntry,
  type OutboxStore,
} from './storage';

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export type SendOutcome = 'sent' | 'queued' | 'rejected';

export interface PostResult {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type Poster = (url: string, body: string) => Promise<PostResult>;

/** POST as text/plain: a "simple" request, so no CORS preflight (Apps Script cannot answer one). */
export const defaultPoster: Poster = (url, body) =>
  fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' });

const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 5 * 60 * 1000;

/** Delay before attempt n+1: 2 s, 4 s, 8 s … capped at 5 min, each ×0.5–1.5 at random. */
export function backoffMs(attempts: number, random = Math.random): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.5 + random()));
}

export function payloadFor(e: OutboxEntry): string {
  return JSON.stringify({
    action: 'submit',
    s: e.s,
    submission_id: e.submission_id,
    instrument_version_id: e.instrument_version_id,
    consent: e.consent,
    route_role: e.route_role,
    route_class: e.route_class,
    started_at: e.started_at,
    finished_at: e.finished_at,
    client_app_version: APP_VERSION,
    answers: e.answers,
  });
}

export interface SenderOptions {
  apiUrl: string;
  post?: Poster;
  store?: OutboxStore | null;
  now?: () => number;
  random?: () => number;
}

/** Tries to send one entry now (ignoring its backoff time) and records the result. */
export async function sendOne(id: string, opts: SenderOptions): Promise<SendOutcome> {
  const store = opts.store === undefined ? (globalThis.localStorage as OutboxStore | undefined) ?? null : opts.store;
  const now = opts.now ?? Date.now;
  const entry = readOutbox(id, store);
  if (!entry) return 'sent';
  if (entry.rejected) return 'rejected';
  const post = opts.post ?? defaultPoster;
  let retryReason = 'network';
  try {
    const res = await post(opts.apiUrl, payloadFor(entry));
    const body = (await res.json()) as { ok?: boolean; error?: string; retry?: boolean };
    if (body && body.ok === true) {
      removeOutbox(id, store);
      return 'sent';
    }
    if (body && body.retry === false) {
      writeOutbox({ ...entry, rejected: String(body.error ?? 'refused'), last_error: String(body.error ?? '') }, store);
      return 'rejected';
    }
    retryReason = String(body?.error ?? `http_${res.status}`);
  } catch {
    retryReason = 'network';
  }
  const attempts = (entry.attempts ?? 0) + 1;
  writeOutbox({ ...entry, attempts, last_error: retryReason, next_at: new Date(now() + backoffMs(attempts, opts.random)).toISOString() }, store);
  return 'queued';
}

/** Sends every entry whose backoff time has passed. One at a time, to be gentle on the server. */
export async function flushOutbox(opts: SenderOptions): Promise<{ sent: number; queued: number; rejected: number }> {
  const store = opts.store === undefined ? (globalThis.localStorage as OutboxStore | undefined) ?? null : opts.store;
  const now = opts.now ?? Date.now;
  const counts = { sent: 0, queued: 0, rejected: 0 };
  for (const id of outboxIds(store)) {
    const e = readOutbox(id, store);
    if (!e || e.rejected) continue;
    if (e.next_at && Date.parse(e.next_at) > now()) {
      counts.queued++;
      continue;
    }
    counts[await sendOne(id, { ...opts, store })]++;
  }
  return counts;
}

/** Entries still waiting (not sent, not refused). */
export function pendingCount(store: OutboxStore | null = (globalThis.localStorage as OutboxStore | undefined) ?? null): number {
  return outboxIds(store).filter((id) => !readOutbox(id, store)?.rejected).length;
}

let running = false;
let timer: ReturnType<typeof setInterval> | undefined;

/** Background sender for the page: now, every 15 s while something waits, and on reconnect. */
export function startOutboxSender(apiUrl: string): void {
  const tick = async () => {
    if (running || pendingCount() === 0) return;
    running = true;
    try {
      await flushOutbox({ apiUrl });
    } finally {
      running = false;
    }
  };
  void tick();
  if (timer === undefined) timer = setInterval(() => void tick(), 15000);
  globalThis.addEventListener?.('online', () => void tick());
}
