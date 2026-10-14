// ============================================================================
// Signing in and the screens every role opens, out of Apps Script: what this
// person may do, "am I still signed in", the doctor picker, a patient's
// profile, and a doctor's bookable slots for a day.
// ----------------------------------------------------------------------------
// Line-for-line ports of the Apps Script functions named next to each, fed by
// the session's identity (getEdgeIdentity, kept in Supabase) and the Supabase
// copy of the workbook. The MIGRATION repo's tools/sbmirror.js runs each
// against the Apps Script original on the demo year and requires the same
// answer. Where a port meets something it cannot reproduce exactly, it throws
// Unsure and the Worker hands the call to Apps Script.
//
// Pure: no fetch, no globals. Times are the clinic's: Asia/Kolkata.
// ============================================================================

import { shape, doctorsFrom, resolveScope, inScope, dcStr, dcUpper, dcTo24, dcTo12, dcMinutes } from './ledger.js';

const IST_MS = 330 * 60 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DS_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DC_DEFAULT_DOCTOR = 'DOC001';
const YES = ['TRUE', 'YES', '1', 'Y'];

/** Thrown inside a port to say "Apps Script must answer this one". */
export class Unsure extends Error {}
const unsure = (why) => { throw new Unsure(why); };

const p2 = (n) => (n < 10 ? '0' : '') + n;
const ist = (d) => new Date(d.getTime() + IST_MS);
/** Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd'). */
const istDate = (d) => { const t = ist(d); return t.getUTCFullYear() + '-' + p2(t.getUTCMonth() + 1) + '-' + p2(t.getUTCDate()); };
/** Date.prototype.toString() as Apps Script prints it, the script's zone being Asia/Kolkata. */
export function istToString(d) {
  if (isNaN(d.getTime())) return 'Invalid Date';
  const t = ist(d);
  return DAYS[t.getUTCDay()] + ' ' + MONTHS[t.getUTCMonth()] + ' ' + p2(t.getUTCDate()) + ' ' + t.getUTCFullYear() + ' ' +
         p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes()) + ':' + p2(t.getUTCSeconds()) + ' GMT+0530 (India Standard Time)';
}

// --------------------------------------------------------------------------
// RBAC.gs, Doctor_Session_Store.gs
// --------------------------------------------------------------------------

/** crescGetMyPermissions(token) for a known session. */
export function myPermissions(who) {
  if (!who.actor || !Array.isArray(who.uiHiddenAll)) unsure('an identity without the full list of hidden keys');
  const permissions = {};
  who.permissions.forEach((p) => { permissions[p] = true; });
  const uiHidden = {};
  who.uiHiddenAll.forEach((k) => { uiHidden[k] = true; });
  return { success: true, role: who.actor.role, permissions, uiHidden, displayName: who.displayName, message: '' };
}

/** crescTouchSession(token) for a known session. */
export const touchSession = (who) => ({ success: true, username: who.username });

// --------------------------------------------------------------------------
// The Doctors sheet: crescDoctorRows_, getActiveDoctors_ (Doctors_Engine.gs),
// dc_getDoctorById_, dc_isDutyMO_ (Doctor_Core.gs), dv_isVisitingSlot_
// (Doctor_Visiting.gs). The sheet as displayed (dc_sheetValues_ and
// getDisplayValues agree on a sheet with no dates).
// --------------------------------------------------------------------------

export function doctorTable(result, who) {
  if (!result || !result.found) unsure('no Doctors sheet in the copy');
  if (!Array.isArray(who.tenants) || !who.tenants.length) unsure('an identity without the tenant list');
  const t = shape(result);
  const tenants = who.tenants.map((x) => String(x).trim().toUpperCase());
  const dutyIds = (who.dutyMoIds || []).map((x) => String(x).toUpperCase());
  const rowsShown = t.rows.map((r) => r.disp || []);

  // crescDoctorRows_: by normalised heading, original position as fallback.
  const head = t.header.map((h) => String(h || '').trim().toLowerCase().replace(/[\s.]+/g, '_'));
  const col = (names, fb) => { for (const n of names) { const i = head.indexOf(n); if (i !== -1) return i; } return fb; };
  const C = { id: col(['doctor_id', 'doc_id', 'id'], 0), tenant: col(['tenant_id', 'tenant'], 1),
              name: col(['display_name', 'doctor_name', 'name'], 2), spec: col(['specialty', 'speciality', 'department'], 3),
              reg: col(['reg_no', 'registration_no', 'reg_number', 'regn_no'], 4), sig: col(['signature_line', 'signature'], 5),
              user: col(['linked_username', 'username', 'login'], 6), status: col(['status', 'active'], 7) };
  const v = (r, i) => (i < 0 ? '' : String(r[i] ?? '').trim());
  const rows = [];
  for (const r of rowsShown) {
    const id = v(r, C.id);
    if (!id) continue;
    const tenant = v(r, C.tenant);
    if (tenant && !tenants.includes(tenant.toUpperCase())) continue;
    let st = v(r, C.status).toUpperCase();
    if (st === 'TRUE' || st === 'YES') st = 'ACTIVE';
    rows.push({ doctorId: id, tenantId: tenant, name: v(r, C.name) || id, specialty: v(r, C.spec), regNo: v(r, C.reg),
                signature: v(r, C.sig), username: v(r, C.user), status: st || 'ACTIVE' });
  }

  // dc_headerMap_: exact (trimmed) headings, first one wins.
  const hmap = {};
  t.header.forEach((h, i) => { const k = String(h || '').trim(); if (k && hmap[k] === undefined) hmap[k] = i; });
  const idCol = hmap.Doctor_ID !== undefined ? hmap.Doctor_ID : 0;

  const isDutyMO = (p) => {
    const text = [p.name, p.specialty, p.signature].map(dcStr).join(' | ');
    return /\bduty\s*(m\.?\s*o\b|medical\s+officer)|\bd\.?\s*m\.?\s*o\b|\bcasualty\s+medical\s+officer/i.test(text) ||
           dutyIds.includes(dcUpper(p.doctorId));
  };

  return {
    /** getActiveDoctors_ */
    active: () => rows.filter((d) => d.status === 'ACTIVE')
      .map((d) => ({ doctorId: d.doctorId, name: d.name, specialty: d.specialty, regNo: d.regNo })),
    /** dc_getDoctorById_: name, colour, isDutyMO (the fields the ports use), or null. */
    byId(doctorId) {
      const id = dcUpper(doctorId);
      if (!id) return null;
      const prof = rows.find((d) => dcUpper(d.doctorId) === id) || null;
      for (const r of rowsShown) {
        if (dcUpper(r[idCol]) !== id) continue;
        const P = prof || { doctorId: r[0], name: r[2], specialty: r[3], signature: r[5] };
        return { doctorId: dcStr(P.doctorId), name: dcStr(P.name), isDutyMO: isDutyMO(P),
                 colour: hmap.Colour_Tag !== undefined ? dcStr(r[hmap.Colour_Tag]) : '' };
      }
      return null;
    },
    /** dv_isVisitingSlot_ */
    isVisitingSlot(doctorId) {
      if (hmap.Is_Visiting === undefined) return false;
      const id = dcUpper(doctorId);
      if (!id) return false;
      for (const r of rowsShown) {
        if (dcUpper(r[0]) !== id) continue;
        return YES.includes(dcUpper(r[hmap.Is_Visiting]));
      }
      return false;
    }
  };
}

const doctorsQuery = () => ({ sheet: 'Doctors', all: true, parts: 'disp' });
const staffOf = (who) => ({ username: who.username, role: who.role, doctorId: who.doctorId });

// --------------------------------------------------------------------------
// getDoctorPickerContext (Doctor_Core.gs)
// --------------------------------------------------------------------------

export const pickerQuery = () => [doctorsQuery()];

export function doctorPicker(who, [doctorsRes]) {
  if (!('visiting' in who)) unsure('an identity without the visiting declaration');
  const scope = resolveScope(staffOf(who), doctorsFrom(doctorsRes, who.dutyMoIds), null);
  if (!scope.ok) return { success: false, message: scope.message, doctors: [] };
  const T = doctorTable(doctorsRes, who);
  const all = T.active();
  const visible = scope.mode === 'ALL' ? all : all.filter((d) => scope.doctorIds.includes(d.doctorId));
  return {
    success: true,
    mode: scope.mode,
    locked: scope.mode !== 'ALL',
    selfDoctorId: scope.selfDoctorId,
    signsAsSelf: !!(scope.selfDoctorId && (T.byId(scope.selfDoctorId) || {}).isDutyMO),
    doctors: visible.map((d) => {
      const full = T.byId(d.doctorId);
      const isVisiting = T.isVisitingSlot(d.doctorId);
      const declared = isVisiting ? who.visiting : null;
      return {
        doctorId: d.doctorId,
        name: (declared && declared.name) ? declared.name : d.name,
        specialty: (declared && declared.specialty) ? declared.specialty : d.specialty,
        colour: full ? full.colour : '',
        visiting: isVisiting,
        unavailable: !!(isVisiting && !declared),
        unavailableReason: (isVisiting && !declared)
          ? 'Nobody has entered their name and registration number on this slot yet.'
          : ''
      };
    })
  };
}

// --------------------------------------------------------------------------
// getUserProfile (CodeMV.gs) and pt_readProfile_
// --------------------------------------------------------------------------

/** Columns A and C..V: never B, the portal password. */
const PROFILE_COLS = [0].concat(Array.from({ length: 20 }, (_, i) => i + 2));
export const profileQuery = (want) => [{ sheet: 'Patients', rid: want, parts: 'both', cols: PROFILE_COLS }];

/**
 * The profile, or null (Apps Script's null: no such patient, or a patient
 * asking for someone else). `want` is the patient ID, trimmed and upper-cased.
 */
export function userProfile(who, want, [res]) {
  if (!res || !res.found) unsure('no Patients sheet in the copy');
  if (!want) return null;
  if (who.role === 'patient' && dcUpper(who.username) !== want) return null;
  if ((res.last_row || 0) < 2) return null;
  // The TextFinder's match: the whole cell, any case, the first row down.
  const t = shape(res);
  const hit = t.rows.filter((r) => r.rowNo > 1).sort((a, b) => a.rowNo - b.rowNo)
    .find((r) => String((r.disp || [])[0] ?? '').toUpperCase() === want);
  if (!hit) return null;
  const row = new Array(22).fill('');
  // shape() gives dates as {date}; as getValues() would, a Date.
  (hit.vals || []).forEach((v, i) => { if (i < 22) row[i] = (v && typeof v === 'object' && 'date' in v) ? new Date(v.date) : (v ?? ''); });
  const isDate = (v) => v instanceof Date;
  return {
    id: row[0],
    name: row[2],
    age: row[3],
    gender: row[4],
    dob: isDate(row[5]) ? istDate(row[5]) : String(row[5] || ''),
    mobile: row[6],
    whatsapp: row[7],
    address: row[8],
    comorb: row[9],
    regDate: row[10] ? (isDate(row[10]) ? istToString(row[10]) : row[10].toString()) : '',
    salutation: row[11] || '',
    maritalStatus: row[12] || '',
    bloodGroup: row[13] || '',
    occupation: row[14] || '',
    education: row[15] || '',
    email: row[16] || '',
    relationType: row[17] || '',
    relationName: row[18] || '',
    emergencyName: row[19] || '',
    emergencyNumber: row[20] || '',
    referredBy: row[21] || ''
  };
}

// --------------------------------------------------------------------------
// getDoctorSlotsForDate (Doctor_Schedule_Engine.gs): ds_generateSlots_,
// ds_bookingsByTime_
// --------------------------------------------------------------------------

/** dc_dateKey_ on a cell as getDisplayValues() shows it, raw value alongside. */
function dateKeyOf(raw, shown, monthFirst) {
  const v = shown;
  if (!v && v !== 0) return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length >= 10 && s.charCodeAt(4) === 45 && s.charCodeAt(7) === 45) return s.substring(0, 10);
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      const a = +m[1], b = +m[2];
      const mf = (a > 12) ? false : (b > 12) ? true : !!monthFirst;
      const dd = mf ? b : a, mm = mf ? a : b;
      return m[3] + '-' + p2(mm) + '-' + p2(dd);
    }
    // Any other text is parsed in the script's zone (new Date(s)): text that
    // is no date at all is kept as typed; a date cell is its own day; other
    // text, Apps Script reads.
    if (isNaN(new Date(s).getTime())) return s.substring(0, 10);
    if (raw && typeof raw === 'object' && 'date' in raw) return istDate(new Date(raw.date));
    unsure('a date typed in an unusual way');
  }
  unsure('a date that is not text');
}

/** dc_dateKey_ on the date asked for: the page sends yyyy-MM-dd. */
function askedDay(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length >= 10 && s.charCodeAt(4) === 45 && s.charCodeAt(7) === 45) return s.substring(0, 10);
  if (!v && v !== 0) return '';
  unsure('a date not given as yyyy-MM-dd');
}

export function slotsQuery(dateKey) {
  return [
    doctorsQuery(),
    { sheet: 'Doctor_Schedules', all: true, parts: 'disp' },
    { sheet: 'Doctor_Schedule_Exceptions', all: true, parts: 'both' },
    { sheet: 'Appointments', from: dateKey, to: dateKey, parts: 'disp' }
  ];
}

/** The day the page asks about, or '' (Apps Script's "Select a valid date."); throws Unsure for an odd one. */
export const slotsDay = (dateStr) => askedDay(dateStr);

export function doctorSlots(who, doctorId, dateKey, [doctorsRes, schedRes, excRes, apptRes]) {
  for (const r of [schedRes, excRes, apptRes]) if (!r || !r.found) unsure('a schedule sheet not in the copy');
  const scope = resolveScope(staffOf(who), doctorsFrom(doctorsRes, who.dutyMoIds), doctorId);
  if (!scope.ok) return { success: false, message: scope.message, slots: [] };
  const target = dcStr(doctorId) || scope.selfDoctorId;
  if (!target) return { success: false, message: 'Select a doctor.', slots: [] };
  if (!inScope(scope, target)) return { success: false, message: 'You can only view your own schedule.', slots: [] };
  if (!dateKey) return { success: false, message: 'Select a valid date.', slots: [] };

  const T = doctorTable(doctorsRes, who);
  const doc = T.byId(target);
  const generated = generateSlots(target, dateKey, schedRes, excRes, who);
  const booked = bookingsByTime(target, dateKey, apptRes);

  const slots = generated.map((s) => {
    const b = booked[s.time24] || [];
    return { time24: s.time24, time12: s.time12, sessionLabel: s.sessionLabel, available: b.length < s.maxPerSlot,
             bookedCount: b.length, maxPerSlot: s.maxPerSlot, bookings: b };
  });
  const covered = {};
  generated.forEach((s) => { covered[s.time24] = true; });
  const orphans = [];
  Object.keys(booked).forEach((t) => {
    if (covered[t]) return;
    booked[t].forEach((b) => { orphans.push({ time24: t, time12: dcTo12(t), booking: b }); });
  });
  orphans.sort((a, b) => dcMinutes(a.time24) - dcMinutes(b.time24));

  const [y, mo, d] = dateKey.split('-').map((x) => parseInt(x, 10));
  return {
    success: true,
    doctorId: target,
    doctorName: doc ? doc.name : target,
    date: dateKey,
    weekdayName: DS_WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()],
    slots,
    offSchedule: orphans,
    message: slots.length ? '' : (doc ? doc.name : target) + ' has no clinic hours on this day.'
  };
}

// --------------------------------------------------------------------------
// getDoctorSchedule (Doctor_Schedule_Engine.gs): one doctor's weekly hours
// --------------------------------------------------------------------------

export const scheduleQuery = () => [doctorsQuery(), { sheet: 'Doctor_Schedules', all: true, parts: 'disp' }];

export function doctorSchedule(who, doctorId, [doctorsRes, schedRes]) {
  if (!schedRes || !schedRes.found) unsure('Doctor_Schedules not in the copy');
  const scope = resolveScope(staffOf(who), doctorsFrom(doctorsRes, who.dutyMoIds), doctorId);
  if (!scope.ok) return { success: false, message: scope.message, rows: [] };
  const target = dcStr(doctorId) || scope.selfDoctorId;
  if (!target) return { success: false, message: 'Select a doctor.', rows: [] };
  if (!inScope(scope, target)) return { success: false, message: 'You can only view your own schedule.', rows: [] };

  const T = doctorTable(doctorsRes, who);
  const doc = T.byId(target);
  const tenants = who.tenants.map((x) => String(x).trim().toUpperCase());
  const rows = [];
  for (const row of shape(schedRes).rows) {
    const r = row.disp || [];
    if (dcUpper(r[2]) !== dcUpper(target)) continue;
    if (!tenants.includes(String(r[1] ?? '').trim().toUpperCase())) continue;
    if (dcUpper(r[10]) !== 'ACTIVE') continue;
    rows.push({
      scheduleId: dcStr(r[0]),
      weekday: dcInt(r[3]),
      weekdayName: DS_WEEKDAYS[dcInt(r[3])] || '',
      sessionLabel: dcStr(r[4]),
      startTime: dcTo24(r[5]),
      endTime: dcTo24(r[6]),
      slotMinutes: dcInt(r[7]) || 15,
      maxPerSlot: dcInt(r[8]) || 1,
      location: dcStr(r[9])
    });
  }
  rows.sort((a, b) => (a.weekday - b.weekday) || (dcMinutes(a.startTime) - dcMinutes(b.startTime)));
  return { success: true, doctorId: target, doctorName: doc ? doc.name : target, rows,
           message: rows.length ? '' : 'No recurring clinic hours set for this doctor yet.' };
}

function dcInt(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
const fromMinutes = (mins) => { const h = Math.floor(mins / 60), m = mins % 60; return p2(h) + ':' + p2(m); };

/** ds_generateSlots_ */
function generateSlots(doctorId, dateKey, schedRes, excRes, who) {
  const m = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return [];
  const weekday = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  const tenants = who.tenants.map((x) => String(x).trim().toUpperCase());
  const ourTenant = (v) => tenants.includes(String(v ?? '').trim().toUpperCase());
  const docU = dcUpper(doctorId);

  const windows = [];
  for (const row of shape(schedRes).rows) {
    const r = row.disp || [];
    if (dcUpper(r[2]) !== docU) continue;
    if (!ourTenant(r[1])) continue;
    if (dcInt(r[3]) !== weekday) continue;
    if (dcUpper(r[10]) !== 'ACTIVE') continue;
    windows.push({ label: dcStr(r[4]), start: dcMinutes(r[5]), end: dcMinutes(r[6]), step: dcInt(r[7]) || 15, max: dcInt(r[8]) || 1 });
  }

  const blocks = [];
  let fullDayOff = false;
  for (const row of shape(excRes).rows) {
    const r = row.disp || [], raw = row.vals || [];
    if (dcUpper(r[2]) !== docU) continue;
    if (dateKeyOf(raw[3], r[3], who.monthFirst) !== dateKey) continue;
    const type = dcUpper(r[4]);
    const s = dcMinutes(r[5]), n = dcMinutes(r[6]);
    if (type === 'LEAVE' && s < 0) { fullDayOff = true; break; }
    if (type === 'LEAVE' || type === 'BLOCK') blocks.push({ start: s < 0 ? 0 : s, end: n < 0 ? 1440 : n });
    else if (type === 'EXTRA' && s >= 0 && n > s) windows.push({ label: 'EXTRA', start: s, end: n, step: 15, max: 1 });
  }
  if (fullDayOff) return [];

  const seen = {}, slots = [];
  windows.forEach((win) => {
    if (win.start < 0 || win.end <= win.start) return;
    for (let t = win.start; t + win.step <= win.end; t += win.step) {
      if (blocks.some((b) => t >= b.start && t < b.end)) continue;
      const key = fromMinutes(t);
      if (seen[key]) continue;
      seen[key] = true;
      slots.push({ time24: key, time12: dcTo12(key), sessionLabel: win.label, maxPerSlot: win.max });
    }
  });
  slots.sort((a, b) => dcMinutes(a.time24) - dcMinutes(b.time24));
  return slots;
}

/** ds_bookingsByTime_: the copy's day index reads the date as this does (dc_dateKey_ of the shown cell). */
function bookingsByTime(doctorId, dateKey, apptRes) {
  const A = shape(apptRes);
  const out = {};
  const hmap = {};
  A.header.forEach((h, i) => { const k = String(h || '').trim(); if (k && hmap[k] === undefined) hmap[k] = i; });
  const docCol = hmap.Doctor_ID === undefined ? -1 : hmap.Doctor_ID;
  const docU = dcUpper(doctorId);
  for (const row of A.rows.slice().sort((a, b) => a.rowNo - b.rowNo)) {
    if (row.rowNo < 2) continue;
    const d = row.disp || [];
    let status = d[6];
    if (status === 'Cancelled' || status === 'DELETE' || status === 'Blocked') continue;
    if (d[1] === 'ADMIN') continue;
    status = dcStr(status);
    const rowDoc = docCol === -1 ? DC_DEFAULT_DOCTOR : (dcStr(d[docCol]) || DC_DEFAULT_DOCTOR);
    if (dcUpper(rowDoc) !== docU) continue;
    const key = dcTo24(d[4]);            // the shown time is text: dc_to24_'s text branch
    if (!key) continue;
    (out[key] = out[key] || []).push({ apptId: dcStr(d[0]), patientId: dcStr(d[1]), patientName: dcStr(d[2]),
                                       purpose: dcStr(d[5]), status });
  }
  return out;
}
