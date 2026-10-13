// ============================================================================
// The whole CresRx app from this address, with the Daily Ledger read from
// Supabase instead of Apps Script.
// ----------------------------------------------------------------------------
// The page and every server call work as they do on the clinic's address
// today (the demo-web Worker, docs/cloudflare/demo-web-worker.js in the
// MIGRATION repo, with Web_Proxy.gs):
//
//   GET  /       the app's page, fetched from the Apps Script deployment
//                (…/exec?shell=1, server to server) and served as this
//                address's own page.
//   POST /rpc    every server call the page makes ({fn, args}), passed to
//                the deployment's doPost and the answer back.
//   GET  /?privacy, ?rights, ?doc=…, ?verifyDS=…, ?viewReport=…
//                the patient pages, Google's page in a frame as before.
//
// One difference. The Daily Ledger's call, fetchDailyLedgerScoped, is
// answered here from the Supabase copy of the workbook — no Apps Script —
// when it can be (edgeLedger below); anything else, and any doubt, goes to
// Apps Script exactly as before:
//
//   * who is asking: the app's own session token, checked by Apps Script
//     (getEdgeIdentity) and remembered here for IDENTITY_SECONDS;
//   * whether the copy may be used: Apps Script says so with the identity
//     (reads on and the every-minute sync running; RUN_SB_04b_readsOff
//     switches this off too);
//   * the answer: src/ledger.js, the Apps Script function line for line,
//     compared with it on the demo year by the MIGRATION repo's
//     tools/sbmirror.js;
//   * fresh after a change: a call that books, moves, re-states or deletes
//     an appointment, or registers or edits a patient, goes to Apps Script
//     with "flush" (Web_Proxy.gs), which copies those sheets to Supabase
//     before answering, so the ledger the screen reloads shows it. Changes
//     made in the sheet by hand reach it with the next sync (a minute).
//
// Settings: APP_EXEC_URL (the deployment's …/exec address; the same one the
// clinic's address uses), SUPABASE_URL, SUPABASE_SECRET_KEY. EDGE_LEDGER =
// "off" sends the ledger to Apps Script too.
// ============================================================================

import { sessionLedgerQueries, buildLedger, doctorsFrom, resolveScope, dayKey } from './ledger.js';

const SHELL_EDGE_SECONDS = 20;
const IDENTITY_SECONDS = 120;
const MAX_RPC_BYTES = 20 * 1024 * 1024;
const PASS_THROUGH = /^(privacy|rights|doc|k|verifyDS|viewReport)$/;
const EXEC_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

/** Calls after which the ledger's sheets are copied before the answer comes back. */
export const FLUSH_AFTER = {
  updateAppointmentStatus: 1, setAppointmentTime: 1, barcodeUpdateAppointment: 1, submitNewAppointment: 1,
  bookAppointmentScoped: 1, saveOPEncounterScoped: 1, portalBookAppointment: 1, portalCancelAppointment: 1,
  registerPatient: 1, updatePatientProfile: 1
};
const FLUSH_SHEETS = ['Appointments', 'Patients'];

export const execUrl = (env) => String((env && (env.APP_EXEC_URL || env.APP_EXEC_URL_DEFAULT)) || '').trim();
export const hasApp = (env) => EXEC_RE.test(execUrl(env));

// ---------------------------------------------------------------------------
// /rpc
// ---------------------------------------------------------------------------

export async function rpc(request, env, ctx, supabase) {
  if (request.method !== 'POST') return json({ ok: false, e: 'Method not allowed.' }, 405);
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ ok: false, e: 'Not allowed from another site.' }, 403);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_RPC_BYTES) return json({ ok: false, e: 'That request is too large.' }, 413);
  let body = await request.text();
  if (body.length > MAX_RPC_BYTES) return json({ ok: false, e: 'That request is too large.' }, 413);

  let call = null;
  try { call = JSON.parse(body); } catch (e) { call = null; }
  const fn = call && typeof call.fn === 'string' ? call.fn : '';
  const args = call && Array.isArray(call.args) ? call.args : [];

  if (fn === 'fetchDailyLedgerScoped' && String(env.EDGE_LEDGER || '').toLowerCase() !== 'off' && env.SUPABASE_SECRET_KEY) {
    try {
      const v = await edgeLedger(args, env, ctx, supabase);
      if (v) return json({ ok: true, v }, 200, { 'X-CresRx-Source': 'supabase' });
    } catch (e) {
      console.error('edge ledger fell back to Apps Script:', e && e.message);
    }
  }
  if (FLUSH_AFTER[fn] === 1 && call) body = JSON.stringify({ fn, args, flush: FLUSH_SHEETS });
  return forward(env, body);
}

/** The call to the deployment's doPost, its answer back unchanged. */
async function forward(env, body) {
  let res;
  try {
    // Apps Script answers a POST with a redirect to the result; fetch
    // follows it (as a GET, which is what Google expects).
    res = await fetch(execUrl(env), { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, redirect: 'follow' });
  } catch (e) {
    return json({ ok: false, e: 'The app server could not be reached. Please try again.' }, 502);
  }
  const out = await res.text();
  if (!/^\s*\{/.test(out)) {
    return json({ ok: false, e: /accounts\.google\.com|ServiceLogin|signin/i.test(out)
      ? 'The app server asks for a Google sign-in: set the deployment\'s access to "Anyone" and deploy again.'
      : 'The app server gave no answer (deploy the latest version of the app). Status ' + res.status + '.' }, 502);
  }
  return new Response(out, { status: 200, headers: secure({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-CresRx-Source': 'apps-script' }) });
}

/** One server call to Apps Script from here, its value or null. */
async function appsScript(env, fn, args) {
  const res = await fetch(execUrl(env), { method: 'POST', body: JSON.stringify({ fn, args }),
                                          headers: { 'Content-Type': 'application/json' }, redirect: 'follow' });
  const t = await res.text();
  if (!/^\s*\{/.test(t)) return null;
  const o = JSON.parse(t);
  return o && o.ok ? o.v : null;
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

const MEMO = new Map();        // this isolate's copy; the edge cache is shared within a data centre

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The session's {username, role, doctorId, dutyMoIds, edge}, or null. Asked
 * of Apps Script (getEdgeIdentity) at most once per IDENTITY_SECONDS per
 * session; only a live session is remembered, under a hash of its token.
 */
export async function identity(token, env, ctx) {
  token = String(token || '');
  if (!token) return null;
  const h = await sha256('cresrx-session:' + token);
  const now = Date.now();
  const m = MEMO.get(h);
  if (m && m.until > now) return m.id;
  const key = new Request('https://identity.cresrx.internal/' + h);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const id = await hit.json();
      MEMO.set(h, { id, until: now + 15000 });
      return id;
    }
  }
  const v = await appsScript(env, 'getEdgeIdentity', [token]);
  if (!v || !v.success) return null;
  const id = { username: String(v.username || ''), role: String(v.role || '').toLowerCase(), doctorId: String(v.doctorId || ''),
               dutyMoIds: Array.isArray(v.dutyMoIds) ? v.dutyMoIds.map(String) : [], edge: v.edge === true };
  if (MEMO.size > 500) MEMO.clear();
  MEMO.set(h, { id, until: now + IDENTITY_SECONDS * 1000 });
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(id), { headers: { 'Cache-Control': 'max-age=' + IDENTITY_SECONDS } }));
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
  }
  return id;
}

// ---------------------------------------------------------------------------
// The Daily Ledger from Supabase
// ---------------------------------------------------------------------------

/**
 * fetchDailyLedgerScoped(dateStr, doctorId, sessionToken) answered from the
 * copy, or null for Apps Script to answer: a date not in yyyy-MM-dd, a
 * session it does not know, the copy switched off, a sheet not in the copy.
 */
export async function edgeLedger(args, env, ctx, supabase) {
  const t0 = Date.now();
  const [dateStr, doctorId, token] = args;
  const date = dayKey(dateStr);
  if (!date) return null;
  const who = await identity(token, env, ctx);
  if (!who || !who.edge) return null;
  const res = await supabase('mirror_query', { queries: sessionLedgerQueries(date) });
  const [doctorsRes, appointments, patients] = (res && res.results) || [];
  if (!doctorsRes || !doctorsRes.found || !appointments || !appointments.found || !patients || !patients.found) return null;
  const doctors = doctorsFrom(doctorsRes, who.dutyMoIds.map((x) => x.toUpperCase()));
  const scope = resolveScope({ username: who.username, role: who.role, doctorId: who.doctorId }, doctors, doctorId == null ? '' : String(doctorId));
  const out = buildLedger({ appointments, patients, doctors, scope, dateKey: date });
  out.edge = { ms: Date.now() - t0, syncedAt: appointments.synced_at || null };
  return out;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export async function shell(request, env, ctx) {
  const url = new URL(request.url);
  const exec = execUrl(env);

  // Patient-facing pages: as before, Google's page in a frame.
  const keep = new URLSearchParams();
  let special = false;
  for (const [k, v] of url.searchParams) {
    if (PASS_THROUGH.test(k)) { keep.append(k, v); if (k !== 'k') special = true; }
  }
  if (special) {
    return page('<iframe src="' + attr(exec + '?' + keep.toString()) + '" title="DEMO CLINIC" ' +
                'allow="camera; clipboard-write; fullscreen" allowfullscreen></iframe>', 200);
  }

  // ?v=<build> is the app's own "a newer version is available -> Reload":
  // never answered from the edge, so it cannot get the old copy back.
  const fresh = url.searchParams.has('v');
  const cache = caches.default;
  const key = new Request(url.origin + '/__shell__', { method: 'GET' });
  let html = '';
  if (!fresh) {
    const hit = await cache.match(key);
    if (hit) html = await hit.text();
  }
  if (!html) {
    try {
      const r = await fetch(exec + '?shell=1', { redirect: 'follow' });
      const t = await r.text();
      if (r.ok && /<html/i.test(t) && /CRESC_BUILD/.test(t)) {
        html = t;
        ctx.waitUntil(cache.put(key, new Response(t, { headers: { 'Cache-Control': 'public, max-age=' + SHELL_EDGE_SECONDS } })));
      }
    } catch (e) { /* fall back below */ }
  }
  if (!html) {
    // The deployment is not ready for it (older code, or access not
    // "Anyone"): the app in Google's frame, as before, rather than nothing.
    return page('<iframe src="' + attr(exec + '?t=' + Date.now()) + '" title="DEMO CLINIC" ' +
                'allow="camera; clipboard-write; fullscreen" allowfullscreen></iframe>', 200);
  }
  return text(html, 200, 'text/html; charset=utf-8', 'no-store, no-cache, must-revalidate, max-age=0');
}

export function notSetUp() {
  return page('<p style="color:#cbd5e1;font:16px system-ui;padding:40px;text-align:center">' +
              'The app address is not set up on this server yet (APP_EXEC_URL).</p>', 503);
}

// ---------------------------------------------------------------------------

export function secure(h) {
  return Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Permissions-Policy': 'geolocation=(), payment=()'
  }, h);
}
export function text(body, status, type, cacheControl) {
  return new Response(body, { status, headers: secure({ 'Content-Type': type, 'Cache-Control': cacheControl, 'CDN-Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Expires': '0' }) });
}
function json(o, status, extra) {
  return new Response(JSON.stringify(o), { status, headers: secure(Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {})) });
}
function page(body, status) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#020617">' +
    '<title>DEMO CLINIC</title>' +
    '<style>html,body{margin:0;height:100%;background:#020617;overflow:hidden}' +
    'iframe{position:fixed;inset:0;width:100%;height:100%;border:0;display:block}</style>' +
    '</head><body>' + body + '</body></html>';
  return text(html, status, 'text/html; charset=utf-8', 'no-store, no-cache, must-revalidate, max-age=0');
}
function attr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
