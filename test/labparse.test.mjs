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
  assert.equal(parseLabReport('Order No   :  37748552, 37748551').orderNo, '37748552,37748551');
  assert.deepEqual(r.orders, [{ test: 'Liver Function Test (LFT)', status: 'REJECTED' }]);
});

const KEY = 'k'.repeat(24);
const ENV = { LAB_IMPORT_KEY: KEY, SUPABASE_URL: 'https://sb.test', SUPABASE_SECRET_KEY: 'sb_secret_x' };
const call = (body, key = KEY) => worker.fetch(new Request('https://w.test/api/lab/import', {
  method: 'POST', headers: { 'x-lab-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) }), ENV, {});

test('/api/lab/import: key, preview with patient, save, rejects non-reports and unknown IDs', async () => {
  const sent = [];
  let hmis = '11112222333344';
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/mirror_query')) return Response.json({ results: [{ found: true, header: ['Patient ID', 'x', 'Name', 'Age', 'Sex', 'HMIS ID'],
      rows: [[2, null, ['DEMO0007', '', 'Test Patient', '52', 'F', hmis]]] }] });
    sent.push([url, body]); return new Response('5');
  };
  assert.equal((await call({ text: REPORT }, 'wrong')).status, 401);
  const pre = await (await call({ text: REPORT })).json();
  assert.equal(pre.saved, false); assert.equal(pre.report.results.length, 5); assert.equal(pre.patient.patientId, 'DEMO0007');
  assert.equal(sent.length, 0);
  assert.equal((await call({ text: 'hello' })).status, 422);
  const saved = await (await call({ text: REPORT, save: true, by: 'Dr X', source: 'https://hmis/x' })).json();
  assert.equal(saved.rows, 5);
  assert.equal(sent[0][0], 'https://sb.test/rest/v1/rpc/lab_import');
  assert.equal(sent[0][1].p.by, 'Dr X'); assert.equal(sent[0][1].p.report.orderNo, '12345678');
  assert.equal(sent[0][1].p.patientId, 'DEMO0007');
  hmis = '999';
  const none = await call({ text: REPORT, save: true });
  assert.equal(none.status, 409); assert.match((await none.json()).message, /No CresRx patient has HMIS ID 11112222333344/);
});

test('the page and the extension read PDFs with the same code', async () => {
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync('public/lab/pdftext.js', 'utf8'), readFileSync('extension/pdftext.js', 'utf8'));
});

test('a report goes to the patient with its HMIS ID, never by name', async () => {
  const { findByPin } = await import('../src/labmatch.js');
  const sheet = { found: true, header: ['Patient ID', 'x', 'Name', 'Age', 'Sex', 'HMIS ID'], rows: [
    [2, null, ['DEMO0001', '', 'TEST PATIENT', '52', 'F', '5551 0000 0000 01']],
    [3, null, ['DEMO0002', '', 'TEST PATIENT', '30', 'F', '55510000000002']]] };
  const rpc = async () => ({ results: [sheet] });
  assert.deepEqual(await findByPin(rpc, '55510000000001'), { patientId: 'DEMO0001', name: 'TEST PATIENT', age: '52', sex: 'F' });
  assert.equal(await findByPin(rpc, '55519999999999'), null);
  sheet.rows.push([4, null, ['DEMO0003', '', 'Other', '1', 'M', '55510000000002']]);
  assert.deepEqual(await findByPin(rpc, '55510000000002'), { duplicate: ['DEMO0002', 'DEMO0003'] });
  sheet.header[5] = 'Notes';
  await assert.rejects(findByPin(rpc, '1'), /no HMIS ID column/);
});
