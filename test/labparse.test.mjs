// The TN HMIS lab report parser and /api/lab/import. The report below is
// made up, laid out as `pdftotext -layout` and the extension give it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLabReport } from '../src/labparse.js';
import worker from '../src/worker.js';

const REPORT = `                  Demo Medical College Hospital
Patient Info              : TEST PATIENT / 52 Y/Female
PIN                       : 11112222333344
Sample Collected At       : Demo Medical College Hospital
Ordered On                : 05-Mar-2025 09:10
Order No                  : 12345678
                                                    Lab Test Report
 Sample Type        : Serum
 Test Methodology : Automated
Collected on : 05-Mar-2025 09:10                                              Reported on: 05-Mar-2025 13:02
  # Test                                                     Result                    UOM           Reference Range
   1 Erythrocyte Sedimentation Rate(ESR)                     42*                       mm/hr         0-15
   2 Serum Sodium / Pottasium
      Sodium                                                 138                       mEq/L         135 - 145
      Potassium                                              5.9*                      mEq/L         3. 5 - 5. 5
 Sample Type        : EDTA whole blood
Collected on : 05-Mar-2025 09:10                                              Reported on: 05-Mar-2025 10:36
3\tComplete Blood Count
WBC\t9100\t10ᴧ3/µl\t4000 - 11000
NEUT #\t5.2\t10ᴧ3/μl
slno\tTest Name\tOrder status
1\tLiver Function Test (LFT)\tREJECTED
*****End of Lab Result*****`;

test('parses header, panels, flags, units and rejected orders', () => {
  const r = parseLabReport(REPORT);
  assert.deepEqual(r.patient, { name: 'TEST PATIENT', age: '52 Y', sex: 'Female', pin: '11112222333344' });
  assert.equal(r.orderNo, '12345678');
  assert.equal(r.orderedAt, '2025-03-05T03:40:00.000Z');
  assert.deepEqual(r.results.map((x) => [x.panel, x.test, x.value, x.unit, x.range, x.abnormal]), [
    ['', 'Erythrocyte Sedimentation Rate(ESR)', '42', 'mm/hr', '0-15', true],
    ['Serum Sodium / Pottasium', 'Sodium', '138', 'mEq/L', '135 - 145', false],
    ['Serum Sodium / Pottasium', 'Potassium', '5.9', 'mEq/L', '3.5 - 5.5', true],
    ['Complete Blood Count', 'WBC', '9100', '10^3/μl', '4000 - 11000', false],
    ['Complete Blood Count', 'NEUT #', '5.2', '10^3/μl', '', false]
  ]);
  assert.equal(r.results[3].sampleType, 'EDTA whole blood');
  assert.equal(r.results[3].reportedAt, '2025-03-05T05:06:00.000Z');
  assert.deepEqual(r.orders, [{ test: 'Liver Function Test (LFT)', status: 'REJECTED' }]);
});

const KEY = 'k'.repeat(24);
const ENV = { LAB_IMPORT_KEY: KEY, SUPABASE_URL: 'https://sb.test', SUPABASE_SECRET_KEY: 'sb_secret_x' };
const call = (body, key = KEY) => worker.fetch(new Request('https://w.test/api/lab/import', {
  method: 'POST', headers: { 'x-lab-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) }), ENV, {});

test('/api/lab/import: key, preview, save, rejects non-reports', async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push([url, JSON.parse(init.body)]); return new Response('5'); };
  assert.equal((await call({ text: REPORT }, 'wrong')).status, 401);
  const pre = await (await call({ text: REPORT })).json();
  assert.equal(pre.saved, false); assert.equal(pre.report.results.length, 5); assert.equal(sent.length, 0);
  assert.equal((await call({ text: 'hello' })).status, 422);
  const saved = await (await call({ text: REPORT, save: true, by: 'Dr X', source: 'https://hmis/x' })).json();
  assert.equal(saved.rows, 5);
  assert.equal(sent[0][0], 'https://sb.test/rest/v1/rpc/lab_import');
  assert.equal(sent[0][1].p.by, 'Dr X'); assert.equal(sent[0][1].p.report.orderNo, '12345678');
});

test('the page and the extension read PDFs with the same code', async () => {
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync('public/lab/pdftext.js', 'utf8'), readFileSync('extension/pdftext.js', 'utf8'));
});
