// Talks to the public Apps Script endpoint for a school link. Only status, classes and
// instrument versions ever come back (DEC-23). The last good answer is kept on the device,
// so a link opened once keeps working when the connection drops.
import type { SchoolInfo } from './routing';

const CACHE_PREFIX = 'beginners.school.';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isTokenShaped(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/**
 * A short, one-way name for the token, used for local storage keys so the token itself is
 * not repeated across storage. SHA-256 where available; FNV-1a otherwise (old browsers).
 */
export async function tokenContext(token: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const buf = await subtle.digest('SHA-256', new TextEncoder().encode(token));
      return 's' + [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through */
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'f' + h.toString(16);
}

function readCache(context: string): SchoolInfo | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + context);
    return raw ? (JSON.parse(raw) as SchoolInfo) : null;
  } catch {
    return null;
  }
}

function writeCache(context: string, info: SchoolInfo): void {
  try {
    if (info.status === 'active') localStorage.setItem(CACHE_PREFIX + context, JSON.stringify(info));
    else localStorage.removeItem(CACHE_PREFIX + context);
  } catch {
    /* ignore */
  }
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface SchoolInfoResult {
  info: SchoolInfo;
  /** True when the network failed and the saved answer from an earlier visit is used. */
  fromCache: boolean;
}

/**
 * Asks the API about a token. Retries twice with backoff on network errors, then falls back
 * to the saved answer. Throws only if there is neither a network answer nor a saved one.
 */
export async function getSchoolInfo(apiUrl: string, token: string, context: string, fetcher: Fetcher = fetch, waitMs = 800): Promise<SchoolInfoResult> {
  if (!isTokenShaped(token)) return { info: { ok: true, status: 'unavailable' }, fromCache: false };
  const url = `${apiUrl}${apiUrl.includes('?') ? '&' : '?'}action=school_info&s=${encodeURIComponent(token)}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetcher(url);
      if (!res.ok) throw new Error('HTTP error');
      const info = (await res.json()) as SchoolInfo;
      if (!info || info.ok !== true || typeof info.status !== 'string') throw new Error('Bad response');
      writeCache(context, info);
      return { info, fromCache: false };
    } catch (e) {
      lastError = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, waitMs * 2 ** attempt * (0.75 + Math.random() / 2)));
    }
  }
  const cached = readCache(context);
  if (cached) return { info: cached, fromCache: true };
  throw lastError;
}
