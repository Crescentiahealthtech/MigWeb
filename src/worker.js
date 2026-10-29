// ============================================================================
// migweb — the CresRx web front, moving off Apps Script one screen at a time.
// ----------------------------------------------------------------------------
//   /            the whole app, served from here (src/app.js): its page and
//   /rpc         its server calls go to Apps Script as on the clinic's
//                address today, except the Daily Ledger's, which is
//                answered here from Supabase
//   /ledger/     a stand-alone read-only ledger with Google sign-in
//   /api/ledger  its data: GET ?date=yyyy-MM-dd&doctor=DOC001
//   /api/health  is the Worker up, can it reach Supabase and Apps Script
//   /api/lab/import  POST from the lab extension (extension/): a TN HMIS lab
//                report's text → parsed rows, saved to Supabase on save:true
//
// Settings (Cloudflare → Workers → migweb → Settings → Variables and Secrets):
//   APP_EXEC_URL         the Apps Script deployment's …/exec address (the
//                        same one the clinic's address uses)
//   SUPABASE_SECRET_KEY  secret: the project's sb_secret_… key (server-side only)
//   ALLOWED_EMAILS       for /ledger/ only: Google accounts allowed in,
//                        comma-separated. Empty = nobody.
//   LAB_IMPORT_KEY       secret: the key the lab extension sends (X-Lab-Key).
//                        Empty = /api/lab/import is off.
//   EDGE_LEDGER          "off" sends the app's Daily Ledger to Apps Script too
//   SUPABASE_URL, FIREBASE_PROJECT_ID   in wrangler.jsonc
//
// Google Sheets is still the system of record; the copy in Supabase is kept
// current by Apps Script (Supabase_Mirror.gs).
// ============================================================================

import { verifyFirebaseToken } from './auth.js';
import { ledgerQueries, buildLedger, doctorsFrom, staffFromUsers, resolveScope, dayKey, todayIST } from './ledger.js';
import { parseLabReport } from './labparse.js';
import { rpc as appRpc, shell, notSetUp, hasApp, migrationStatus } from './app.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
             'x-content-type-options': 'nosniff' }
});

async function rpc(env, fn, p, raw) {
  const key = env.SUPABASE_SECRET_KEY || '';
  const headers = { apikey: key, 'content-type': 'application/json' };
  if (!/^sb_/.test(key)) headers.authorization = 'Bearer ' + key;     // a legacy service_role JWT
  const res = await fetch(env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers, body: JSON.stringify(p === undefined ? {} : { p })
  });
  if (!res.ok) throw new Error('Supabase ' + fn + ' answered ' + res.status);
  return raw ? res.text() : res.json();     // raw: the reply's text, for an answer passed on unparsed
}

async function signedIn(request, env) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  const who = await verifyFirebaseToken(m ? m[1] : '', env.FIREBASE_PROJECT_ID);
  if (!who.ok) return { status: 401, body: { success: false, message: who.message } };
  const allowed = String(env.ALLOWED_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (!allowed.includes(who.email)) {
    return { status: 403, body: { success: false, message: who.email + ' is not on this pilot\'s list (ALLOWED_EMAILS).' } };
  }
  return { who };
}

async function ledger(request, env) {
  const t0 = Date.now();
  const auth = await signedIn(request, env);
  if (!auth.who) return json(auth.body, auth.status);
  const url = new URL(request.url);
  const date = dayKey(url.searchParams.get('date')) || todayIST();
  const res = await rpc(env, 'mirror_query', { queries: ledgerQueries(date) });
  const [users, doctorsRes, appointments, patients] = res.results;
  const staff = staffFromUsers(users, auth.who.email);
  if (!staff.ok) return json({ success: false, message: staff.message }, 403);
  const doctors = doctorsFrom(doctorsRes);
  const scope = resolveScope(staff, doctors, url.searchParams.get('doctor') || '');
  const out = buildLedger({ appointments, patients, doctors, scope, dateKey: date });
  if (!out.success) return json(out, 403);
  out.me = { email: auth.who.email, username: staff.username, role: staff.role };
  out.doctors = doctors.filter((d) => d.status === 'ACTIVE' &&
    (resolveScope(staff, doctors, '').mode === 'ALL' || d.doctorId === scope.selfDoctorId))
    .map((d) => ({ doctorId: d.doctorId, name: d.name }));
  out.syncedAt = appointments && appointments.synced_at;
  out.serverMs = Date.now() - t0;
  return json(out);
}

// The extension sends the report's text; this parses it and, on save, stores
// it (lab_import: one row per test, re-sending a report updates its rows).
async function labImport(request, env) {
  const key = String(env.LAB_IMPORT_KEY || '');
  if (key.length < 16 || request.headers.get('x-lab-key') !== key) {
    return json({ success: false, message: 'Wrong or missing lab key (extension Options).' }, 401);
  }
  const body = await request.json().catch(() => null);
  const text = body && typeof body.text === 'string' ? body.text : '';
  if (!text || text.length > 200000) return json({ success: false, message: 'No report text.' }, 400);
  const report = parseLabReport(text);
  if (!report.orderNo || !report.patient.pin || !report.results.length) {
    return json({ success: false, message: 'This does not look like a TN HMIS lab report (no PIN, Order No or results).', report }, 422);
  }
  if (!body.save) return json({ success: true, saved: false, report });
  const by = String(body.by || '').slice(0, 80), source = String(body.source || '').slice(0, 500);
  const saved = await rpc(env, 'lab_import', { report, by, source });
  return json({ success: true, saved: true, rows: saved, report });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/ledger' && request.method === 'GET') return await ledger(request, env);
      if (url.pathname === '/api/health') {
        const t0 = Date.now();
        let supabase = 'not configured';
        if (env.SUPABASE_SECRET_KEY) {
          try { await rpc(env, 'mirror_query', { queries: [] }); supabase = 'ok'; } catch (e) { supabase = e.message; }
        }
        return json({ ok: true, supabase, app: hasApp(env) ? 'set' : 'APP_EXEC_URL not set',
                      edgeLedger: String(env.EDGE_LEDGER || '').toLowerCase() === 'off' ? 'off' : 'on', ms: Date.now() - t0 });
      }
      if (url.pathname === '/api/lab/import' && request.method === 'POST') return await labImport(request, env);
      if (url.pathname === '/api/migration') return json(migrationStatus(env));   // TEMPORARY: the status badge's list
      if (url.pathname.startsWith('/api/')) return json({ success: false, message: 'Not found.' }, 404);
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' } });
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204, headers: { 'Cache-Control': 'public, max-age=86400' } });
      if (url.pathname === '/rpc') {
        if (!hasApp(env)) return json({ ok: false, e: 'The app address is not set up on this server yet (APP_EXEC_URL).' }, 503);
        return await appRpc(request, env, ctx, (fn, p, raw) => rpc(env, fn, p, raw));
      }
      if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        return hasApp(env) ? await shell(request, env, ctx) : notSetUp();
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      // No detail to the browser: it can carry an ID. Cloudflare's logs have it.
      console.error(url.pathname, e && e.stack || e);
      return json({ success: false, message: 'The server could not answer. Try again.' }, 502);
    }
  }
};
