// TN HMIS "Lab Test Report" → rows. The input is the report's text, one line
// per printed row with its cells split by a tab or 2+ spaces: what the
// extension (extension/) reads from the PDF or the report page, and what
// `pdftotext -layout` gives too.

const CELLS = /\t+|\s{2,}/;
const RESULT = /^([<>]=?\s*)?-?\d+(\.\d+)?\*?$|^(positive|negative|reactive|non[- ]?reactive|nil|absent|present|trace|rejected)\*?$/i;
const RANGE = /^[<>]?\s*\d[\d.\s]*(-\s*\d[\d.\s]*)?$/;
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// "27-Jul-2024 15:09" (IST) → ISO, or null.
export function hmisDate(s) {
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})/.exec(s || '');
  if (!m || MON[m[2].toLowerCase()] === undefined) return null;
  return new Date(Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1], +m[4], +m[5]) - 330 * 60000).toISOString();
}

const tidy = (s) => String(s || '').normalize('NFKC').replace(/ᴧ/g, '^').replace(/(\d)\.\s+(\d)/g, '$1.$2').replace(/\s+/g, ' ').trim();
const field = (line, label) => {
  const m = new RegExp('^\\s*' + label + '\\s*:\\s*(.*)$', 'i').exec(line);
  return m ? tidy(m[1]) : null;
};

export function parseLabReport(text) {
  const out = { patient: {}, orderNo: '', orderedAt: null, facility: '', results: [], orders: [] };
  let sample = '', method = '', collectedAt = null, reportedAt = null, panel = '', inOrders = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/ /g, ' ').trimEnd();
    if (!line.trim()) continue;
    let v;
    if ((v = field(line, 'Patient Info')) !== null) {
      const [name, rest = ''] = v.split(/\s*\/\s*/, 2).concat();
      const m = /(\d+)\s*([YMD])\s*\/?\s*(Male|Female|Other)?/i.exec(v.slice(name.length));
      Object.assign(out.patient, { name, age: m ? m[1] + ' ' + m[2].toUpperCase() : rest, sex: m && m[3] ? m[3] : '' });
      continue;
    }
    if ((v = field(line, 'PIN')) !== null) { out.patient.pin = v.replace(/\D/g, ''); continue; }
    if ((v = field(line, 'Order No')) !== null) { out.orderNo = v.split(/[^\d]+/).filter(Boolean).join(','); continue; }   // one report can carry several: "37748552,37748551"
    if ((v = field(line, 'Ordered On')) !== null) { out.orderedAt = hmisDate(v); continue; }
    if ((v = field(line, 'Sample Collected At')) !== null) { out.facility = v; continue; }
    if ((v = field(line, 'Sample Type')) !== null) { sample = v; panel = ''; continue; }
    if ((v = field(line, 'Test Methodology')) !== null) { method = v; continue; }
    if (/Collected on\s*:/i.test(line)) {
      collectedAt = hmisDate(line.split(/Reported on/i)[0]);
      reportedAt = hmisDate((line.split(/Reported on/i)[1]) || '');
      continue;
    }
    if (/Test Name\s+Order status/i.test(line)) { inOrders = true; continue; }
    if (/End of Lab Result|Printed On|Authorized Signature|^\s*#?\s*Test\s+Result/i.test(line)) continue;

    const cells = line.trim().split(CELLS).map(tidy).filter(Boolean);
    const numbered = /^\d+(\s|$)/.test(cells[0] || '') && !RANGE.test(line.trim());
    if (numbered) cells[0] = cells[0].replace(/^\d+\s*/, '');     // the row number
    if (!cells[0]) cells.shift();
    if (!cells.length) continue;
    if (inOrders) {
      if (cells.length >= 2) out.orders.push({ test: cells[0], status: cells[cells.length - 1].toUpperCase() });
      continue;
    }
    const ri = cells.findIndex((c, i) => i > 0 && RESULT.test(c));
    if (ri < 0) {                                                    // a panel heading, e.g. "Renal Function Test (RFT)"
      if (cells.length === 1 && numbered) panel = cells[0];
      continue;
    }
    const name = cells.slice(0, ri).join(' ');
    const val = cells[ri];
    let unit = '', range = '';
    for (const c of cells.slice(ri + 1)) {
      if (!range && RANGE.test(c) && /\d/.test(c)) range = c.replace(/\s+/g, ' ');
      else if (!unit) unit = c;
    }
    const num = parseFloat(val.replace(/[<>=*\s]/g, ''));
    out.results.push({
      panel: numbered ? '' : panel, test: name, value: val.replace(/\*$/, ''),
      num: Number.isFinite(num) ? num : null, unit, range,
      abnormal: /\*$/.test(val), sampleType: sample, method, collectedAt, reportedAt
    });
    if (numbered) panel = '';
  }
  return out;
}
