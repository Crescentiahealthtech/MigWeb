// ============================================================================
// The appointment ledger, out of Apps Script.
// ----------------------------------------------------------------------------
// The same answer as fetchDailyLedgerScoped (Doctor_Schedule_Engine.gs in the
// Crescentiahealthtech/MIGRATION repo), computed here from the Supabase copy
// of the workbook (schema `mirror`, public.mirror_query). Every helper below
// is a line-for-line port of the Apps Script function named next to it; the
// MIGRATION repo's tools/sbmirror.js compares this module's answer with the
// Apps Script one for 60 days of the demo year (MIGWEB_DIR=…).
//
// Pure: no fetch, no globals. The Worker (src/worker.js) does the I/O.
// Times are the clinic's: Asia/Kolkata, UTC+05:30, no daylight saving.
// ============================================================================

const IST_MS = 330 * 60 * 1000;
const SHEET_EPOCH_MS = Date.UTC(1900, 0, 1);          // CRESC_SHEET_EPOCH_MS

// Doctor_Core.gs
const DC_DEFAULT_DOCTOR = 'DOC001';
const DC_ROLES_VIEW_ALL = ['admin', 'receptionist', 'reception', 'nurse', 'accounts', 'accountant',
                           'pharmacy', 'pharmacist', 'lab', 'lab technician'];
const DC_NO_SLOT = 'No slot';
// RBAC.gs
const CRESC_CHIEF_OWNERS = ['DRMEIVASAGAM', 'DRLOGAVIGNESH'];
// Doctors_Engine.gs
const CRESC_OLD_DOCTOR_NAMES = /^\s*(?:dr\.?\s*)?valarmathi\s*$/i;
// CodeMV.gs
const CRESC_SALUTATION_RX = /^\s*(mr|mrs|ms|miss|master|mst|dr|baby|b\/o|selvi|selvan|thiru|tmt|prof|rev|sr|fr)\b\.?\s+/i;

// --------------------------------------------------------------------------
// Cells: the mirror's encoding back to what Apps Script would hold
// --------------------------------------------------------------------------

/** sb_dec_ (Supabase_Mirror.gs): {"$d": ms} is a date cell. */
export function decodeCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, '$d')) {
    return { date: v.$d === null ? NaN : v.$d };
  }
  return v;
}
const isDate = (v) => v !== null && typeof v === 'object' && 'date' in v;

const p2 = (n) => (n < 10 ? '0' : '') + n;
/** Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd' | 'HH:mm'). */
function istParts(ms) {
  const d = new Date(ms + IST_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
export const istDay = (ms) => { const t = istParts(ms); return t.y + '-' + p2(t.mo) + '-' + p2(t.d); };
const istClock = (ms) => { const t = istParts(ms); return p2(t.h) + ':' + p2(t.mi); };

/** cresc_sheetTextOf_ (Shared_Dates.gs), one cell. */
function sheetText(raw, shown) {
  if (!isDate(raw) || isNaN(raw.date)) return shown === null || shown === undefined ? '' : shown;
  if (raw.date < SHEET_EPOCH_MS) return istClock(raw.date);
  const hm = istClock(raw.date);
  return istDay(raw.date) + (hm === '00:00' ? '' : ' ' + hm);
}

/**
 * One mirror_query result as rows: {header, rows: [{rowNo, vals, disp}]} with
 * the columns the server left out filled with ''. Row 1 (the headings) is
 * returned as `header` (shown text), never among `rows`.
 */
export function shape(r) {
  if (!r || !r.found) return { header: [], rows: [], lastRow: 0, syncedAt: null };
  const width = r.cols || (r.header || []).length;
  const pick = r.picked || null;
  const full = (a, dec) => {
    const out = new Array(width).fill('');
    if (!a) return out;
    if (pick) pick.forEach((c, k) => { if (c < width) out[c] = dec ? decodeCell(a[k]) : (a[k] ?? ''); });
    else for (let c = 0; c < width && c < a.length; c++) out[c] = dec ? decodeCell(a[c]) : (a[c] ?? '');
    return out;
  };
  return {
    header: (r.header || []).map((h) => String(h ?? '')),
    lastRow: r.last_row, syncedAt: r.synced_at,
    rows: (r.rows || []).map((x) => ({ rowNo: x[0], vals: x[1] ? full(x[1], true) : null, disp: x[2] ? full(x[2], false) : null }))
  };
}

// --------------------------------------------------------------------------
// Doctor_Core.gs, Doctors_Engine.gs, CodeMV.gs
// --------------------------------------------------------------------------

export const dcStr = (v) => (v === null || v === undefined) ? '' : String(v).trim();
export const dcUpper = (v) => dcStr(v).toUpperCase();
const dcMoney = (v) => { const n = parseFloat(v); return isNaN(n) ? 0.0 : n; };

/** dc_to24_ */
export function dcTo24(t) {
  if (!t && t !== 0) return '';
  if (isDate(t)) return istClock(t.date);
  const s = dcUpper(t).replace(/\./g, '').replace(/([0-9])(AM|PM)/, '$1 $2');
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/) || s.match(/^(\d{1,2})(\d{2})\s*(AM|PM)?$/);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const mi = m[2], ap = m[3];
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return (h < 10 ? '0' : '') + h + ':' + mi;
}
/** dc_to12_ */
export function dcTo12(t24) {
  const s = dcTo24(t24);
  if (!s) return (t24 && !isDate(t24) && String(t24).trim()) ? DC_NO_SLOT : '';
  const parts = s.split(':');
  const h = parseInt(parts[0], 10), mi = parts[1];
  const ap = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return (h12 < 10 ? '0' : '') + h12 + ':' + mi + ' ' + ap;
}
/** dc_minutes_ */
export function dcMinutes(t24) {
  const s = dcTo24(t24);
  if (!s) return -1;
  const p = s.split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}
/** cresc_salutation_ */
function salutation(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const k = s.replace(/\.+$/, '').toLowerCase();
  const map = { mr: 'Mr.', mrs: 'Mrs.', ms: 'Ms.', dr: 'Dr.', miss: 'Miss', master: 'Master', mst: 'Master',
                baby: 'Baby', 'b/o': 'B/o', selvi: 'Selvi', selvan: 'Selvan', thiru: 'Thiru', tmt: 'Tmt.',
                prof: 'Prof.', rev: 'Rev.', sr: 'Sr.', fr: 'Fr.' };
  return map[k] || s;
}
/** cresc_salutedName_ */
function salutedName(sal, name) {
  const n = String(name ?? '').trim();
  const s = salutation(sal);
  if (!n || !s || CRESC_SALUTATION_RX.test(n)) return n;
  return s + ' ' + n;
}

/** crescDoctorRows_ + dc_getDoctorById_ (Can_View_All, chief owner, duty MO), from the Doctors tab as shown. */
export function doctorsFrom(result, dutyMoIds = []) {
  const t = shape(result);
  const head = t.header.map((h) => String(h || '').trim().toLowerCase().replace(/[\s.]+/g, '_'));
  const col = (names, fb) => { for (const n of names) { const i = head.indexOf(n); if (i !== -1) return i; } return fb; };
  const C = { id: col(['doctor_id', 'doc_id', 'id'], 0), name: col(['display_name', 'doctor_name', 'name'], 2),
              spec: col(['specialty', 'speciality', 'department'], 3), sig: col(['signature_line', 'signature'], 5),
              user: col(['linked_username', 'username', 'login'], 6), status: col(['status', 'active'], 7),
              all: col(['can_view_all'], -1) };
  const v = (r, i) => (i < 0 ? '' : String(r[i] ?? '').trim());
  const out = [];
  for (const row of t.rows) {
    const r = row.disp || [];
    const id = v(r, C.id);
    if (!id) continue;
    let st = v(r, C.status).toUpperCase();
    if (st === 'TRUE' || st === 'YES') st = 'ACTIVE';
    const d = { doctorId: id, name: v(r, C.name) || id, specialty: v(r, C.spec), signature: v(r, C.sig),
                username: v(r, C.user), status: st || 'ACTIVE' };
    const text = [d.name, d.specialty, d.signature].join(' | ');
    d.isDutyMO = /\bduty\s*(m\.?\s*o\b|medical\s+officer)|\bd\.?\s*m\.?\s*o\b|\bcasualty\s+medical\s+officer/i.test(text) ||
                 dutyMoIds.includes(id.toUpperCase());
    d.canViewAll = ['TRUE', 'YES', '1', 'Y'].includes(v(r, C.all).toUpperCase()) ||
                   CRESC_CHIEF_OWNERS.includes(d.username.toUpperCase()) || d.isDutyMO;
    out.push(d);
  }
  return out;
}

/**
 * Who is signing in, from the Users tab: the row whose "Email Address"
 * (column E, as verifyGoogleLogin in AuthLogin.gs reads it) is this Google
 * account, and only while its Status is Active.
 */
export function staffFromUsers(result, email) {
  const t = shape(result);
  const want = String(email || '').trim().toLowerCase();
  for (const row of t.rows) {
    const r = row.disp || [];
    const stored = String(r[4] ?? '').trim().toLowerCase();
    if (!stored || stored !== want) continue;
    const status = String(r[3] ?? '').trim();
    if (status && status.toLowerCase() !== 'active') return { ok: false, message: 'This staff account is deactivated.' };
    return { ok: true, username: String(r[0] ?? '').trim(), role: String(r[2] ?? '').trim().toLowerCase() };
  }
  return { ok: false, message: 'The email ' + want + ' is not registered in CresRx. Contact Admin.' };
}

/**
 * resolveScope_ (Doctor_Core.gs) for a signed-in staff member. `staff` is
 * {username, role} from the Users sheet (the /ledger/ page's Google sign-in:
 * the doctor is found by Linked_Username), or the app's own session
 * {username, role, doctorId} (getEdgeIdentity), whose doctorId is used as is.
 */
export function resolveScope(staff, doctors, requestedDoctorId) {
  const role = staff.role, req = dcStr(requestedDoctorId);
  const self = staff.doctorId !== undefined ? dcStr(staff.doctorId)
    : (doctors.find((d) => d.username && d.username.toUpperCase() === staff.username.toUpperCase()) || {}).doctorId || '';
  const base = { ok: true, role, username: staff.username, selfDoctorId: self, message: '' };
  if (role === 'patient') return { ...base, ok: false, mode: 'SET', doctorIds: [], message: 'Not authorised.' };
  if (DC_ROLES_VIEW_ALL.includes(role)) {
    return req ? { ...base, mode: 'SET', doctorIds: [req] } : { ...base, mode: 'ALL', doctorIds: [] };
  }
  if (role === 'doctor') {
    if (!self) return { ...base, ok: false, mode: 'SET', doctorIds: [],
                        message: 'Your login is not linked to a doctor profile. Ask the administrator to set Linked_Username in the Doctors sheet.' };
    const canAll = !!(doctors.find((d) => d.doctorId === self) || {}).canViewAll;
    if (!req) return canAll ? { ...base, mode: 'ALL', doctorIds: [] } : { ...base, mode: 'SET', doctorIds: [self] };
    if (req === self || canAll) return { ...base, mode: 'SET', doctorIds: [req] };
    return { ...base, ok: false, mode: 'SET', doctorIds: [self], message: 'You can only view your own records.' };
  }
  return { ...base, ok: false, mode: 'SET', doctorIds: [], message: "Role '" + role + "' has no defined clinical scope." };
}

/** dc_inScope_ */
export function inScope(scope, doctorId) {
  if (!scope || !scope.ok) return false;
  if (scope.mode === 'ALL') return true;
  if (!doctorId) return false;
  return scope.doctorIds.includes(dcStr(doctorId));
}

// --------------------------------------------------------------------------
// The ledger
// --------------------------------------------------------------------------

/** The one mirror_query call the ledger needs: Users, Doctors, the day's appointments, their patients. */
export function ledgerQueries(dateKey) {
  return [
    { sheet: 'Users', all: true, parts: 'disp', cols: [0, 1, 2, 3, 4] },
    { sheet: 'Doctors', all: true, parts: 'disp' },
    { sheet: 'Appointments', from: dateKey, to: dateKey, parts: 'both' },
    { sheet: 'Patients', rid_from: { q: 2, col: 1 }, parts: 'disp' }
  ];
}

/** The same without Users: for a caller the app's session already identifies. */
export function sessionLedgerQueries(dateKey) {
  return [
    { sheet: 'Doctors', all: true, parts: 'disp' },
    { sheet: 'Appointments', from: dateKey, to: dateKey, parts: 'both' },
    { sheet: 'Patients', rid_from: { q: 1, col: 1 }, parts: 'disp' }
  ];
}

/** 'yyyy-MM-dd', or '' (dc_dateKey_ is applied by the mirror's day index). */
export function dayKey(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) ? s : '';
}
export const todayIST = () => istDay(Date.now());

/**
 * fetchDailyLedgerScoped's reply, from the mirror's Appointments and Patients
 * results for the day, the doctors, and the caller's scope.
 */
export function buildLedger({ appointments, patients, doctors, scope, dateKey }) {
  if (!scope.ok) return { success: false, message: scope.message, ledger: [] };
  const A = shape(appointments), P = shape(patients);
  const hmap = {};
  A.header.forEach((h, i) => { const k = String(h || '').trim(); if (k && hmap[k] === undefined) hmap[k] = i; });
  const docCol = hmap.Doctor_ID === undefined ? -1 : hmap.Doctor_ID;
  const snapCol = hmap.Doctor_Name_Snapshot === undefined ? -1 : hmap.Doctor_Name_Snapshot;
  const byId = {};
  doctors.forEach((d) => { byId[d.doctorId.toUpperCase()] = d; });
  const shownDoctor = (id, snap) => {
    const s = dcStr(snap);
    if (s && !CRESC_OLD_DOCTOR_NAMES.test(s)) return s;
    const d = byId[dcUpper(id)];
    return d && d.name ? d.name : '';
  };

  const patMap = {};
  for (const row of P.rows) {
    const pd = row.disp;
    patMap[dcUpper(pd[0])] = { age: dcStr(pd[3]), sex: dcStr(pd[4]), sal: dcStr(pd[11]) };
  }

  const ledger = [];
  for (const row of A.rows) {
    const data = row.vals.map((raw, j) => sheetText(raw, row.disp[j]));
    const status = dcStr(data[6]);
    if (status === 'Blocked' || status === 'DELETE') continue;
    const pid = dcUpper(data[1]);
    if (pid === 'ADMIN') continue;
    const rowDoc = docCol === -1 ? DC_DEFAULT_DOCTOR : (dcStr(data[docCol]) || DC_DEFAULT_DOCTOR);
    if (!inScope(scope, rowDoc)) continue;
    const docName = shownDoctor(rowDoc, snapCol !== -1 ? data[snapCol] : '') || rowDoc;
    ledger.push({
      apptId: dcStr(data[0]),
      time12: dcTo12(data[4]),
      time24: dcTo24(data[4]),
      patientId: pid,
      patientName: patMap[pid] ? salutedName(patMap[pid].sal, dcStr(data[2])) : dcStr(data[2]),
      noSlot: !dcTo24(data[4]),
      age: patMap[pid] ? patMap[pid].age : '',
      sex: patMap[pid] ? patMap[pid].sex : '',
      purpose: dcStr(data[5]),
      status,
      fee: dcMoney(data[7]),
      doctorId: rowDoc,
      doctorName: docName
    });
  }
  ledger.sort((a, b) => (dcMinutes(a.time24) - dcMinutes(b.time24)) || (a.doctorName < b.doctorName ? -1 : 1));
  return { success: true, date: dateKey, scopeMode: scope.mode, ledger,
           message: ledger.length ? '' : 'No appointments recorded for this date.' };
}
