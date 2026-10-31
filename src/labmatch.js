// Which CresRx patient a lab report belongs to: the one whose HMIS ID (a
// Patients column headed "HMIS ID", "HMIS PIN" or the like) is the report's
// PIN. Matched by that number only, never by name.

const isHmis = (h) => /hmis/i.test(String(h || ''));
const digits = (s) => String(s ?? '').replace(/\D/g, '');

/** rpc(fn, p) → the Patients row with this PIN, { patientId, name, age, sex }, or null; throws when there is no HMIS column. */
export async function findByPin(rpc, pin) {
  const r = (await rpc('mirror_query', { queries: [{ sheet: 'Patients', all: true, parts: 'disp' }] })).results[0];
  const h = (r && r.header || []).findIndex(isHmis);
  if (h < 0) throw new Error('The Patients sheet has no HMIS ID column yet.');
  const at = (row, c) => String((row[2] || row[1] || [])[c] ?? '').trim();
  const want = digits(pin);
  const hits = (r.rows || []).filter((row) => digits(at(row, h)) === want);
  if (hits.length !== 1) return hits.length ? { duplicate: hits.map((row) => at(row, 0)) } : null;
  const row = hits[0];
  return { patientId: at(row, 0), name: at(row, 2), age: at(row, 3), sex: at(row, 4) };
}
