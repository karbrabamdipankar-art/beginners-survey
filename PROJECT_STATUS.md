# PROJECT_STATUS

Last updated: 2026-11-22 · Updated by: Claude

## Current phase: Platform build — **M3 submission done and live (2026-11-27).** Next: M4 (monitoring + CSV/codebook export). M1 and M2 done and deployed.

### Completed in this stage (M3)
- **Server** (`apps-script/Submit.js` + `Api.js doPost`): validates link, school status, survey window, instrument offered, consent; re-checks every answer with the app's own engine (bundled into `Engine.js` by `npm run apps-script`); writes one row per response to `R_<version>` (created on first use) under one lock; idempotent on `submission_id`; `#SYSTEM_FILLED` → school code; formula-safe text; per-link rate limit; audit of submit/reject. Rules in DEC-29.
- **Restricted contacts:** `Beginners_Restricted_Contacts` spreadsheet (created by *Set up / repair tabs*, owner-only) receives STU_G08 / STU_L08 answers; never the research row.
- **App** (`web/src/outbox.ts`): finished responses queue on the device and are sent at once, then with exponential backoff + jitter (2 s → 5 min cap), on reconnect and on every load; permanent refusals stay on the device and stop retrying. Finish screen says sending / sent / saved-will-send / please tell your teacher.
- Script permission widened from "this spreadsheet only" to Sheets (needed for the restricted spreadsheet); owner re-authorised 2026-11-27.

### Tests performed (M3)
- `web`: **246 pass** (8 new: payload, sent/duplicate/refused/backoff paths, jitter cap, finish-screen messages). Typecheck + build pass.
- `apps-script`: **20 pass** (9 new submit tests run the real Core/Engine/Instruments/Submit files in a sandbox: full row, duplicates, refusals, #INVALID storage, formula safety, class mismatch, late-sync window, busy/rate-limit, all four instruments accept a complete response).
- **Live:** a complete STU_11_12 response posted directly → `R_STU_11_12_V1.0` row (school code filled, duration, no flags); sent again → `duplicate: true`, still one row; both contact answers in the restricted spreadsheet once. A complete STU_7_10 response finished **in the browser on the live site** (phone size) → "Your answers have been sent", outbox emptied, row in `R_STU_7_10_V1.1` with no flags.
- **Noticed:** first load of a school link took ~8 s (Apps Script cold start). Sheets shows `route_class` "11" as a number; harmless.

### Before real data collection
- **Remove the two test rows** (tabs `R_STU_11_12_V1.0`, `R_STU_7_10_V1.1`, both school `ML-EKH-0001`, text answers "…test - please ignore") and the two test rows in `Beginners_Restricted_Contacts`, and close test school `ML-EKH-0001` again.
- **Owner decision (LOG-014):** how a "Yes" to the support-contact questions is followed up, since no student contact details are collected.
- Consent/assent text approval; real schools with real safeguarding contacts; organisation Google account before full fieldwork.

### Deployment (2026-11-25, DEC-28)
- **Site:** https://karbrabamdipankar-art.github.io/beginners-survey/ (GitHub Pages via Actions; public repo `karbrabamdipankar-art/beginners-survey`, code + instrument JSON only).
- **Google:** spreadsheet `Beginners_Research_Data` + bound script, owned by the owner's personal Gmail for the pilot (move to an organisation account before full fieldwork; the API URL will change then). Script properties `ADMIN_EMAILS`, `SITE_URL` set. Public web app deployed; its `/exec` URL is the repo variable `API_URL`.
- **Checked live:** anonymous `school_info` answers (unknown token → unavailable; test school → status/classes/instruments only, no school details); admin dialog opens for the allow-listed account; test school `ML-EKH-0001` registered ACTIVE through the dialog; its link at phone size asks student/teacher, offers only Classes 9–11, opens the Class 11–12 survey after consent without STU_A05; storage keys hold no token. Fixed after the live check: a teacher band with one offered class now reads "Class 11", not "Classes 11–11".
- **Updating:** `apps-script/README.md` → "Updating with clasp" (always redeploy to the same deployment ID).
- **Fixed after the live check:** Close / Pause / New link did nothing in the real dialog because Google's sandbox blocks `confirm()` pop-ups; confirmations now appear inside the dialog (tested with pop-ups blocked, then used live).
- **Test school `ML-EKH-0001` is CLOSED:** its link now answers `unavailable` and the page shows "This link is not open" (checked live straight after closing). Leave it closed; it never collected responses.
- **By hand only:** the admin dialog's dropdowns cannot be driven by automation, so staff register schools themselves.

### Completed in this stage (M2)
- **`/apps-script`** (bound to the research spreadsheet; see `apps-script/README.md` for the 15-minute setup):
  - `Schools`, `School_Contacts` (hidden, protected), `Audit`, `Config` tabs, created by a menu item.
  - Staff *School admin* dialog in the spreadsheet (DEC-26): register, edit, activate, pause, close, new link, link + QR code (PNG, drawn locally). Allow-list `ADMIN_EMAILS`; every action audited.
  - School code `ML-<district>-<NNNN>`; 256-bit token; duplicate UDISE refused; district locked after registration.
  - Activation rule: no ACTIVE status without safeguarding lead + referral contact (from `Config.safeguarding_required`); removing them deactivates.
  - Public `school_info`: only status / classes / instrument versions (DEC-23); unknown, paused, closed and inactive tokens look identical; survey window in India time; 2-minute cache cleared by admin actions.
- **`/web`**: school link landing: student/teacher → class (student) or class band (teacher) → consent → the right instrument; roles and classes come only from the instrument registry and `school_info`. `route_role` / `route_class` stored with the response. Offline: last good `school_info` reused, with a notice. STU_A05 hidden and stored as `#SYSTEM_FILLED` on school links (DEC-24), asked as written in preview. Shared-device rules (DEC-27): 6-hour resume limit, finished responses to an outbox, "Next person" button, token never used as a storage key. Neutral home page; preview kept at `?preview`.
- GitHub Actions now also runs the Apps Script tests and builds with `vars.API_URL`.
- Decisions DEC-26, DEC-27 logged (docs/20); docs/22 → v1.3.

### Files added / modified
Added: `apps-script/**`, `web/src/{routing,school,mock-api}.ts`, `web/src/ui/landing.ts`, `web/test/school-link.test.ts`. Modified: web engine (system fill), survey screen, storage (outbox, route fields), i18n strings, copy script (`system_fill`), `instruments.deploy.json`, `.github/workflows/pages.yml`, docs/20, docs/22, web/README.md, CLAUDE.md, PROJECT_STATUS.md. **No instrument JSON was changed.**

### Tests performed
- `web`: **237 tests pass** (218 from M1 + 19 new: routing, school_info client retries/offline/cache, token hashing, STU_A05 system fill, landing screens incl. outbox and 6-hour expiry). Typecheck and production build pass; the dev mock is confirmed absent from the production bundle.
- `apps-script`: **11 tests pass** (node:test, in-memory tabs): tokens, codes, form checks, activation rule, deactivation, duplicate UDISE, school_info leaks nothing (name, code, district, locality, UDISE, contacts, token), paused/closed/unknown identical, new link kills old one, survey window edges in IST, Config pausing.
- Browser (phone size, mock API): student → Class 11 → consent → survey without STU_A05; storage keys contain no token. Admin dialog run in a browser on the real Core.js with in-memory tabs: validation errors, register → REGISTERED, activate refused, add safeguarding → activate → link + QR, audit trail. Dark-mode readability bug in the dialog fixed.
- **Not tested:** the Google-only glue (`Store.js`, `Api.js`, `Admin.js`) has only been syntax-checked; it runs for the first time when deployed. Do the check in step 7 of `apps-script/README.md`.

### Open conditions before fieldwork
- TCH_11_12 wording is drafted, not original: pretest with 3–5 teachers.
- No expert review exists, so all versions are APPROVED_FOR_PILOT. Run a small pilot before full rollout.
- Consent/assent text (placeholder in the app), safeguarding lead and referral contact per school, and the schools to register.

### Known limits
- Responses are not sent yet (M3). Finished ones wait in the device outbox.
- The class answer inside each instrument is not yet compared with `route_class` (flag in M3 on submit).
- Not yet tested on real low-end Android phones or a real slow network.

### Next task
1. **Deploy M2** (owner inputs needed): organisation Google Workspace account → create the spreadsheet and script per `apps-script/README.md`; GitHub repository → push, enable Pages, set `API_URL`; first school(s) to register with safeguarding contacts.
2. **M3 — submission**: `doPost submit` (validate token/status/window/instrument/every answer against the JSON, idempotent on `submission_id`, one `appendRow` under lock), `R_<version>` tabs, fill `#SYSTEM_FILLED` with school_code, class/route mismatch flag, restricted contacts spreadsheet, outbox sender with backoff + jitter.

### Stage log
- 2026-11-27: M3 submission built, deployed and checked live (246 web + 20 Apps Script tests). DEC-29; LOG-014 open.
- 2026-11-25: M2 deployed for the pilot (DEC-28). Live checks passed; teacher single-class label and admin confirmations fixed; test school closed.
- 2026-11-22: M2 built and tested locally (237 web + 11 Apps Script tests). DEC-26, DEC-27; docs/22 v1.3.
- 2026-11-22: M1 renderer built and tested (218 tests). DEC-24, DEC-25.
- 2026-11-22: DEC-23 school link never shows the school name (docs/22 v1.2).
- 2026-11-22: DEC-21 all schools eligible incl. Shillong; DEC-22 registration-first school links. TCH_11_12_V1.1 created (district label), V1.0 retired. docs/22 v1.1.
- 2026-11-22: architecture fixed (DEC-20, docs/22); CLAUDE.md and .gitignore added for Claude Code handoff.
