/**
 * Google Sheets implementation of the small table interface used by Core.js:
 * read(tab), append(tab, obj), update(tab, keyField, keyValue, patch).
 * Row 1 of every tab holds the column names (HEADERS in Core.js).
 */

function spreadsheet_() {
  // The script is bound to the research spreadsheet (Extensions → Apps Script), which also
  // keeps its permission to "this spreadsheet only" (spreadsheets.currentonly).
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This script must be bound to the research spreadsheet.');
  return ss;
}

function sheetDb_() {
  var ss = spreadsheet_();
  var cache = {};

  function sheet(tab) {
    var sh = ss.getSheetByName(tab);
    if (!sh) throw new Error('Tab "' + tab + '" is missing. Run "The Beginners → Set up / repair tabs".');
    return sh;
  }
  function load(tab) {
    if (cache[tab]) return cache[tab];
    var values = sheet(tab).getDataRange().getValues();
    var headers = (values[0] || []).map(String);
    var rows = [];
    for (var r = 1; r < values.length; r++) {
      var obj = {};
      var empty = true;
      for (var c = 0; c < headers.length; c++) {
        obj[headers[c]] = values[r][c];
        if (values[r][c] !== '' && values[r][c] !== null) empty = false;
      }
      if (!empty) { obj.__row = r + 1; rows.push(obj); }
    }
    cache[tab] = { headers: headers, rows: rows };
    return cache[tab];
  }

  return {
    read: function (tab) {
      return load(tab).rows.map(function (r) { var o = {}; for (var k in r) if (k !== '__row') o[k] = r[k]; return o; });
    },
    append: function (tab, obj) {
      var headers = load(tab).headers;
      sheet(tab).appendRow(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
      delete cache[tab];
    },
    update: function (tab, keyField, keyValue, patch) {
      var t = load(tab);
      var row = t.rows.filter(function (r) { return String(r[keyField]).trim() === String(keyValue); })[0];
      if (!row) return false;
      var sh = sheet(tab);
      Object.keys(patch).forEach(function (k) {
        var col = t.headers.indexOf(k);
        if (col >= 0) sh.getRange(row.__row, col + 1).setValue(patch[k]);
      });
      delete cache[tab];
      return true;
    },
  };
}

/** Creates any missing tab with its header row. Never edits a tab that already has data. */
function setupTabs_() {
  var ss = spreadsheet_();
  var report = [];
  Object.keys(HEADERS).forEach(function (tab) {
    var headers = HEADERS[tab];
    var sh = ss.getSheetByName(tab);
    if (!sh) {
      sh = ss.insertSheet(tab);
      report.push('Created ' + tab);
    }
    var first = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
    if (sh.getLastRow() === 0 || first.join('') === '') {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
      // Plain text everywhere: keeps UDISE codes, tokens, class lists and dates exactly as written.
      sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
    } else {
      var missing = headers.filter(function (h) { return first.indexOf(h) < 0; });
      if (missing.length) report.push(tab + ' is missing columns: ' + missing.join(', ') + ' (not changed; please fix by hand)');
    }
  });

  var config = ss.getSheetByName(TAB.CONFIG);
  if (config.getLastRow() <= 1) {
    var rows = DEFAULT_CONFIG.map(function (r) { return HEADERS.Config.map(function (h) { return r[h]; }); });
    config.getRange(2, 1, rows.length, HEADERS.Config.length).setValues(rows);
    report.push('Filled Config with the four deployable instruments');
  }

  // Contacts are restricted: hidden, and protected so only the owner can edit.
  var contacts = ss.getSheetByName(TAB.CONTACTS);
  contacts.hideSheet();
  if (contacts.getProtections(SpreadsheetApp.ProtectionType.SHEET).length === 0) {
    var p = contacts.protect().setDescription('Restricted: school and safeguarding contacts');
    p.removeEditors(p.getEditors());
    if (p.canDomainEdit()) p.setDomainEdit(false);
    report.push('Protected School_Contacts');
  }
  var audit = ss.getSheetByName(TAB.AUDIT);
  if (audit.getProtections(SpreadsheetApp.ProtectionType.SHEET).length === 0) {
    audit.protect().setDescription('Audit log: written by the script').setWarningOnly(true);
  }
  report.push(ensureRestrictedSpreadsheet_());
  return report;
}

/**
 * Spreadsheet B (docs/22 §5): student contact requests, kept apart from the research data.
 * Created by setupTabs_ and owned by the script owner only; share it with the safeguarding
 * lead alone. Its ID is in Script property RESTRICTED_SPREADSHEET_ID.
 */
function restrictedSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('RESTRICTED_SPREADSHEET_ID');
  if (!id) throw new Error('Restricted contacts spreadsheet missing. Run "The Beginners → Set up / repair tabs".');
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName('Contact_Requests');
  if (!sh) {
    sh = ss.insertSheet('Contact_Requests');
    sh.getRange(1, 1, 1, CONTACT_REQUEST_HEADERS.length).setValues([CONTACT_REQUEST_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureRestrictedSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('RESTRICTED_SPREADSHEET_ID');
  if (id) {
    try { SpreadsheetApp.openById(id); restrictedSheet_(); return 'Restricted contacts spreadsheet already set up.'; } catch (e) { /* recreate below */ }
  }
  var ss = SpreadsheetApp.create('Beginners_Restricted_Contacts');
  props.setProperty('RESTRICTED_SPREADSHEET_ID', ss.getId());
  var first = ss.getSheets()[0];
  first.setName('Contact_Requests');
  first.getRange(1, 1, 1, CONTACT_REQUEST_HEADERS.length).setValues([CONTACT_REQUEST_HEADERS]).setFontWeight('bold');
  first.setFrozenRows(1);
  return 'Created "Beginners_Restricted_Contacts" (only you can open it; share it with the safeguarding lead only).';
}
