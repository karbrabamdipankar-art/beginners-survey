/**
 * Public web app endpoint (deploy: Execute as "Me", Who has access "Anyone").
 * GET ?action=school_info&s=<token> → status, classes and instrument versions only (DEC-23).
 * The submit action (doPost) arrives in M3. Admin functions are never reachable from here:
 * they run only inside the spreadsheet (Admin.js), for allow-listed staff.
 */

var SCHOOL_INFO_CACHE_SECONDS = 120;

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (p.action === 'school_info') out = cachedSchoolInfo_(p.s);
    else out = { ok: false, error: 'unknown_action' };
  } catch (err) {
    console.error(err);
    out = { ok: false, error: 'server_error' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * A whole class opens the link at once, so answers are cached briefly per token. Admin
 * changes to a school clear its entry (Admin.js), so pauses and new links act at once.
 */
function cachedSchoolInfo_(token) {
  token = String(token || '').trim();
  if (!TOKEN_PATTERN.test(token)) return { ok: true, status: 'unavailable' };
  var cache = CacheService.getScriptCache();
  var key = 'si:' + token;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var db = sheetDb_();
  var info = schoolInfo(token, {
    findSchoolByToken: function (t) {
      return db.read(TAB.SCHOOLS).filter(function (s) { return String(s.school_token).trim() === t; })[0] || null;
    },
    readConfig: function () { return db.read(TAB.CONFIG); },
    now: function () { return new Date(); },
  });
  cache.put(key, JSON.stringify(info), SCHOOL_INFO_CACHE_SECONDS);
  return info;
}

/* ------------------------------------------------------------------ submit (M3) */

/**
 * POST (Content-Type text/plain, so browsers send it without a CORS preflight):
 * {"action":"submit", "s": token, "submission_id", "instrument_version_id", "answers", ...}
 */
function doPost(e) {
  var out;
  try {
    var body = (e && e.postData && e.postData.contents) || '';
    if (body.length > MAX_BODY_CHARS) out = { ok: false, error: 'too_large', retry: false };
    else {
      var payload = null;
      try { payload = JSON.parse(body); } catch (parseErr) { payload = null; }
      if (!payload || payload.action !== 'submit') out = { ok: false, error: 'bad_request', retry: false };
      else out = processSubmission(payload, submitDeps_());
    }
  } catch (err) {
    console.error(err);
    out = { ok: false, error: 'server_error', retry: true };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function submitDeps_() {
  var db = sheetDb_();
  var ss = spreadsheet_();
  var cache = CacheService.getScriptCache();
  return {
    findSchoolByToken: function (t) {
      return db.read(TAB.SCHOOLS).filter(function (s) { return String(s.school_token).trim() === t; })[0] || null;
    },
    readConfig: function () { return db.read(TAB.CONFIG); },
    registry: INSTRUMENT_REGISTRY,
    engine: BeginnersEngine,
    now: function () { return new Date(); },
    rateOk: function (token) {
      var key = 'rl:' + token;
      var n = Number(cache.get(key) || 0) + 1;
      cache.put(key, String(n), 600);
      return n <= RATE_LIMIT_PER_10_MIN;
    },
    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(20000)) throw new Error('busy');
      try { return fn(); } finally { lock.releaseLock(); }
    },
    ensureTab: function (tab, headers) {
      var sh = ss.getSheetByName(tab);
      if (!sh) {
        sh = ss.insertSheet(tab);
        if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
        sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
        sh.setFrozenRows(1);
        db.append(TAB.AUDIT, { timestamp: new Date().toISOString(), event: 'create_tab', school_code: '', submission_id: '', actor: 'system', detail: tab });
        return true;
      }
      var have = sh.getRange(1, 1, 1, headers.length).getValues()[0].map(String);
      if (have.join('\u0001') !== headers.join('\u0001')) throw new Error('Header mismatch in ' + tab);
      return true;
    },
    tabHasSubmission: function (tab, id) {
      var sh = ss.getSheetByName(tab);
      if (!sh || sh.getLastRow() < 2) return false;
      return !!sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
    },
    appendRow: function (tab, cells) { ss.getSheetByName(tab).appendRow(cells); },
    appendContactRequests: function (rows) {
      var sh = restrictedSheet_();
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    },
    audit: function (event, schoolCode, submissionId, detail) {
      db.append(TAB.AUDIT, { timestamp: new Date().toISOString(), event: event, school_code: schoolCode, submission_id: submissionId, actor: 'public', detail: detail || '' });
    },
  };
}
