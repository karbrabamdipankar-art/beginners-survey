# /apps-script — school registry and public API

One Apps Script project, **bound to the research spreadsheet** `Beginners_Research_Data`.

| File | What it does |
|---|---|
| `Core.js` | All logic: form checks, school codes, 256-bit tokens, activation rule, `school_info`. No Google services, so it is tested locally. |
| `Store.js` | Reads and writes the tabs; `setupTabs_` creates them. |
| `Api.js` | Public web app: `GET ?action=school_info&s=<token>` and `POST {action:"submit"}` (Google-side glue). |
| `Submit.js` | The submit rules: refusals, re-checking answers, duplicate check, row and contact-request building (DEC-29). Tested locally. |
| `Engine.js`, `Instruments.js` | **Generated** by `npm run apps-script` in `/web` (the app's logic engine and the deployable instruments). Git-ignored; regenerate before every `clasp push`. |
| `Admin.js` + `AdminDialog.html` | Staff admin inside the spreadsheet (menu **The Beginners → School admin**). Allow-listed accounts only (DEC-26). |
| `test/core.test.mjs` | `node --test "apps-script/test/*.test.mjs"` (also runs in GitHub Actions). |

## First-time setup (about 15 minutes)

Use the **organisation Google Workspace account**, not a personal Gmail.

1. **Spreadsheet.** In Google Drive, create a spreadsheet named `Beginners_Research_Data`. Share it only with named research staff.
2. **Script.** In the spreadsheet: *Extensions → Apps Script*. Delete the sample `Code.gs`. Add one script file per `.js` file here (same names; `.gs` is fine), and an HTML file named `AdminDialog`. Paste the contents. In *Project Settings*, tick "Show appsscript.json" and paste `appsscript.json`.
   - Or with [clasp](https://github.com/google/clasp): `clasp clone <scriptId>` into this folder, then `clasp push`. Do not commit `.clasp.json` or `.clasprc.json`.
3. **Script properties** (*Project Settings → Script properties*):
   - `ADMIN_EMAILS`: comma-separated Google accounts allowed to register schools.
   - `SITE_URL`: the GitHub Pages address, e.g. `https://<org>.github.io/<repo>/`.
4. **Tabs.** Reload the spreadsheet. Menu *The Beginners → Set up / repair tabs*. Approve the permissions (this spreadsheet only, the dialog, your email). This creates `Schools`, `School_Contacts` (hidden, protected), `Audit`, `Config` (filled with the four instruments).
5. **Public web app.** *Deploy → New deployment → Web app*. Execute as: **Me**. Who has access: **Anyone**. Copy the URL ending in `/exec`.
6. **Connect the site.** In the GitHub repository: *Settings → Secrets and variables → Actions → Variables → New variable* `API_URL` = the `/exec` URL. Re-run the Pages workflow.
7. **Check.** Register a test school with safeguarding contacts, open its link on a phone: you should see "Are you a student or a teacher?" and never the school name. Then *Close* the test school.

After code changes: *Deploy → Manage deployments → Edit → New version*, so the `/exec` URL stays the same.

### Updating with clasp (how the pilot was deployed, 2026-11-25)

The pilot script was created and is updated from this folder with Google's clasp tool (needs "Google Apps Script API" ON at script.google.com/home/usersettings, and `npx @google/clasp@3.3.0 login` once). `.clasp.json` (script ID) stays on the project PC and is git-ignored; `.claspignore` keeps tests out of uploads.

```
cd ../web && npm run apps-script && cd ../apps-script   # regenerate Engine.js + Instruments.js
npx @google/clasp@3.3.0 push --force
npx @google/clasp@3.3.0 create-deployment --deploymentId <live deployment ID> --description "what changed"
```

Always pass `--deploymentId` with the live deployment ID (shown in *Deploy → Manage deployments*): a new deployment would get a new `/exec` URL and the site's `API_URL` would have to change. Note: `clasp create` replaces `appsscript.json` with Google's default; restore ours before pushing.

## How staff use it

*The Beginners → School admin* opens the dialog:
- **Register school**: details, school contact, safeguarding lead and referral contact. With both safeguarding contacts the school is **ACTIVE** at once; without them it stays **REGISTERED** and its link does not work.
- **Link & QR**: copy the link or download a QR code (PNG, school code printed underneath). The QR is drawn in the dialog; the link never goes to an outside QR service.
- **Pause / Close / Activate**: a paused or closed link shows "This link is not open". Changes act within seconds.
- **New link**: if a link was shared with the wrong people. The old link and QR stop working at once; the school keeps its code and data.
- **Edit**: anything except the district (the school code is based on it).

Every action is written to the `Audit` tab with the staff account and time.

## Rules this code enforces

- `school_info` returns only `status`, `classes`, `instruments`. Never name, code, district, contacts or dates (DEC-23). Unknown, paused, closed and not-yet-active tokens all return `unavailable`.
- A school whose instruments need safeguarding (`Config.safeguarding_required`) cannot be ACTIVE without a safeguarding lead (name, phone) and referral contact (name, phone). Removing them later sets it back to REGISTERED.
- Duplicate UDISE codes are refused. Tokens are 256 random bits.
- Survey dates are compared in India time; outside the window the link says not yet open / closed.
- Instruments can be paused centrally in the `Config` tab (status other than ACTIVE).

## Submissions (M3)

- Each finished response becomes one row in `R_<instrument_version_id>` (created on first use): system columns, then one column per variable, then other-text columns (docs/22 §5). Sending twice stores it once.
- Contact-request answers go to `Beginners_Restricted_Contacts` → `Contact_Requests` (created by *Set up / repair tabs*; ID in Script property `RESTRICTED_SPREADSHEET_ID`). Only the owner can open it; share it with the safeguarding lead alone.
- `Audit` records `submit`, `reject` (with reason) and `create_tab`, never answer content.
- The `flags` column lists anything for data review: `INVALID:…`, `MISSING_REQUIRED:…`, `ROUTE_CLASS_MISMATCH`, `LATE_SYNC`, `SOFT_RANGE:…`.
