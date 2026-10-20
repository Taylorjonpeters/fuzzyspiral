// Plane geometry for toolpaths: arcs, winding, containment, and which side of a wall is air.

/**
 * Split a G2/G3 arc into chords no longer than `maxSeg` mm.
 * Returns the points after `from`, ending exactly at `to`.
 * @param {{x:number,y:number,z:number}} from
 * @param {{x:number,y:number,z:number}} to
 * @param {number} i  center offset X from `from`
 * @param {number} j  center offset Y from `from`
 * @param {boolean} cw  true for G2
 */
export function linearizeArc(from, to, i, j, cw, maxSeg = 0.2) {
  const cx = from.x + i, cy = from.y + j;
  const r = Math.hypot(i, j);
  const a0 = Math.atan2(from.y - cy, from.x - cx);
  let a1 = Math.atan2(to.y - cy, to.x - cx);
  let sweep = a1 - a0;
  if (cw && sweep >= 0) sweep -= Math.PI * 2;
  if (!cw && sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(1, Math.ceil((Math.abs(sweep) * r) / maxSeg));
  const out = [];
  for (let k = 1; k < n; k++) {
    const a = a0 + (sweep * k) / n;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: from.z + ((to.z - from.z) * k) / n });
  }
  out.push({ x: to.x, y: to.y, z: to.z });
  return out;
}

/** Shoelace area; positive when the polygon runs counter-clockwise. */
export function signedArea(pts) {
  let a = 0;
  for (let k = 0, n = pts.length; k < n; k++) {
    const p = pts[k], q = pts[(k + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
    const a = pts[k], b = pts[j];
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Points of a run including its starting position. */
export const runPoints = (run) => [run.from, ...run.segs.map((s) => s.to)];

/**
 * For every run, the sign that turns a segment's right-hand normal (dy, -dx) into one that
 * points at air rather than into the part, plus how deeply the run is nested.
 *
 * Outer walls trace both the part's outside and the inside of holes. Air is outside a contour
 * but inside a hole, and a loop's interior is on its left when it runs counter-clockwise. So the
 * sign depends on both winding and whether the loop is a hole, which is decided by how many other
 * loops of the same layer and object contain it. Slicers usually print contours CCW and holes CW,
 * which makes this +1 everywhere, but not all of them do.
 *
 * `depth` is that containment count: 0 is the outermost skin, 1 a hole in it, 2 an island inside
 * that hole (a lamp's inner socket tube, say), and so on. Holes are the odd depths.
 *
 * Open runs (a wall split by a comment or an overhang change) can't be classified by winding, so
 * they take the sign that points away from the object's center at their midpoint, and their depth
 * comes from how many closed loops contain that midpoint. They are never counted as holes.
 *
 * @param {import('./parse.js').Run[]} runs
 * @param {Record<string, {x:number,y:number}>} centers
 * @returns {{sides: Int8Array, holes: Uint8Array, depth: Uint16Array}}
 */
export function airSides(runs, centers) {
  const sides = new Int8Array(runs.length).fill(1);
  const holes = new Uint8Array(runs.length);
  const depth = new Uint16Array(runs.length);

  // A wall the slicer interrupts mid-loop (Bambu drops M73 progress lines anywhere) arrives as
  // several runs, each starting exactly where the last one stopped. Classification works on the
  // whole loop, so stitch those back together; fuzzing still treats each run on its own.
  /** @type {{idx:number[], pts:any[]}[]} */
  const chains = [];
  runs.forEach((run, idx) => {
    const prev = chains.at(-1);
    const last = prev && runs[prev.idx.at(-1)];
    const end = prev && prev.pts.at(-1);
    if (prev && last.layer === run.layer && last.obj === run.obj &&
        Math.hypot(end.x - run.from.x, end.y - run.from.y) < 1e-3) {
      prev.idx.push(idx);
      for (const s of run.segs) prev.pts.push(s.to);
    } else {
      chains.push({ idx: [idx], pts: runPoints(run) });
    }
  });

  /** @type {Map<string, {chain:any, pts:any[], area:number}[]>} */
  const groups = new Map();
  /** @type {{chain:any, key:string, mid:any}[]} */
  const open = [];
  for (const chain of chains) {
    const run = runs[chain.idx[0]];
    const pts = chain.pts;
    const a = pts[0], b = pts[pts.length - 1];
    const closed = pts.length > 3 && Math.hypot(a.x - b.x, a.y - b.y) < 1.0;
    const key = `${run.layer}|${run.obj}`;
    if (closed) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ chain, pts, area: signedArea(pts) });
    } else {
      const side = openRunSide(pts, centers[run.obj] ?? centers[""] ?? { x: 0, y: 0 });
      for (const i of chain.idx) sides[i] = side;
      open.push({ chain, key, mid: pts[Math.floor(pts.length / 2)] });
    }
  }
  for (const loops of groups.values()) {
    for (const L of loops) {
      const p = L.pts[0];
      let d = 0;
      for (const M of loops) {
        if (M !== L && Math.abs(M.area) > Math.abs(L.area) && pointInPolygon(p.x, p.y, M.pts)) d++;
      }
      const hole = d % 2 === 1;
      const ccw = L.area > 0;
      // Right-hand normal points outside the loop when CCW. Air is outside unless it's a hole.
      const side = ccw !== hole ? 1 : -1;
      for (const i of L.chain.idx) { depth[i] = d; holes[i] = hole ? 1 : 0; sides[i] = side; }
    }
  }
  for (const o of open) {
    const d = (groups.get(o.key) ?? []).filter((M) => pointInPolygon(o.mid.x, o.mid.y, M.pts)).length;
    for (const i of o.chain.idx) depth[i] = d;
  }
  return { sides, holes, depth };
}

function openRunSide(pts, c) {
  const k = Math.max(1, Math.floor(pts.length / 2));
  const a = pts[k - 1], b = pts[k];
  const dx = b.x - a.x, dy = b.y - a.y;
  const mx = (a.x + b.x) / 2 - c.x, my = (a.y + b.y) / 2 - c.y;
  return dy * mx - dx * my >= 0 ? 1 : -1;
}

/**
 * For each layer and object, the furthest outer-wall radius in every direction from the pattern
 * center. A wall point is on the outermost skin when nothing else in its layer lies further out
 * along the same ray.
 *
 * This is geometric rather than topological on purpose. A lamp base with a cable slot running in
 * to a central tube is a single outline, so counting holes calls the slot walls and the tube
 * "outside" too. Looking outward from the center keeps only the faces you see from outside.
 * Parts that fold back on themselves around the center are the exception: a face hidden behind
 * another face at the same angle counts as inside.
 *
 * @param {import('./parse.js').Run[]} runs
 * @param {Record<string, {x:number,y:number}>} centers
 * @param {number} arc  angular bin width at the part's outer radius, mm
 * @returns {Map<string, {cx:number, cy:number, bins:Float32Array}>}  keyed by `${layer}|${obj}`
 */
export function outerProfiles(runs, centers, arc = 0.25) {
  /** @type {Map<string, {c:{x:number,y:number}, polys:any[][]}>} */
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.layer}|${run.obj}`;
    if (!groups.has(key)) groups.set(key, { c: centers[run.obj] ?? centers[""] ?? { x: 0, y: 0 }, polys: [] });
    groups.get(key).polys.push(runPoints(run));
  }
  const out = new Map();
  for (const [key, { c, polys }] of groups) {
    let rMax = 0;
    for (const pts of polys) for (const p of pts) rMax = Math.max(rMax, Math.hypot(p.x - c.x, p.y - c.y));
    const n = Math.min(16384, Math.max(360, Math.ceil((2 * Math.PI * rMax) / arc)));
    const bins = new Float32Array(n).fill(-1);
    const binOf = (p) => {
      const t = Math.atan2(p.y - c.y, p.x - c.x) / (2 * Math.PI);
      return Math.floor((t - Math.floor(t)) * n) % n;
    };
    for (const pts of polys) {
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k];
        // Sample the segment itself, not its angle: the middle of a long straight side is
        // closer to the center than its ends.
        let span = Math.abs(binOf(b) - binOf(a));
        span = Math.min(span, n - span);
        const steps = 2 * span + 1;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          const j = binOf(p);
          const r = Math.hypot(p.x - c.x, p.y - c.y);
          if (r > bins[j]) bins[j] = r;
        }
      }
    }
    out.set(key, { cx: c.x, cy: c.y, bins, binOf });
  }
  return out;
}
