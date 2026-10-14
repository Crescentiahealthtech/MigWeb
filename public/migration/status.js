/* ==========================================================================
   MIGRATION STATUS — temporary, remove when the move off Apps Script is done.
   --------------------------------------------------------------------------
   Added to the app's page by the Worker (src/app.js, shell()). It watches the
   page's server calls (POST /rpc) and shows, bottom-right:

     ⚡ 212 ms · Cloudflare + Supabase · getAllPatients
     ⏳ 2.4 s  · Apps Script            · getDPDPNotice

   Click it for the recent calls and the list of what has moved and what has
   not (/api/migration). It also retries, once, a call that never reached
   the server when the call is one with no side effects (a screen bundle,
   the consent notice, the build check), so one dropped connection does not
   leave a screen empty.

   To remove: delete this file and the line in shell() that adds it, or set
   MIGRATION_BADGE=off on the Worker.
   ========================================================================== */
(function () {
  'use strict';
  if (window.__crescMigrationStatus) return;
  window.__crescMigrationStatus = true;

  var SAFE_TO_RETRY = { crescGetBundle: 1, getDPDPNotice: 1, getAppBuild: 1 };
  var recent = [];
  var realFetch = window.fetch.bind(window);

  function fnOf(init) {
    try {
      var b = init && init.body;
      if (typeof b !== 'string') return '';
      var m = /^\s*\{\s*"fn"\s*:\s*"([^"]{1,80})"/.exec(b.slice(0, 160));
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  function isRpc(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    return /(^|\/)rpc$/.test(url.split('?')[0]) && init && String(init.method || '').toUpperCase() === 'POST';
  }

  window.fetch = function (input, init) {
    if (!isRpc(input, init)) return realFetch(input, init);
    var fn = fnOf(init), t0 = Date.now();
    var attempt = function (retried) {
      return realFetch(input, init).then(function (res) {
        var r = note(fn, Date.now() - t0, res.headers.get('X-CresRx-Source') || '?', res.ok, retried, res.headers.get('X-CresRx-Age'),
                     res.headers.get('X-CresRx-Why'), res.headers.get('X-CresRx-Via'));
        // A slow Apps Script answer says where its time went (doPost's "t":
        // the call, the copy to Supabase after it, the steps it marked).
        if (r && r.source === 'apps-script' && r.took >= 2000) {
          res.clone().json().then(function (b) { if (b && b.t) { r.split = b.t; redraw(r); } }, function () {});
        }
        return res;
      }, function (err) {
        if (!retried && SAFE_TO_RETRY[fn]) {
          return new Promise(function (r) { setTimeout(r, 400); }).then(function () { return attempt(true); });
        }
        note(fn, Date.now() - t0, 'failed', false, retried);
        throw err;
      });
    };
    return attempt(false);
  };

  // ---- the badge --------------------------------------------------------
  var pill, panel;
  var LABEL = { supabase: 'Cloudflare + Supabase', 'apps-script': 'Apps Script', failed: 'no answer', '?': 'unknown' };

  function ms(n) { return n < 1000 ? n + ' ms' : (n / 1000).toFixed(1) + ' s'; }
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; }

  function note(fn, took, source, ok, retried, age, why, via) {
    recent.unshift({ fn: fn || '(unnamed)', took: took, source: source, ok: ok, retried: retried, at: new Date(),
                     age: age === null || age === undefined || age === '' ? null : Number(age), why: why || '', via: via || '' });
    if (recent.length > 40) recent.pop();
    var r = recent[0];
    // Background calls the page makes on its own (keeping the session
    // alive, checking the build) are listed but do not take over the badge.
    if (/^(getAppBuild|crescTouchSession|crescPing|dc_touch|keepAlive)/.test(fn)) { if (panel && panel.style.display !== 'none') drawPanel(); return r; }
    draw(r);
    return r;
  }
  function redraw(r) {
    if (recent[0] === r) draw(r);
    if (panel && panel.style.display !== 'none') drawPanel();
  }

  /** "call 4.1 s · copy to Supabase 0.8 s · session 0.3 s, save 2.0 s, …", or ''. */
  function splitText(t) {
    if (!t) return '';
    var parts = [];
    if (typeof t.run === 'number') parts.push('call ' + ms(t.run));
    if (typeof t.sb === 'number') parts.push('copy to Supabase ' + ms(t.sb));
    if (t.steps && t.steps.length) parts.push(t.steps.map(function (s) { return s[0] + ' ' + ms(s[1]); }).join(', '));
    return parts.join(' · ');
  }

  function ensure() {
    if (pill || !document.body) return !!pill;
    pill = el('div', 'position:fixed;right:10px;bottom:10px;z-index:2147483000;font:12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;' +
      'padding:5px 10px;border-radius:999px;background:rgba(2,6,23,.88);color:#e2e8f0;border:1px solid rgba(148,163,184,.35);' +
      'cursor:pointer;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.35)');
    pill.title = 'Migration status (temporary). Click for details.';
    pill.onclick = function () { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; if (panel.style.display === 'block') drawPanel(); };
    panel = el('div', 'display:none;position:fixed;right:10px;bottom:44px;z-index:2147483000;width:min(460px,calc(100vw - 20px));max-height:60vh;overflow:auto;' +
      'font:12px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:10px;padding:10px 12px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.45)');
    document.body.appendChild(panel);
    document.body.appendChild(pill);
    return true;
  }

  function draw(r) {
    if (!ensure()) return;
    var icon = r.source === 'supabase' ? '⚡' : r.source === 'failed' ? '⚠' : '⏳';
    // "app code": answered by the Edge Function running the app's own
    // Apps Script code on the copy (Day 3), not by a port in the Worker.
    pill.textContent = icon + ' ' + ms(r.took) + ' · ' + (LABEL[r.source] || r.source) + (r.via ? ' (app code)' : '') +
      (r.age !== null && r.age !== undefined ? ' (copy ' + ms(r.age * 1000) + ' old)' : '') + ' · ' + r.fn + (r.retried ? ' (retried)' : '');
    pill.title = (r.why ? 'Apps Script answered because: ' + r.why : 'Migration status (temporary). Click for details.') +
      (r.split ? '\nWhere the time went: ' + splitText(r.split) + ' (the rest: the network and Google)' : '');
    pill.style.borderColor = r.source === 'supabase' ? '#22c55e' : r.source === 'failed' ? '#ef4444' : 'rgba(148,163,184,.35)';
  }

  var plan = null;
  function drawPanel() {
    panel.textContent = '';
    panel.appendChild(el('div', 'font-weight:600;margin-bottom:6px', 'Moving off Apps Script — status (temporary)'));
    if (plan) {
      plan.forEach(function (g) {
        var row = el('div', 'margin:2px 0');
        row.appendChild(el('span', 'display:inline-block;width:18px', g.done ? '✅' : '⬜'));
        row.appendChild(el('span', g.done ? '' : 'opacity:.7', g.label + (g.day ? ' — ' + g.day : '')));
        panel.appendChild(row);
      });
    } else {
      panel.appendChild(el('div', 'opacity:.7', 'Loading the list…'));
      realFetch('/api/migration', { cache: 'no-store' }).then(function (r) { return r.json(); })
        .then(function (b) { plan = b.screens || []; drawPanel(); }, function () {});
    }
    panel.appendChild(el('div', 'font-weight:600;margin:10px 0 4px', 'Recent server calls'));
    recent.slice(0, 15).forEach(function (r) {
      var row = el('div', 'display:flex;gap:8px;margin:1px 0');
      row.appendChild(el('span', 'width:58px;text-align:right;font-variant-numeric:tabular-nums', ms(r.took)));
      row.appendChild(el('span', 'width:150px;color:' + (r.source === 'supabase' ? '#4ade80' : r.source === 'failed' ? '#f87171' : '#cbd5e1'),
                         (LABEL[r.source] || r.source) + (r.via ? ' (app code)' : '') +
                         (r.age !== null && r.age !== undefined ? ' · ' + ms(r.age * 1000) + ' old' : '') + (r.retried ? ' ↻' : '')));
      row.appendChild(el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', r.fn));
      panel.appendChild(row);
      // A call the Worker could answer but left to Apps Script: why.
      if (r.why) panel.appendChild(el('div', 'margin:0 0 3px 66px;opacity:.65;font-size:11px', '↳ ' + r.why));
      // A slow call: where its time went inside Apps Script.
      if (r.split) panel.appendChild(el('div', 'margin:0 0 3px 66px;opacity:.65;font-size:11px', '⏱ ' + splitText(r.split) +
                                        ' · network and Google ' + ms(Math.max(0, r.took - (r.split.run || 0) - (r.split.sb || 0)))));
    });
    if (!recent.length) panel.appendChild(el('div', 'opacity:.7', 'None yet.'));
  }
})();
