// Entry point.
//   ?s=<token>              school link (M2): role → class → survey. Never shows school details (DEC-23).
//   ?preview[=<version id>] preview mode: try any deployable instrument; nothing is sent.
//   (no parameters)         a neutral page asking people to use their school's link.
import './styles.css';
import { t } from './i18n';
import { h } from './ui/dom';
import { Survey } from './ui/survey';
import { Landing } from './ui/landing';
import { getSchoolInfo, tokenContext } from './school';
import { mockFetcher, mockPoster } from './mock-api';
import { flushOutbox, sendOne, startOutboxSender } from './outbox';
import type { IndexEntry } from './routing';
import type { Instrument } from './types';

const root = document.getElementById('app')!;
const base = import.meta.env.BASE_URL;
const apiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim() ?? '';
/** Development only: VITE_API_URL=mock answers submissions locally (never in production builds). */
const mockPost = import.meta.env.DEV && apiUrl === 'mock' ? mockPoster : undefined;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const loadIndex = () => fetchJson<{ instruments: IndexEntry[] }>('instruments/index.json').then((r) => r.instruments);
const loadInstrument = (e: IndexEntry) => fetchJson<Instrument>(`instruments/${e.file}`);

function showError(retry: () => void, key = 'app.load_failed'): void {
  root.replaceChildren(h('main', { class: 'survey' },
    h('p', { role: 'alert' }, t(key)),
    h('button', { type: 'button', class: 'btn primary', onclick: retry }, t('app.retry'))));
}

async function start(): Promise<void> {
  root.replaceChildren(h('main', { class: 'survey' }, h('p', {}, t('app.loading'))));
  const params = new URLSearchParams(location.search);
  const token = params.get('s');
  try {
    if (token !== null) return await startSchoolLink(token.trim());
    if (params.has('preview')) return await startPreview(params.get('preview'));
    renderHome();
  } catch {
    showError(start);
  }
}

async function startSchoolLink(token: string): Promise<void> {
  // Storage keys use a hash of the token, never the token itself.
  if (!apiUrl) {
    root.replaceChildren(h('main', { class: 'survey' }, h('p', { role: 'alert' }, t('landing.not_configured'))));
    return;
  }
  const context = await tokenContext(token);
  const fetcher = import.meta.env.DEV && apiUrl === 'mock' ? mockFetcher : undefined;
  const [index, result] = await Promise.all([loadIndex(), getSchoolInfo(apiUrl, token, context, fetcher)]);
  const send = (id: string) => sendOne(id, { apiUrl, post: mockPost });
  new Landing({ root, index, info: result.info, context, offline: result.fromCache, loadInstrument, token, send }).start();
}

async function startPreview(wanted: string | null): Promise<void> {
  const instruments = await loadIndex();
  const entry = instruments.find((i) => i.instrument_version_id === wanted);
  if (!entry) return renderPicker(instruments);
  const instrument = await loadInstrument(entry);
  new Survey({ root, instrument, context: 'preview', preview: true }).render();
}

function renderHome(): void {
  root.replaceChildren(h('main', { class: 'survey' }, h('h1', {}, t('home.title')), h('p', {}, t('home.body'))));
}

function renderPicker(instruments: IndexEntry[]): void {
  const list = h('ul', { class: 'picker' });
  for (const i of instruments) {
    const url = `?preview=${encodeURIComponent(i.instrument_version_id)}`;
    list.append(h('li', {}, h('a', { href: url, class: 'picker-item' },
      h('strong', {}, i.title),
      h('span', { class: 'q-hint' }, i.instrument_version_id))));
  }
  root.replaceChildren(
    h('div', { class: 'banner', role: 'note' }, t('preview.banner')),
    h('main', { class: 'survey' }, h('h1', {}, t('preview.choose')), list));
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${base}sw.js`)
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      const urls = performance.getEntriesByType('resource').map((e) => e.name).concat(location.href);
      reg.active?.postMessage({ cache: urls });
    })
    .catch(() => { /* offline support is a bonus; the survey still works online */ });
}

// Finished responses waiting on this device (from earlier visits too) are sent in the background.
if (apiUrl && !new URLSearchParams(location.search).has('preview')) {
  if (mockPost) void flushOutbox({ apiUrl, post: mockPost });
  else startOutboxSender(apiUrl);
}

start();
