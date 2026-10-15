// The Command Center from its ready-made answer (src/snapshots.js via src/app.js).
// Exactness against Apps Script on the demo year: MIGRATION tools/sbmirror.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { splitSnapshot, redact } from '../src/snapshots.js';

const EXEC = 'https://script.google.com/macros/s/AKfyTEST/exec';
const DATA = { meta: { generatedAt: '14 Oct 2026 • 09:00 AM', financial: true }, census: { occupied: 4 },
  revenue: { consultToday: 1200, hospitalToday: 5000, pharmacyToday: 800, totalToday: 7000, pendingCredit: 300 },
  analytics: { revenueMix: [{ k: 'OP', v: 1 }], doctorLoad: [{ d: 'A', n: 3 }] }, footfall: [1, 2, 3] };
const SESS = {
  FIN: { permissions: ['dashboard.read', 'accounts.read'], uiHidden: {} },
  CLIN: { permissions: ['dashboard.read'], uiHidden: {} },
  HIDE: { permissions: ['dashboard.read', 'accounts.read'],
          uiHidden: { 'dash.kpi.revenue': ['revenue.consultToday', 'revenue.hospitalToday', 'revenue.pharmacyToday', 'revenue.totalToday'],
                      'dash.panel.doctors': ['analytics.doctorLoad'], 'acc.kpi.cash': ['kpis.drawerCash'] } },
  NONE: { permissions: ['patient.read'], uiHidden: {} }
};

function network({ age = 5000, stored = true, claim = true } = {}) {
  // A copy made `age` ms ago, but never before today's midnight in the clinic (a test at 00:01 IST stays "today").
  const sinceMidnight = (Date.now() + 330 * 60000) % 86400000;
  if (age < 86400000) age = Math.min(age, Math.max(0, sinceMidnight - 1000));
  const log = { apps: [], claims: [], keys: [] };
  const waits = [];
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    const body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
    if (url === EXEC) {
      log.apps.push(body);
      if (body.fn === 'getEdgeIdentity') {
        const s = SESS[body.args[0]];
        return Response.json({ ok: true, v: s ? { success: true, username: 'u', role: 'admin', doctorId: '', dutyMoIds: [], edge: true,
          actor: { username: 'u', role: 'admin', doctorId: '' }, ...s } : { success: false } });
      }
      return Response.json({ ok: true, v: { success: true, data: { from: 'apps-script' }, message: 'fresh' } });
    }
    if (url.endsWith('/rpc/snapshot_get')) {
      log.keys.push(body.p.key);
      // As PostgREST sends a jsonb answer: Postgres's own layout, spaces after colons.
      return new Response(stored ? '{"data": ' + JSON.stringify(DATA).replace(/":/g, '": ') + ', "made": ' + (Date.now() - age) + '}' : 'null',
                          { headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/rpc/snapshot_claim')) { log.claims.push(body.p.ms); return Response.json(claim); }
    if (url.endsWith('/rpc/session_get')) return new Response('null', { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/rpc/edge_writes')) return Response.json({ n: 0 });          // no save made in Supabase waiting
    throw new Error('unexpected fetch ' + url);
  };
  const ctx = { waitUntil: (p) => waits.push(p) };
  return { log, ctx, settle: () => Promise.all(waits) };
}
const env = (more = {}) => ({ APP_EXEC_URL: EXEC, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x',
  ASSETS: { fetch: () => new Response('asset') }, ...more });
const call = async (args, ctx, e = env()) => {
  const r = await worker.fetch(new Request('https://migweb.example/rpc', { method: 'POST', body: JSON.stringify({ fn: 'getDashboardData', args }) }), e, ctx);
  return { source: r.headers.get('x-cresrx-source'), age: r.headers.get('x-cresrx-age'), v: (await r.json()).v };
};

test('the stored answer is passed on as it is, for the right group, with its age', async () => {
  const { log, ctx } = network({ age: 12000 });
  const { source, age, v } = await call(['admin', false, 'FIN'], ctx);
  assert.equal(source, 'supabase');
  assert.equal(age, '12');
  assert.deepEqual(v, { success: true, data: DATA, message: 'snapshot', age: 12 });
  assert.deepEqual(log.keys, ['dash:FIN']);
  assert.equal(log.claims.length, 0);                                 // fresh enough: no refresh asked
  await call(['admin', false, 'CLIN'], ctx);
  assert.deepEqual(log.keys, ['dash:FIN', 'dash:CLIN']);              // no money: the clinical answer
});

test('each person\'s switched-off cards are taken out, as crescUiRedact_ does', async () => {
  const { ctx } = network();
  const { v } = await call(['admin', false, 'HIDE'], ctx);
  assert.deepEqual(v.data.revenue, { consultToday: null, hospitalToday: null, pharmacyToday: null, totalToday: null, pendingCredit: 300 });
  assert.deepEqual(v.data.analytics.doctorLoad, []);
  assert.deepEqual(v.data.uiRedacted, ['dash.kpi.revenue', 'dash.panel.doctors']);      // not the 'acc.' key
  assert.deepEqual(redact(DATA, {}, 'dash.'), DATA);
});

test('an answer over a minute old is served, and one refresh is asked of Apps Script in the background', async () => {
  let { log, ctx, settle } = network({ age: 90000 });
  const { source } = await call(['admin', false, 'FIN'], ctx);
  await settle();
  assert.equal(source, 'supabase');
  assert.deepEqual(log.claims, [60000]);
  assert.deepEqual(log.apps.filter((b) => b.fn === 'getDashboardData').map((b) => b.args), [['admin', true, 'FIN']]);
  ({ log, ctx, settle } = network({ age: 90000, claim: false }));     // someone else already asked
  await call(['admin', false, 'FIN'], ctx); await settle();
  assert.equal(log.apps.filter((b) => b.fn === 'getDashboardData').length, 0);
});

test('opening the screen and Refresh are answered from the copy too, and ask for a new one once it is 15 s old', async () => {
  let { log, ctx, settle } = network({ age: 20000 });
  const r = await call(['admin', true, 'FIN'], ctx);
  await settle();
  assert.equal(r.source, 'supabase');
  assert.equal(r.v.age, 20);                                          // the screen looks again when it is over 20 s
  assert.deepEqual(log.claims, [15000]);
  assert.deepEqual(log.apps.filter((b) => b.fn === 'getDashboardData').map((b) => b.args), [['admin', true, 'FIN']]);
  ({ log, ctx, settle } = network({ age: 2 * 3600000 }));             // hours old, still today: served, refreshed
  assert.equal((await call(['admin', true, 'FIN'], ctx)).source, 'supabase');
  await settle();
  assert.equal(log.claims.length, 1);
});

test('Apps Script answers when there is no copy, the copy is from an earlier day, or without dashboard.read', async () => {
  let { ctx, log, settle } = network({ stored: false });
  let r = await call(['admin', true, 'FIN'], ctx);
  assert.equal(r.source, 'apps-script');
  ({ ctx, log, settle } = network({ age: 2 * 86400000 }));
  const res = await worker.fetch(new Request('https://migweb.example/rpc', { method: 'POST',
    body: JSON.stringify({ fn: 'getDashboardData', args: ['admin', false, 'FIN'] }) }), env(), ctx);
  assert.equal(res.headers.get('x-cresrx-source'), 'apps-script');
  assert.equal(res.headers.get('x-cresrx-why'), 'the stored copy is from an earlier day');
  await settle();
  assert.equal(log.claims.length, 0);                                 // and no refresh asked on top
  ({ ctx } = network());
  assert.equal((await call(['admin', false, 'NONE'], ctx)).source, 'apps-script');
  assert.equal((await call(['admin', false, 'FIN'], ctx, env({ EDGE_OFF: 'getDashboardData' }))).source, 'apps-script');
});

test('the stored text is split without parsing, whatever its spacing', () => {
  assert.deepEqual(splitSnapshot('{"data": {"a": [1, 2]}, "made": 5}'), { dataText: '{"a": [1, 2]}', made: 5 });
  assert.deepEqual(splitSnapshot('{"data":{"a":1},"made":7}'), { dataText: '{"a":1}', made: 7 });
  assert.deepEqual(splitSnapshot('{"made": 9, "data": {"a": 1}}'), { dataText: '{"a":1}', made: 9 });
  assert.equal(splitSnapshot('null'), null);
});
