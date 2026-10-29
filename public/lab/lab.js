// The lab import page: read a TN HMIS report PDF in this browser (pdf.js),
// show the Worker's parse, save on a click. Same /api/lab/import as the
// extension (extension/popup.js).
import * as pdfjs from '/vendor/pdfjs-4.10.38/pdf.min.mjs';
import { pdfLines } from './pdftext.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-4.10.38/pdf.worker.min.mjs';
const $ = (id) => document.getElementById(id);
const say = (s) => { $('msg').textContent = s; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get: (k) => { try { return localStorage.getItem('lab.' + k) || ''; } catch { return ''; } },
                set: (k, v) => { try { localStorage.setItem('lab.' + k, v); } catch {} } };
let pending = null;

$('key').value = store.get('key'); $('by').value = store.get('by');
if (!store.get('key')) $('setup').open = true;
$('saveSet').onclick = () => { store.set('key', $('key').value.trim()); store.set('by', $('by').value.trim()); $('setup').open = false; say('Settings saved.'); };

async function post(text, source, save) {
  if (!store.get('key')) { $('setup').open = true; throw new Error('Enter the lab key in Settings first.'); }
  const res = await fetch('/api/lab/import', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lab-key': store.get('key') },
    body: JSON.stringify({ text, source, save, by: store.get('by') }) });
  const out = await res.json().catch(() => ({ message: 'The server answered ' + res.status }));
  if (!out.success) throw new Error(out.message || 'Failed.');
  return out;
}

function show(r) {
  const p = r.patient;
  $('preview').innerHTML = `<b>${esc(p.name)}</b> · ${esc(p.age)} ${esc(p.sex)} · PIN ${esc(p.pin)} · Order ${esc(r.orderNo)}
    <table><tr><th>Test</th><th>Result</th><th>Unit</th><th>Range</th></tr>${r.results.map((x) =>
      `<tr><td>${esc(x.panel ? x.panel + ' › ' : '')}${esc(x.test)}</td><td class="${x.abnormal ? 'ab' : ''}">${esc(x.value)}</td><td>${esc(x.unit)}</td><td>${esc(x.range)}</td></tr>`).join('')}
    </table>${r.orders.map((o) => `<div class="muted">${esc(o.test)}: ${esc(o.status)}</div>`).join('')}`;
}

async function readPdf(data, source) {
  say('Reading…'); $('save').hidden = true; $('preview').innerHTML = '';
  const text = await pdfLines(pdfjs, data);
  const out = await post(text, source, false);
  pending = { text, source };
  show(out.report);
  say(out.report.results.length + ' results. Check them, then save.');
  $('save').hidden = false;
}

const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { say(e.message); } };
$('file').onchange = guard(async (e) => {
  const f = e.target.files[0];
  if (f) await readPdf(new Uint8Array(await f.arrayBuffer()), 'file:' + f.name);
  e.target.value = '';
});
$('save').onclick = guard(async () => {
  say('Saving…');
  const out = await post(pending.text, pending.source, true);
  $('save').hidden = true;
  say('Saved ' + out.rows + ' results for order ' + out.report.orderNo + '.');
});

// A PDF shared from Android (sw.js kept it).
guard(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/lab/sw.js', { scope: '/lab/' }).catch(() => {});
  const shared = new URLSearchParams(location.search).get('shared');
  if (shared === null) return;
  history.replaceState(null, '', '/lab/');
  const cache = await caches.open('lab-share');
  const res = await cache.match('/lab/shared.pdf');
  if (!res) return say('The shared file did not arrive. Choose it with the button instead.');
  await cache.delete('/lab/shared.pdf');
  await readPdf(new Uint8Array(await res.arrayBuffer()), 'share');
})();
