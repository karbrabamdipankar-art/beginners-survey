/**
 * Core logic for school registration, school links and the public school_info call.
 *
 * Pure JavaScript: no SpreadsheetApp, LockService or Session here. Everything that touches
 * Google services is passed in (`db`, `deps`), so this file runs unchanged in Apps Script
 * and in the Node tests (apps-script/test). Apps Script shares one global scope across
 * files, so these are plain top-level declarations.
 */

/* ------------------------------------------------------------------ constants */

var DISTRICTS = [
  { name: 'East Garo Hills', abbr: 'EGH' },
  { name: 'West Garo Hills', abbr: 'WGH' },
  { name: 'North Garo Hills', abbr: 'NGH' },
  { name: 'South Garo Hills', abbr: 'SGH' },
  { name: 'South West Garo Hills', abbr: 'SWGH' },
  { name: 'East Khasi Hills', abbr: 'EKH' },
  { name: 'West Khasi Hills', abbr: 'WKH' },
  { name: 'South West Khasi Hills', abbr: 'SWKH' },
  { name: 'Eastern West Khasi Hills', abbr: 'EWKH' },
  { name: 'Ri-Bhoi', abbr: 'RB' },
  { name: 'East Jaintia Hills', abbr: 'EJH' },
  { name: 'West Jaintia Hills', abbr: 'WJH' },
];
var AREA_TYPES = ['Urban', 'Semi-urban', 'Rural', 'Remote'];
var MANAGEMENT_TYPES = ['Government', 'Government-aided', 'Private', 'Other'];
var STREAMS = ['Science', 'Commerce', 'Arts', 'Vocational'];
var CLASSES = [7, 8, 9, 10, 11, 12];
var SCHOOL_STATUSES = ['REGISTERED', 'ACTIVE', 'PAUSED', 'CLOSED'];

var TAB = { SCHOOLS: 'Schools', CONTACTS: 'School_Contacts', AUDIT: 'Audit', CONFIG: 'Config' };

var HEADERS = {
  Schools: ['school_code', 'school_token', 'name', 'udise_code', 'district', 'block_locality', 'is_shillong_city',
    'area_type', 'management', 'classes_offered', 'streams', 'status', 'survey_opens', 'survey_closes',
    'registered_by', 'registered_at', 'updated_at'],
  School_Contacts: ['school_code', 'contact_person', 'contact_phone', 'contact_email', 'safeguarding_lead_name',
    'safeguarding_lead_phone', 'referral_name', 'referral_phone', 'updated_at'],
  Audit: ['timestamp', 'event', 'school_code', 'submission_id', 'actor', 'detail'],
  Config: ['instrument_version_id', 'respondent_type', 'class_band', 'status', 'safeguarding_required', 'json_file'],
};

/** Starting registry for the Config tab: the four deployable instruments (docs/22 §5). */
var DEFAULT_CONFIG = [
  { instrument_version_id: 'STU_7_10_V1.1', respondent_type: 'student', class_band: '7;8;9;10', status: 'ACTIVE', safeguarding_required: 'TRUE', json_file: 'STU_7_10_V1.1.json' },
  { instrument_version_id: 'TCH_7_10_V1.1', respondent_type: 'teacher', class_band: '7;8;9;10', status: 'ACTIVE', safeguarding_required: 'TRUE', json_file: 'TCH_7_10_V1.1.json' },
  { instrument_version_id: 'STU_11_12_V1.0', respondent_type: 'student', class_band: '11;12', status: 'ACTIVE', safeguarding_required: 'TRUE', json_file: 'STU_11_12_V1.0.json' },
  { instrument_version_id: 'TCH_11_12_V1.1', respondent_type: 'teacher', class_band: '11;12', status: 'ACTIVE', safeguarding_required: 'TRUE', json_file: 'TCH_11_12_V1.1.json' },
];

/** Fields that must be filled before a school whose surveys need safeguarding can be ACTIVE. */
var SAFEGUARDING_FIELDS = ['safeguarding_lead_name', 'safeguarding_lead_phone', 'referral_name', 'referral_phone'];

/** 256-bit tokens, base64url: 43 characters. */
var TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/* ------------------------------------------------------------------ small helpers */

function str_(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function truthy_(v) {
  var s = str_(v).toUpperCase();
  return s === 'TRUE' || s === 'YES' || s === '1';
}

/** '7;8;11' (or a number such as 11 read back from Sheets) → [7, 8, 11] */
function parseList_(v) {
  return str_(v).split(/[;,\s]+/).filter(function (x) { return x !== ''; });
}

function parseClasses_(v) {
  return parseList_(v).map(Number).filter(function (n) { return CLASSES.indexOf(n) >= 0; }).sort(function (a, b) { return a - b; });
}

/** YYYY-MM-DD for a Date in India Standard Time (UTC+5:30), the survey's calendar. */
function istDate_(d) {
  var ist = new Date(d.getTime() + 330 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** Accepts 'YYYY-MM-DD', a Date (Sheets may convert), or blank. Returns 'YYYY-MM-DD' or ''. */
function normalizeDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : istDate_(v);
  var s = str_(v);
  if (s === '') return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : 'INVALID';
}

function districtAbbr_(name) {
  for (var i = 0; i < DISTRICTS.length; i++) if (DISTRICTS[i].name === name) return DISTRICTS[i].abbr;
  return null;
}

/* ------------------------------------------------------------------ tokens and codes */

/**
 * A new school token: 256 random bits, base64url. `uuid` must return a random v4 UUID
 * (Utilities.getUuid in Apps Script). Four UUIDs give 4 × 122 = 488 random bits; the
 * first 256 bits of their hex are used.
 */
function newToken(uuid) {
  var hex = '';
  while (hex.length < 64) {
    // Drop dashes and the fixed version/variant nibbles so only random hex remains.
    var u = String(uuid()).replace(/-/g, '');
    hex += u.slice(0, 12) + u.slice(13, 16) + u.slice(17);
  }
  hex = hex.slice(0, 64);
  var bytes = [];
  for (var i = 0; i < 64; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return base64url_(bytes);
}

function base64url_(bytes) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    if (b1 !== undefined) out += chars[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    if (b2 !== undefined) out += chars[b2 & 63];
  }
  return out;
}

/** Next sequential code for a district: ML-EKH-0001, ML-EKH-0002, … */
function nextSchoolCode(existingCodes, abbr) {
  var prefix = 'ML-' + abbr + '-';
  var max = 0;
  existingCodes.forEach(function (c) {
    c = str_(c);
    if (c.indexOf(prefix) === 0) {
      var n = parseInt(c.slice(prefix.length), 10);
      if (n > max) max = n;
    }
  });
  var next = String(max + 1);
  while (next.length < 4) next = '0' + next;
  return prefix + next;
}

function schoolLink(siteUrl, token) {
  var base = str_(siteUrl);
  if (!base) return '';
  if (base.charAt(base.length - 1) !== '/') base += '/';
  return base + '?s=' + token;
}

/* ------------------------------------------------------------------ validation */

/**
 * Checks the registration / edit form. Returns { errors: {field: message}, school, contacts }
 * with cleaned values. Messages are for project staff (admin dialog), not respondents.
 */
function validateSchoolForm(input) {
  var errors = {};
  var name = str_(input.name);
  if (!name) errors.name = 'School name is required.';

  var udise = str_(input.udise_code).replace(/\s+/g, '');
  if (udise && !/^\d{11}$/.test(udise)) errors.udise_code = 'UDISE code must be 11 digits.';

  var district = str_(input.district);
  if (!districtAbbr_(district)) errors.district = 'Choose one of the 12 districts.';

  var locality = str_(input.block_locality);
  if (!locality) errors.block_locality = 'Block / locality is required.';

  var shillong = str_(input.is_shillong_city);
  if (shillong !== 'Yes' && shillong !== 'No') errors.is_shillong_city = 'Answer Yes or No.';

  var area = str_(input.area_type);
  if (AREA_TYPES.indexOf(area) < 0) errors.area_type = 'Choose an area type.';

  var mgmt = str_(input.management);
  if (MANAGEMENT_TYPES.indexOf(mgmt) < 0) errors.management = 'Choose a management type.';

  var classes = Array.isArray(input.classes_offered) ? input.classes_offered.map(Number) : parseClasses_(input.classes_offered);
  classes = classes.filter(function (c) { return CLASSES.indexOf(c) >= 0; });
  if (classes.length === 0) errors.classes_offered = 'Tick at least one class from 7 to 12.';

  var streams = Array.isArray(input.streams) ? input.streams.map(str_) : parseList_(input.streams);
  streams = streams.filter(function (s) { return STREAMS.indexOf(s) >= 0; });
  var senior = classes.some(function (c) { return c >= 11; });
  if (senior && streams.length === 0) errors.streams = 'Tick the streams offered in Classes 11–12.';
  if (!senior) streams = [];

  var opens = normalizeDate_(input.survey_opens);
  var closes = normalizeDate_(input.survey_closes);
  if (opens === 'INVALID') errors.survey_opens = 'Use the date picker (YYYY-MM-DD).';
  if (closes === 'INVALID') errors.survey_closes = 'Use the date picker (YYYY-MM-DD).';
  if (opens && closes && opens !== 'INVALID' && closes !== 'INVALID' && closes < opens) errors.survey_closes = 'The closing date is before the opening date.';

  var contactPerson = str_(input.contact_person);
  var contactPhone = str_(input.contact_phone);
  var contactEmail = str_(input.contact_email);
  if (!contactPerson) errors.contact_person = 'School contact person is required.';
  if (!contactPhone && !contactEmail) errors.contact_phone = 'Give a phone number or an email.';
  if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) errors.contact_email = 'This email does not look right.';

  return {
    errors: errors,
    school: {
      name: name,
      udise_code: udise,
      district: district,
      block_locality: locality,
      is_shillong_city: shillong,
      area_type: area,
      management: mgmt,
      classes_offered: classes.sort(function (a, b) { return a - b; }).join(';'),
      streams: streams.join(';'),
      survey_opens: opens === 'INVALID' ? '' : opens,
      survey_closes: closes === 'INVALID' ? '' : closes,
    },
    contacts: {
      contact_person: contactPerson,
      contact_phone: contactPhone,
      contact_email: contactEmail,
      safeguarding_lead_name: str_(input.safeguarding_lead_name),
      safeguarding_lead_phone: str_(input.safeguarding_lead_phone),
      referral_name: str_(input.referral_name),
      referral_phone: str_(input.referral_phone),
    },
  };
}

/* ------------------------------------------------------------------ instruments and activation */

function activeConfig_(configRows) {
  return configRows.filter(function (r) { return str_(r.status).toUpperCase() === 'ACTIVE' && str_(r.instrument_version_id); });
}

/** Instruments a school's link can offer: active in Config and overlapping its classes. */
function instrumentsForSchool(school, configRows) {
  var classes = parseClasses_(school.classes_offered);
  return activeConfig_(configRows).filter(function (r) {
    return parseClasses_(r.class_band).some(function (c) { return classes.indexOf(c) >= 0; });
  });
}

/** Safeguarding fields still missing before this school may be ACTIVE ([] = may activate). */
function missingForActivation(school, contacts, configRows) {
  var needs = instrumentsForSchool(school, configRows).some(function (r) { return truthy_(r.safeguarding_required); });
  if (!needs) return [];
  return SAFEGUARDING_FIELDS.filter(function (f) { return !str_(contacts && contacts[f]); });
}

/* ------------------------------------------------------------------ public school_info */

/**
 * The only thing the public link learns about a school (DEC-23): whether it is accepting
 * responses, which classes it offers and which instrument versions it may use. Never the
 * name, code, district, contacts or survey dates. Unknown, malformed, registered-only,
 * paused and closed tokens all look the same ("unavailable"), so tokens cannot be probed.
 */
function schoolInfo(token, deps) {
  var unavailable = { ok: true, status: 'unavailable' };
  token = str_(token);
  if (!TOKEN_PATTERN.test(token)) return unavailable;
  var school = deps.findSchoolByToken(token);
  if (!school || str_(school.status) !== 'ACTIVE') return unavailable;

  var today = istDate_(deps.now());
  var opens = normalizeDate_(school.survey_opens);
  var closes = normalizeDate_(school.survey_closes);
  if (opens && opens !== 'INVALID' && today < opens) return { ok: true, status: 'not_yet_open' };
  if (closes && closes !== 'INVALID' && today > closes) return { ok: true, status: 'closed' };

  var instruments = instrumentsForSchool(school, deps.readConfig());
  if (instruments.length === 0) return unavailable;
  return {
    ok: true,
    status: 'active',
    classes: parseClasses_(school.classes_offered),
    instruments: instruments.map(function (r) { return str_(r.instrument_version_id); }),
  };
}

/* ------------------------------------------------------------------ registry operations */

/**
 * The admin operations, written against a tiny table interface so they can be tested
 * without Google services:
 *   db.read(tab)                      → array of row objects
 *   db.append(tab, obj)
 *   db.update(tab, keyField, keyValue, patch)  → true if a row was updated
 * deps: { now(): Date, uuid(): string, actor: string, siteUrl: string }
 */
function makeRegistry(db, deps) {
  function audit(event, code, detail) {
    db.append(TAB.AUDIT, { timestamp: deps.now().toISOString(), event: event, school_code: code || '', submission_id: '', actor: deps.actor, detail: detail || '' });
  }
  function findSchool(code) {
    var rows = db.read(TAB.SCHOOLS);
    for (var i = 0; i < rows.length; i++) if (str_(rows[i].school_code) === code) return rows[i];
    return null;
  }
  function findContacts(code) {
    var rows = db.read(TAB.CONTACTS);
    for (var i = 0; i < rows.length; i++) if (str_(rows[i].school_code) === code) return rows[i];
    return {};
  }
  function view(school, contacts) {
    var missing = missingForActivation(school, contacts, db.read(TAB.CONFIG));
    return {
      school_code: str_(school.school_code),
      name: str_(school.name),
      udise_code: str_(school.udise_code),
      district: str_(school.district),
      block_locality: str_(school.block_locality),
      is_shillong_city: str_(school.is_shillong_city),
      area_type: str_(school.area_type),
      management: str_(school.management),
      classes_offered: parseClasses_(school.classes_offered),
      streams: parseList_(school.streams),
      status: str_(school.status),
      survey_opens: normalizeDate_(school.survey_opens),
      survey_closes: normalizeDate_(school.survey_closes),
      registered_at: str_(school.registered_at),
      contacts: {
        contact_person: str_(contacts.contact_person),
        contact_phone: str_(contacts.contact_phone),
        contact_email: str_(contacts.contact_email),
        safeguarding_lead_name: str_(contacts.safeguarding_lead_name),
        safeguarding_lead_phone: str_(contacts.safeguarding_lead_phone),
        referral_name: str_(contacts.referral_name),
        referral_phone: str_(contacts.referral_phone),
      },
      missing_for_activation: missing,
      link: str_(school.status) === 'ACTIVE' ? schoolLink(deps.siteUrl, str_(school.school_token)) : '',
    };
  }
  function fail(message, errors) {
    return { ok: false, message: message, errors: errors || {} };
  }

  return {
    list: function () {
      var contacts = db.read(TAB.CONTACTS);
      return db.read(TAB.SCHOOLS).map(function (s) {
        var c = contacts.filter(function (x) { return str_(x.school_code) === str_(s.school_code); })[0] || {};
        return view(s, c);
      });
    },

    register: function (input) {
      var v = validateSchoolForm(input);
      if (Object.keys(v.errors).length) return fail('Please correct the marked fields.', v.errors);
      var schools = db.read(TAB.SCHOOLS);
      if (v.school.udise_code) {
        var dup = schools.filter(function (s) { return str_(s.udise_code) === v.school.udise_code; })[0];
        if (dup) return fail('A school with this UDISE code is already registered (' + str_(dup.school_code) + ').', { udise_code: 'Already registered.' });
      }
      var code = nextSchoolCode(schools.map(function (s) { return s.school_code; }), districtAbbr_(v.school.district));
      var token = newToken(deps.uuid);
      var tokens = schools.map(function (s) { return str_(s.school_token); });
      while (tokens.indexOf(token) >= 0) token = newToken(deps.uuid);
      var now = deps.now().toISOString();
      var missing = missingForActivation(v.school, v.contacts, db.read(TAB.CONFIG));
      var status = missing.length === 0 ? 'ACTIVE' : 'REGISTERED';
      var school = Object.assign({ school_code: code, school_token: token }, v.school, {
        status: status, registered_by: deps.actor, registered_at: now, updated_at: now,
      });
      db.append(TAB.SCHOOLS, school);
      db.append(TAB.CONTACTS, Object.assign({ school_code: code }, v.contacts, { updated_at: now }));
      audit('register', code, '');
      if (status === 'ACTIVE') audit('activate', code, 'on registration');
      return { ok: true, school: view(school, v.contacts) };
    },

    /** Edit details and contacts. Activation state is re-checked: an ACTIVE school that loses its safeguarding contacts is set back to REGISTERED. */
    update: function (code, input) {
      var school = findSchool(code);
      if (!school) return fail('School not found.');
      var v = validateSchoolForm(input);
      if (Object.keys(v.errors).length) return fail('Please correct the marked fields.', v.errors);
      if (v.school.udise_code) {
        var dup = db.read(TAB.SCHOOLS).filter(function (s) { return str_(s.udise_code) === v.school.udise_code && str_(s.school_code) !== code; })[0];
        if (dup) return fail('Another school has this UDISE code (' + str_(dup.school_code) + ').', { udise_code: 'Already registered.' });
      }
      if (v.school.district !== str_(school.district)) {
        // The code carries the district; changing it would break links to existing data.
        return fail('The district cannot be changed after registration, because the school code is based on it. Close this school and register it again if the district was wrong.', { district: 'Cannot change.' });
      }
      var now = deps.now().toISOString();
      var patch = Object.assign({}, v.school, { updated_at: now });
      var missing = missingForActivation(v.school, v.contacts, db.read(TAB.CONFIG));
      if (str_(school.status) === 'ACTIVE' && missing.length) {
        patch.status = 'REGISTERED';
        audit('deactivate', code, 'safeguarding contacts removed');
      }
      db.update(TAB.SCHOOLS, 'school_code', code, patch);
      var contactPatch = Object.assign({}, v.contacts, { updated_at: now });
      if (!db.update(TAB.CONTACTS, 'school_code', code, contactPatch)) db.append(TAB.CONTACTS, Object.assign({ school_code: code }, contactPatch));
      audit('update', code, '');
      return { ok: true, school: view(findSchool(code), findContacts(code)) };
    },

    setStatus: function (code, status) {
      var school = findSchool(code);
      if (!school) return fail('School not found.');
      if (SCHOOL_STATUSES.indexOf(status) < 0 || status === 'REGISTERED') return fail('Unknown status.');
      if (status === 'ACTIVE') {
        var missing = missingForActivation(school, findContacts(code), db.read(TAB.CONFIG));
        if (missing.length) return fail('Add the safeguarding lead and referral contact before activating this school.', { missing: missing.join(', ') });
      }
      var from = str_(school.status);
      if (from === status) return { ok: true, school: view(school, findContacts(code)) };
      db.update(TAB.SCHOOLS, 'school_code', code, { status: status, updated_at: deps.now().toISOString() });
      audit(status === 'ACTIVE' ? 'activate' : 'status_' + status.toLowerCase(), code, from + ' → ' + status);
      return { ok: true, school: view(findSchool(code), findContacts(code)) };
    },

    /** A leaked link stops working at once; the school keeps its code and its data. */
    regenerateToken: function (code) {
      var school = findSchool(code);
      if (!school) return fail('School not found.');
      var tokens = db.read(TAB.SCHOOLS).map(function (s) { return str_(s.school_token); });
      var token = newToken(deps.uuid);
      while (tokens.indexOf(token) >= 0) token = newToken(deps.uuid);
      db.update(TAB.SCHOOLS, 'school_code', code, { school_token: token, updated_at: deps.now().toISOString() });
      audit('token_regenerated', code, '');
      return { ok: true, school: view(findSchool(code), findContacts(code)) };
    },

    /** The link for staff to share. Only ACTIVE schools have a working link. */
    link: function (code) {
      var school = findSchool(code);
      if (!school) return fail('School not found.');
      if (!deps.siteUrl) return fail('SITE_URL is not set in Script properties.');
      return { ok: true, link: schoolLink(deps.siteUrl, str_(school.school_token)), status: str_(school.status) };
    },
  };
}

/* Node test hook: exposes the declarations above when loaded with vm. Ignored by Apps Script. */
if (typeof module !== 'undefined') {
  module.exports = {
    DISTRICTS: DISTRICTS, HEADERS: HEADERS, DEFAULT_CONFIG: DEFAULT_CONFIG, TAB: TAB, TOKEN_PATTERN: TOKEN_PATTERN,
    newToken: newToken, nextSchoolCode: nextSchoolCode, schoolLink: schoolLink, validateSchoolForm: validateSchoolForm,
    instrumentsForSchool: instrumentsForSchool, missingForActivation: missingForActivation, schoolInfo: schoolInfo,
    makeRegistry: makeRegistry, normalizeDate_: normalizeDate_, istDate_: istDate_,
  };
}
