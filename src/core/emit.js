// Rebuild G-code: original lines verbatim, except for the runs fuzz.js changed.

/** Trim a fixed-point number: 12.300 -> 12.3, -0.000 -> 0. */
export function num(v, digits) {
  let s = v.toFixed(digits);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

/**
 * The replacement lines for one run.
 * @param {import('./parse.js').Run} run
 * @param {import('./fuzz.js').OutSeg[]} segs
 * @returns {string[]}
 */
export function runLines(run, segs) {
  const lines = [];
  let f = run.fIn;
  let z = run.from.z;
  let e = run.eIn;
  for (const s of segs) {
    let l = `G1 X${num(s.to.x, 3)} Y${num(s.to.y, 3)}`;
    if (Math.abs(s.to.z - z) > 1e-6) { l += ` Z${num(s.to.z, 3)}`; z = s.to.z; }
    if (run.absE) { e += s.e; l += ` E${num(e, 5)}`; }
    else l += ` E${num(s.e, 5)}`;
    if (s.f !== f) { l += ` F${num(s.f, 3)}`; f = s.f; }
    lines.push(l);
  }
  // A trailing feed-only line in the run sets the speed for whatever follows it.
  if (f !== run.fOut) lines.push(`G1 F${num(run.fOut, 3)}`);
  // Absolute-E files continue from the original count, which no longer matches the new total.
  if (run.absE) {
    const eOut = run.eIn + run.segs.reduce((a, s) => a + s.e, 0);
    lines.push(`G92 E${num(eOut, 5)}`);
  }
  return lines;
}

/**
 * @param {import('./parse.js').Parsed} parsed
 * @param {(import('./fuzz.js').OutSeg[] | null)[]} out
 * @returns {string}
 */
export function emitGcode(parsed, out) {
  const { lines, eol, runs } = parsed;
  const cr = eol === "\r\n" ? "\r" : "";
  const result = [];
  let i = 0;
  runs.forEach((run, k) => {
    for (; i < run.start; i++) result.push(lines[i]);
    if (out[k]) {
      for (const l of runLines(run, out[k])) result.push(l + cr);
      i = run.end + 1;
    }
  });
  for (; i < lines.length; i++) result.push(lines[i]);
  return result.join("\n");
}
