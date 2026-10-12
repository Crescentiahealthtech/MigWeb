// ============================================================================
// migweb — the CresRx web front, moving off Apps Script one screen at a time.
// ----------------------------------------------------------------------------
//   /            the existing app (public/index.html, the Apps Script web app)
//   /ledger/     the appointment ledger, served from here and read from
//                Supabase — no Apps Script in the path
//   /api/ledger  its data: GET ?date=yyyy-MM-dd&doctor=DOC001
//   /api/health  is the Worker up, can it reach Supabase
//
// Settings (Cloudflare → Workers → migweb → Settings → Variables and Secrets):
//   SUPABASE_SECRET_KEY  secret: the project's sb_secret_… key (server-side only)
//   ALLOWED_EMAILS       secret or text: Google accounts allowed in during the
//                        pilot, comma-separated. Empty = nobody. (The Apps Script
//                        app also asks for an authenticator code; this pilot
//                        does not yet, so it is limited to named people.)
//   SUPABASE_URL, FIREBASE_PROJECT_ID   in wrangler.jsonc
//
// Read-only: Google Sheets is still the system of record, and the copy in
// Supabase is kept current by Apps Script (Supabase_Mirror.gs) every minute.
// ============================================================================

import { verifyFirebaseToken } from './auth.js';
import { ledgerQueries, buildLedger, doctorsFrom, staffFromUsers, resolveScope, dayKey, todayIST } from './ledger.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
             'x-content-type-options': 'nosniff' }
});

async function rpc(env, fn, p) {
  const key = env.SUPABASE_SECRET_KEY || '';
  const headers = { apikey: key, 'content-type': 'application/json' };
  if (!/^sb_/.test(key)) headers.authorization = 'Bearer ' + key;     // a legacy service_role JWT
  const res = await fetch(env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers, body: JSON.stringify(p === undefined ? {} : { p })
  });
  if (!res.ok) throw new Error('Supabase ' + fn + ' answered ' + res.status);
  return res.json();
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/ledger' && request.method === 'GET') return await ledger(request, env);
      if (url.pathname === '/api/health') {
        const t0 = Date.now();
        let supabase = 'not configured';
        if (env.SUPABASE_SECRET_KEY) {
          try { await rpc(env, 'mirror_query', { queries: [] }); supabase = 'ok'; } catch (e) { supabase = e.message; }
        }
        return json({ ok: true, supabase, ms: Date.now() - t0 });
      }
      if (url.pathname.startsWith('/api/')) return json({ success: false, message: 'Not found.' }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      // No detail to the browser: it can carry an ID. Cloudflare's logs have it.
      console.error(url.pathname, e && e.stack || e);
      return json({ success: false, message: 'The server could not answer. Try again.' }, 502);
    }
  }
};
