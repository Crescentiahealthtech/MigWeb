// The app proxy (src/app.js) with Apps Script and Supabase stood in for.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const EXEC = 'https://script.google.com/macros/s/AKfyTEST/exec';
const IST = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - 330 * 60000;
const res = (header, rows) => ({ found: true, cols: header.length, header, last_row: rows.length + 1, synced_at: '2026-10-13T04:00:00Z',
  rows: rows.map((r, i) => [i + 2, r.vals || null, r.disp || null]) });

// A tiny workbook copy: two doctors, three appointments on 2026-10-13.
const DOCTORS = res(['Doctor_ID', 'Tenant_ID', 'Display_Name', 'Specialty', 'x', 'Signature', 'Linked_Username', 'Status'],
  [{ disp: ['DOC001', 'T', 'Dr. Meivasagam', 'GP', '', '', 'drmei', 'ACTIVE'] }, { disp: ['DOC002', 'T', 'Dr. DMO', 'Duty MO', '', '', 'drdmo', 'ACTIVE'] }]);
const day = { $d: IST(2026, 10, 13) };
const appt = (id, pid, name, time, status, doc) => ({ vals: [id, pid, name, day, time, 'Consultation', status, 300, doc],
  disp: [id, pid, name, '13/10/2026', time, 'Consultation', status, '300', doc] });
const APPTS = res(['Appt ID', 'Patient ID', 'Patient Name', 'Date', 'Time', 'Purpose', 'Status', 'Fee', 'Doctor_ID'],
  [appt('A1', 'DEMO0404', 'Ilango N', '12:19 PM', 'Booked', 'DOC001'), appt('A2', 'DEMO0031', 'Shankar C', '12:21 PM', 'Booked', 'DOC001'),
   appt('A3', 'DEMO0284', 'Yamuna E', '05:05 PM', 'Booked', 'DOC002')]);
const PATS = res(Array.from({ length: 12 }, (_, i) => 'c' + i),
  [{ disp: ['DEMO0404', '', '', '71', 'M', '', '', '', '', '', '', 'Mr'] }, { disp: ['DEMO0031', '', '', '49', 'M', '', '', '', '', '', '', 'Mr'] },
   { disp: ['DEMO0284', '', '', '64', 'F', '', '', '', '', '', '', 'Mrs'] }]);

const SESSIONS = {
  ADMIN: { success: true, username: 'crescentia', role: 'admin', doctorId: '', dutyMoIds: [], edge: true },
  DOC: { success: true, username: 'drmei', role: 'doctor', doctorId: 'DOC001', dutyMoIds: [], edge: true },
  OFF: { success: true, username: 'crescentia', role: 'admin', doctorId: '', dutyMoIds: [], edge: false }
};

// Stand-ins for the network: Apps Script's doPost and Supabase's REST.
function network() {
  const log = { apps: [], supabase: 0 };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith(EXEC + '?shell=1')) return new Response('<html><script>window.CRESC_BUILD="b1"</script>app</html>');
    if (url === EXEC) {
      const b = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
      log.apps.push(b);
      if (b.fn === 'getEdgeIdentity') return Response.json({ ok: true, v: SESSIONS[b.args[0]] || { success: false } });
      return Response.json({ ok: true, v: { from: 'apps-script', fn: b.fn } });
    }
    if (url.endsWith('/rest/v1/rpc/mirror_query')) { log.supabase++; return Response.json({ results: [DOCTORS, APPTS, PATS] }); }
    throw new Error('unexpected fetch ' + url);
  };
  return log;
}
const env = (more = {}) => ({ APP_EXEC_URL: EXEC, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x',
  ASSETS: { fetch: () => new Response('asset') }, ...more });
const ctx = { waitUntil() {} };
const call = (fn, args, headers = {}) => new Request('https://migweb.example/rpc', { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ fn, args }) });

test('/ serves the app page from the deployment, /rpc passes other calls through unchanged', async () => {
  const log = network();
  const page = await worker.fetch(new Request('https://migweb.example/'), env(), ctx);
  assert.match(await page.text(), /CRESC_BUILD/);
  const r = await worker.fetch(call('getPatientEMRHistory', ['DEMO0404', 'ADMIN']), env(), ctx);
  assert.deepEqual((await r.json()).v, { from: 'apps-script', fn: 'getPatientEMRHistory' });
  assert.equal(r.headers.get('x-cresrx-source'), 'apps-script');
  assert.equal(log.apps.at(-1).flush, undefined);
});

test('the Daily Ledger is answered from Supabase, with the session\'s scope', async () => {
  const log = network();
  let r = await worker.fetch(call('fetchDailyLedgerScoped', ['2026-10-13', '', 'ADMIN']), env(), ctx);
  assert.equal(r.headers.get('x-cresrx-source'), 'supabase');
  let v = (await r.json()).v;
  assert.equal(v.success, true);
  assert.deepEqual(v.ledger.map((x) => [x.time12, x.patientName, x.doctorName]),
    [['12:19 PM', 'Mr. Ilango N', 'Dr. Meivasagam'], ['12:21 PM', 'Mr. Shankar C', 'Dr. Meivasagam'], ['05:05 PM', 'Mrs. Yamuna E', 'Dr. DMO']]);
  assert.ok(v.edge && v.edge.syncedAt);
  assert.deepEqual(log.apps.map((b) => b.fn), ['getEdgeIdentity']);       // never fetchDailyLedgerScoped

  r = await worker.fetch(call('fetchDailyLedgerScoped', ['2026-10-13', '', 'DOC']), env(), ctx);
  v = (await r.json()).v;
  assert.deepEqual(v.ledger.map((x) => x.apptId), ['A1', 'A2']);          // a doctor sees their own
  r = await worker.fetch(call('fetchDailyLedgerScoped', ['2026-10-13', 'DOC002', 'DOC']), env(), ctx);
  assert.equal((await r.json()).v.success, false);                        // and not another's

  // The identity is remembered: a second load asks Apps Script nothing.
  const before = log.apps.length;
  await worker.fetch(call('fetchDailyLedgerScoped', ['2026-10-14', '', 'ADMIN']), env(), ctx);
  assert.equal(log.apps.length, before);
});

test('Apps Script answers the ledger when the copy is off, the session unknown, or the date odd', async () => {
  const log = network();
  for (const [args, e] of [[['2026-10-13', '', 'OFF'], env()], [['2026-10-13', '', 'NOBODY'], env()],
                           [['13/10/2026', '', 'ADMIN'], env()], [['2026-10-13', '', 'ADMIN'], env({ EDGE_LEDGER: 'off' })],
                           [['2026-10-13', '', 'ADMIN'], env({ SUPABASE_SECRET_KEY: '' })]]) {
    const r = await worker.fetch(call('fetchDailyLedgerScoped', args), e, ctx);
    assert.equal((await r.json()).v.from, 'apps-script', JSON.stringify(args));
  }
  assert.ok(log.apps.some((b) => b.fn === 'fetchDailyLedgerScoped'));
});

test('a status change or booking asks Apps Script to copy the ledger\'s sheets before answering', async () => {
  const log = network();
  for (const [fn, sheets] of [['updateAppointmentStatus', ['Appointments', 'Patients']], ['bookAppointmentScoped', ['Appointments', 'Patients']],
                              ['barcodeUpdateAppointment', ['Appointments', 'Patients']], ['registerPatient', ['Patients']],
                              ['processPatientDischarge', ['IP_Admissions']], ['saveIPNote', ['IP_Timeline_DB', 'IP_Pharmacy_Queue']],
                              ['recordLedgerEntry', ['Finance_Master_Ledger', 'Audit_Event_Ledger']]]) {
    await worker.fetch(call(fn, ['A1', 'Arrived', 'ADMIN']), env(), ctx);
    assert.deepEqual(log.apps.at(-1), { fn, args: ['A1', 'Arrived', 'ADMIN'], flush: sheets });
  }
  // The OP save marks every row it edits, so only those and its new rows
  // are copied (window 0); a bill settled weeks later reads the watched
  // columns too.
  await worker.fetch(call('saveOPEncounterScoped', [{ patientId: 'DEMO0404' }, 'DOC']), env(), ctx);
  assert.deepEqual(log.apps.at(-1), { fn: 'saveOPEncounterScoped', args: [{ patientId: 'DEMO0404' }, 'DOC'],
    flush: ['Appointments', 'OP_Encounters', 'Clinical_Templates'], flushOpts: { window: 0, watch: false } });
  await worker.fetch(call('settleReceivableBill', [{ billId: 'B1' }, 'ADMIN']), env(), ctx);
  assert.deepEqual(log.apps.at(-1).flushOpts, { watch: true });
});

test('/rpc refuses other sites and GET; nothing works without APP_EXEC_URL', async () => {
  network();
  let r = await worker.fetch(call('getAppBuild', [], { origin: 'https://evil.example' }), env(), ctx);
  assert.equal(r.status, 403);
  r = await worker.fetch(new Request('https://migweb.example/rpc'), env(), ctx);
  assert.equal(r.status, 405);
  r = await worker.fetch(call('getAppBuild', []), env({ APP_EXEC_URL: 'https://evil.example/exec' }), ctx);
  assert.equal(r.status, 503);
  r = await worker.fetch(new Request('https://migweb.example/'), env({ APP_EXEC_URL: '' }), ctx);
  assert.equal(r.status, 503);
});

test('a passed-through call goes byte for byte, and its answer comes back unread', async () => {
  const sent = [];
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (url, init = {}) => {
    sent.push(init.body);
    return new Response('{"ok":true,"v":"' + 'x'.repeat(200000) + '"}', { headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  // A body JSON.parse would choke on still goes through: nothing here parses it.
  const odd = '{"fn":"saveBigThing","args":[' + '1,'.repeat(50000) + '1]} ';
  const r = await worker.fetch(new Request('https://migweb.example/rpc', { method: 'POST', body: odd }), env(), ctx);
  assert.equal(new TextDecoder().decode(sent[0]), odd);
  assert.equal((await r.text()).length, 200000 + 18);
  assert.equal(r.headers.get('x-cresrx-source'), 'apps-script');
});

test('flush is added without parsing the body', async () => {
  const { fnOf, withFlush } = await import('../src/app.js');
  const b = new TextEncoder().encode('{"fn":"bookAppointmentScoped","args":[{"a":"}"},"T"]}\n');
  assert.equal(fnOf(b), 'bookAppointmentScoped');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(withFlush(b, ['Appointments']))),
    { fn: 'bookAppointmentScoped', args: [{ a: '}' }, 'T'], flush: ['Appointments'] });
  assert.equal(fnOf(new TextEncoder().encode('{"args":[],"fn":"x"}')), '');      // name not first: pass through untouched
});

test('the app page carries the migration badge, and /api/migration lists what has moved', async () => {
  network();
  const page = await (await worker.fetch(new Request('https://migweb.example/'), env(), ctx)).text();
  assert.match(page, /<script src="\/migration\/status.js"><\/script>/);
  const off = await (await worker.fetch(new Request('https://migweb.example/?v=2'), env({ MIGRATION_BADGE: 'off' }), ctx)).text();
  assert.doesNotMatch(off, /migration\/status.js/);
  const list = await (await worker.fetch(new Request('https://migweb.example/api/migration'), env(), ctx)).json();
  const done = list.screens.filter((s) => s.done).map((s) => s.label);
  assert.ok(done.includes('Appointments · Daily Ledger') && done.includes('Patients · search list and profile'));
  assert.ok(done.some((l) => /^Sign-in/.test(l)) && done.some((l) => /booking: slots/.test(l)));
  assert.ok(list.screens.some((s) => s.done && /Command Center/.test(s.label)));
  for (const re of [/^Finance Hub/, /^IP Notes/, /^OP consultation/, /^Hospital Billing/]) assert.ok(list.screens.some((s) => s.done && re.test(s.label)), String(re));
  assert.ok(list.screens.some((s) => !s.done && /^Pharmacy/.test(s.label)));
  // EDGE_OFF=runner: the screens the Edge Function answers go back to Apps Script; the Worker's own stay.
  const runnerOff = await (await worker.fetch(new Request('https://migweb.example/api/migration'), env({ EDGE_OFF: 'runner' }), ctx)).json();
  assert.ok(runnerOff.screens.some((s) => !s.done && /^Finance Hub/.test(s.label)));
  assert.ok(runnerOff.screens.some((s) => s.done && /Command Center/.test(s.label)));
  const none = await (await worker.fetch(new Request('https://migweb.example/api/migration'), env({ EDGE_OFF: 'all' }), ctx)).json();
  assert.equal(none.screens.filter((s) => s.done).length, 0);
});
