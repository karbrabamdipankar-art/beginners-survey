# The Beginners — Meghalaya survey platform

A static survey app (GitHub Pages) with a Google Apps Script + Google Sheets back end, for research surveys of students and teachers in Classes 7–12 across Meghalaya.

- `web/` — the survey app (Vite + TypeScript). See `web/README.md`.
- `apps-script/` — school registry, school links and the public API. See `apps-script/README.md`.
- `questionnaires/` — instrument definitions in the `beginners.instrument/1` format (`docs/21`, `schemas/instrument.schema.json`).
- `docs/22_PLATFORM_ARCHITECTURE.md` — how it fits together.

This repository holds code and instrument definitions only. No respondent data, school tokens or contact details are ever stored here.
