/**
 * M4: response monitoring and research exports. Pure logic (tested locally); the Google-side
 * reading and writing is in Admin.js. Admin only: reached from the School admin dialog.
 */

/**
 * Response counts per school and instrument version.
 * schools: Schools tab rows. tabs: { versionId: [{ school_code, received_at, flags }] }.
 */
function summarizeResponses(schools, tabs) {
  var versions = Object.keys(tabs).sort();
  var bySchool = {};
  schools.forEach(function (s) {
    bySchool[str_(s.school_code)] = {
      school_code: str_(s.school_code), name: str_(s.name), district: str_(s.district), status: str_(s.status),
      counts: {}, total: 0, flagged: 0, last_received: '',
    };
  });
  var totals = {};
  var unknown = 0;
  versions.forEach(function (v) {
    totals[v] = 0;
    tabs[v].forEach(function (r) {
      totals[v]++;
      var s = bySchool[str_(r.school_code)];
      if (!s) { unknown++; return; }
      s.counts[v] = (s.counts[v] || 0) + 1;
      s.total++;
      if (str_(r.flags)) s.flagged++;
      var at = str_(r.received_at);
      if (at > s.last_received) s.last_received = at;
    });
  });
  var rows = Object.keys(bySchool).map(function (k) { return bySchool[k]; })
    .sort(function (a, b) { return a.school_code < b.school_code ? -1 : 1; });
  var all = 0;
  versions.forEach(function (v) { all += totals[v]; });
  return { versions: versions, schools: rows, totals: totals, total: all, unknown_school_rows: unknown };
}

/**
 * Builds the tables of one research export. Rows whose research-use answer is not a "yes"
 * code are left out (DEC-30); instruments without a research-use question keep every row.
 * Every cell is made formula-safe again, because Sheets returns '=…' text without its apostrophe.
 */
function prepareExport(versionId, headers, rows, entry, engine) {
  var permCol = headers.indexOf('research_permission');
  var yes = entry.research_permission_yes;
  var included = [];
  var excluded = 0;
  rows.forEach(function (r) {
    if (yes && yes.length) {
      var v = permCol >= 0 ? str_(r[permCol]) : '';
      if (!yes.some(function (c) { return String(c) === v; })) { excluded++; return; }
    }
    included.push(r);
  });
  var safe = function (row) { return row.map(function (v) { return safeCell_(v === null || v === undefined ? '' : v); }); };
  var label = engine.makeLabeller(entry.instrument);
  return {
    data_codes: [headers].concat(included.map(safe)),
    data_labels: [headers].concat(included.map(function (r) { return safe(label(headers, r)); })),
    codebook: engine.buildCodebook(entry.instrument, { systemFilled: Object.keys(entry.system_fill || {}) }).map(safe),
    status_tokens: [['token', 'meaning']].concat(engine.STATUS_TOKENS.map(function (t) { return [t[0], t[1]]; })),
    included: included.length,
    excluded_no_permission: excluded,
  };
}

if (typeof module !== 'undefined') {
  module.exports = { summarizeResponses: summarizeResponses, prepareExport: prepareExport };
}
