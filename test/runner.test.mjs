// The reads the Supabase Edge Function cresrx-reads answers by running the
// app's own Apps Script code (src/runner.js): what goes there, what it is
// sent, and what happens when it cannot answer. That its answers are Apps
// Script's own: MIGRATION tools/sbmirror.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { RUNNER, WRITER, recover } from '../src/runner.js';
import { FLUSH_AFTER, FLUSH_SOON, EDGE, withDrain } from '../src/app.js';

const EXEC = 'https://script.google.com/macros/s/AKfyTEST/exec';
const FN_URL = 'https://x.supabase.co/functions/v1/cresrx-reads';
const env = (more = {}) => ({ APP_EXEC_URL: EXEC, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x',
  SUPABASE_REGION: 'ap-south-1', ASSETS: { fetch: () => new Response('asset') }, ...more });
const ctx = { waitUntil() {} };
const body = (fn, args) => JSON.stringify({ fn, args });
const call = (fn, args) => new Request('https://migweb.example/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(fn, args) });

const LOG_URL = 'https://x.supabase.co/rest/v1/rpc/edge_writes';
/**
 * Apps Script and the Edge Function stood in for; `edge` answers the Edge
 * Function's calls, `saves` the save log's (edge_writes: {pending} and {status}).
 */
function network(edge, saves) {
  const log = { apps: [], edge: [], saves: [] };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    const text = typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body);
    if (url === FN_URL) { log.edge.push({ text, headers: init.headers }); return edge(JSON.parse(text), init.headers); }
    if (url === LOG_URL) { const p = JSON.parse(text).p; log.saves.push(p); return Response.json(saves ? saves(p) : (p.pending ? { n: 0 } : { found: false })); }
    if (url === EXEC) { const b = JSON.parse(text); log.apps.push(b); return Response.json({ ok: true, v: { from: 'apps-script', fn: b.fn } }); }
    throw new Error('unexpected fetch ' + url);
  };
  return log;
}

test('a read the Edge Function serves goes there as the page sent it, and its answer comes back', async () => {
  const log = network(() => new Response('{"ok":true,"v":{"rows":[1,2,3]}}', { headers: { 'x-cresrx-runs': '1', 'content-type': 'application/json' } }));
  const r = await worker.fetch(call('getIPTimeline', ['IP-2026-0001', 'TOKEN']), env(), ctx);
  assert.deepEqual(await r.json(), { ok: true, v: { rows: [1, 2, 3] } });
  assert.equal(r.headers.get('x-cresrx-source'), 'supabase');
  assert.equal(r.headers.get('x-cresrx-via'), 'app code on Supabase');
  assert.equal(r.headers.get('x-cresrx-runs'), '1');
  assert.equal(log.apps.length, 0);
  assert.equal(log.edge[0].text, body('getIPTimeline', ['IP-2026-0001', 'TOKEN']));            // byte for byte
  assert.equal(log.edge[0].headers.apikey, 'sb_secret_x');
  assert.equal(log.edge[0].headers['x-region'], 'ap-south-1');                                // run beside the database
});

test('when the Edge Function cannot answer exactly, Apps Script does, and the badge is told why', async () => {
  for (const [edge, why] of [
    [() => new Response('{"fallback":"a write (setValue)"}', { status: 409, headers: { 'x-cresrx-why': 'a write (setValue)' } }), 'a write (setValue)'],
    [() => new Response('not found', { status: 404 }), 'the reads service is not deployed'],
    [() => new Response('boom', { status: 500 }), 'the reads service answered 500'],
    [() => { throw new TypeError('network down'); }, 'the reads service could not be reached']]) {
    const log = network(edge);
    const r = await worker.fetch(call('getAccountsDashboard', ['TOKEN']), env(), ctx);
    assert.deepEqual((await r.json()).v, { from: 'apps-script', fn: 'getAccountsDashboard' });
    assert.equal(r.headers.get('x-cresrx-source'), 'apps-script');
    assert.equal(r.headers.get('x-cresrx-why'), why);
    assert.equal(log.edge.length, 1);
    assert.deepEqual(log.apps[0], { fn: 'getAccountsDashboard', args: ['TOKEN'] });             // no flush: a read
  }
});

test('EDGE_OFF=runner, EDGE_OFF=<name>, EDGE_OFF=all and no key leave the reads to Apps Script', async () => {
  for (const [e, fn, asked] of [[env({ EDGE_OFF: 'runner' }), 'getIPNotesBundle', false], [env({ EDGE_OFF: 'getIPNotesBundle' }), 'getIPNotesBundle', false],
                                [env({ EDGE_OFF: 'getIPNotesBundle' }), 'getIPTimeline', true], [env({ EDGE_OFF: 'all' }), 'getComposerContext', false],
                                [env({ SUPABASE_SECRET_KEY: '' }), 'getComposerContext', false]]) {
    const log = network(() => new Response('{"ok":true,"v":1}'));
    const r = await worker.fetch(call(fn, ['X', 'TOKEN']), e, ctx);
    assert.equal(log.edge.length, asked ? 1 : 0, fn + ' ' + JSON.stringify(e.EDGE_OFF));
    if (!asked) assert.equal(r.headers.get('x-cresrx-why'), 'switched off (EDGE_OFF)');
  }
});

test('saves kept with Apps Script never go to the Edge Function; each copies what it changed before answering', async () => {
  for (const fn of ['crescChangePassword', 'crescAdminResetPassword', 'ds_sign', 'declareVisitingConsultant', 'endVisitingConsultant', 'lockFinancialPeriod']) {
    assert.ok(!RUNNER.has(fn) && !WRITER.has(fn), fn);
    const log = network(() => { throw new Error('a write reached the Edge Function'); });
    await worker.fetch(call(fn, [{}, 'TOKEN']), env(), ctx);
    const spec = FLUSH_AFTER[fn];
    assert.deepEqual(log.apps[0].flush, Array.isArray(spec) ? spec : spec.sheets, fn);
  }
  // A save the Edge Function refuses (nothing written) is Apps Script's, copied as before.
  for (const fn of ['saveOPEncounterScoped', 'saveConsultTemplate', 'hb_saveInvoice', 'hb_recordPayment', 'hb_cancelInvoice', 'hb_changePaymentMode',
                    'hb_dismissOrder', 'updateAppointmentStatus', 'registerPatient', 'saveIPNote', 'recordLedgerEntry', 'settleDischarge',
                    'processPharmacyBill', 'collectLabSample', 'saveIPDiabeticEntry', 'crescSetAccountActive']) {
    assert.ok(WRITER.has(fn) && !RUNNER.has(fn), fn);
    const log = network(() => new Response('{"fallback":"x"}', { status: 409, headers: { 'x-cresrx-why': 'a write: Appointments.deleteRow' } }));
    const r = await worker.fetch(call(fn, [{}, 'TOKEN']), env(), ctx);
    assert.equal(log.edge.length, 1, fn);
    const spec = FLUSH_AFTER[fn];
    assert.deepEqual(log.apps[0].flush, Array.isArray(spec) ? spec : spec.sheets, fn);
    assert.equal(r.headers.get('x-cresrx-why'), 'a write: Appointments.deleteRow');
  }
  // Every read served is a read (get…, list…, fetch…, check…, search…, preview…, suggest…, build…, lookup…, a print, …Eligibility).
  // Named otherwise and reads all the same (MIGRATION tools/sbmirror.js runs each): the access overview, the
  // administrator's scope, the privacy console's consent queue, summary and breach notice.
  for (const fn of RUNNER) assert.match(fn, /^(hb_|mc|ds_)?(get|Get|list|fetch|check|search|preview|suggest|build|lookup|verify|resolve|portal|labList)|^mtPrint|Eligibility$|^(crescGetAccessOverview|crescUserAdminScope|dpdpConsentQueue|dpdpConsoleSnapshot|dpdpBreachNotice)$/, fn);
});

test('a write listed to copy in the background is copied just after its answer (none is, since Day 6)', async () => {
  assert.deepEqual(Object.keys(FLUSH_SOON), []);
  FLUSH_SOON.collectAndBillLabSample = ['LAB_BILLING', 'IP_Charges'];
  FLUSH_SOON.settleLabBillBalance = { sheets: ['LAB_BILLING'], watch: true };
  const after = { a: FLUSH_AFTER.collectAndBillLabSample, b: FLUSH_AFTER.settleLabBillBalance };
  delete FLUSH_AFTER.collectAndBillLabSample; delete FLUSH_AFTER.settleLabBillBalance;
  try {
  const log = network(() => { throw new Error('a write reached the Edge Function'); });
  // The copy's call is held until released: the bill's answer must not wait for it.
  let release; const held = new Promise((r) => { release = r; });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === LOG_URL) return inner(url, init);
    const b = JSON.parse(new TextDecoder().decode(init.body));
    if (b.fn === 'getAppBuild') { const out = await inner(url, init); await held; return out; }
    return inner(url, init);
  };
  const waits = [];
  // (Made in Supabase since Phase W: saves there switched off, so Apps Script makes it.)
  const r = await worker.fetch(call('collectAndBillLabSample', [{ items: [] }, 'TOKEN']), env({ EDGE_OFF: 'writes' }), { waitUntil: (p) => waits.push(p) });
  assert.deepEqual((await r.json()).v, { from: 'apps-script', fn: 'collectAndBillLabSample' });      // answered, the copy still on its way
  assert.equal(waits.length, 1);
  release();
  await Promise.all(waits);
  assert.deepEqual(log.apps, [{ fn: 'collectAndBillLabSample', args: [{ items: [] }, 'TOKEN'] },
                              { fn: 'getAppBuild', args: [], flush: FLUSH_SOON.collectAndBillLabSample }]);
  // An old lab bill settled: its watched columns are compared too.
  await worker.fetch(call('settleLabBillBalance', [{ billId: 'LB-1' }, 'TOKEN']), env({ EDGE_OFF: 'writes' }), { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(log.apps.at(-1), { fn: 'getAppBuild', args: [], flush: FLUSH_SOON.settleLabBillBalance.sheets, flushOpts: { watch: true } });
  // Never both: a call is flushed before its answer or after it.
  for (const fn of Object.keys(FLUSH_SOON)) assert.ok(!FLUSH_AFTER[fn] && !RUNNER.has(fn), fn);
  } finally {
    delete FLUSH_SOON.collectAndBillLabSample; delete FLUSH_SOON.settleLabBillBalance;
    FLUSH_AFTER.collectAndBillLabSample = after.a; FLUSH_AFTER.settleLabBillBalance = after.b;
  }
});

test('a save of groups A-J is made by the Edge Function: one call id, its answer back, then the Sheet asked to take it', async () => {
  const log = network(() => new Response('{"ok":true,"v":{"success":true,"invoiceNo":"HB-2610-0001"}}',
    { headers: { 'x-cresrx-wrote': '41', 'x-cresrx-ms': '640', 'content-type': 'application/json' } }));
  const waits = [];
  const r = await worker.fetch(call('hb_saveInvoice', ['TOKEN', { patientId: 'DEMO0001' }]), env(), { waitUntil: (p) => waits.push(p) });
  assert.deepEqual(await r.json(), { ok: true, v: { success: true, invoiceNo: 'HB-2610-0001' } });
  assert.equal(r.headers.get('x-cresrx-source'), 'supabase');
  assert.equal(r.headers.get('x-cresrx-via'), 'saved in Supabase');
  assert.equal(r.headers.get('x-cresrx-wrote'), '41');
  assert.equal(log.edge[0].text, body('hb_saveInvoice', ['TOKEN', { patientId: 'DEMO0001' }]));        // byte for byte
  assert.match(log.edge[0].headers['x-cresrx-call'], /^[0-9a-f-]{36}$/);                               // its call id
  assert.equal(log.apps.filter((b) => b.fn === 'hb_saveInvoice').length, 0);                          // not made by Apps Script
  await Promise.all(waits);
  assert.deepEqual(log.apps, [{ fn: 'getAppBuild', args: [], drain: true }]);                          // the Sheet takes it now
  // A second save: a new call id.
  await worker.fetch(call('bookAppointmentScoped', [{ doctorId: 'DOC001' }, 'TOKEN']), env(), ctx);
  assert.notEqual(log.edge[1].headers['x-cresrx-call'], log.edge[0].headers['x-cresrx-call']);
});

test('a save whose answer is lost is answered from the log, never made again; unsure, the person is told to check', async () => {
  // The connection dropped after the commit: closing the call finds it made, with its answer.
  let log = network(() => { throw new TypeError('connection reset'); }, (p) => (p.fence ? { found: true, seq: 7, answer: { success: true, apptId: 'APT-1' } } : { n: 1 }));
  let r = await worker.fetch(call('submitNewAppointment', [{ patientId: 'DEMO0001' }, 'TOKEN']), env(), ctx);
  assert.deepEqual(await r.json(), { ok: true, v: { success: true, apptId: 'APT-1' } });
  assert.equal(r.headers.get('x-cresrx-via'), 'saved in Supabase (answer from its log)');
  assert.equal(log.saves[0].fence, log.edge[0].headers['x-cresrx-call']);                              // closed by its call id
  assert.equal(log.apps.filter((b) => b.fn === 'submitNewAppointment').length, 0);
  // Not made: closed, so it cannot be any more, and Apps Script makes it at once.
  log = network(() => new Response('boom', { status: 502 }), (p) => (p.fence ? { fenced: true } : { n: 0 }));
  r = await worker.fetch(call('hb_saveInvoice', ['TOKEN', { patientId: 'DEMO0001' }]), env(), ctx);
  assert.deepEqual((await r.json()).v, { from: 'apps-script', fn: 'hb_saveInvoice' });
  assert.equal(r.headers.get('x-cresrx-why'), 'the save service did not answer');
  assert.ok(log.saves.some((p) => p.fence));
  // The Edge Function could not tell whether its commit landed, and closing finds it closed by an earlier try.
  log = network(() => new Response('{"unsure":true}', { status: 503, headers: { 'x-cresrx-unsure': '1' } }), (p) => (p.fence ? { found: true, fenced: true } : { n: 0 }));
  r = await worker.fetch(call('hb_recordPayment', ['TOKEN', 'HB-1', 100, 'Cash', '']), env(), ctx);
  assert.equal(log.apps.filter((b) => b.fn === 'hb_recordPayment').length, 1);
  // Supabase cannot be asked at all: the person is told to check, and nothing makes it again.
  log = network(() => { throw new TypeError('down'); }, () => { throw new Error('down'); });
  globalThis.fetch = ((inner) => async (url, init) => { if (String(url) === LOG_URL) throw new TypeError('down'); return inner(url, init); })(globalThis.fetch);
  r = await worker.fetch(call('hb_recordPayment', ['TOKEN', 'HB-1', 100, 'Cash', '']), env(), ctx);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.match(j.e, /could not be confirmed/);
  assert.equal(log.apps.filter((b) => b.fn === 'hb_recordPayment').length, 0);
  assert.deepEqual(await recover(env(), 'call-zzzz'), { unsure: true });
});

test('EDGE_OFF=writes (or the save\'s name) sends saves to Apps Script, reads still on Supabase; saves waiting go into the Sheet first', async () => {
  for (const e of [env({ EDGE_OFF: 'writes' }), env({ EDGE_OFF: 'hb_saveInvoice' }), env({ EDGE_OFF: 'all' })]) {
    const log = network(() => { throw new Error('a save reached the Edge Function'); });
    const r = await worker.fetch(call('hb_saveInvoice', ['TOKEN', {}]), e, ctx);
    assert.equal(log.edge.length, 0);
    assert.equal(r.headers.get('x-cresrx-why'), 'switched off (EDGE_OFF)');
    assert.equal(log.apps[0].fn, 'hb_saveInvoice');
  }
  const log = network(() => new Response('{"ok":true,"v":1}'));
  await worker.fetch(call('getIPTimeline', ['IP1', 'TOKEN']), env({ EDGE_OFF: 'writes' }), ctx);
  assert.equal(log.edge.length, 1);                                                                     // reads stay
  // Two saves made in Supabase still waiting: the call Apps Script answers carries "drain".
  const l2 = network(() => { throw new Error('no'); }, (p) => (p.pending ? { n: 2 } : { found: false }));
  await worker.fetch(call('hb_saveInvoice', ['TOKEN', {}]), env({ EDGE_OFF: 'writes' }), ctx);
  assert.equal(l2.apps[0].drain, true);
  assert.deepEqual(l2.apps[0].flush, FLUSH_AFTER.hb_saveInvoice.sheets);
  // The log not answering: Apps Script is asked to look for itself.
  const l3 = network(() => { throw new Error('no'); }, () => { throw new Error('log down'); });
  globalThis.fetch = ((inner) => async (url, init) => (String(url) === LOG_URL ? new Response('', { status: 500 }) : inner(url, init)))(globalThis.fetch);
  await worker.fetch(call('getPatientEMRHistory', ['DEMO0001', 'TOKEN']), env(), ctx);
  assert.equal(l3.apps.at(-1).drain, true);
  // drain is added without parsing the body.
  const b = new TextEncoder().encode('{"fn":"x","args":[{"a":"}"}],"flush":["T"]} ');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(withDrain(b))), { fn: 'x', args: [{ a: '}' }], flush: ['T'], drain: true });
});

test('the saves the Worker sends are groups A-K, none a read; the ones that need what never leaves Google are not among them', () => {
  for (const fn of WRITER) assert.ok(!RUNNER.has(fn) && FLUSH_AFTER[fn], fn + ' copies as before if Apps Script makes it');
  for (const fn of ['crescChangePassword', 'crescAdminResetPassword', 'ds_sign', 'declareVisitingConsultant', 'endVisitingConsultant', 'lockFinancialPeriod']) assert.ok(!WRITER.has(fn), fn);
  for (const fn of ['registerPatient', 'deletePhraseTemplate', 'saveIPNote', 'settleDischarge', 'processPharmacyBill', 'collectLabSample', 'ds_initiateDischarge', 'recordConsent']) assert.ok(WRITER.has(fn), fn);
  assert.equal(WRITER.size, 131);
});

test('an admitted patient\'s timeline, which the Worker\'s own port leaves, goes to the Edge Function before Apps Script', async () => {
  // Supabase's REST calls are not stood in for here: the Worker's port cannot
  // answer, so the runner is asked, and it answers.
  const log = network(() => new Response('{"ok":true,"v":{"found":true,"events":[1]}}', { headers: { 'x-cresrx-ms': '120', 'x-cresrx-load-ms': '0' } }));
  const r = await worker.fetch(call('buildLongitudinalTimeline', ['DEMO0002', 'TOKEN']), env(), ctx);
  assert.deepEqual(await r.json(), { ok: true, v: { found: true, events: [1] } });
  assert.equal(r.headers.get('x-cresrx-via'), 'app code on Supabase');
  assert.equal(r.headers.get('x-cresrx-ms'), '120');
  assert.equal(log.edge.length, 1);
  assert.ok(log.apps.every((b) => b.fn !== 'buildLongitudinalTimeline'));      // Apps Script is asked who the session is, nothing more
  // Switched off by name: neither the port nor the runner.
  const off = network(() => { throw new Error('reached the Edge Function'); });
  const r2 = await worker.fetch(call('buildLongitudinalTimeline', ['DEMO0002', 'TOKEN']), env({ EDGE_OFF: 'buildLongitudinalTimeline' }), ctx);
  assert.equal(r2.headers.get('x-cresrx-source'), 'apps-script');
  assert.equal(off.edge.length, 0);
});

test('a session stored over ten minutes ago is re-checked by Apps Script after the answer, once a minute at most', async () => {
  const log = network(() => new Response('{"ok":true,"v":1}', { headers: { 'x-cresrx-refresh': '1' } }));
  const waits = [];
  const c = { waitUntil: (p) => waits.push(p) };
  const r = await worker.fetch(call('getIPTimeline', ['IP-1', 'TOKEN-OLD']), env(), c);
  assert.equal(r.headers.get('x-cresrx-source'), 'supabase');
  await Promise.all(waits);
  assert.deepEqual(log.apps, [{ fn: 'getEdgeIdentity', args: ['TOKEN-OLD'] }]);
  await worker.fetch(call('getIPTimeline', ['IP-1', 'TOKEN-OLD']), env(), c);
  await Promise.all(waits);
  assert.equal(log.apps.length, 1);                                    // not again within the minute
  const fresh = network(() => new Response('{"ok":true,"v":1}'));
  await worker.fetch(call('getIPTimeline', ['IP-1', 'TOKEN-NEW']), env(), c);
  await Promise.all(waits);
  assert.equal(fresh.apps.length, 0);                                  // a recent session: nothing asked
});

test('the rollback: EDGE_OFF=all sends every moved read back to Apps Script, and nothing reaches Supabase', async () => {
  // network() throws on any other address: a call to Supabase's REST API or
  // to the Edge Function would fail this test.
  for (const fn of [...RUNNER, ...Object.keys(EDGE)]) {
    const log = network(() => { throw new Error(fn + ' reached the Edge Function'); });
    const r = await worker.fetch(call(fn, ['X', 'TOKEN']), env({ EDGE_OFF: 'all' }), ctx);
    assert.deepEqual((await r.json()).v, { from: 'apps-script', fn }, fn);
    assert.equal(r.headers.get('x-cresrx-source'), 'apps-script', fn);
    assert.equal(log.edge.length, 0, fn);
  }
});
