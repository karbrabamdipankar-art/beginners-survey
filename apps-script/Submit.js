/**
 * The `submit` action (M3): one finished response → one row in R_<instrument_version_id>.
 *
 * Pure logic, written against injected `deps` so it runs in Apps Script and in the Node
 * tests. Order: cheap checks → school and instrument → re-check every answer with the
 * shared engine (BeginnersEngine, generated) → under one lock: duplicate check + append.
 *
 * Responses that are structurally wrong or for a school that is not accepting responses are
 * refused (retry: false). Answer-level problems never lose a response: they are stored as
 * #INVALID / flagged (DEC-29). Server trouble answers retry: true so the app tries again.
 */

var SYSTEM_COLUMNS = ['submission_id', 'school_code', 'instrument_version_id', 'respondent_type', 'route_class', 'consent', 'assent',
  'research_permission', 'started_at', 'submitted_at', 'received_at', 'client_app_version', 'duration_sec', 'flags'];

var CONTACT_REQUEST_HEADERS = ['received_at', 'school_code', 'submission_id', 'instrument_version_id', 'question_id', 'variable',
  'answer_status', 'answer_code', 'answer_label', 'follow_up_status', 'notes'];

var MAX_BODY_CHARS = 200000;
/** A finished response may still arrive this many days after the survey window closes (offline phones). */
var LATE_SYNC_GRACE_DAYS = 14;
/** Per school link: at most this many submissions in 10 minutes (a whole school at once is fine). */
var RATE_LIMIT_PER_10_MIN = 600;

var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function refuse_(error) { return { ok: false, error: error, retry: false }; }
function tryLater_(error) { return { ok: false, error: error, retry: true }; }

function isoOrEmpty_(v) {
  var s = String(v == null ? '' : v);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) ? s : '';
}

/** Text that Sheets would read as a formula is stored as plain text. */
function safeCell_(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function addDays_(yyyyMmDd, days) {
  var d = new Date(yyyyMmDd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * deps:
 *   findSchoolByToken(token) → school row | null      readConfig() → Config rows
 *   registry                → INSTRUMENT_REGISTRY      engine → BeginnersEngine
 *   now() → Date                                      rateOk(token) → boolean
 *   withLock(fn) → fn() result, or throws 'busy'      tabHasSubmission(tab, id) → boolean
 *   ensureTab(tab, headers) → true, or throws          appendRow(tab, cells)
 *   appendContactRequests(rows)                        audit(event, schoolCode, submissionId, detail)
 */
function processSubmission(payload, deps) {
  if (!payload || typeof payload !== 'object') return refuse_('bad_request');
  var token = str_(payload.s);
  var id = str_(payload.submission_id).toLowerCase();
  var versionId = str_(payload.instrument_version_id);
  if (!TOKEN_PATTERN.test(token) || !UUID_PATTERN.test(id) || !versionId) return refuse_('bad_request');
  if (!deps.rateOk(token)) return tryLater_('rate_limited');

  // School: must exist and be ACTIVE. Never say why to the client beyond "unavailable".
  var school = deps.findSchoolByToken(token);
  if (!school || str_(school.status) !== 'ACTIVE') {
    deps.audit('reject', school ? str_(school.school_code) : '', id, 'school not active');
    return refuse_('unavailable');
  }
  var code = str_(school.school_code);
  var now = deps.now();
  var today = istDate_(now);
  var opens = normalizeDate_(school.survey_opens);
  var closes = normalizeDate_(school.survey_closes);
  var flags = [];
  if (opens && opens !== 'INVALID' && today < opens) {
    deps.audit('reject', code, id, 'before survey window');
    return refuse_('not_yet_open');
  }
  if (closes && closes !== 'INVALID' && today > closes) {
    var finished = isoOrEmpty_(payload.finished_at);
    var finishedDay = finished ? istDate_(new Date(finished)) : '';
    if (!finishedDay || finishedDay > closes || today > addDays_(closes, LATE_SYNC_GRACE_DAYS)) {
      deps.audit('reject', code, id, 'after survey window');
      return refuse_('closed');
    }
    flags.push('LATE_SYNC');
  }

  // Instrument: deployed, active in Config, and offered by this school.
  var entry = deps.registry[versionId];
  var allowed = instrumentsForSchool(school, deps.readConfig()).some(function (r) { return str_(r.instrument_version_id) === versionId; });
  if (!entry || !allowed) {
    deps.audit('reject', code, id, 'instrument not offered: ' + versionId.slice(0, 40));
    return refuse_('instrument_not_allowed');
  }
  var inst = entry.instrument;
  if (inst.settings.consent_required && payload.consent !== 'yes') {
    deps.audit('reject', code, id, 'no consent');
    return refuse_('no_consent');
  }

  var routeRole = str_(payload.route_role);
  var routeClass = str_(payload.route_class).slice(0, 10);
  if (routeRole && routeRole !== inst.respondent_type) flags.push('ROUTE_ROLE_MISMATCH');

  var prepared = deps.engine.prepareSubmission(inst, payload.answers, {
    systemFilled: Object.keys(entry.system_fill || {}),
    routeCheck: entry.route_check || undefined,
    routeClass: routeClass || undefined,
  });
  flags = flags.concat(prepared.flags);

  // #SYSTEM_FILLED → the value the server knows (DEC-24). Only school_code exists today.
  Object.keys(entry.system_fill || {}).forEach(function (qid) {
    var q = null;
    inst.sections.forEach(function (s) { s.questions.forEach(function (x) { if (x.id === qid) q = x; }); });
    if (q && prepared.row[q.variable] === '#SYSTEM_FILLED' && entry.system_fill[qid] === 'school_code') prepared.row[q.variable] = code;
  });

  var started = isoOrEmpty_(payload.started_at);
  var submitted = isoOrEmpty_(payload.finished_at);
  var duration = started && submitted ? Math.round((Date.parse(submitted) - Date.parse(started)) / 1000) : '';
  if (duration !== '' && (duration < 0 || duration > 30 * 24 * 3600)) { flags.push('ODD_DURATION'); duration = ''; }

  var system = {
    submission_id: id,
    school_code: code,
    instrument_version_id: versionId,
    respondent_type: inst.respondent_type,
    route_class: routeClass || '#NOT_APPLICABLE',
    consent: inst.settings.consent_required ? 'yes' : '#NOT_APPLICABLE',
    assent: inst.settings.assent_required ? 'yes' : '#NOT_APPLICABLE',
    research_permission: prepared.research_permission === null ? '#NOT_APPLICABLE' : prepared.research_permission,
    started_at: started,
    submitted_at: submitted,
    received_at: now.toISOString(),
    client_app_version: str_(payload.client_app_version).slice(0, 20),
    duration_sec: duration,
    flags: flags.join(' ').slice(0, 5000),
  };
  var headers = SYSTEM_COLUMNS.concat(prepared.columns);
  var cells = headers.map(function (h) {
    var v = h in system ? system[h] : prepared.row[h];
    return safeCell_(v === undefined ? '' : v);
  });
  var tab = 'R_' + versionId;

  var contactRows = prepared.restricted
    .filter(function (r) { return r.status !== 'NOT_DISPLAYED' && r.status !== 'SKIPPED'; })
    .map(function (r) {
      return [now.toISOString(), code, id, versionId, r.question_id, r.variable, r.status, r.code === null ? '' : r.code, r.label, 'NEW', ''].map(safeCell_);
    });

  try {
    return deps.withLock(function () {
      deps.ensureTab(tab, headers);
      if (deps.tabHasSubmission(tab, id)) return { ok: true, submission_id: id, duplicate: true };
      deps.appendRow(tab, cells);
      if (contactRows.length) deps.appendContactRequests(contactRows);
      deps.audit('submit', code, id, flags.length ? flags.length + ' flag(s)' : '');
      return { ok: true, submission_id: id };
    });
  } catch (err) {
    if (String(err && err.message || err) === 'busy') return tryLater_('busy');
    throw err;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { processSubmission: processSubmission, SYSTEM_COLUMNS: SYSTEM_COLUMNS, CONTACT_REQUEST_HEADERS: CONTACT_REQUEST_HEADERS, safeCell_: safeCell_ };
}
