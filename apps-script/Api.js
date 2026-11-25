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
