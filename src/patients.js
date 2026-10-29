// ============================================================================
// Patients, out of Apps Script: the register, a patient's demographics, and
// the clinical timeline.
// ----------------------------------------------------------------------------
// Line-for-line ports of the Apps Script functions named next to each, fed by
// the Supabase copy of the workbook (mirror_query). The MIGRATION repo's
// tools/sbmirror.js runs each against the Apps Script original on the demo
// year and requires the same answer.
//
// The rule that keeps them exact: where the original would do something this
// port cannot reproduce byte for byte (turn a date cell into text with
// toString(), parse a date written as text, read the discharge module), the
// function returns null, and the Worker hands the call to Apps Script.
//
// Pure: no fetch, no globals. Times are the clinic's: Asia/Kolkata.
// ============================================================================

const IST_MS = 330 * 60 * 1000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CRESC_SALUTATION_RX = /^\s*(mr|mrs|ms|miss|master|mst|dr|baby|b\/o|selvi|selvan|thiru|tmt|prof|rev|sr|fr)\b\.?\s+/i;

/** Thrown inside a port to say "Apps Script must answer this one". */
class Unsure extends Error {}
const unsure = (why) => { throw new Unsure(why); };

/** sb_dec_ (Supabase_Mirror.gs): the cell getValues() would have returned. */
export function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, '$d')) {
    return new Date(v.$d === null ? NaN : v.$d);
  }
  return v;
}
const isDate = (v) => v instanceof Date;

/**
 * One mirror_query result as getValues()-shaped rows: row 1 (the headings,
 * as values) then every row the server sent, each full width.
 * `allRows` fills the rows the copy did not send (getDataRange() would
 * include a blank row) — only for a query that asked for all rows.
 */
export function values(r, allRows) {
  if (!r || !r.found) return null;
  const width = r.cols || (r.header || []).length;
  const pick = r.picked || null;
  const full = (a) => {
    const out = new Array(width).fill('');
    if (!a) return out;
    if (pick) pick.forEach((c, k) => { if (c < width) out[c] = cell(a[k]); });
    else for (let c = 0; c < width && c < a.length; c++) out[c] = cell(a[c]);
    return out;
  };
  const head = (r.header || []).slice();
  while (head.length < width) head.push('');
  const rows = (r.rows || []).map((x) => ({ n: x[0], v: full(x[1]) }));
  if (!allRows) return [head].concat(rows.map((x) => x.v));
  const byRow = new Map(rows.map((x) => [x.n, x.v]));
  const out = [head];
  for (let n = 2; n <= (r.last_row || 1); n++) out.push(byRow.get(n) || new Array(width).fill(''));
  return out;
}

/** String(x) as Apps Script would print it; a date's text depends on the script's zone, so not here. */
function text(v) {
  if (isDate(v)) unsure('a date cell turned into text');
  return v.toString();
}

/** Utilities.formatDate(d, 'Asia/Kolkata', pattern) for the patterns used here. */
function fmtIST(d, pattern) {
  const t = new Date(d.getTime() + IST_MS);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const h = t.getUTCHours(), h12 = h % 12 || 12;
  return pattern
    .replace('dd', p2(t.getUTCDate())).replace('MMM', MON[t.getUTCMonth()]).replace('yyyy', String(t.getUTCFullYear()))
    .replace('hh', p2(h12)).replace('mm', p2(t.getUTCMinutes())).replace(/\ba\b/, h < 12 ? 'AM' : 'PM');
}

/** yyyy-MM-dd in the clinic's zone (Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd")): the zone's own rules, so a date in 1942-45 (India kept +6:30) is the one Apps Script prints. */
const YMD = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
function ymdIST(d) { return YMD.format(d); }

/** op_parsePaedExam_ (OP_Database_Engine.gs): Paed_Exam back to an object; null when empty or unreadable. */
function parsePaed(raw) {
  if (!raw) return null;
  try { const o = JSON.parse(raw); return (o && typeof o === 'object') ? o : null; } catch (e) { return null; }
}

/** op_paedExamRows_ (OP_Database_Engine.gs): the paediatric examination as [label, text] rows, in examining order. */
function paedRows(px) {
  if (!px || typeof px !== 'object') return [];
  const t = (k) => String(px[k] === undefined || px[k] === null ? '' : px[k]).trim();
  const rows = [];
  if (Array.isArray(px.danger) && px.danger.length) rows.push(['Danger signs', px.danger.join(', ')]);
  const anthro = [];
  if (t('hc')) anthro.push('HC ' + t('hc') + ' cm');
  if (t('chest')) anthro.push('Chest ' + t('chest') + ' cm');
  if (t('hcr')) anthro.push('Head : chest ' + t('hcr'));
  if (t('muac')) anthro.push('MUAC ' + t('muac') + ' cm');
  if (anthro.length) rows.push(['Measurements', anthro.join(' \u00b7 ')]);
  [['loc', 'Consciousness'], ['activity', 'Activity / interaction'], ['cry', 'Cry'],
   ['posture', 'Posture'], ['moves', 'Spontaneous movements'], ['face', 'Facial expression'],
   ['turgor', 'Skin turgor'], ['crt', 'Capillary refill']].forEach((f) => { if (t(f[0])) rows.push([f[1], t(f[0])]); });
  return rows;
}

/** new Date(x) for a cell: a date cell is copied; text would be parsed in the script's zone, so not here. */
function asDate(v) {
  if (isDate(v)) return new Date(v.getTime());
  if (v === '' || v === null || v === undefined) return new Date(NaN);
  if (typeof v === 'number') return new Date(v);
  unsure('a date written as text');
}

/** cresc_salutation_ / cresc_salutedName_ (CodeMV.gs). */
function salutation(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const k = s.replace(/\.+$/, '').toLowerCase();
  const map = { mr: 'Mr.', mrs: 'Mrs.', ms: 'Ms.', dr: 'Dr.', miss: 'Miss', master: 'Master', mst: 'Master',
                baby: 'Baby', 'b/o': 'B/o', selvi: 'Selvi', selvan: 'Selvan', thiru: 'Thiru', tmt: 'Tmt.',
                prof: 'Prof.', rev: 'Rev.', sr: 'Sr.', fr: 'Fr.' };
  return map[k] || s;
}
function salutedName(sal, name) {
  if (isDate(sal) || isDate(name)) unsure('a date in a name column');
  const n = String(name ?? '').trim();
  const s = salutation(sal);
  if (!n || !s || CRESC_SALUTATION_RX.test(n)) return n;
  return s + ' ' + n;
}

/** Runs a port; null when it met something only Apps Script can answer exactly. */
function attempt(fn) {
  try { return fn(); } catch (e) { if (e instanceof Unsure) return null; throw e; }
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

/** The Patients columns the register screens read: A id, C name, D age, E sex, G mobile, I address, L salutation. */
export const REGISTER_COLS = [0, 2, 3, 4, 6, 8, 11];
export const registerQuery = () => [{ sheet: 'Patients', all: true, parts: 'vals', cols: REGISTER_COLS }];

/** getAllPatients (CodeMV.gs), once crescRequire_ has passed. */
export function allPatients(result) {
  return attempt(() => {
    const data = values(result, true);
    if (!data) unsure('no Patients in the copy');
    const roster = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) {
        roster.push({
          id: text(data[i][0]),
          name: text(data[i][2]),
          display: salutedName(data[i][11], text(data[i][2])),
          age: text(data[i][3]),
          gender: text(data[i][4]),
          mobile: text(data[i][6]),
          address: data[i][8] ? text(data[i][8]) : ''
        });
      }
    }
    return roster;
  });
}

/** getMasterPatientDirectory (EMR_MasterTimeline_Logic.gs), once crescRequire_ has passed. */
export function masterDirectory(result) {
  return attempt(() => {
    const data = values(result, true);
    if (!data) unsure('no Patients in the copy');
    const out = [];
    for (let i = 1; i < data.length; i++) {
      out.push({
        id: data[i][0] ? text(data[i][0]) : '',
        name: data[i][2] || 'Unknown',
        age: data[i][3] || '--',
        sex: data[i][4] || '--',
        mobile: data[i][6] ? text(data[i][6]) : ''
      });
    }
    return { success: true, data: JSON.stringify(out.reverse()), message: '' };
  });
}

// ---------------------------------------------------------------------------
// One patient
// ---------------------------------------------------------------------------

export const patientKey = (patientId) => String(patientId || '').trim().toUpperCase();

/** getPatientDemographics (Appointment.gs), once crescRequire_ has passed. */
export const demographicsQuery = (pid) => [{ sheet: 'Patients', rid: pid, parts: 'vals' }];
export function demographics(result, patientId) {
  return attempt(() => {
    if (!patientId) return { success: true, data: null, message: '' };
    const data = values(result, false);
    if (!data) unsure('no Patients in the copy');
    const want = text(patientId).trim().toUpperCase();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && text(data[i][0]).trim().toUpperCase() === want) {
        return { success: true, message: '', data: {
          id: data[i][0], name: data[i][2], age: data[i][3], sex: data[i][4],
          gender: data[i][4], mobile: data[i][6] || '' } };
      }
    }
    return { success: true, data: null, message: '' };
  });
}

/** buildLongitudinalTimeline's three registers, the patient's rows of each. */
export const timelineQuery = (pid) => [
  { sheet: 'Patients', rid: pid, parts: 'vals' },
  { sheet: 'OP_Encounters', pid, parts: 'vals' },
  { sheet: 'IP_Admissions', pid, parts: 'vals' }
];

/**
 * buildLongitudinalTimeline (EMR_MasterTimeline_Logic.gs), once crescRequire_
 * has passed. A patient with an admission goes to Apps Script: each stay
 * carries its discharge summary, which the discharge module reads.
 */
export function timeline([patients, op, ip], patientId) {
  return attempt(() => {
    const pIdUpper = String(patientId || '').trim().toUpperCase();
    const response = { found: false, patient: {}, events: [] };
    const pData = values(patients, false);
    if (!pData) unsure('no Patients in the copy');
    for (let i = 1; i < pData.length; i++) {
      if (text(pData[i][0]).trim().toUpperCase() === pIdUpper) {
        response.found = true;
        response.patient = { id: pData[i][0], name: pData[i][2], age: pData[i][3], sex: pData[i][4],
                             // F: date of birth, for a child's age in years and months.
                             dob: (isDate(pData[i][5]) && !isNaN(pData[i][5])) ? ymdIST(pData[i][5]) : String(pData[i][5] || ''),
                             mobile: pData[i][6], email: pData[i][16] || '' };
        break;
      }
    }
    if (!response.found) return response;

    const ipData = values(ip, false);
    if (!ipData) unsure('no IP_Admissions in the copy');
    if (ipData.slice(1).some((r) => r[1] && text(r[1]).trim().toUpperCase() === pIdUpper)) unsure('an admission');

    const opData = values(op, false);
    if (opData) {
      const headers = opData[0];
      for (let i = 1; i < opData.length; i++) {
        const r = opData[i];
        if (!(r[1] && text(r[1]).trim().toUpperCase() === pIdUpper)) continue;
        const rawDate = asDate(r[2]);
        if (isNaN(rawDate)) continue;

        const vitalsObj = {};
        if (r[3] || r[4]) vitalsObj.bp = (r[3] || '--') + '/' + (r[4] || '--');
        if (isDate(r[3]) || isDate(r[4])) unsure('a date in a vitals column');
        if (r[5]) vitalsObj.hr = r[5];
        if (r[6]) vitalsObj.spo2 = r[6];
        if (r[7]) vitalsObj.temp = r[7];
        if (r[8]) vitalsObj.weight = r[8];
        if (r[9]) vitalsObj.bmi = r[9];
        // Appended columns, read by heading (op_ensureEncounterColumns_).
        const byHead = (h) => { const c = headers.indexOf(h); if (c === -1) return ''; if (isDate(r[c])) unsure('a date in an appended column'); return String(r[c] || '').trim(); };
        if (byHead('Height_Cm')) vitalsObj.height = byHead('Height_Cm');
        if (byHead('Resp_Rate')) vitalsObj.rr = byHead('Resp_Rate');
        const paedRaw = byHead('Paed_Exam');
        const paedText = paedRows(parsePaed(paedRaw)).map((x) => x[0] + ': ' + x[1]).join('; ');

        const genExamObj = {};
        for (let c = 12; c <= 16; c++) if (r[c] && r[c] !== '') genExamObj[headers[c] || `GenExam_${c}`] = r[c];
        const sysExamObj = {};
        for (let c = 17; c <= 20; c++) if (r[c] && r[c] !== '') sysExamObj[headers[c] || `SysExam_${c}`] = r[c];
        if (byHead('PV_Exam')) sysExamObj.PV = byHead('PV_Exam');   // appended column

        const rawFollowUp = r[25];
        let followUpStr = 'None';
        if (isDate(rawFollowUp) && !isNaN(rawFollowUp)) followUpStr = fmtIST(rawFollowUp, 'dd-MMM-yyyy');
        else if (rawFollowUp) followUpStr = text(rawFollowUp);

        response.events.push({
          type: 'OP',
          rawDateObj: rawDate.getTime(),
          date: fmtIST(rawDate, 'dd-MMM-yyyy | hh:mm a'),
          apptId: r[0] || 'Unknown',
          vitals: JSON.stringify(vitalsObj),
          complaints: r[10] || 'Not recorded',
          history: r[11] || 'None',
          genExam: JSON.stringify(genExamObj),
          sysExam: JSON.stringify(sysExamObj),
          diagnosis: r[21] || 'Pending',
          rx: r[22] || '[]',
          labs: r[23] || 'None',
          advice: r[24] || 'None',
          followUp: followUpStr,
          localExam: byHead('Local_Exam'),
          paedExam: paedRaw,
          paedText
        });
      }
    }
    response.events.sort((a, b) => b.rawDateObj - a.rawDateObj);
    return { success: true, data: response, message: '' };
  });
}
