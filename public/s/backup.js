/* ==========================================================================
   THE GOOGLE SHEET BANNER, for every member of staff.
   --------------------------------------------------------------------------
   Added to the page by the Worker (src/app.js, shell()). It reads two
   headers on the answers to the page's server calls (POST /rpc), set by
   src/breaker.js:

     X-CresRx-Behind: N      the Google Sheet copy is N minutes behind
     X-CresRx-Backup: paused the Google Sheet side is not answering

   and shows a thin bar at the top of the screen while either is there. The
   screens keep working: saves are kept in Supabase and written into the
   Sheet when Google answers again. Nothing is ever locked.
   ========================================================================== */
(function () {
  'use strict';
  if (window.__crescBackupBanner) return;
  window.__crescBackupBanner = true;

  var realFetch = window.fetch.bind(window);
  var bar = null, shown = '';

  function isRpc(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    return /(^|\/)rpc$/.test(url.split('?')[0]) && init && String(init.method || '').toUpperCase() === 'POST';
  }

  function draw(text) {
    if (text === shown) return;
    shown = text;
    if (!document.body) { document.addEventListener('DOMContentLoaded', function () { shown = ''; draw(text); }); return; }
    if (!text) { if (bar) bar.style.display = 'none'; return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483646;padding:6px 16px;' +
        'font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;' +
        'background:#fff4d6;color:#5c4400;border-bottom:1px solid #e8c766;box-shadow:0 1px 3px rgba(0,0,0,.08)';
      document.body.appendChild(bar);
    }
    bar.textContent = text;   // text only: never markup
    bar.style.display = 'block';
  }

  function read(res) {
    try {
      var paused = res.headers.get('X-CresRx-Backup') === 'paused';
      var behind = Number(res.headers.get('X-CresRx-Behind') || 0);
      if (paused) draw('The Google Sheet backup is paused for a few minutes. You can keep working: saves are kept and copied to the Sheet when it is back.');
      else if (behind >= 25) draw('The Google Sheet backup is ' + (behind >= 120 ? Math.floor(behind / 60) + ' hours' : behind + ' minutes') +
                                  ' behind. You can keep working: saves are kept and copied to the Sheet when it catches up.');
      else draw('');
    } catch (e) { /* the banner is a help, never in the way */ }
  }

  window.fetch = function (input, init) {
    var p = realFetch(input, init);
    if (!isRpc(input, init)) return p;
    return p.then(function (res) { read(res); return res; });
  };
})();
