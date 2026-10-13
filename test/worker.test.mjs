// Offline checks of the Worker: no Supabase, no Google. The comparison with
// Apps Script on a whole demo year lives in the MIGRATION repo
// (tools/sbmirror.js, MIGWEB_DIR=…), which needs PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { verifyFirebaseToken } from '../src/auth.js';
import { buildLedger, resolveScope, staffFromUsers, doctorsFrom, dayKey, decodeCell } from '../src/ledger.js';

const env = (more = {}) => ({ SUPABASE_URL: 'https://x.supabase.co', FIREBASE_PROJECT_ID: 'cresrxdemo',
  ASSETS: { fetch: () => new Response('asset') }, ...more });
const get = (path, headers = {}) => new Request('https://migweb.example' + path, { headers });

test('pages come from public/, unknown /api/ paths are 404', async () => {
  assert.equal(await (await worker.fetch(get('/ledger/'), env())).text(), 'asset');
  assert.equal((await worker.fetch(get('/api/nothing'), env())).status, 404);
});

test('the ledger refuses a request with no or a forged sign-in', async () => {
  let r = await worker.fetch(get('/api/ledger'), env());
  assert.equal(r.status, 401);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = b64({ alg: 'none' }) + '.' + b64({ email: 'a@b.c', email_verified: true }) + '.x';
  r = await worker.fetch(get('/api/ledger', { authorization: 'Bearer ' + forged }), env());
  assert.equal(r.status, 401);
  assert.equal((await verifyFirebaseToken('', 'cresrxdemo')).ok, false);
});

test('health without a key says so', async () => {
  const b = await (await worker.fetch(get('/api/health'), env())).json();
  assert.equal(b.supabase, 'not configured');
});

// A tiny mirror_query result in the mirror's own encoding.
const res = (header, rows, extra = {}) => ({ found: true, cols: header.length, header, last_row: rows.length + 1,
  synced_at: '2026-10-12T10:00:00Z', rows: rows.map((r, i) => [i + 2, r.vals || null, r.disp || null]), ...extra });
const IST = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - 330 * 60000;

test('the ledger: scope, order, salutation, cancelled and blocked rows', () => {
  const users = res(['Username', 'Password', 'Role', 'Status', 'Email Address'],
    [{ disp: ['drA', '', 'doctor', 'Active', 'A@Clinic.in'] }, { disp: ['gone', '', 'admin', 'Inactive', 'g@clinic.in'] },
     { disp: ['desk', '', 'receptionist', '', 'desk@clinic.in'] }]);
  const docs = doctorsFrom(res(['Doctor_ID', 'Tenant_ID', 'Display_Name', 'Specialty', 'x', 'Signature', 'Linked_Username', 'Status'],
    [{ disp: ['DOC001', 'T', 'Dr. A', 'GP', '', '', 'drA', 'ACTIVE'] }, { disp: ['DOC002', 'T', 'Dr. B', 'Duty MO', '', '', 'drB', 'ACTIVE'] }]));
  assert.equal(staffFromUsers(users, ' a@clinic.in ').username, 'drA');
  assert.equal(staffFromUsers(users, 'g@clinic.in').ok, false);
  assert.equal(staffFromUsers(users, 'x@clinic.in').ok, false);
  assert.equal(docs[1].canViewAll, true);

  const head = ['Appt ID', 'Patient ID', 'Patient Name', 'Date', 'Time', 'Purpose', 'Status', 'Fee', 'Doctor_ID'];
  const day = { $d: IST(2026, 10, 12) };
  const row = (id, pid, name, time, status, doc, fee = 300) =>
    ({ vals: [id, pid, name, day, time, 'Review', status, fee, doc], disp: [id, pid, name, '12/10/2026', String(time), 'Review', status, String(fee), doc] });
  const appts = res(head, [row('A1', 'p1', 'Ravi', '10:30 AM', 'Booked', 'DOC001'), row('A2', 'p2', 'Mala', { $d: IST(1899, 12, 30, 9, 15) }, 'Completed', 'DOC002'),
    row('A3', 'p1', 'Ravi', '', 'Cancelled', 'DOC001'), row('A4', 'p3', 'X', '11:00', 'Blocked', 'DOC001'), row('A5', 'ADMIN', 'X', '11:00', 'Booked', 'DOC001')]);
  appts.rows[1][1][4] = { $d: Date.UTC(1899, 11, 30, 3, 45) };     // 09:15 IST as a time-only cell
  const pats = res(Array.from({ length: 12 }, (_, i) => 'c' + i),
    [{ disp: ['P1', '', '', '41', 'M', '', '', '', '', '', '', 'mr'] }, { disp: ['P2', '', '', '30', 'F', '', '', '', '', '', '', ''] }]);

  const doctor = staffFromUsers(users, 'a@clinic.in');
  const own = buildLedger({ appointments: appts, patients: pats, doctors: docs, scope: resolveScope(doctor, docs, ''), dateKey: '2026-10-12' });
  assert.deepEqual(own.ledger.map((r) => r.apptId), ['A3', 'A1']);           // no slot (-1) sorts first, as in Apps Script
  assert.equal(own.ledger[1].patientName, 'Mr. Ravi');
  assert.equal(own.ledger[1].time12, '10:30 AM');
  assert.equal(own.scopeMode, 'SET');
  assert.equal(buildLedger({ appointments: appts, patients: pats, doctors: docs, scope: resolveScope(doctor, docs, 'DOC002'), dateKey: '2026-10-12' }).success, false);

  const desk = buildLedger({ appointments: appts, patients: pats, doctors: docs, scope: resolveScope(staffFromUsers(users, 'desk@clinic.in'), docs, ''), dateKey: '2026-10-12' });
  assert.deepEqual(desk.ledger.map((r) => r.apptId), ['A3', 'A2', 'A1']);
  assert.equal(desk.ledger[1].time24, '09:15');
  assert.equal(desk.ledger[1].doctorName, 'Dr. B');
});

test('dates and cells', () => {
  assert.equal(dayKey('2026-10-12'), '2026-10-12');
  assert.equal(dayKey('12/10/2026'), '');
  assert.equal(dayKey("2026-10-12' or 1=1"), '');
  assert.deepEqual(decodeCell({ $d: 5 }), { date: 5 });
  assert.equal(decodeCell(null), '');
});
