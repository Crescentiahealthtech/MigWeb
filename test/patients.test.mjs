// The patient reads (src/patients.js through src/app.js), Apps Script and
// Supabase stood in for. Exactness against the real Apps Script functions is
// checked by the MIGRATION repo's tools/sbmirror.js on the demo year.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const EXEC = 'https://script.google.com/macros/s/AKfyTEST/exec';
const IST = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - 330 * 60000;
const res = (header, rows, extra = {}) => ({ found: true, cols: header.length, header,
  last_row: Math.max(1, ...rows.map((r) => r[0])), synced_at: '2026-10-14T04:00:00Z', rows, ...extra });

const PAT_HEAD = Array.from({ length: 17 }, (_, i) => ['Patient_ID', 'Password', 'Name', 'Age', 'Gender', 'x', 'Mobile', 'x', 'Address', 'x', 'x', 'Salutation'][i] || 'c' + i);
const pat = (n, id, name, age, sex, mobile, sal, email = '') => {
  const v = new Array(17).fill(''); v[0] = id; v[2] = name; v[3] = age; v[4] = sex; v[6] = mobile; v[8] = 'Salem'; v[11] = sal; v[16] = email;
  return [n, v, null];
};
const PATIENTS = [pat(2, 'DEMO0001', 'Ilango N', 71, 'M', 9876500001, 'Mr', 'ilango@example.org'),
                  pat(4, 'DEMO0002', 'Yamuna E', 64, 'F', 9876500002, 'Mrs')];         // row 3 is blank in the sheet
const OP_HEAD = Array.from({ length: 26 }, (_, i) => (i === 12 ? 'Pallor' : i === 17 ? 'CVS' : 'op' + i));
const op = (n, appt, pid, at, extra = {}) => {
  const v = new Array(26).fill(''); v[0] = appt; v[1] = pid; v[2] = { $d: at }; v[3] = 120; v[4] = 80; v[5] = 72;
  v[10] = 'Fever'; v[12] = 'Absent'; v[17] = 'S1S2 heard'; v[21] = 'Viral fever'; v[22] = '[]';
  Object.entries(extra).forEach(([k, x]) => { v[k] = x; });
  return [n, v, null];
};
const ENCOUNTERS = [op(2, 'OP-1', 'DEMO0001', IST(2026, 10, 1, 9, 5)), op(3, 'OP-2', 'DEMO0001', IST(2026, 10, 9, 17, 40), { 25: { $d: IST(2026, 10, 16) } })];
const ADMISSIONS = [[2, ['IP-1', 'DEMO0002', '', '', { $d: IST(2026, 9, 1) }], null]];

const SESSIONS = {
  DESK: { success: true, username: 'desk', role: 'receptionist', doctorId: '', dutyMoIds: [], edge: true,
          permissions: ['patient.read', 'emr.read'], actor: { username: 'desk', role: 'reception', doctorId: '' } },
  NOEMR: { success: true, username: 'pharm', role: 'pharmacist', doctorId: '', dutyMoIds: [], edge: true,
           permissions: ['patient.read'], actor: { username: 'pharm', role: 'pharmacy', doctorId: '' } }
};

function network({ auditFails = false, patients = PATIENTS } = {}) {
  const log = { apps: [], audits: [], order: [] };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url === EXEC) {
      const b = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
      log.apps.push(b); log.order.push('apps:' + b.fn);
      if (b.fn === 'getEdgeIdentity') return Response.json({ ok: true, v: SESSIONS[b.args[0]] || { success: false } });
      return Response.json({ ok: true, v: { from: 'apps-script', fn: b.fn } });
    }
    const body = JSON.parse(typeof init.body === 'string' ? (init.body || '{}') : new TextDecoder().decode(init.body)).p;
    if (url.endsWith('/rpc/edge_log_read')) {
      log.order.push('audit');
      if (auditFails) return new Response('no', { status: 500 });
      log.audits.push(body); return Response.json(1);
    }
    if (url.endsWith('/rpc/mirror_query')) {
      log.order.push('query');
      const results = body.queries.map((q) => {
        if (q.sheet === 'Patients') {
          const rows = patients.filter((r) => !q.rid || String(r[1][0]).toUpperCase() === q.rid);
          if (q.cols) return res(PAT_HEAD, rows.map(([n, v]) => [n, q.cols.map((c) => v[c]), null]), { picked: q.cols, last_row: Math.max(...patients.map((r) => r[0])) });
          return res(PAT_HEAD, rows, { last_row: Math.max(...patients.map((r) => r[0])) });
        }
        if (q.sheet === 'OP_Encounters') return res(OP_HEAD, ENCOUNTERS.filter((r) => r[1][1] === q.pid));
        if (q.sheet === 'IP_Admissions') return res(['IP_No', 'Patient_ID', 'c2', 'c3', 'DOA'], ADMISSIONS.filter((r) => r[1][1] === q.pid));
        return { found: false };
      });
      return Response.json({ results });
    }
    if (url.endsWith('/rpc/edge_writes')) return Response.json({ n: 0 });          // no save made in Supabase waiting
    throw new Error('unexpected fetch ' + url);
  };
  return log;
}
const env = (more = {}) => ({ APP_EXEC_URL: EXEC, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x',
  ASSETS: { fetch: () => new Response('asset') }, ...more });
const ctx = { waitUntil() {} };
const call = async (fn, args, e = env()) => {
  const r = await worker.fetch(new Request('https://migweb.example/rpc', { method: 'POST', body: JSON.stringify({ fn, args }) }), e, ctx);
  return { source: r.headers.get('x-cresrx-source'), v: (await r.json()).v };
};

test('the register: every patient, as getAllPatients gives it, audited before it goes back', async () => {
  const log = network();
  const { source, v } = await call('getAllPatients', ['DESK']);
  assert.equal(source, 'supabase');
  assert.deepEqual(v, [
    { id: 'DEMO0001', name: 'Ilango N', display: 'Mr. Ilango N', age: '71', gender: 'M', mobile: '9876500001', address: 'Salem' },
    { id: 'DEMO0002', name: 'Yamuna E', display: 'Mrs. Yamuna E', age: '64', gender: 'F', mobile: '9876500002', address: 'Salem' }]);
  assert.deepEqual(log.audits, [{ actor: { username: 'desk', role: 'reception', doctorId: '' }, what: 'PatientRegister', entityId: 'ALL',
                                  details: { endpoint: 'getAllPatients' } }]);
  assert.deepEqual(log.order, ['apps:getEdgeIdentity', 'query', 'audit']);
});

test('the master directory keeps blank rows and puts the newest first, as JSON text', async () => {
  network();
  const { v } = await call('getMasterPatientDirectory', ['DESK']);
  assert.deepEqual(JSON.parse(v.data).map((x) => x.id), ['DEMO0002', '', 'DEMO0001']);
  assert.deepEqual(JSON.parse(v.data)[1], { id: '', name: 'Unknown', age: '--', sex: '--', mobile: '' });
});

test('demographics for the booking form', async () => {
  network();
  assert.deepEqual((await call('getPatientDemographics', [' demo0002 ', 'DESK'])).v,
    { success: true, message: '', data: { id: 'DEMO0002', name: 'Yamuna E', age: 64, sex: 'F', gender: 'F', mobile: 9876500002 } });
  assert.deepEqual((await call('getPatientDemographics', ['NOBODY', 'DESK'])).v, { success: true, data: null, message: '' });
});

test('the timeline of an outpatient: visits newest first, times in IST', async () => {
  const log = network();
  const { source, v } = await call('buildLongitudinalTimeline', ['demo0001', 'DESK']);
  assert.equal(source, 'supabase');
  assert.equal(v.success, true);
  assert.deepEqual(v.data.patient, { id: 'DEMO0001', name: 'Ilango N', age: 71, sex: 'M', mobile: 9876500001, email: 'ilango@example.org' });
  assert.deepEqual(v.data.events.map((e) => [e.apptId, e.date, e.followUp]),
    [['OP-2', '09-Oct-2026 | 05:40 PM', '16-Oct-2026'], ['OP-1', '01-Oct-2026 | 09:05 AM', 'None']]);
  assert.equal(v.data.events[0].vitals, JSON.stringify({ bp: '120/80', hr: 72 }));
  assert.equal(v.data.events[0].genExam, JSON.stringify({ Pallor: 'Absent' }));
  assert.equal(v.data.events[0].sysExam, JSON.stringify({ CVS: 'S1S2 heard' }));
  assert.deepEqual(log.audits.map((a) => [a.what, a.entityId]), [['Patient', 'demo0001']]);
  assert.deepEqual((await call('buildLongitudinalTimeline', ['NOBODY', 'DESK'])).v, { found: false, patient: {}, events: [] });
});

test('Apps Script answers when the Worker cannot be exact or may not answer', async () => {
  let log = network();
  assert.equal((await call('buildLongitudinalTimeline', ['DEMO0002', 'DESK'])).source, 'apps-script');   // an admission
  assert.equal(log.audits.length, 0);                                                                    // Apps Script audits it
  assert.equal((await call('buildLongitudinalTimeline', ['DEMO0001', 'NOEMR'])).source, 'apps-script'); // no emr.read
  assert.equal((await call('getAllPatients', ['NOBODY'])).source, 'apps-script');                     // unknown session
  assert.equal((await call('getAllPatients', ['DESK'], env({ EDGE_OFF: 'getAllPatients' }))).source, 'apps-script');
  assert.equal((await call('getAllPatients', ['DESK'], env({ EDGE_OFF: 'all' }))).source, 'apps-script');
  log = network({ auditFails: true });
  assert.equal((await call('getAllPatients', ['DESK'])).source, 'apps-script');                       // no audit, no answer
  const withDate = PATIENTS.concat([pat(5, 'DEMO0003', 'X', { $d: IST(2026, 1, 1) }, 'M', 1, '')]);
  network({ patients: withDate });
  assert.equal((await call('getAllPatients', ['DESK'])).source, 'apps-script');                       // a date in the Age column
});
