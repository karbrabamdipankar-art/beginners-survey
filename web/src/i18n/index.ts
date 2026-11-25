// UI strings live in translation files (en.json now; Khasi/Garo later). Code never
// hard-codes respondent-facing text. Missing keys fall back to English, then the key itself.
import en from './en.json';

type Dict = Record<string, string>;
const dictionaries: Record<string, Dict> = { en };
let current: Dict = en;

export function setLanguage(lang: string): void {
  current = dictionaries[lang] ?? en;
}

export function t(key: string, params?: Record<string, string | number>): string {
  let s = current[key] ?? (en as Dict)[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
