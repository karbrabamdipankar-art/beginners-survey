# 21 — Instrument Definition Format (`beginners.instrument/1`)

| Field | Value |
|---|---|
| Version | 1.0 |
| Date | 2026-11-22 |
| Status | APPROVED (under delegated authority, DEC-19) |
| Owner | The Beginners · prepared by Claude |
| Dependencies | schemas/instrument.schema.json; questionnaires/*/<ID>_V*.json |

## Purpose

This is the single format the platform uses to load **any** instrument: the four research surveys now, and later the career and academic psychometric tests you will upload when a new test is created. Screens, validation, branching, storage and exports are all driven from this file. Nothing about a specific questionnaire is hard-coded in the software.

## Structure

```
instrument
├─ format            "beginners.instrument/1"
├─ kind              survey | assessment
├─ instrument_id     e.g. STU_7_10          (stable across versions)
├─ version           e.g. 1.1
├─ instrument_version_id  STU_7_10_V1.1     (what every response is stored against)
├─ status            DRAFT | APPROVED_BASELINE_ARCHIVE | APPROVED_FOR_PILOT | APPROVED_FOR_FIELDWORK | RETIRED
├─ approval          approved_by, approved_on, basis
├─ wording_origin    SOURCE_VERBATIM | SOURCE_VERBATIM_WITH_LOGGED_CORRECTIONS | DRAFTED_FROM_FOCUS_REGISTER
├─ settings          consent_required, assent_required, safeguarding_required,
│                    research_permission_gate, contact_request_questions, answer_statuses, estimated_minutes
├─ change_log[]      question_id, change_type, detail
├─ sections[]
│   └─ code, title, notice (platform text for sensitive sections)
│       └─ questions[]
│           id         source question ID, verbatim (STU-A01 / STU_A01)
│           uid        globally unique: <INSTRUMENT_ID>.<id with - → _>
│           variable   snake_case analysis name (unique within instrument)
│           text       respondent-facing wording
│           type       single | multi | text | number | matrix
│           required   true/false (skipping records answer_status SKIPPED)
│           options[]  code, label, role, exclusive, specify
│           options_from  {q, use:"selected"} — options are the answers given to q
│           rows[]     matrix only: variable, uid, label (each row = its own variable)
│           max_select, ordinal, validation, show_if
│           sensitivity, scoring_category, constructs[]
├─ scoring           (assessment only — reserved)
└─ report            (assessment only — reserved)
```

### Option roles and codes (DEC-06)

| Role | Code | Behaviour |
|---|---|---|
| VALUE | 1…n (stable across versions; new options take the next free code) | Substantive answer |
| NONE_EXCLUSIVE | 0 | Clears and blocks all other selections in a multi-select |
| VARIES_DEPENDS | 95 | Kept out of ordinal analysis |
| OTHER | 96 | Opens a specify box stored as `<variable>_other_text` |
| NOT_SURE | 97 | Also recorded as answer_status NOT_SURE; exclusive in multi-selects |
| PREFER_NOT_TO_ANSWER | 98 | Also recorded as answer_status PREFER_NOT_TO_ANSWER |
| NOT_APPLICABLE | 99 | Also recorded as answer_status NOT_APPLICABLE |

Display order is never assumed to be semantic order. Analysis recodes direction explicitly.

### Conditions (`show_if`)

`{"q": "STU_B01", "in": [1]}` · `{"all": [ … ]}` · `{"any": [ … ]}`. A hidden question is stored with answer_status `NOT_DISPLAYED`, never as zero, "No" or missing (STU_11_12 LOG-23).

## Platform rules attached to the format

1. Every response row stores `instrument_version_id`, `question_uid`, `variable`, `code(s)`, `text_value` and `answer_status`.
2. A campaign cannot go live with an instrument whose `safeguarding_required` is true until a safeguarding lead and referral contact are configured for that campaign.
3. A consent/assent screen is shown before the first section whenever `consent_required` is true.
4. Answers to `contact_request_questions` are written to a restricted contact table, not the research dataset.
5. `NOT_SCORABLE` and `HIGHLY_SENSITIVE` items are never included in any computed score.
6. An approved version is immutable. Any change creates a new version with a change-log entry.

## Reserved for psychometric tests (`kind: assessment`) — to be specified in Phase 6

`scoring`: scales (item lists, keys, reverse-scored items, scoring method), validation evidence status, norm-set references.
`report`: report template ID and version, allowed audiences, interpretation bands tied to an approved scoring version.
Uploading a new test = uploading one file in this format plus its scoring and report blocks, which the platform validates against the schema before it can be approved.
