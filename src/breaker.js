// ============================================================================
// The circuit breaker in front of Apps Script, and what the page is told
// about the Google Sheet side.
//
// 6 Nov 2026: the Sheet sync lapsed, every screen fell back to Apps Script,
// and every fallback spent more of the same Google quota that had run out,
// so the sync never came back. Now, once Apps Script fails or is slow
// FAILS times in WINDOW_MS, nothing more is sent to it for OPEN_MS: the
// screens the Worker or Supabase answer carry on, saves made in Supabase
// wait there for the Sheet, and the one call that needs Apps Script is told
// to try again in a few minutes. After OPEN_MS calls go through again: the
// first good answer closes the breaker, the first failure pauses it again.
//
// The state is this instance's, and shared with the other instances in the
// same Cloudflare location through the edge cache (best effort).
//
// The page's banner (public/s/backup.js) reads two headers on every /rpc
// answer: X-CresRx-Behind (minutes since the Sheet sync last ran, from the
// Supabase heartbeat, when it is 25 or more: the sync ticks every 15) and X-CresRx-Backup: paused
// (the breaker is open).
// ============================================================================

export const FAILS = 3;
export const WINDOW_MS = 60 * 1000;
export const OPEN_MS = 3 * 60 * 1000;
export const SLOW_MS = 25 * 1000;
const CACHE_KEY = 'https://breaker.cresrx.invalid/apps-script';

const state = { fails: [], openUntil: 0, lagS: null, lagAt: 0 };

/** For the tests. */
export function resetBreaker() { state.fails = []; state.openUntil = 0; state.lagS = null; state.lagAt = 0; }
export function breakerState() { return { fails: state.fails.slice(), openUntil: state.openUntil }; }

function edgeCache() {
  try { return (typeof caches !== 'undefined' && caches.default) ? caches.default : null; } catch (e) { return null; }
}

/** Is the breaker open (nothing to be sent to Apps Script)? */
export async function gasPaused() {
  if (Date.now() < state.openUntil) return true;
  const c = edgeCache();
  if (!c) return false;
  try {
    const hit = await c.match(CACHE_KEY);
    if (!hit) return false;
    const until = Number(await hit.text()) || 0;
    if (Date.now() < until) { state.openUntil = until; return true; }
  } catch (e) { /* the cache is a help, not the rule */ }
  return false;
}

/** One call to Apps Script came back: ok, or failed / too slow. */
export function gasResult(ok, ms) {
  const now = Date.now();
  if (ok && !(ms > SLOW_MS)) {
    state.fails = [];
    if (state.openUntil && now >= state.openUntil) {
      state.openUntil = 0;
      const c = edgeCache();
      if (c) { try { c.delete(CACHE_KEY).catch(() => {}); } catch (e) { /* nothing */ } }
    }
    return;
  }
  state.fails = state.fails.filter((t) => now - t < WINDOW_MS);
  state.fails.push(now);
  // A call let through after the pause failed again: straight back to paused.
  const retrial = state.openUntil && now >= state.openUntil;
  if (state.fails.length >= FAILS || retrial) {
    state.openUntil = now + OPEN_MS;
    state.fails = [];
    console.warn('Apps Script paused for ' + (OPEN_MS / 1000) + ' s: it failed or was slow ' + FAILS + ' times in a minute.');
    const c = edgeCache();
    if (c) {
      try {
        c.put(CACHE_KEY, new Response(String(state.openUntil), { headers: { 'Cache-Control': 'max-age=' + Math.ceil(OPEN_MS / 1000) } }))
          .catch(() => {});
      } catch (e) { /* nothing */ }
    }
  }
}

/**
 * fetch() to the deployment, through the breaker: the Response, or throws
 * (the network). A 5xx or a slow answer always counts as a failure; with
 * judgeLater the caller says whether any other answer was a good one.
 */
export async function gasFetch(url, init, judgeLater) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    gasResult(false, Date.now() - t0);
    throw e;
  }
  const ms = Date.now() - t0;
  // judgeLater: the caller reads the answer and says whether it was good.
  if (res.status >= 500 || ms > SLOW_MS || !judgeLater) gasResult(res.status < 500, ms);
  return res;
}

/** The Sheet sync's lag in seconds, as Supabase last told this instance (session_get's "lag"). */
export function noteLag(lagS) {
  if (lagS === null || lagS === undefined || !isFinite(Number(lagS))) return;
  state.lagS = Number(lagS);
  state.lagAt = Date.now();
}

/** The banner's headers on an /rpc answer. */
export async function healthHeaders(res) {
  if (!res || !res.headers) return res;
  try {
    if (await gasPaused()) res.headers.set('X-CresRx-Backup', 'paused');
    if (state.lagS !== null && Date.now() - state.lagAt < 10 * 60 * 1000 && state.lagS >= 25 * 60) {
      res.headers.set('X-CresRx-Behind', String(Math.floor(state.lagS / 60)));
    }
  } catch (e) { /* an answer whose headers cannot change: it goes as it is */ }
  return res;
}

/** The answer to a call that needs Apps Script while it is paused. */
export function pausedAnswer() {
  return new Response(JSON.stringify({ ok: false,
    e: 'The Google Sheet side is not answering just now. Saves on most screens still go through; please try this one again in a few minutes.' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
               'X-CresRx-Why': 'Apps Script paused (it failed or was slow several times)', 'X-CresRx-Backup': 'paused', 'Retry-After': '120' }
  });
}
