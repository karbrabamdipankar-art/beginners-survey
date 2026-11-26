# 22 — Platform Architecture (GitHub Pages + Google Apps Script + Google Sheets)

| Field | Value |
|---|---|
| Version | 1.4 |
| Date | 2026-11-22 |
| Status | APPROVED. Owner constraints: Google Sheets storage, GitHub hosting, all schools eligible, school registration generates the survey link (DEC-20, DEC-21, DEC-22) |
| Dependencies | docs/21 instrument format; questionnaires/*/<ID>_V*.json; docs/20 Part D |

**Change history:** 1.0 (2026-11-22) first version · 1.1 (2026-11-22) all schools eligible, including Shillong; registration-first school links replace per-campaign tokens · 1.2 (2026-11-22) the link never shows the school name (DEC-23) · 1.3 (2026-11-22) staff admin is a dialog inside the research spreadsheet (DEC-26); shared-device rules (DEC-27) · 1.4 (2026-11-27) submit implemented as specified, with refusal and late-sync rules (DEC-29).

## 1. Shape of the system

```
 Project team                       Student / teacher browser (school name never shown)
 ┌─────────────────────────┐        ┌────────────────────────────────┐
 │ 1. Register school      │        │ 3. Opens school link ?s=<token>│
 │    (admin page / Sheet  │        │    → "Student or teacher?"     │
 │    menu)                │        │    → class → right survey      │
 │ 2. Gets school link +   │ share  │ 4. Consent → survey → submit   │
 │    QR code              │ ─────▶ │    (offline queue, retries)    │
 └───────────┬─────────────┘        └───────────────┬────────────────┘
             │                                      │ HTTPS POST (text/plain)
             ▼                                      ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ Google Apps Script web app (the only writer)                     │
 │  register_school · school_info · submit · admin exports          │
 ├──────────────────────────────────────────────────────────────────┤
 │ Google Sheets: Research data spreadsheet · Restricted contacts   │
 └──────────────────────────────────────────────────────────────────┘
```

- **Frontend:** Vite + TypeScript, built by GitHub Actions, published to GitHub Pages. Fully static.
- **API:** a Google Apps Script web app bound to the research data spreadsheet. It is the only thing that reads or writes Sheets.
- **Storage:** Google Sheets owned by the project's Google account. No data is ever stored in GitHub.

## 2. Eligibility (DEC-21)

**Every school in Meghalaya is eligible, including Shillong city schools.** There is no exclusion rule. For analysis, the school record captures `locality` and `is_shillong_city` (yes/no), so Shillong and non-Shillong results can still be compared or separated.

## 3. School registration → school link (DEC-22)

Registration happens **before** any survey can be taken. Only registered, active schools have working links.

**Who registers:** project staff, through the *School admin* dialog inside the research spreadsheet (menu *The Beginners → School admin*, DEC-26). Only people the spreadsheet is shared with can open it, and each action also checks the `ADMIN_EMAILS` allow-list. No password is stored in the public site.

**Registration form fields**

| Field | Required | Notes |
|---|---|---|
| School name | Yes | |
| UDISE code | Recommended | Official school ID; used to block duplicate registrations |
| District | Yes | The 12 districts |
| Block / locality | Yes | |
| Is the school in Shillong city? | Yes | Yes / No |
| Area type | Yes | Urban / Semi-urban / Rural / Remote |
| Management | Yes | Government / Government-aided / Private / Other |
| Classes offered | Yes | Any of 7–12; decides which surveys the link offers |
| Streams (if Classes 11–12) | If applicable | Science / Commerce / Arts / Vocational |
| School contact person + phone/email | Yes | Restricted column |
| Safeguarding lead + referral contact | Yes before activation | Required because the student surveys contain sensitive items |
| Survey window (opens / closes) | Optional | Link refuses submissions outside the window |

**What registration generates**
- `school_code`: short, human-readable and sequential (e.g. `ML-EKH-0042`).
- `school_token`: long random string (≥ 128 bits), used only in the link.
- **School link:** `https://<site>/?s=<school_token>`, plus a QR code (PNG) for printing.
- Status `REGISTERED`, which becomes `ACTIVE` once the safeguarding fields are filled. Staff can set it to `PAUSED` or `CLOSED`, and can **regenerate the token** if a link leaks (the old link then stops working).

**What the link does**
1. Asks **"Are you a student or a teacher?"**. The link **never shows the school's name** or any other school detail to the respondent (DEC-23). The school is identified silently from the token.
2. Student → "Which class are you in?" (only the classes the school offers). Classes 7–10 → `STU_7_10_V1.1`; Classes 11–12 → `STU_11_12_V1.0`.
3. Teacher → "Which classes do you mainly teach?" Classes 7–10 → `TCH_7_10_V1.1`; Classes 11–12 → `TCH_11_12_V1.1`. A teacher who teaches both bands may complete both, one at a time.
4. Consent / assent screen → survey → submit.

The routing answers are stored as system fields (`route_role`, `route_class`). They are not instrument variables. The instrument's own class question is still asked as written, and a mismatch is flagged for data review, never blocked.

## 4. Hard limits that shape the design

| Limit | Value | Design response |
|---|---|---|
| Apps Script simultaneous executions | 30 | Client retries with exponential backoff + jitter. A whole class submitting at once is normal. |
| doPost timeout | 30 s | doPost does validate → one `appendRow` under `LockService` → return. Nothing slow happens in the request. |
| Sheets cells per spreadsheet | 20 M (raised Sept 2026; plan to 10 M to be safe) | **Wide format**: one row per submission, one column per variable. 10,000 STU_7_10 submissions × ~110 columns ≈ 1.1 M cells. |
| Sheets tabs | 200 | One tab per instrument version, plus system tabs. |

## 5. Spreadsheets and tabs

**Spreadsheet A — `Beginners_Research_Data`** (shared only with named research staff)

| Tab | Content |
|---|---|
| `Schools` | school_code, school_token, name, udise_code, district, block_locality, is_shillong_city, area_type, management, classes_offered, streams, status, survey_opens, survey_closes, registered_by, registered_at |
| `School_Contacts` | school_code, contact person, phone/email, safeguarding lead, referral contact (hidden/protected tab) |
| `R_<instrument_version_id>` | One per version, e.g. `R_STU_7_10_V1.1`: system columns, then one column per variable in instrument order, then `<variable>_other_text` columns |
| `Audit` | timestamp, event (register, activate, token_regenerated, submit, reject), school_code, submission_id, actor. No answer content |
| `Config` | instrument registry: instrument_version_id → JSON URL, status, class band, respondent type |

System columns in every `R_` tab: `submission_id` (client UUID; idempotency key), `school_code`, `instrument_version_id`, `respondent_type`, `route_class`, `consent`, `assent`, `research_permission`, `started_at`, `submitted_at`, `received_at`, `client_app_version`, `duration_sec`, `flags`.

**Cell encoding:** single = code; multi = codes joined with `;`; text = text; number = number. A non-answer is a status token: `#SKIPPED`, `#NOT_DISPLAYED`, `#PREFER_NOT_TO_ANSWER`, `#NOT_SURE`, `#NOT_APPLICABLE`. Blank never means "No" or zero.

**Spreadsheet B — `Beginners_Restricted_Contacts`** (safeguarding lead only): student contact requests (STU_G08 / STU_L08) with school_code, submission_id, contact details, purpose, status.

## 6. API (Apps Script `doGet` / `doPost`, JSON over `text/plain`)

| Action | Caller | Purpose |
|---|---|---|
| `school_info?s=<token>` | Public link | Returns only status (active/not active), classes offered and available instrument versions. **Never the school name, code, district or contacts** (DEC-23). |
| `submit` | Public link | Validates token, active status, window, instrument, idempotency and every answer against the instrument JSON, then appends the row. Returns `{ok, submission_id}`. |
| `register`, `update`, `set_status` (activate / pause / close), `regenerate_token`, `list`, QR | Staff only, from the *School admin* dialog in the spreadsheet (DEC-26); not on the public URL | School management |
| `export` | Admin only | Per-version CSV with value labels + codebook |

## 7. Security and privacy (minimum bar)

- Use an **organisation-owned Google Workspace account** for the Sheets and the script.
- The research instruments collect no student names. The school comes from the link.
- School tokens are long random strings kept only in `Schools`, never in the repo. They can be regenerated.
- Admin functions require a Google sign-in on an allow-list. They are never exposed through the public endpoint.
- Apps Script re-validates every submission and never trusts the client. Rate limiting per token via `CacheService`.
- A school cannot become `ACTIVE` without a safeguarding lead and referral contact (instruments with `safeguarding_required`).
- The public GitHub repo holds code and instrument JSON only.

## 8. Repository layout

```
/web                       Vite + TypeScript app: landing/routing, renderer, logic engine, offline queue, i18n strings
/web/public/instruments    deployable instrument JSON (copied from /questionnaires at build time)
/apps-script               public API + admin web app (clasp-managed), README with deploy steps
/questionnaires /schemas /docs /data_dictionary /research   (existing)
/.github/workflows/pages.yml
```

## 9. Build order

1. **M1 — Renderer:** load any instrument JSON; all question types, branching, exclusivity, max-select, specify, validation, local save/resume, mobile-first. Tests over all four deployable instruments.
2. **M2 — School registration + links:** admin page, `Schools`/`School_Contacts` tabs, code/token generation, QR codes, activation rules, landing page routing by role and class.
3. **M3 — Submission:** offline queue, `submit` endpoint, wide-row writer, idempotency, restricted contacts, audit log. End-to-end test on a test spreadsheet.
4. **M4 — Monitoring and exports:** response counts per school/instrument, CSV + codebook export.
5. **M5 — Assessments (`kind: assessment`):** item bank, scoring engine, report templates, using the same renderer and upload path.
