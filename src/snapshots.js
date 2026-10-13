// ============================================================================
// Ready-made answers kept in Supabase (mirror.snapshots): the Command Center.
// ----------------------------------------------------------------------------
// Apps Script computes the answer as it always has and leaves it in Supabase
// (sbSnapshotPut_). The Worker passes it on — unparsed when it can, because
// the free plan allows 10 ms of CPU — after taking out the cards this person
// has switched off (crescUiRedact_, RBAC_Access.gs, ported below).
// ============================================================================

/**
 * snapshot_get's reply text, {"data": …, "made": <ms>}, split without
 * parsing the data. null when there is no answer stored.
 */
export function splitSnapshot(text) {
  const t = String(text || '').trim();
  if (!t || t === 'null') return null;
  const head = /^\{\s*"data"\s*:\s*/.exec(t);
  const tail = /,\s*"made"\s*:\s*(\d+)\s*\}$/.exec(t);
  if (head && tail) return { dataText: t.slice(head[0].length, tail.index), made: Number(tail[1]) };
  const o = JSON.parse(t);                       // a reply laid out differently: read it properly
  if (!o || o.data === undefined) return null;
  return { dataText: JSON.stringify(o.data), made: Number(o.made) || 0 };
}

/** cresc_emptyLike_ (RBAC_Access.gs). */
function emptyLike(v) {
  if (Array.isArray(v)) return [];
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { o[k] = emptyLike(v[k]); }); return o; }
  return null;
}

/**
 * The keys of `uiHidden` ({key: [paths]}, from getEdgeIdentity) that start
 * with `prefix` ('dash.', 'acc.'), in the order Apps Script lists them.
 */
export function hiddenFor(uiHidden, prefix) {
  return Object.keys(uiHidden || {}).filter((k) => k.indexOf(prefix) === 0 && Array.isArray(uiHidden[k]));
}

/** crescUiRedact_ on a parsed payload: the hidden figures emptied, uiRedacted added. */
export function redact(payload, uiHidden, prefix) {
  const hidden = hiddenFor(uiHidden, prefix);
  if (!hidden.length || !payload) return payload;
  const out = JSON.parse(JSON.stringify(payload));
  hidden.forEach((k) => {
    uiHidden[k].forEach((path) => {
      const parts = String(path).split('.');
      let at = out;
      for (let i = 0; i < parts.length - 1; i++) at = at && at[parts[i]];
      const last = parts[parts.length - 1];
      if (at && Object.prototype.hasOwnProperty.call(at, last)) at[last] = emptyLike(at[last]);
    });
  });
  out.uiRedacted = hidden;
  return out;
}
