// Development-only stand-in for the Apps Script endpoint (VITE_API_URL=mock with `npm run dev`).
// Production builds never use it. The first letter of a 43-character test token picks a case:
//   A… all classes 7–12 · J… Classes 7–10 only · S… Classes 11–12, students only
//   W… not yet open · C… closed · anything else: unavailable
import type { Fetcher } from './school';
import type { SchoolInfo } from './routing';

const ALL = ['STU_7_10_V1.1', 'TCH_7_10_V1.1', 'STU_11_12_V1.0', 'TCH_11_12_V1.1'];

export const mockFetcher: Fetcher = async (url) => {
  const token = new URL(url, 'http://x').searchParams.get('s') ?? '';
  let info: SchoolInfo = { ok: true, status: 'unavailable' };
  if (token.startsWith('A')) info = { ok: true, status: 'active', classes: [7, 8, 9, 10, 11, 12], instruments: ALL };
  if (token.startsWith('J')) info = { ok: true, status: 'active', classes: [7, 8, 9, 10], instruments: ALL.slice(0, 2) };
  if (token.startsWith('S')) info = { ok: true, status: 'active', classes: [11, 12], instruments: ['STU_11_12_V1.0'] };
  if (token.startsWith('W')) info = { ok: true, status: 'not_yet_open' };
  if (token.startsWith('C')) info = { ok: true, status: 'closed' };
  await new Promise((r) => setTimeout(r, 150));
  return { ok: true, json: async () => info };
};
