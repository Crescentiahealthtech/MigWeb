// Read the lab report in the current tab (the HMIS page, or its PDF), show
// what the web app parsed, and save it on a click. Nothing runs unless the
// user clicks: the extension never browses HMIS on its own.
import * as pdfjs from './vendor/pdf.min.mjs';
import { pdfLines } from './pdftext.js';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
const $ = (id) => document.getElementById(id);
const say = (s) => { $('msg').textContent = s; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let pending = null;

async function post(text, source, save) {
  const cfg = await chrome.storage.local.get(['server', 'key', 'by']);
  if (!cfg.server || !cfg.key) { chrome.runtime.openOptionsPage(); throw new Error('Set the web app address and key in Options first.'); }
  const res = await fetch(cfg.server + '/api/lab/import', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-lab-key': cfg.key },
    body: JSON.stringify({ text, source, save, by: cfg.by || '' })
  });
  const out = await res.json().catch(() => ({ message: 'The web app answered ' + res.status }));
  if (!out.success) throw new Error(out.message || 'Failed.');
  return out;
}

function show(r, m, note) {
  const p = r.patient;
  $('preview').innerHTML = (m ? `<div class="ok">→ CresRx patient <b>${esc(m.patientId)}</b> · ${esc(m.name)} · ${esc(m.age)} ${esc(m.sex)}</div>`
      : `<div class="ab">${esc(note)}</div>`) +
    `<b>${esc(p.name)}</b> · ${esc(p.age)} ${esc(p.sex)} · HMIS ID ${esc(p.pin)} · Order ${esc(r.orderNo)}
    <table><tr><th>Test</th><th>Result</th><th>Unit</th><th>Range</th></tr>${r.results.map((x) =>
      `<tr><td>${esc(x.panel ? x.panel + ' › ' : '')}${esc(x.test)}</td><td class="${x.abnormal ? 'ab' : ''}">${esc(x.value)}</td><td>${esc(x.unit)}</td><td>${esc(x.range)}</td></tr>`).join('')}
    </table>${r.orders.map((o) => `<div class="muted">${esc(o.test)}: ${esc(o.status)}</div>`).join('')}`;
}

async function preview(text, source) {
  say('Reading…'); $('save').hidden = true; $('preview').innerHTML = '';
  const out = await post(text, source, false);
  pending = { text, source };
  show(out.report, out.patient, out.matchNote);
  say(out.report.results.length + ' results. Check the patient and results, then save.');
  $('save').hidden = !out.patient;
  if (!out.patient) say('Not saved: no matching patient.');
}

async function readTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && (tab.url || tab.pendingUrl) || '';
  // HMIS opens the report as blob:https://tnhmislims.org/…: only a page of that
  // site can read it, so it is fetched from inside an open HMIS tab.
  if (url.startsWith('blob:')) return preview(await pdfLines(pdfjs, await blobFromSite(url)), 'hmis-pdf');
  if (/\.pdf($|\?)/i.test(url) || await isPdf(url)) {
    const data = new Uint8Array(await (await fetch(url, { credentials: 'include' })).arrayBuffer());
    return preview(await pdfLines(pdfjs, data), url);
  }
  // An HTML report: the text of the page and its frames (table cells come tab-separated).
  const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => document.body ? document.body.innerText : '' });
  const text = frames.map((f) => f.result || '').find((t) => /Order No/i.test(t) && /PIN/.test(t));
  if (!text) throw new Error('No lab report on this page. Open the report (or its PDF), or choose the PDF file.');
  return preview(text, url);
}

async function blobFromSite(blobUrl) {
  const origin = new URL(blobUrl.slice(5)).origin;
  const tabs = await chrome.tabs.query({ url: origin + '/*' });
  for (const t of tabs) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', args: [blobUrl], func: async (u) => {
        const b = new Uint8Array(await (await fetch(u)).arrayBuffer());
        let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        return btoa(s);
      } });
      if (r && r.result) return Uint8Array.from(atob(r.result), (c) => c.charCodeAt(0));
    } catch { /* that tab is not the one that made it */ }
  }
  throw new Error('Keep the HMIS tab that opened this report open, then try again. Or download the PDF and choose it here.');
}

async function isPdf(url) {
  if (!/^https?:/.test(url)) return false;
  try { return /pdf/i.test((await fetch(url, { method: 'HEAD', credentials: 'include' })).headers.get('content-type') || ''); }
  catch { return false; }
}

const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { say(e.message); } };
$('read').onclick = guard(readTab);
$('file').onchange = guard(async (e) => {
  const f = e.target.files[0];
  if (f) await preview(await pdfLines(pdfjs, new Uint8Array(await f.arrayBuffer())), 'file:' + f.name);
});
$('save').onclick = guard(async () => {
  say('Saving…');
  const out = await post(pending.text, pending.source, true);
  $('save').hidden = true;
  say('Saved ' + out.rows + ' results for order ' + out.report.orderNo + '.');
});
