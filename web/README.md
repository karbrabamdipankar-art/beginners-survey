# /web — survey app (Vite + TypeScript)

Renders any `beginners.instrument/1` file (docs/21). No questionnaire content is in the code.

```
npm install
npm run dev        # copies instruments, starts http://localhost:5173
npm test           # engine + screen tests over all four deployable instruments
npm run build      # typecheck + production build to web/dist
```

- `instruments.deploy.json` lists the deployable versions; `scripts/copy-instruments.mjs` copies them to `public/instruments/` (generated, not committed) with an `index.json` registry.
- `src/engine/logic.ts`: show_if, options_from, exclusive, max_select, validation.
- `src/engine/record.ts`: answer statuses, wide-row encoding (docs/22 §5, DEC-25).
- `src/ui/`: consent → one section per screen → finish. `src/storage.ts`: on-device save/resume.
- `src/i18n/en.json`: every UI string. Khasi/Garo files go next to it.
- `public/sw.js`: offline after first load.

Entry points:
- `?s=<token>`: school link. Asks student/teacher, then class, then opens the right survey (`src/ui/landing.ts`, `src/routing.ts`). Never shows the school's name (DEC-23). Needs `VITE_API_URL` (the Apps Script `/exec` URL) at build time; GitHub Actions takes it from the repository variable `API_URL`.
- `?preview` / `?preview=<instrument_version_id>`: try any instrument; nothing is sent.
- no parameters: a page asking people to use their school's link.

Local testing of school links without Apps Script: create `web/.env.development.local` with `VITE_API_URL=mock` and run `npm run dev`, then open `/?s=` plus a 43-character test token. Its first letter picks the case (see `src/mock-api.ts`): `A` all classes, `J` Classes 7–10, `S` Classes 11–12 students only, `W` not yet open, `C` closed. The mock is never in production builds.

Finished responses on a school link go to an on-device outbox (`beginners.outbox.*`) and are sent by `src/outbox.ts`: at once, then with exponential backoff + jitter, on reconnect and on every page load. A permanent refusal keeps the response on the device and stops retrying. `npm run apps-script` bundles `src/engine` + the instruments into `/apps-script` so the server applies the same rules.
