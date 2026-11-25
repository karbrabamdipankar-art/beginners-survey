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
