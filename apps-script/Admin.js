/**
 * Staff admin, inside the research spreadsheet (DEC-26). Only people the spreadsheet is
 * shared with can open it, and every admin call also checks the ADMIN_EMAILS allow-list
 * in Script properties. Nothing here is reachable from the public web app URL.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('The Beginners')
    .addItem('School admin', 'openSchoolAdmin')
    .addSeparator()
    .addItem('Set up / repair tabs', 'setupTabs')
    .addToUi();
}

function openSchoolAdmin() {
  requireAdmin_();
  var html = HtmlService.createHtmlOutputFromFile('AdminDialog').setWidth(1100).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, 'School admin');
}

function setupTabs() {
  requireAdmin_();
  var report = setupTabs_();
  SpreadsheetApp.getUi().alert('Set up', report.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

function requireAdmin_() {
  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var allowed = String(PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '')
    .toLowerCase().split(/[,;\s]+/).filter(function (x) { return x; });
  if (!email || allowed.indexOf(email) < 0) {
    throw new Error('Your Google account is not on the admin list (ADMIN_EMAILS). Ask the project lead to add it.');
  }
  return email;
}

function withRegistry_(fn) {
  var actor = requireAdmin_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var db = sheetDb_();
    var registry = makeRegistry(db, {
      now: function () { return new Date(); },
      uuid: function () { return Utilities.getUuid(); },
      actor: actor,
      siteUrl: PropertiesService.getScriptProperties().getProperty('SITE_URL') || '',
    });
    return fn(registry, db);
  } finally {
    lock.releaseLock();
  }
}

/** Clears the cached public answer for a school, so status and link changes act at once. */
function forgetSchoolInfo_(db, code) {
  var s = db.read(TAB.SCHOOLS).filter(function (r) { return String(r.school_code) === code; })[0];
  if (s) CacheService.getScriptCache().remove('si:' + String(s.school_token).trim());
}

/* ----- functions called from AdminDialog.html with google.script.run ----- */

function adminBootstrap() {
  return withRegistry_(function (registry) {
    return {
      schools: registry.list(),
      options: { districts: DISTRICTS.map(function (d) { return d.name; }), areas: AREA_TYPES, management: MANAGEMENT_TYPES, streams: STREAMS, classes: CLASSES },
      siteUrlSet: !!PropertiesService.getScriptProperties().getProperty('SITE_URL'),
    };
  });
}

function adminRegister(form) {
  return withRegistry_(function (registry) { return registry.register(form); });
}

function adminUpdate(code, form) {
  return withRegistry_(function (registry, db) {
    forgetSchoolInfo_(db, code);
    return registry.update(code, form);
  });
}

function adminSetStatus(code, status) {
  return withRegistry_(function (registry, db) {
    forgetSchoolInfo_(db, code);
    return registry.setStatus(code, status);
  });
}

function adminRegenerateToken(code) {
  return withRegistry_(function (registry, db) {
    forgetSchoolInfo_(db, code); // the old link stops working immediately
    return registry.regenerateToken(code);
  });
}

/* ----- M4: monitoring and exports (admin only) ----- */

/** Every R_<version> tab: headers and data rows (row 1 = headers). */
function readResponseTabs_() {
  var out = {};
  spreadsheet_().getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf('R_') !== 0) return;
    var values = sh.getLastRow() > 0 ? sh.getDataRange().getValues() : [[]];
    out[name.slice(2)] = { headers: values[0].map(String), rows: values.slice(1).filter(function (r) { return String(r[0]) !== ''; }) };
  });
  return out;
}

function adminResponseSummary() {
  requireAdmin_();
  var tabs = readResponseTabs_();
  var slim = {};
  Object.keys(tabs).forEach(function (v) {
    var h = tabs[v].headers;
    var c = h.indexOf('school_code'), r = h.indexOf('received_at'), f = h.indexOf('flags');
    slim[v] = tabs[v].rows.map(function (row) { return { school_code: row[c], received_at: row[r], flags: row[f] }; });
  });
  var summary = summarizeResponses(sheetDb_().read(TAB.SCHOOLS), slim);
  summary.generated_at = new Date().toISOString();
  return summary;
}

/**
 * Creates a new spreadsheet in the owner's Drive with the research export of one instrument
 * version: data_codes, data_labels, codebook, status_tokens, about. Private by default.
 * Download any tab as CSV with File → Download → CSV.
 */
function adminExport(versionId) {
  var actor = requireAdmin_();
  var entry = INSTRUMENT_REGISTRY[versionId];
  if (!entry) return { ok: false, message: 'Unknown instrument version.' };
  var tab = readResponseTabs_()[versionId];
  if (!tab || tab.rows.length === 0) return { ok: false, message: 'There are no responses for ' + versionId + ' yet.' };
  var ex = prepareExport(versionId, tab.headers, tab.rows, entry, BeginnersEngine);
  var now = new Date();
  var stamp = Utilities.formatDate(now, 'Asia/Kolkata', 'yyyy-MM-dd HHmm');
  var ss = SpreadsheetApp.create('Beginners_Export_' + versionId + '_' + stamp);
  var write = function (name, rows, first) {
    var sh = first ? ss.getSheets()[0].setName(name) : ss.insertSheet(name);
    var width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
    if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    var padded = rows.map(function (r) { while (r.length < width) r.push(''); return r; });
    for (var i = 0; i < padded.length; i += 5000) {
      var chunk = padded.slice(i, i + 5000);
      sh.getRange(i + 1, 1, chunk.length, width).setValues(chunk);
    }
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, width).setFontWeight('bold');
  };
  write('about', [
    ['item', 'value'],
    ['instrument_version_id', versionId],
    ['generated_at', now.toISOString()],
    ['generated_by', actor],
    ['rows_in_R_tab', tab.rows.length],
    ['rows_exported', ex.included],
    ['rows_left_out_no_research_permission', ex.excluded_no_permission],
    ['rule', 'Only responses whose research-use answer is "yes" are exported; instruments without that question export every row (DEC-30).'],
    ['contact_requests', 'Not included. Support-contact answers live only in the restricted contacts spreadsheet.'],
    ['csv', 'File > Download > Comma-separated values exports the tab you are looking at.'],
  ], true);
  write('data_codes', ex.data_codes);
  write('data_labels', ex.data_labels);
  write('codebook', ex.codebook);
  write('status_tokens', ex.status_tokens);
  sheetDb_().append(TAB.AUDIT, { timestamp: now.toISOString(), event: 'export', school_code: '', submission_id: '', actor: actor,
    detail: versionId + ': ' + ex.included + ' rows exported, ' + ex.excluded_no_permission + ' left out' });
  return { ok: true, url: ss.getUrl(), name: ss.getName(), included: ex.included, excluded: ex.excluded_no_permission };
}

function adminListInstruments() {
  requireAdmin_();
  return Object.keys(INSTRUMENT_REGISTRY).map(function (k) { return { id: k, title: INSTRUMENT_REGISTRY[k].instrument.title }; });
}
