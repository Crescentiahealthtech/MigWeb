// The reads the Supabase Edge Function cresrx-reads answers by running the
// app's own Apps Script code (src/runner.js): what goes there, what it is
// sent, and what happens when it cannot answer. That its answers are Apps
// Script's own: MIGRATION tools/sbmirror.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { RUNNER } from '../src/runner.js';
import { FLUSH_AFTER, FLUSH_SOON } from '../src/app.js';

const EXEC = 'https://script.google.com/macros/s/AKfyTEST/exec';
const FN_URL = 'https://x.supabase.co/functions/v1/cresrx-reads';
const env = (more = {}) => ({ APP_EXEC_URL: EXEC, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x',
  SUPABASE_REGION: 'ap-south-1', ASSETS: { fetch: () => new Response('asset') }, ...more });
const ctx = { waitUntil() {} };
const body = (fn, args) => JSON.stringify({ fn, args });
const call = (fn, args) => new Request('https://migweb.example/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(fn, args) });

/** Apps Script and the Edge Function stood in for; `edge` answers the Edge Function's calls. */
function network(edge) {
  const log = { apps: [], edge: [] };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    const text = typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body);
    if (url === FN_URL) { log.edge.push({ text, headers: init.headers }); return edge(JSON.parse(text)); }
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

test('writes never go to the Edge Function; each Day 3 write copies what it changed before answering', async () => {
  for (const fn of ['saveOPEncounterScoped', 'saveIPNote', 'recordLedgerEntry', 'settleDischarge', 'addIPCrossConsult', 'saveConsultTemplate']) {
    assert.ok(!RUNNER.has(fn), fn);
    const log = network(() => { throw new Error('a write reached the Edge Function'); });
    await worker.fetch(call(fn, [{}, 'TOKEN']), env(), ctx);
    const spec = FLUSH_AFTER[fn];
    assert.deepEqual(log.apps[0].flush, Array.isArray(spec) ? spec : spec.sheets, fn);
  }
  // Every served name is a read (get…, list…, fetch…, check…, …Eligibility).
  for (const fn of RUNNER) assert.match(fn, /^(get|list|fetch|check)|Eligibility$/, fn);
});

test('a bill made at a counter not moved yet is copied just after its answer, in the background', async () => {
  const log = network(() => { throw new Error('a write reached the Edge Function'); });
  // The copy's call is held until released: the bill's answer must not wait for it.
  let release; const held = new Promise((r) => { release = r; });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(new TextDecoder().decode(init.body));
    if (b.fn === 'getAppBuild') { const out = await inner(url, init); await held; return out; }
    return inner(url, init);
  };
  const waits = [];
  const r = await worker.fetch(call('processPharmacyBill', [{ items: [] }, 'TOKEN']), env(), { waitUntil: (p) => waits.push(p) });
  assert.deepEqual((await r.json()).v, { from: 'apps-script', fn: 'processPharmacyBill' });          // answered, the copy still on its way
  assert.equal(waits.length, 1);
  release();
  await Promise.all(waits);
  assert.deepEqual(log.apps, [{ fn: 'processPharmacyBill', args: [{ items: [] }, 'TOKEN'] },
                              { fn: 'getAppBuild', args: [], flush: FLUSH_SOON.processPharmacyBill }]);
  // An old credit bill settled: its watched columns are compared too.
  await worker.fetch(call('settleCreditBill', [{ invoiceNo: 'PH-1' }, 'TOKEN']), env(), { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(log.apps.at(-1), { fn: 'getAppBuild', args: [], flush: FLUSH_SOON.settleCreditBill.sheets, flushOpts: { watch: true } });
  // Never both: a call is flushed before its answer or after it.
  for (const fn of Object.keys(FLUSH_SOON)) assert.ok(!FLUSH_AFTER[fn] && !RUNNER.has(fn), fn);
});
