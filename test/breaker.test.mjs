// The circuit breaker in front of Apps Script (src/breaker.js) and the
// banner's headers, through the Worker as the page calls it.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { resetBreaker, gasResult, gasPaused, OPEN_MS, noteLag, healthHeaders } from '../src/breaker.js';

const EXEC = 'https://script.google.com/macros/s/AKfyTEST/exec';
const env = { APP_EXEC_URL: EXEC, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x',
  ASSETS: { fetch: () => new Response('asset') } };
const ctx = { waitUntil() {} };
const call = (fn) => new Request('https://w.example/rpc', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fn, args: ['T'] }) });

function network(apps) {
  const log = { apps: 0, waiting: 0 };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => true } };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url === EXEC) { log.apps++; return apps(); }
    if (url.endsWith('/rest/v1/rpc/edge_writes')) { log.waiting++; return Response.json({ n: 0 }); }
    if (url.endsWith('/rest/v1/rpc/session_get')) return Response.json({ identity: { username: 'u' }, age: 0, lag: 1500 });
    if (url.endsWith('/functions/v1/cresrx-reads')) return new Response('{"fallback":"t"}', { status: 409 });
    throw new Error('unexpected fetch ' + url);
  };
  return log;
}

test('three failures in a minute pause Apps Script: no more calls, no Supabase check, a clear answer', async () => {
  resetBreaker();
  const log = network(() => new Response('boom', { status: 500 }));
  for (let i = 0; i < 3; i++) await worker.fetch(call('someOldScreen'), env, ctx);
  assert.equal(log.apps, 3);
  const r = await worker.fetch(call('someOldScreen'), env, ctx);
  assert.equal(log.apps, 3, 'not sent while paused');
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('X-CresRx-Backup'), 'paused');
  const b = await r.json();
  assert.equal(b.ok, false);
  assert.match(b.e, /try this one again in a few minutes/);
  const waited = log.waiting;
  await worker.fetch(call('someOldScreen'), env, ctx);
  assert.equal(log.waiting, waited, 'Supabase is not asked about waiting saves while paused');
});

test('a good answer keeps it closed; after the pause one call is let through and closes it', async () => {
  resetBreaker();
  let ok = true;
  const log = network(() => ok ? Response.json({ ok: true, v: 1 }) : new Response('x', { status: 502 }));
  ok = false;
  await worker.fetch(call('a'), env, ctx);
  await worker.fetch(call('a'), env, ctx);
  ok = true;
  await worker.fetch(call('a'), env, ctx);          // resets the count
  ok = false;
  await worker.fetch(call('a'), env, ctx);
  assert.equal(await gasPaused(), false, 'two failures, a success between: not paused');
  await worker.fetch(call('a'), env, ctx);
  await worker.fetch(call('a'), env, ctx);
  assert.equal(await gasPaused(), true);
  const real = Date.now;
  try {
    Date.now = () => real() + OPEN_MS + 1000;
    ok = true;
    const before = log.apps;
    const r = await worker.fetch(call('a'), env, ctx);
    assert.equal(log.apps, before + 1);
    assert.equal((await r.json()).v, 1);
    assert.equal(await gasPaused(), false);
  } finally { Date.now = real; }
});

test('a quota error from doPost counts against Apps Script, and the answer still reaches the page', async () => {
  resetBreaker();
  network(() => new Response('{"quota":true,"ok":false,"e":"Service invoked too many times for one day: urlfetch.","n":"Exception"}',
    { headers: { 'Content-Type': 'application/json' } }));
  for (let i = 0; i < 2; i++) {
    const r = await worker.fetch(call('q'), env, ctx);
    assert.match((await r.json()).e, /too many times/);
  }
  assert.equal(await gasPaused(), false);
  await worker.fetch(call('q'), env, ctx);
  assert.equal(await gasPaused(), true);
});

test('slow answers count as failures', async () => {
  resetBreaker();
  gasResult(true, 30000); gasResult(true, 30000);
  assert.equal(await gasPaused(), false);
  gasResult(true, 30000);
  assert.equal(await gasPaused(), true);
  resetBreaker();
});

test('the page is given the banner script', async () => {
  resetBreaker();
  network(() => new Response('<html><head></head><script>window.CRESC_BUILD=\'abc123\'</script>app</html>', { headers: { 'Content-Type': 'text/html' } }));
  globalThis.fetch = (orig => async (url, init) => String(url).includes('?shell=1')
    ? new Response('<html><head></head><script>window.CRESC_BUILD=\'abc123\'</script>app</html>') : orig(url, init))(globalThis.fetch);
  const page = await worker.fetch(new Request('https://w.example/'), env, ctx);
  assert.match(await page.text(), /<script src="\/s\/backup.js"><\/script>/);
});

test('the banner headers: minutes behind from 15, nothing below, nothing once the news is old', async () => {
  resetBreaker();
  noteLag(14 * 60);
  assert.equal((await healthHeaders(new Response('x'))).headers.get('X-CresRx-Behind'), null);
  noteLag(42 * 60 + 30);
  assert.equal((await healthHeaders(new Response('x'))).headers.get('X-CresRx-Behind'), '42');
  const real = Date.now;
  try { Date.now = () => real() + 11 * 60 * 1000; assert.equal((await healthHeaders(new Response('x'))).headers.get('X-CresRx-Behind'), null); }
  finally { Date.now = real; resetBreaker(); }
});
