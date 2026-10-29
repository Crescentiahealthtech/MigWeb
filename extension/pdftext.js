// A PDF's text as printed lines: items on one baseline joined left to right,
// a tab where the gap is a column gap. Feeds src/labparse.js.
export async function pdfLines(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const { items } = await (await doc.getPage(p)).getTextContent();
    // One row per baseline, within 5pt: a smaller font (the ranges) sits a little higher.
    const rows = [];
    for (const it of items.filter((i) => i.str.trim()).sort((a, b) => b.transform[5] - a.transform[5])) {
      const y = it.transform[5], last = rows[rows.length - 1];
      const item = { x: it.transform[4], w: it.width, s: it.str };
      if (last && last.y - y < 5) last.items.push(item); else rows.push({ y, items: [item] });
    }
    for (const row of rows) {
      const r = row.items.sort((a, b) => a.x - b.x);
      let s = '', end = null;
      for (const it of r) {
        if (end !== null) s += it.x - end > 6 ? '\t' : (it.x - end > 1 ? ' ' : '');
        s += it.s; end = it.x + it.w;
      }
      lines.push(s);
    }
  }
  return lines.join('\n');
}
