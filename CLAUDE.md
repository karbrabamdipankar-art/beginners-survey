# CLAUDE.md — The Beginners: Meghalaya Assessment, Career Guidance & Counselling Platform

## What this project is
A web platform to (1) run research surveys of students and teachers in Classes 7–12 across Meghalaya (**all schools are eligible, including Shillong city**: DEC-21), and later (2) deliver career/academic psychometric tests whose questions, scoring and report logic are **uploaded as data** when a test is created.

## Read first
1. `PROJECT_STATUS.md`: where we are and what's next
2. `docs/22_PLATFORM_ARCHITECTURE.md`: the stack and how it fits together
3. `docs/21_INSTRUMENT_DEFINITION_FORMAT.md` + `schemas/instrument.schema.json`: the instrument format the app renders
4. `docs/20_OPEN_ISSUES_AND_DECISIONS.md` Part D: decisions already made (don't reopen them)
5. `docs/01_MASTER_INSTRUCTION_MANUAL.md`: the full governing manual (long; consult as needed)

## Fixed constraints (from the project owner)
- **Hosting:** GitHub (GitHub Pages, static site, deployed by GitHub Actions).
- **Storage:** Google Sheets, written **only** through a Google Apps Script web app.
- **Schools are registered first** by project staff; registration generates the school's own survey link (`?s=<token>`) and QR code. The link asks student/teacher and class, then routes to the right instrument (DEC-22, docs/22 §3). **The link must never display the school's name or any school detail, and the public API must never return it** (DEC-23).
- Where docs/01 (the manual) says Shillong city is excluded, DEC-21 overrides it.
- The owner has delegated technical decisions to Claude. Log any significant new decision in `docs/20` Part D (DEC-xx) and update `PROJECT_STATUS.md` at the end of each work session.

## Deployable instruments (do not edit their wording)
- `questionnaires/student_7_10/STU_7_10_V1.1.json`
- `questionnaires/teacher_7_10/TCH_7_10_V1.1.json`
- `questionnaires/student_11_12/STU_11_12_V1.0.json`
- `questionnaires/teacher_11_12/TCH_11_12_V1.1.json` (V1.0 retired)

`*_V1.0.json` files for the 7–10 instruments are archived baselines. `*_extracted.json` files are the Phase 0 audit record. An approved version is immutable: any wording, option or logic change means a **new version** with a `change_log` entry, validated with `tools/phase0_scripts/validate.py`.

## Non-negotiable rules
- The app must be **instrument-agnostic**: no questionnaire content in code. Everything comes from the instrument JSON.
- Never store respondent data in the repo. No tokens, sheet IDs with data, or exports committed.
- A blank answer is never "No" or 0. Use status tokens (`#SKIPPED`, `#NOT_DISPLAYED`, `#PREFER_NOT_TO_ANSWER`, `#NOT_SURE`, `#NOT_APPLICABLE`).
- Respect `exclusive`, `max_select`, `show_if`, `options_from`, `specify` and `required` exactly as defined in the JSON.
- Survey items are **not** psychometric scores. Never compute scores, risk flags or labels from `NOT_SCORABLE` / `HIGHLY_SENSITIVE` items.
- Consent/assent screen before the first section. Contact requests (STU_G08, STU_L08) go to the restricted contacts spreadsheet only.
- A school cannot become ACTIVE (its link cannot accept submissions) without a safeguarding lead + referral contact, because the student instruments have `safeguarding_required: true`.
- Admin functions (registration, tokens, exports) need Google sign-in on an allow-list and are never on the public endpoint.
- Mobile-first, low-bandwidth, works offline after first load (Meghalaya connectivity). Retry submissions with backoff (Apps Script allows 30 concurrent executions; doPost times out at 30 s).
- Plain, respectful language in UI text. UI strings in a translation file (Khasi/Garo translations come later).

## Current milestone
**M2 deploy, then M3 — Submission** (docs/22 §5, §6, §9). M1 renderer and M2 school registry/links are built and tested (see PROJECT_STATUS.md, `web/README.md`, `apps-script/README.md`). Run `npm test` in `/web` and `node --test "apps-script/test/*.test.mjs"` after any change. M2 deployment waits for the owner's Google Workspace account and GitHub repository.

## Owner inputs still needed (ask when the milestone needs them)
- Organisation Google Workspace account to own the Sheets and the script (strongly preferred over personal Gmail)
- GitHub account / repository name
- Schools to register (with UDISE codes if available)
- Safeguarding lead and referral contact per school; consent/assent text approval
