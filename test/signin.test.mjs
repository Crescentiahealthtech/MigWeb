// Sessions kept in Supabase, and the calls every screen makes at sign-in,
// answered by the Worker (src/app.js, src/signin.js) with Apps Script and
// Supabase stood in for. Exactness against Apps Script on the demo year:
// MIGRATION tools/sbmirror.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../src/worker.js';
import { istToString } from '../src/signin.js';

const EXEC = 'https://script.google.com/macros/s/AKfyTEST/exec';
const IST = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - 330 * 60000;
const hashOf = (token) => createHash('sha256').update('cresrx-session:' + token).digest('hex');
const res = (header, rows) => ({ found: true, cols: header.length, header, last_row: rows.length + 1, synced_at: '2026-10-13T04:00:00Z',
  rows: rows.map((r, i) => [r.n || i + 2, r.vals || null, r.disp || null]) });

const DOCTORS = res(['Doctor_ID', 'Tenant_ID', 'Display_Name', 'Specialty', 'Reg_No', 'Signature_Line', 'Linked_Username', 'Status', 'Colour_Tag', 'Is_Visiting'], [
  { disp: ['DOC001', 'DEMO', 'Dr. Meivasagam', 'General Medicine', '', '', 'drmeivasagam', 'ACTIVE', '#2563eb', ''] },
  { disp: ['DOC002', 'DEMO', 'Dr. Nagamanikandan', 'O&G', '', '', 'drnaga', 'ACTIVE', '#db2777', ''] },
  { disp: ['DOC006', 'DEMO', 'Dr. DMO', 'Duty Medical Officer (DMO)', '', '', 'dmo', 'ACTIVE', '', ''] },
  { disp: ['DOC007', 'DEMO', 'Visiting Doctor', 'Visiting', '', '', 'visit', 'ACTIVE', '', 'TRUE'] },
  { disp: ['DOC008', 'OTHER', 'Dr. Elsewhere', 'GP', '', '', '', 'ACTIVE', '', ''] },
  { disp: ['DOC009', 'DEMO', 'Dr. Retired', 'GP', '', '', '', 'INACTIVE', '', ''] }]);
const SCHED = res(['Schedule_ID', 'Tenant_ID', 'Doctor_ID', 'Weekday', 'Session_Label', 'Start_Time', 'End_Time', 'Slot_Minutes', 'Max_Per_Slot', 'Location', 'Status'], [
  { disp: ['S1', 'DEMO', 'DOC001', '3', 'Evening', '17:00', '18:00', '15', '2', 'OP 1', 'ACTIVE'] },     // Wednesday
  { disp: ['S2', 'DEMO', 'DOC001', '3', 'Morning', '09:00', '10:00', '30', '1', 'OP 1', 'ACTIVE'] },
  { disp: ['S3', 'DEMO', 'DOC001', '1', 'Morning', '09:00', '12:00', '30', '1', 'OP 1', 'ACTIVE'] },     // Monday
  { disp: ['S4', 'DEMO', 'DOC001', '3', 'Old', '12:00', '13:00', '15', '1', 'OP 1', 'INACTIVE'] },
  { disp: ['S5', 'DEMO', 'DOC002', '3', 'Morning', '10:00', '11:00', '15', '1', 'OP 2', 'ACTIVE'] }]);
const EXC = res(['Exception_ID', 'Tenant_ID', 'Doctor_ID', 'Date', 'Type', 'Start_Time', 'End_Time', 'Reason', 'Created_By', 'Created_At'], [
  { vals: ['E1', 'DEMO', 'DOC001', { $d: IST(2026, 10, 14) }, 'BLOCK', '17:15', '17:45', 'meeting', 'admin', ''],
    disp: ['E1', 'DEMO', 'DOC001', '10/14/2026', 'BLOCK', '17:15', '17:45', 'meeting', 'admin', ''] },
  { vals: ['E2', 'DEMO', 'DOC002', { $d: IST(2026, 10, 14) }, 'LEAVE', '', '', 'leave', 'admin', ''],
    disp: ['E2', 'DEMO', 'DOC002', '10/14/2026', 'LEAVE', '', '', 'leave', 'admin', ''] }]);
const APPTS = res(['Appt ID', 'Patient ID', 'Patient Name', 'Date', 'Time', 'Purpose', 'Status', 'Fee', 'Doctor_ID'], [
  { disp: ['A1', 'DEMO0404', 'Ilango N', '10/14/2026', '05:00 PM', 'Consultation', 'Booked', '300', 'DOC001'] },
  { disp: ['A2', 'DEMO0031', 'Shankar C', '10/14/2026', '05:00 PM', 'Review', 'Arrived', '300', 'DOC001'] },
  { disp: ['A3', 'DEMO0284', 'Yamuna E', '10/14/2026', '09:00 AM', 'Consultation', 'Cancelled', '300', 'DOC001'] },
  { disp: ['A4', 'DEMO0100', 'Late Walk-in', '10/14/2026', '07:40 PM', 'Emergency', 'Booked', '0', 'DOC001'] },
  { disp: ['A5', 'DEMO0101', 'Other Doc', '10/14/2026', '10:00 AM', 'Consultation', 'Booked', '0', 'DOC002'] }]);
const regAt = new Date(IST(2026, 3, 2, 10, 15));
const PATIENTS = res(['Patient ID', 'Password', 'Name', 'Age', 'Gender', 'DOB', 'Mobile', 'WhatsApp', 'Address', 'Comorbidities', 'Reg Date', 'Salutation',
                      'Marital', 'Blood', 'Occupation', 'Education', 'Email', 'RelType', 'RelName', 'EmName', 'EmNo', 'Referred'], [
  { n: 7, vals: ['DEMO0404', '', 'Ilango N', 71, 'M', { $d: IST(1955, 1, 9) }, 9876543210, '', 'Erode', 'DM', { $d: regAt.getTime() }, 'Mr', '', 'B+',
                 '', '', '', '', '', '', '', ''],
    disp: ['DEMO0404', '', 'Ilango N', '71', 'M', '1/9/1955', '9876543210', '', 'Erode', 'DM', '4/2/2026', 'Mr', '', 'B+', '', '', '', '', '', '', '', ''] }]);

const base = { dutyMoIds: [], edge: true, uiHidden: {}, uiHiddenAll: [], tenants: ['DEMO', 'KSH'], monthFirst: true, visiting: null };
const SESS = {
  ADMIN: { ...base, success: true, username: 'crescentia', role: 'admin', doctorId: '', displayName: 'Crescentia',
           permissions: ['dashboard.read', 'patient.read'], uiHiddenAll: ['dash.kpi.revenue', 'nav.pharmacy'],
           actor: { username: 'crescentia', role: 'admin', doctorId: '' } },
  DOC: { ...base, success: true, username: 'drnaga', role: 'doctor', doctorId: 'DOC002', displayName: 'Dr. Nagamanikandan',
         permissions: ['patient.read'], actor: { username: 'drnaga', role: 'doctor', doctorId: 'DOC002' } },
  DMO: { ...base, success: true, username: 'dmo', role: 'doctor', doctorId: 'DOC006', displayName: 'Dr. DMO',
         permissions: ['patient.read'], actor: { username: 'dmo', role: 'doctor', doctorId: 'DOC006' } },
  VISIT: { ...base, success: true, username: 'visit', role: 'doctor', doctorId: 'DOC007', displayName: 'Visiting Doctor',
           permissions: ['patient.read'], visiting: { doctorId: 'DOC007', name: 'Dr. Guest', specialty: 'Cardiology' },
           actor: { username: 'visit', role: 'doctor', doctorId: 'DOC007' } },
  PAT: { ...base, success: true, username: 'DEMO0031', role: 'patient', doctorId: '', displayName: 'Shankar',
         permissions: ['portal.self'], actor: { username: 'DEMO0031', role: 'patient', doctorId: '' } },
  OLDAPPS: { success: true, username: 'old', role: 'admin', doctorId: '', dutyMoIds: [], edge: true, permissions: ['dashboard.read'],
             uiHidden: {}, actor: { username: 'old', role: 'admin', doctorId: '' } }
};

let seq = 0;
/** Stand-ins for Apps Script and Supabase. `stored`: tokens whose session Supabase holds, and how old. */
function network({ stored = {}, snapshots = {} } = {}) {
  const log = { apps: [], sb: [], waits: [] };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  const byHash = {};
  Object.keys(stored).forEach((t) => { byHash[hashOf(t)] = { identity: SESS[t.replace(/\d+$/, '')], age: stored[t] }; });
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith(EXEC + '?shell=1')) return new Response("<html><head></head><script>window.CRESC_BUILD = 'a1b2c3d4e5f6';</script>app</html>");
    const body = init.body ? JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) : {};
    if (url === EXEC) {
      log.apps.push(body);
      if (body.fn === 'getEdgeIdentity') return Response.json({ ok: true, v: SESS[String(body.args[0]).replace(/\d+$/, '')] || { success: false } });
      return Response.json({ ok: true, v: { from: 'apps-script', fn: body.fn, args: body.args } });
    }
    if (url.includes('/functions/v1/cresrx-reads')) { (log.edge = log.edge || []).push(body); return Response.json({ tabs: 3, loaded: 3, reused: 0, ms: 9 }); }
    const fn = url.split('/rpc/')[1];
    log.sb.push(fn);
    const j = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (fn === 'session_get') return j(byHash[body.p.hash] || null);
    if (fn === 'snapshot_get') {
      const s = snapshots[body.p.key];
      return new Response(s ? '{"data": ' + JSON.stringify(s.data) + ', "made": ' + (Date.now() - s.age) + '}' : 'null',
                          { headers: { 'content-type': 'application/json' } });
    }
    if (fn === 'snapshot_claim') return j(true);
    if (fn === 'edge_writes') return j({ n: 0 });             // no save made in Supabase waiting
    if (fn === 'mirror_query') {
      return j({ results: body.p.queries.map((q) => ({ Doctors: DOCTORS, Doctor_Schedules: SCHED, Doctor_Schedule_Exceptions: EXC,
                                                       Appointments: APPTS, Patients: PATIENTS })[q.sheet] || { found: false }) });
    }
    throw new Error('unexpected fetch ' + url);
  };
  const ctx = { waitUntil: (p) => log.waits.push(p) };
  return { log, ctx, settle: () => Promise.all(log.waits) };
}
const env = (more = {}) => ({ APP_EXEC_URL: EXEC, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x',
  ASSETS: { fetch: () => new Response('asset') }, ...more });
async function call(fn, args, ctx, { headers = {}, e = env() } = {}) {
  const r = await worker.fetch(new Request('https://migweb.example/rpc', { method: 'POST', headers,
    body: JSON.stringify({ fn, args }) }), e, ctx);
  return { source: r.headers.get('x-cresrx-source'), why: r.headers.get('x-cresrx-why'), age: r.headers.get('x-cresrx-age'), v: (await r.json()).v };
}
// A fresh token per test: the Worker remembers sessions for 15 s.
const tok = (name) => name + (++seq);

test('a session Supabase holds is used as it is: Apps Script is not asked', async () => {
  const t = tok('ADMIN');
  const { log, ctx } = network({ stored: { [t]: 4000 } });
  const r = await call('crescGetMyPermissions', [t], ctx);
  assert.equal(r.source, 'supabase');
  assert.deepEqual(r.v, { success: true, role: 'admin', permissions: { 'dashboard.read': true, 'patient.read': true },
                          uiHidden: { 'dash.kpi.revenue': true, 'nav.pharmacy': true }, displayName: 'Crescentia', message: '' });
  assert.deepEqual((await call('crescTouchSession', [t], ctx)).v, { success: true, username: 'crescentia' });
  assert.deepEqual(log.apps, []);
  assert.deepEqual(log.sb, ['session_get']);                          // then remembered here for 15 s
});

test('a session Supabase does not hold is asked of Apps Script once; an old one is re-checked in the background', async () => {
  let t = tok('ADMIN');
  let { log, ctx, settle } = network();
  await call('crescTouchSession', [t], ctx);
  await call('crescGetMyPermissions', [t], ctx);
  assert.deepEqual(log.apps.map((b) => b.fn), ['getEdgeIdentity']);   // then remembered
  t = tok('ADMIN');
  ({ log, ctx, settle } = network({ stored: { [t]: 11 * 60000 } }));
  const r = await call('crescTouchSession', [t], ctx);
  assert.equal(r.source, 'supabase');
  await settle();
  assert.deepEqual(log.apps.map((b) => b.fn), ['getEdgeIdentity']);   // after the answer
});

test('an unknown or ended session, and an Apps Script too old for the new calls, are left to Apps Script', async () => {
  const { log, ctx } = network();
  let r = await call('crescTouchSession', ['NOBODY'], ctx);
  assert.equal(r.source, 'apps-script');
  assert.equal(r.why, 'session not known here');
  r = await call('crescGetMyPermissions', [tok('OLDAPPS')], ctx);
  assert.equal(r.source, 'apps-script');
  assert.match(r.why, /hidden keys/);
  r = await call('getDoctorPickerContext', [tok('OLDAPPS')], ctx);
  assert.equal(r.source, 'apps-script');
  assert.ok(log.apps.some((b) => b.fn === 'getDoctorPickerContext'));
});

test('signing out: this instance forgets the session at once', async () => {
  const t = tok('ADMIN');
  const { log, ctx } = network({ stored: { [t]: 1000 } });
  assert.equal((await call('crescTouchSession', [t], ctx)).source, 'supabase');
  await call('crescLogSignOut', [t], ctx);
  assert.equal(log.apps.at(-1).fn, 'crescLogSignOut');
  const n = log.sb.length;
  await call('crescTouchSession', [t], ctx);
  assert.equal(log.sb.length, n + 1);                                 // looked up again, not remembered
});

test('the doctor picker: everyone for reception, locked for a doctor, the duty MO signs as self, a visiting slot', async () => {
  const { ctx } = network({ stored: { ADMIN901: 0, DOC901: 0, DMO901: 0, VISIT901: 0 } });
  let v = (await call('getDoctorPickerContext', ['ADMIN901'], ctx)).v;
  assert.deepEqual({ ...v, doctors: v.doctors.map((d) => d.doctorId) },
    { success: true, mode: 'ALL', locked: false, selfDoctorId: '', signsAsSelf: false, doctors: ['DOC001', 'DOC002', 'DOC006', 'DOC007'] });
  assert.deepEqual(v.doctors[0], { doctorId: 'DOC001', name: 'Dr. Meivasagam', specialty: 'General Medicine', colour: '#2563eb',
                                   visiting: false, unavailable: false, unavailableReason: '' });
  assert.deepEqual(v.doctors[3], { doctorId: 'DOC007', name: 'Visiting Doctor', specialty: 'Visiting', colour: '', visiting: true,
    unavailable: true, unavailableReason: 'Nobody has entered their name and registration number on this slot yet.' });
  v = (await call('getDoctorPickerContext', ['DOC901'], ctx)).v;
  assert.deepEqual([v.mode, v.locked, v.selfDoctorId, v.doctors.map((d) => d.doctorId)], ['SET', true, 'DOC002', ['DOC002']]);
  v = (await call('getDoctorPickerContext', ['DMO901'], ctx)).v;
  assert.deepEqual([v.mode, v.signsAsSelf, v.doctors.length], ['ALL', true, 4]);
  v = (await call('getDoctorPickerContext', ['VISIT901'], ctx)).v;
  assert.deepEqual(v.doctors.map((d) => [d.name, d.specialty, d.unavailable]), [['Dr. Guest', 'Cardiology', false]]);
});

test('a screen bundle comes from Supabase for the page\'s own build; the first of a build from Apps Script, which stores it', async () => {
  const t = tok('ADMIN');
  const data = { success: true, name: 'patients', html: '<div>' + 'x'.repeat(5000) + '</div>', message: '' };
  let { log, ctx, settle } = network({ snapshots: { 'bundle:a1b2c3d4e5f6:patients': { data, age: 1000 } } });
  const page = await worker.fetch(new Request('https://migweb.example/'), env(), ctx);
  const cookie = page.headers.get('set-cookie');
  assert.match(cookie, /^cresrx_build=a1b2c3d4e5f6; Path=\/; Secure; HttpOnly; SameSite=Strict/);
  const headers = { cookie: 'other=1; ' + cookie.split(';')[0] };
  let r = await call('crescGetBundle', ['patients'], ctx, { headers });
  assert.equal(r.source, 'supabase');
  assert.deepEqual(r.v, data);
  r = await call('crescGetBundle', ['billing'], ctx, { headers });     // not stored yet
  assert.equal(r.source, 'apps-script');
  assert.deepEqual(log.apps.at(-1), { fn: 'crescGetBundle', args: ['billing', 'a1b2c3d4e5f6'] });
  r = await call('crescGetBundle', ['patients'], ctx);                  // a page without the cookie, no build stored: as before
  assert.deepEqual(log.apps.at(-1), { fn: 'crescGetBundle', args: ['patients'] });
  // A page open longer than its cookie lives: the build deployed now (the stored build check).
  ({ log, ctx, settle } = network({ snapshots: { 'bundle:a1b2c3d4e5f6:patients': { data, age: 1000 },
                                                 build: { data: { success: true, build: 'a1b2c3d4e5f6', url: '' }, age: 1000 } } }));
  r = await call('crescGetBundle', ['patients'], ctx);
  assert.equal(r.source, 'supabase');
  assert.deepEqual(r.v, data);
  assert.deepEqual(log.apps, []);
  ({ log, ctx, settle } = network({ snapshots: { 'bundle:a1b2c3d4e5f6:patients': { data, age: 4 * 60000 } } }));
  assert.equal((await call('crescGetBundle', ['patients'], ctx, { headers })).source, 'supabase');
  await settle();
  assert.deepEqual(log.apps, [{ fn: 'crescGetBundle', args: ['patients', 'a1b2c3d4e5f6'] }]);   // re-read in the background
  void t;
});

test('the build check and the consent notice come from their stored copies', async () => {
  const build = { success: true, build: 'a1b2c3d4e5f6', url: 'https://clinic.example' };
  const notice = { success: true, version: '3', fiduciary: 'DEMO CLINIC', purposes: [{ k: 'care' }] };
  let { log, ctx } = network({ snapshots: { build: { data: build, age: 1000 }, 'dpdp:notice': { data: notice, age: 1000 } } });
  assert.deepEqual(await call('getAppBuild', [], ctx), { source: 'supabase', why: null, age: '1', v: build });
  assert.deepEqual((await call('getDPDPNotice', [], ctx)).v, notice);
  assert.deepEqual(log.apps, []);
  ({ log, ctx } = network());
  const r = await call('getDPDPNotice', [], ctx);
  assert.deepEqual([r.source, r.why], ['apps-script', 'not stored yet']);
});

test('a patient\'s profile: for staff; a patient only their own (else null, as Apps Script answers)', async () => {
  const { log, ctx } = network({ stored: { ADMIN902: 0, PAT902: 0 } });
  let r = await call('getUserProfile', [' demo0404 ', 'ADMIN902'], ctx);
  assert.equal(r.source, 'supabase');
  assert.deepEqual(r.v, { id: 'DEMO0404', name: 'Ilango N', age: 71, gender: 'M', dob: '1955-01-09', mobile: 9876543210, whatsapp: '',
    address: 'Erode', comorb: 'DM', regDate: 'Mon Mar 02 2026 10:15:00 GMT+0530 (India Standard Time)', salutation: 'Mr',
    maritalStatus: '', bloodGroup: 'B+', occupation: '', education: '', email: '', relationType: '', relationName: '',
    emergencyName: '', emergencyNumber: '', referredBy: '' });
  r = await call('getUserProfile', ['DEMO0404', 'PAT902'], ctx);
  assert.deepEqual([r.source, r.v], ['supabase', null]);
  r = await call('getUserProfile', ['DEMO9999', 'ADMIN902'], ctx);
  assert.deepEqual([r.source, r.v], ['supabase', null]);
  assert.deepEqual(log.apps, []);
  assert.equal(istToString(new Date(IST(2026, 10, 14, 23, 59))), 'Wed Oct 14 2026 23:59:00 GMT+0530 (India Standard Time)');
});

test('a doctor\'s slots for a day: the weekly hours, less the blocked time, with the bookings; and the weekly hours', async () => {
  const { log, ctx } = network({ stored: { ADMIN903: 0, DOC903: 0 } });
  let v = (await call('getDoctorSlotsForDate', ['DOC001', '2026-10-14', 'ADMIN903'], ctx)).v;
  assert.equal(v.success, true);
  assert.deepEqual([v.doctorId, v.doctorName, v.date, v.weekdayName, v.message], ['DOC001', 'Dr. Meivasagam', '2026-10-14', 'Wednesday', '']);
  assert.deepEqual(v.slots.map((s) => [s.time24, s.time12, s.sessionLabel, s.bookedCount, s.available]),
    [['09:00', '09:00 AM', 'Morning', 0, true], ['09:30', '09:30 AM', 'Morning', 0, true],
     ['17:00', '05:00 PM', 'Evening', 2, false], ['17:45', '05:45 PM', 'Evening', 0, true]]);
  assert.deepEqual(v.slots[2].bookings.map((b) => [b.apptId, b.status]), [['A1', 'Booked'], ['A2', 'Arrived']]);
  assert.deepEqual(v.offSchedule, [{ time24: '19:40', time12: '07:40 PM',
    booking: { apptId: 'A4', patientId: 'DEMO0100', patientName: 'Late Walk-in', purpose: 'Emergency', status: 'Booked' } }]);
  v = (await call('getDoctorSlotsForDate', ['DOC002', '2026-10-14', 'ADMIN903'], ctx)).v;          // on leave all day
  assert.deepEqual([v.slots.length, v.message], [0, 'Dr. Nagamanikandan has no clinic hours on this day.']);
  v = (await call('getDoctorSlotsForDate', ['DOC001', '2026-10-14', 'DOC903'], ctx)).v;            // another doctor's
  assert.deepEqual(v, { success: false, message: 'You can only view your own records.', slots: [] });
  v = (await call('getDoctorSchedule', ['DOC001', 'ADMIN903'], ctx)).v;
  assert.deepEqual(v.rows.map((r) => [r.weekdayName, r.startTime, r.endTime, r.slotMinutes, r.maxPerSlot]),
    [['Monday', '09:00', '12:00', 30, 1], ['Wednesday', '09:00', '10:00', 30, 1], ['Wednesday', '17:00', '18:00', 15, 2]]);
  assert.deepEqual(log.apps, []);
});

test('saving hours, leave or an account copies those sheets at once (when Apps Script makes it)', async () => {
  const { log, ctx } = network();
  for (const [fn, sheets] of [['saveDoctorSchedule', ['Doctor_Schedules']], ['addScheduleException', ['Doctor_Schedule_Exceptions']],
                              ['setDoctorDayBlocks', ['Doctor_Schedule_Exceptions']], ['crescSaveUserAccess', ['Users']],
                              ['crescSetAccountActive', ['Users']], ['crescCreateStaffAccount', ['Users', 'Doctors']]]) {
    // (Made in Supabase since Phase W; saves there switched off, Apps Script makes them as before.)
    await call(fn, [{}, 'T'], ctx, { e: env({ EDGE_OFF: 'writes' }) });
    assert.deepEqual(log.apps.at(-1).flush, sheets, fn);
  }
});

test('a screen opening asks the Edge Function to load the tabs its reads need, once a minute at most', async () => {
  const data = { success: true, name: 'pharmacy', html: '<div>p</div>', message: '' };
  const { log, ctx, settle } = network({ snapshots: { 'bundle:a1b2c3d4e5f6:pharmacy': { data, age: 1000 } } });
  const headers = { cookie: 'cresrx_build=a1b2c3d4e5f6' };
  assert.equal((await call('crescGetBundle', ['pharmacy'], ctx, { headers })).source, 'supabase');
  await settle();
  assert.equal(log.edge.length, 1);
  assert.equal(log.edge[0].fn, '__warm');
  assert.ok(log.edge[0].args.includes('fetchBillableStock') && log.edge[0].args.includes('getPharmacyDashboard'));
  await call('crescGetBundle', ['pharmacy'], ctx, { headers });   // again within the minute: not asked again
  await settle();
  assert.equal(log.edge.length, 1);
  // Switched off with the reads: no warm-up either.
  const off = network({ snapshots: { 'bundle:a1b2c3d4e5f6:billing': { data, age: 1000 } } });
  await call('crescGetBundle', ['billing'], off.ctx, { headers, e: env({ EDGE_OFF: 'runner' }) });
  await off.settle();
  assert.equal((off.log.edge || []).length, 0);
});

test('the letterhead for printouts comes from its stored copy; without one, Apps Script answers and stores it', async () => {
  const clinic = { success: true, clinic: { name: 'DEMO CLINIC', address: '1, Demo Street' }, message: '' };
  let { log, ctx } = network({ snapshots: { clinic: { data: clinic, age: 1000 } } });
  assert.deepEqual(await call('getClinicProfile', [], ctx), { source: 'supabase', why: null, age: '1', v: clinic });
  assert.equal(log.apps.length, 0);
  ({ log, ctx } = network());
  const r = await call('getClinicProfile', [], ctx);
  assert.equal(r.source, 'apps-script');
  assert.equal(r.why, 'not stored yet');
});
