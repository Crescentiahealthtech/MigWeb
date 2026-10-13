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
import { splitSnapshot, redact, hiddenFor } from './snapshots.js';
import { registerQuery, allPatients, masterDirectory, demographicsQuery, demographics, timelineQuery, timeline,
         patientKey } from './patients.js';

const SHELL_EDGE_SECONDS = 20;
const IDENTITY_SECONDS = 120;
const MAX_RPC_BYTES = 20 * 1024 * 1024;
const PASS_THROUGH = /^(privacy|rights|doc|k|verifyDS|viewReport)$/;
const EXEC_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

/**
 * Calls after which some sheets are copied to Supabase before the answer
 * comes back (doPost's "flush", Web_Proxy.gs), so the screens answered from
 * the copy show the change at once. Each lists the sheets it can change.
 */
const APPT = ['Appointments', 'Patients'];
export const FLUSH_AFTER = {
  updateAppointmentStatus: APPT, setAppointmentTime: APPT, barcodeUpdateAppointment: APPT, submitNewAppointment: APPT,
  bookAppointmentScoped: APPT, portalBookAppointment: APPT, portalCancelAppointment: APPT,
  saveOPEncounterScoped: ['Appointments', 'Patients', 'OP_Encounters'],
  createOPReferral: APPT, respondToOPReferral: ['Appointments', 'OP_Encounters'],
  registerPatient: ['Patients'], updatePatientProfile: ['Patients'], saveUserProfile: ['Patients'],
  savePatientAllergies: ['Patients'],
  saveNewAdmissionLedger: ['IP_Admissions', 'Patients'], processBedTransfer: ['IP_Admissions'],
  processPatientDischarge: ['IP_Admissions']
};

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
  // THE CPU BUDGET. On Cloudflare's free plan a request may use 10 ms of
  // CPU, and one that goes over takes down every request running in the
  // same isolate with it (the browser sees "Failed to fetch"). So a call
  // passed to Apps Script is never decoded or parsed here: its bytes go
  // through as they came, and so does the answer. Only the function's name
  // is read, from the first bytes of the body ({"fn":"…","args":…}, as the
  // page's stand-in for google.script.run sends it).
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_RPC_BYTES) return json({ ok: false, e: 'That request is too large.' }, 413);
  const fn = fnOf(bytes);

  if (EDGE[fn] && edgeOn(env, fn)) {
    try {
      const call = JSON.parse(new TextDecoder().decode(bytes));   // small: a name and a few ids
      const args = Array.isArray(call && call.args) ? call.args : [];
      const v = await EDGE[fn](args, env, ctx, supabase);
      if (v instanceof Response) return v;
      if (v) return json({ ok: true, v }, 200, { 'X-CresRx-Source': 'supabase' });
    } catch (e) {
      console.error('edge ' + fn + ' fell back to Apps Script:', e && e.message);
    }
  }
  return forward(env, FLUSH_AFTER[fn] ? withFlush(bytes, FLUSH_AFTER[fn]) : bytes);
}

/** The function's name from the start of the body, or ''. */
export function fnOf(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 160));
  const m = /^\s*\{\s*"fn"\s*:\s*"([A-Za-z$_][\w$]{0,80})"/.exec(head);
  return m ? m[1] : '';
}

/** The same body with "flush": [...] added before its closing brace, without parsing it. */
export function withFlush(bytes, sheets) {
  let end = bytes.length - 1;
  while (end >= 0 && bytes[end] !== 0x7d) end--;                 // the last '}'
  if (end < 0) return bytes;
  const tail = new TextEncoder().encode(',"flush":' + JSON.stringify(sheets) + '}');
  const out = new Uint8Array(end + tail.length);
  out.set(bytes.subarray(0, end), 0);
  out.set(tail, end);
  return out;
}

/** The call to the deployment's doPost, its answer back unchanged and unread. */
async function forward(env, body) {
  let res;
  try {
    // Apps Script answers a POST with a redirect to the result; fetch
    // follows it (as a GET, which is what Google expects).
    res = await fetch(execUrl(env), { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, redirect: 'follow' });
  } catch (e) {
    return json({ ok: false, e: 'The app server could not be reached. Please try again.' }, 502);
  }
  // doPost answers JSON (ContentService); anything else is Google's own
  // page (a sign-in, an error) and is read only to say which.
  if (/json/i.test(res.headers.get('Content-Type') || '')) {
    return new Response(res.body, { status: 200, headers: secure({ 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-CresRx-Source': 'apps-script' }) });
  }
  const out = await res.text();
  if (/^\s*\{/.test(out)) {
    return new Response(out, { status: 200, headers: secure({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-CresRx-Source': 'apps-script' }) });
  }
  return json({ ok: false, e: /accounts\.google\.com|ServiceLogin|signin/i.test(out)
    ? 'The app server asks for a Google sign-in: set the deployment\'s access to "Anyone" and deploy again.'
    : 'The app server gave no answer (deploy the latest version of the app). Status ' + res.status + '.' }, 502);
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
               dutyMoIds: Array.isArray(v.dutyMoIds) ? v.dutyMoIds.map(String) : [], edge: v.edge === true,
               permissions: Array.isArray(v.permissions) ? v.permissions.map(String) : [],
               actor: v.actor && typeof v.actor === 'object' ? v.actor : null,
               uiHidden: v.uiHidden && typeof v.uiHidden === 'object' ? v.uiHidden : {} };
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
// Patients from Supabase (src/patients.js)
// ---------------------------------------------------------------------------

/**
 * One of Apps Script's patient reads answered from the copy, or null for
 * Apps Script to answer. The order is the original's: who is asking and
 * whether they may (crescRequire_: the permission must be among the
 * session's), the answer, then the audit entry (dpdpLogRead_) — written to
 * Supabase before the answer goes back, and if it cannot be written, Apps
 * Script answers (and audits) instead.
 */
async function patientRead(token, permission, env, ctx, supabase, queries, port, audit) {
  const who = await identity(token, env, ctx);
  if (!who || !who.edge || !who.actor || !who.permissions.includes(permission)) return null;
  const res = await supabase('mirror_query', { queries });
  const v = port((res && res.results) || []);
  if (v === null || v === undefined) return null;
  if (audit) {
    await supabase('edge_log_read', { actor: who.actor, what: audit.what, entityId: audit.id, details: { endpoint: audit.endpoint } });
  }
  return v;
}

// ---------------------------------------------------------------------------
// The Command Center from its ready-made answer (src/snapshots.js)
// ---------------------------------------------------------------------------

const SNAPSHOT_FRESH_MS = 60 * 1000;          // older than this: ask Apps Script for a new one, in the background
const SNAPSHOT_MAX_MS = 10 * 60 * 1000;       // older than this: Apps Script answers, as before

/**
 * getDashboardData(role, bust, sessionToken) — Admin_Dashboard_Logic.gs.
 * The automatic loads come from the answer Apps Script last left in
 * Supabase; the Refresh button (bust) still asks Apps Script, which stores
 * what it computes. Same permission (dashboard.read), same split of who sees
 * money (accounts.read), same cards taken out per person (crescUiRedact_).
 */
async function dashboard([role, bust, token], env, ctx, supabase) {
  if (bust === true) return null;
  const who = await identity(token, env, ctx);
  if (!who || !who.edge || !who.permissions.includes('dashboard.read')) return null;
  const key = 'dash:' + (who.permissions.includes('accounts.read') ? 'FIN' : 'CLIN');
  const snap = splitSnapshot(await supabase('snapshot_get', { key }, true));
  if (!snap) return null;
  const age = Date.now() - snap.made;
  if (!(age >= 0 && age <= SNAPSHOT_MAX_MS)) return null;
  if (age > SNAPSHOT_FRESH_MS) {
    // One open dashboard asks for a new answer; the rest are served this one.
    const refresh = supabase('snapshot_claim', { key, ms: SNAPSHOT_FRESH_MS }).then((mine) => {
      if (mine === true) return appsScript(env, 'getDashboardData', [role, true, token]);
    }).catch((e) => console.error('dashboard refresh:', e && e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(refresh);
  }
  const headers = { 'X-CresRx-Source': 'supabase', 'X-CresRx-Age': String(Math.round(age / 1000)) };
  if (hiddenFor(who.uiHidden, 'dash.').length) {
    const data = redact(JSON.parse(snap.dataText), who.uiHidden, 'dash.');
    return raw(JSON.stringify({ ok: true, v: { success: true, data, message: 'snapshot' } }), headers);
  }
  // Nobody's cards to take out: the stored text goes on as it is.
  return raw('{"ok":true,"v":{"success":true,"data":' + snap.dataText + ',"message":"snapshot"}}', headers);
}

/** An answer already in the shape the page expects ({ok, v}), sent as it is. */
function raw(text, headers) {
  return new Response(text, { status: 200, headers: secure(Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers)) });
}

/** The calls the Worker answers itself, by the name the page calls them. */
const EDGE = {
  fetchDailyLedgerScoped: edgeLedger,
  getDashboardData: dashboard,
  // getAllPatients(sessionToken) — CodeMV.gs
  getAllPatients: ([token], env, ctx, sb) => patientRead(token, 'patient.read', env, ctx, sb, registerQuery(),
    ([r]) => allPatients(r), { what: 'PatientRegister', id: 'ALL', endpoint: 'getAllPatients' }),
  // getMasterPatientDirectory(sessionToken) — EMR_MasterTimeline_Logic.gs
  getMasterPatientDirectory: ([token], env, ctx, sb) => patientRead(token, 'patient.read', env, ctx, sb, registerQuery(),
    ([r]) => masterDirectory(r), { what: 'PatientRegister', id: 'ALL', endpoint: 'getMasterPatientDirectory' }),
  // getPatientDemographics(patientId, sessionToken) — Appointment.gs
  getPatientDemographics: ([patientId, token], env, ctx, sb) => patientRead(token, 'patient.read', env, ctx, sb,
    demographicsQuery(patientKey(patientId)), ([r]) => demographics(r, patientId), null),
  // buildLongitudinalTimeline(patientId, sessionToken) — EMR_MasterTimeline_Logic.gs
  buildLongitudinalTimeline: ([patientId, token], env, ctx, sb) => patientRead(token, 'emr.read', env, ctx, sb,
    timelineQuery(patientKey(patientId)), (rs) => timeline(rs, patientId),
    { what: 'Patient', id: String(patientId || ''), endpoint: 'buildLongitudinalTimeline' })
};

/**
 * Whether the Worker answers this call itself. EDGE_OFF (a setting) names
 * calls to leave to Apps Script, comma-separated, or "all"; EDGE_LEDGER=off
 * still works for the ledger.
 */
function edgeOn(env, fn) {
  if (!env.SUPABASE_SECRET_KEY) return false;
  const off = String(env.EDGE_OFF || '').split(/[\s,]+/).filter(Boolean);
  if (off.includes('all') || off.includes(fn)) return false;
  if (fn === 'fetchDailyLedgerScoped' && String(env.EDGE_LEDGER || '').toLowerCase() === 'off') return false;
  return true;
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
  // TEMPORARY, while screens move off Apps Script: the status badge
  // (public/migration/status.js). Remove this line and that file when done.
  if (String(env.MIGRATION_BADGE || '').toLowerCase() !== 'off') {
    const tag = '<script src="/migration/status.js"></script>';
    const at = /<head[^>]*>/i.test(html) ? /<head[^>]*>/i : /<html[^>]*>/i;
    html = at.test(html) ? html.replace(at, (h) => h + tag) : tag + html;
  }
  return text(html, 200, 'text/html; charset=utf-8', 'no-store, no-cache, must-revalidate, max-age=0');
}

/**
 * What has moved off Apps Script and what has not, for the status badge
 * (GET /api/migration). TEMPORARY, like the badge.
 */
export const MIGRATION_SCREENS = [
  { label: 'Appointments · Daily Ledger', fns: ['fetchDailyLedgerScoped'], day: 'Day 0' },
  { label: 'Patients · search list', fns: ['getAllPatients'], day: 'Day 1' },
  { label: 'EMR · patient directory', fns: ['getMasterPatientDirectory'], day: 'Day 1' },
  { label: 'Appointments · booking form patient details', fns: ['getPatientDemographics'], day: 'Day 1' },
  { label: 'EMR · clinical timeline (outpatients; admitted patients still Apps Script)', fns: ['buildLongitudinalTimeline'], day: 'Day 1' },
  { label: 'Command Center', fns: ['getDashboardData'], day: 'Day 2' },
  { label: 'Finance Hub and Master Ledger', fns: ['getAccountsDashboard'], day: 'Day 3' },
  { label: 'Billing ledger and Hospital Billing lists', fns: ['hb_getInvoices'], day: 'Day 4' },
  { label: 'Pharmacy stock, sales and GST reports', fns: [], day: 'Day 5' },
  { label: 'Lab queues, IP ward roster and running bill, admitted patients\' timelines', fns: [], day: 'Day 6' },
  { label: 'All writes (bookings, bills, consultations) — stay on Apps Script until the server stage', fns: [], day: 'later' }
];
export function migrationStatus(env) {
  return { screens: MIGRATION_SCREENS.map((g) => ({ label: g.label, day: g.day,
    done: g.fns.length > 0 && g.fns.every((f) => EDGE[f] && edgeOn(env, f)) })) };
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
